/**
 * All configuration enters through this one validated object. Nothing else
 * reads `process.env`; a missing or malformed variable fails loudly at boot.
 * Table-driven so adding a setting is one line (name, type, default).
 */
type Spec = { type: 'string' | 'number' | 'boolean'; default?: string | number | boolean; required?: boolean; oneOf?: string[] };

const SPEC = {
  NODE_ENV: { type: 'string', default: 'development', oneOf: ['development', 'test', 'production'] },
  PORT: { type: 'number', default: 3000 },
  HOST: { type: 'string', default: '0.0.0.0' },
  // Which proxies may set X-Forwarded-For (rate limits and audit IPs depend on it). 'false' | 'true' | comma-separated CIDRs.
  // Behind the Next.js server / load balancer, set the proxy's address. 'true' trusts ANY sender and lets a caller spoof their IP.
  TRUST_PROXY: { type: 'string', default: 'false' },
  LOG_LEVEL: { type: 'string', default: 'info' },
  APP_BASE_URL: { type: 'string', default: 'http://localhost:5173' }, // used in invite / reset links

  DATABASE_URL: { type: 'string', required: true },
  DB_POOL_MAX: { type: 'number', default: 10 },
  // Optional read replica. Dashboards, analytics and reports read from it so heavy reads never compete with the ledger
  // writes on the primary. Unset = those reads use the primary. Replication lag of a second or two is fine for them.
  DATABASE_READ_URL: { type: 'string', default: '' },
  DB_READ_POOL_MAX: { type: 'number', default: 10 },
  REDIS_URL: { type: 'string', required: true },

  SESSION_TTL_SECONDS: { type: 'number', default: 60 * 60 * 12 },
  IDEMPOTENCY_KEY_TTL_SECONDS: { type: 'number', default: 60 * 60 * 24 },
  CORS_ORIGINS: { type: 'string', default: '' },
  RATE_LIMIT_MAX: { type: 'number', default: 300 },
  RATE_LIMIT_WINDOW_MS: { type: 'number', default: 60_000 },
  AUTH_RATE_LIMIT_MAX: { type: 'number', default: 10 },
  LOGIN_MAX_FAILED_ATTEMPTS: { type: 'number', default: 8 },
  LOGIN_LOCK_MINUTES: { type: 'number', default: 15 },
  MAX_SESSIONS_PER_USER: { type: 'number', default: 10 },
  INVITE_TTL_HOURS: { type: 'number', default: 72 },
  PASSWORD_RESET_TTL_MINUTES: { type: 'number', default: 30 },

  // Offline replay (PRD §21): how far a device clock may drift / how old a queued action may be.
  OFFLINE_MAX_CLOCK_SKEW_SECONDS: { type: 'number', default: 300 },
  OFFLINE_MAX_AGE_HOURS: { type: 'number', default: 24 * 14 },

  // Object storage (S3-compatible: AWS S3, MinIO, R2). Private bucket, signed URLs only.
  S3_ENDPOINT: { type: 'string', default: '' },
  S3_REGION: { type: 'string', default: 'us-east-1' },
  S3_BUCKET: { type: 'string', default: 'storekeeper-files' },
  S3_ACCESS_KEY_ID: { type: 'string', default: '' },
  S3_SECRET_ACCESS_KEY: { type: 'string', default: '' },
  S3_FORCE_PATH_STYLE: { type: 'boolean', default: true },
  S3_SIGNED_URL_TTL_SECONDS: { type: 'number', default: 300 },
  MAX_IMAGE_BYTES: { type: 'number', default: 8 * 1024 * 1024 },

  // Email via nodemailer. Mailgun's SMTP relay: smtp.mailgun.org:587 with the domain's SMTP credentials.
  MAIL_ENABLED: { type: 'boolean', default: false },
  MAIL_HOST: { type: 'string', default: 'smtp.mailgun.org' },
  MAIL_PORT: { type: 'number', default: 587 },
  MAIL_SECURE: { type: 'boolean', default: false },
  MAIL_USER: { type: 'string', default: '' },
  MAIL_PASS: { type: 'string', default: '' },
  MAIL_FROM: { type: 'string', default: 'StoreKeeper <no-reply@localhost>' },

  // Background jobs. 'inline' runs jobs synchronously in-process (tests / single-box dev).
  JOBS_MODE: { type: 'string', default: 'queue', oneOf: ['queue', 'inline'] },
  JOBS_CONCURRENCY: { type: 'number', default: 5 },

  // CSV import (streamed into a staging table, so memory stays flat whatever the file size).
  IMPORT_MAX_MB: { type: 'number', default: 100 },
  IMPORT_MAX_ROWS: { type: 'number', default: 200_000 },
  IMPORT_CHUNK_ROWS: { type: 'number', default: 500 },

  // Circuit breakers (lib/circuit-breaker.ts): defaults applied to every dependency breaker.
  BREAKER_FAILURE_THRESHOLD: { type: 'number', default: 5 },
  BREAKER_WINDOW_MS: { type: 'number', default: 30_000 },
  BREAKER_RESET_TIMEOUT_MS: { type: 'number', default: 20_000 },
  BREAKER_CALL_TIMEOUT_MS: { type: 'number', default: 8_000 },

  // /metrics (Prometheus). Unset => endpoint disabled. Never expose without a token.
  METRICS_TOKEN: { type: 'string', default: '' },
  OVERDUE_SCAN_CRON: { type: 'string', default: '*/10 * * * *' },
} as const satisfies Record<string, Spec>;

type Parsed<S extends Record<string, Spec>> = {
  -readonly [K in keyof S]: S[K]['type'] extends 'number' ? number : S[K]['type'] extends 'boolean' ? boolean : string;
};
export type Env = Parsed<typeof SPEC>;

function loadEnv(): Env {
  const out: Record<string, string | number | boolean> = {};
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(SPEC) as [string, Spec][]) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
      if (spec.required) problems.push(`  ${name}: required`);
      else out[name] = spec.default as string | number | boolean;
      continue;
    }
    if (spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) problems.push(`  ${name}: must be a number`);
      else out[name] = n;
    } else if (spec.type === 'boolean') {
      if (!['true', 'false', '1', '0'].includes(raw)) problems.push(`  ${name}: must be true/false`);
      else out[name] = raw === 'true' || raw === '1';
    } else {
      if (spec.oneOf && !spec.oneOf.includes(raw)) problems.push(`  ${name}: must be one of ${spec.oneOf.join(', ')}`);
      else out[name] = raw;
    }
  }
  const env = out as unknown as Env;
  if (/^\d+$/.test(env.TRUST_PROXY)) problems.push('  TRUST_PROXY: numeric hop counts are unsupported; specify the trusted proxy IP or CIDR');
  if (problems.length === 0 && env.NODE_ENV === 'production') {
    // Fail closed in production on settings whose insecure defaults are only acceptable in dev.
    if (!env.CORS_ORIGINS) problems.push('  CORS_ORIGINS: must be set in production');
    if (env.TRUST_PROXY === 'true') problems.push('  TRUST_PROXY: "true" trusts any client-supplied X-Forwarded-For; use the proxy IP or CIDR');
    if (env.MAIL_ENABLED && (!env.MAIL_USER || !env.MAIL_PASS)) problems.push('  MAIL_USER/MAIL_PASS: required when MAIL_ENABLED');
    if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) problems.push('  S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY: required in production');
    if (env.JOBS_MODE === 'inline') problems.push('  JOBS_MODE: "inline" is not allowed in production');
  }
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${problems.join('\n')}`);
    process.exit(1);
  }
  return env;
}

export const env = loadEnv();
