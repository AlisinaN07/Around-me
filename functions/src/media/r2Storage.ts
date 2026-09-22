/**
 * SERVER-SIDE-ONLY R2 client — Cloud Functions code, never imported by
 * anything under src/ (the mobile app). Deliberately NOT re-exported from
 * functions/src/index.ts — Cloud Functions deploys every trigger/callable
 * that file exports, so keeping this module out of that barrel is what
 * guarantees ZERO production/deployment footprint from it today, exactly
 * per Step 4's "do NOT hook it into current production media flow"
 * instruction. Nothing calls any function in this file anywhere in this
 * repository right now.
 *
 * Every exported function here throws a clear, actionable error if
 * getR2Config() returns null, rather than silently no-op'ing or trying to
 * reach a real bucket with missing credentials — importing this module is
 * always safe (it touches no network and reads no env var at import
 * time); CALLING it without real R2 credentials configured is the only
 * thing that fails, and does so with a message naming exactly what's
 * missing.
 *
 * Uses the AWS SDK v3 MODULAR S3 client (@aws-sdk/client-s3 +
 * @aws-sdk/s3-request-presigner only) — Cloudflare's own documented,
 * officially-supported way to talk to R2 (its object API is
 * S3-compatible) — never the legacy monolithic `aws-sdk` v2 package,
 * which would pull in every AWS service's client for no reason. These
 * two packages alone cover everything Step 4/5 need: put (via a
 * presigned URL, so large video bytes never pass through a Cloud
 * Function), delete, and existence checks.
 */
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { getR2Config } from './r2Config';

/**
 * Short — a presigned upload URL is meant to be used immediately by the
 * client that just requested it, not stashed for later. Long enough for
 * a real device to start a large video upload without racing the clock,
 * short enough that a leaked/logged URL stops being useful quickly.
 */
export const PRESIGNED_UPLOAD_TTL_SECONDS = 5 * 60;

let cachedClient: S3Client | null = null;
let cachedClientAccountId: string | null = null;

/** Throws with a specific, actionable message if R2 isn't configured — see this file's own top doc comment. Reuses one S3Client instance across calls within the same running function instance (cheap; avoids reconstructing it on every single request) and only rebuilds it if the configured account ever actually changes. */
function requireR2Client(): { client: S3Client; bucketName: string } {
  const config = getR2Config();
  if (!config) {
    throw new Error(
      'R2 is not configured — set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY before calling any r2Storage function. See functions/.env.example and the Step 4 report\'s Cloudflare setup plan.'
    );
  }
  if (!cachedClient || cachedClientAccountId !== config.accountId) {
    cachedClient = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    cachedClientAccountId = config.accountId;
  }
  return { client: cachedClient, bucketName: config.bucketName };
}

/**
 * A short-lived presigned PUT URL scoped to exactly ONE object key, ONE
 * Content-Type, and (when `contentLengthBytes` is given) exactly ONE
 * byte length — the eventual client-facing upload primitive (see
 * src/services/media/types.ts's MediaUploadAuthorization). The client
 * can upload directly to R2 with this URL, so large media bytes never
 * pass through a Cloud Function, but it can never choose a different
 * key, content type, or (when bound) body size than what was authorized
 * here — SigV4 presigning covers every parameter passed into the command
 * below, so R2 itself rejects a PUT whose actual Content-Type or
 * Content-Length doesn't match what was signed, with no extra
 * server-side check needed. The URL stops working after
 * PRESIGNED_UPLOAD_TTL_SECONDS regardless.
 *
 * `contentLengthBytes`, when passed, is a REAL enforced upper/exact
 * bound (unlike a caller-declared size the server merely trusted) — the
 * request fails at R2 if the actual upload body isn't exactly that many
 * bytes. Callers should still validate the declared size against a
 * sensible maximum BEFORE calling this (see
 * requestMediaUploadAuthorization.ts's own PROFILE_PHOTO_MAX_SIZE_BYTES
 * check) — this only makes the signed value binding, it doesn't pick
 * what that value should be.
 *
 * Never call this with a client-supplied key directly — always build the
 * key server-side via objectKey.ts's own helpers from TRUSTED
 * identifiers (the caller's own verified auth uid, a freshly-generated
 * Firestore document ID), exactly like isValidReelCreate already
 * enforces for Firebase Storage uploads today. This function does not
 * validate the key itself — that's objectKey.ts's job, deliberately kept
 * separate and pure/dependency-free so it's unit-testable without an R2
 * client.
 */
export async function createPresignedUploadUrl(
  key: string,
  contentType: string,
  contentLengthBytes?: number
): Promise<{ uploadUrl: string; expiresAt: number }> {
  const { client, bucketName } = requireR2Client();
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
    ...(contentLengthBytes !== undefined ? { ContentLength: contentLengthBytes } : {}),
  });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: PRESIGNED_UPLOAD_TTL_SECONDS });
  return { uploadUrl, expiresAt: Date.now() + PRESIGNED_UPLOAD_TTL_SECONDS * 1000 };
}

/** Deletes the object at `key`. Callers should treat a "not found" failure as success (mirrors this codebase's own Firebase Storage delete semantics elsewhere — see src/services/reels.ts's discardReelDraft). */
export async function deleteR2Object(key: string): Promise<void> {
  const { client, bucketName } = requireR2Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}

/** `true` if the object exists, `false` otherwise — never throws for a genuinely missing object. */
export async function r2ObjectExists(key: string): Promise<boolean> {
  const { client, bucketName } = requireR2Client();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch {
    return false;
  }
}
