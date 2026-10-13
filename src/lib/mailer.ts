/**
 * Outbound email via nodemailer. Point it at Mailgun's SMTP relay
 * (smtp.mailgun.org:587, the sending domain's SMTP credentials).
 *
 * Wrapped in a circuit breaker: when Mailgun is down or throttling, the worker
 * stops hammering it for BREAKER_RESET_TIMEOUT_MS, keeps the queued emails safe
 * in the outbox, and resumes automatically. The API never calls this directly.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env.js';
import { breaker } from './circuit-breaker.js';

let transporter: Transporter | null = null;
function t(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: env.MAIL_HOST, port: env.MAIL_PORT, secure: env.MAIL_SECURE,
    auth: env.MAIL_USER ? { user: env.MAIL_USER, pass: env.MAIL_PASS } : undefined,
    pool: true, maxConnections: 3, connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 10_000,
  });
  return transporter;
}

// SMTP 5xx replies for a specific recipient (bad mailbox) are the *message's* fault, not the provider's.
const smtpBreaker = () => breaker('smtp-mailgun', {
  isFailure: (err) => { const c = (err as { responseCode?: number })?.responseCode; return !(typeof c === 'number' && c >= 500 && c < 600 && c !== 503); },
});

export class PermanentMailError extends Error {}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  try {
    await smtpBreaker().exec(() => t().sendMail({ from: env.MAIL_FROM, to, subject, text }));
  } catch (err) {
    const c = (err as { responseCode?: number })?.responseCode;
    if (typeof c === 'number' && c >= 500 && c < 600 && c !== 503) throw new PermanentMailError((err as Error).message);
    throw err;
  }
}
