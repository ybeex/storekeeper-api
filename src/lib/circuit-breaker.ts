/**
 * Circuit breaker for outbound dependencies (SMTP/Mailgun, S3, Redis).
 *
 * Why: a dependency that is slow or down turns every request that touches it
 * into a slow failure that holds a connection, a socket, and a worker slot —
 * the classic cascading-failure shape. The breaker fails fast once a
 * dependency is demonstrably unhealthy, gives it room to recover, and probes
 * it with a trickle of traffic before trusting it again.
 *
 *   CLOSED ──(≥ threshold failures within window)──▶ OPEN
 *   OPEN ──(resetTimeout elapsed)──▶ HALF_OPEN ──(probe ok)──▶ CLOSED
 *                                        └──(probe fails)──▶ OPEN
 *
 * Every call is also bounded by a timeout, because a hung call that never
 * rejects would otherwise never count as a failure.
 *
 * What to wrap vs. what not: wrap I/O to dependencies the request can degrade
 * without (session cache, rate limiter, email), or can report as 503 (object
 * storage). Never wrap the primary Postgres — there is no meaningful fallback
 * and a tripped breaker there would convert a transient blip into an outage;
 * Postgres is protected by pool limits, statement/lock timeouts and
 * load-shedding instead.
 */
import { AppError } from './errors.js';
import { env } from '../env.js';
import { breakerStateGauge, breakerRejections } from './metrics.js';

export type BreakerState = 'closed' | 'open' | 'half_open';

export class DependencyUnavailableError extends AppError {
  constructor(public readonly dependency: string) {
    super(503, 'DEPENDENCY_UNAVAILABLE', `${dependency} is temporarily unavailable`, { dependency });
  }
}

export interface BreakerOptions {
  name: string;
  failureThreshold?: number;
  windowMs?: number;
  resetTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Max concurrent probe calls while half-open. */
  halfOpenMaxCalls?: number;
  /** Errors for which isFailure returns false (e.g. a 4xx from the dependency) do not trip the breaker. */
  isFailure?: (err: unknown) => boolean;
}

export class CircuitBreaker {
  readonly name: string;
  private state: BreakerState = 'closed';
  private failures: number[] = []; // timestamps within the window
  private openedAt = 0;
  private halfOpenInFlight = 0;
  private readonly o: Required<Omit<BreakerOptions, 'name' | 'isFailure'>> & Pick<BreakerOptions, 'isFailure'>;

  constructor(opts: BreakerOptions) {
    this.name = opts.name;
    this.o = {
      failureThreshold: opts.failureThreshold ?? env.BREAKER_FAILURE_THRESHOLD,
      windowMs: opts.windowMs ?? env.BREAKER_WINDOW_MS,
      resetTimeoutMs: opts.resetTimeoutMs ?? env.BREAKER_RESET_TIMEOUT_MS,
      callTimeoutMs: opts.callTimeoutMs ?? env.BREAKER_CALL_TIMEOUT_MS,
      halfOpenMaxCalls: opts.halfOpenMaxCalls ?? 1,
      isFailure: opts.isFailure,
    };
    this.publish();
  }

  getState(): BreakerState {
    this.advance();
    return this.state;
  }

  /** Runs `fn` through the breaker. Throws DependencyUnavailableError when open. */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    this.advance();
    if (this.state === 'open') {
      breakerRejections.inc({ name: this.name });
      throw new DependencyUnavailableError(this.name);
    }
    if (this.state === 'half_open') {
      if (this.halfOpenInFlight >= this.o.halfOpenMaxCalls) {
        breakerRejections.inc({ name: this.name });
        throw new DependencyUnavailableError(this.name);
      }
      this.halfOpenInFlight++;
    }
    const probing = this.state === 'half_open';
    try {
      const result = await withTimeout(fn(), this.o.callTimeoutMs, this.name);
      this.onSuccess(probing);
      return result;
    } catch (err) {
      if (this.o.isFailure && !this.o.isFailure(err)) {
        this.onSuccess(probing); // the dependency answered; the *request* was bad
      } else {
        this.onFailure(probing);
      }
      throw err;
    } finally {
      if (probing) this.halfOpenInFlight--;
    }
  }

  /** Like exec, but returns `fallback()` instead of throwing when the dependency is unavailable or fails. */
  async execOr<T>(fn: () => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
    try {
      return await this.exec(fn);
    } catch {
      return fallback();
    }
  }

  private advance() {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.o.resetTimeoutMs) {
      this.state = 'half_open';
      this.halfOpenInFlight = 0;
      this.publish();
    }
  }
  private onSuccess(wasProbe: boolean) {
    if (wasProbe) { this.state = 'closed'; this.failures = []; this.publish(); }
  }
  private onFailure(wasProbe: boolean) {
    const now = Date.now();
    if (wasProbe) { this.trip(now); return; }
    this.failures = this.failures.filter((t) => now - t < this.o.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.o.failureThreshold) this.trip(now);
  }
  private trip(now: number) {
    this.state = 'open';
    this.openedAt = now;
    this.publish();
  }
  private publish() {
    breakerStateGauge.set({ name: this.name }, this.state === 'closed' ? 0 : this.state === 'half_open' ? 1 : 2);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} call timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** One breaker per dependency, shared process-wide. */
const registry = new Map<string, CircuitBreaker>();
export function breaker(name: string, opts?: Omit<BreakerOptions, 'name'>): CircuitBreaker {
  let b = registry.get(name);
  if (!b) { b = new CircuitBreaker({ name, ...opts }); registry.set(name, b); }
  return b;
}
export function breakerStates(): Record<string, BreakerState> {
  return Object.fromEntries([...registry.entries()].map(([k, v]) => [k, v.getState()]));
}
