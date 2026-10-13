/**
 * Object storage (S3-compatible, PRD §37 "secure file/image storage").
 *
 * - The bucket is PRIVATE. Nothing is ever served by public URL; clients get
 *   short-lived presigned GETs (signed locally — no network call, so it can
 *   neither fail nor be slow).
 * - Writes/deletes go through a circuit breaker: when the store is down the API
 *   answers 503 DEPENDENCY_UNAVAILABLE immediately instead of piling up
 *   hung uploads. Everything else in the app keeps working.
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';
import { breaker } from './circuit-breaker.js';
import { AppError } from './errors.js';

let client: S3Client | null = null;
function s3(): S3Client {
  if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured');
  client ??= new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    maxAttempts: 2, // the breaker, not the SDK, owns retry policy
  });
  return client;
}

const storageBreaker = () => breaker('object-storage', {
  // A 4xx from S3 (e.g. AccessDenied) is a config bug, not an outage; still surface it, but don't trip.
  isFailure: (err) => !(typeof (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 'number'
    && (err as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode < 500),
});

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await storageBreaker().exec(() => s3().send(new PutObjectCommand({
    Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType,
    CacheControl: 'private, max-age=0', ServerSideEncryption: undefined,
  })));
}

export async function deleteObject(key: string): Promise<void> {
  await storageBreaker().exec(() => s3().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key })));
}

export async function signedGetUrl(key: string): Promise<string | null> {
  try {
    return await getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn: env.S3_SIGNED_URL_TTL_SECONDS });
  } catch {
    return null; // unconfigured storage must degrade a read, not fail it
  }
}
