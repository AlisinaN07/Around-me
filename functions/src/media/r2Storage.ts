/**
 * SERVER-SIDE-ONLY R2 client — Cloud Functions code, never imported by
 * anything under src/ (the mobile app). Deliberately NOT re-exported
 * ITSELF from functions/src/index.ts — Cloud Functions deploys every
 * trigger/callable that file exports, so keeping this module out of that
 * barrel directly is what guarantees it has no deployment footprint of
 * its own beyond the few narrow, validated, secret-bound callables that
 * DO import from it (requestMediaUploadAuthorization.ts since Step 5A,
 * discardReelSource.ts since Step 9A, and functions/src/index.ts's own
 * deleteMyReel/deleteMyAccountData/removeReportedReel since Step 9A, for
 * R2-aware Reel-source cleanup — see their own doc comments). No OTHER
 * code path in this repository reaches any function here.
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
 * two packages cover: put (via a presigned URL, so large video bytes
 * normally never pass through a Cloud Function), delete, existence
 * checks (Step 4/5), and — Step 9B — an authenticated direct get/put
 * pair used ONLY by muxReelMusic's own server-internal video
 * read-mux-replace workflow, where bytes DO need to pass through the
 * Cloud Function itself (there is no other way to run ffmpeg on them).
 */
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

/**
 * Step 9B — an AUTHENTICATED read of an R2 object's full body, via the S3
 * API directly (GetObjectCommand) rather than the object's own public
 * delivery URL. Used ONLY by muxReelMusic's own server-internal video
 * read (see reelSourceStorage.ts's downloadReelSourceForMux) — every
 * other R2 read in this codebase (resolveOwnSoundOrigin, addReelToMyStory)
 * deliberately stays on the public-URL `fetch()` path from Step 9A, since
 * those are fine depending on whatever Cloudflare's edge cache currently
 * holds. Muxing is different: it must operate on the OBJECT'S OWN, exactly
 * current bytes, never a possibly-stale CDN-cached copy, and it must not
 * depend on `R2_PUBLIC_MEDIA_BASE_URL` being configured at all (a
 * server-internal operation has no reason to depend on the same public
 * delivery config a client needs) — see the Step 9B report's own "R2
 * server read behavior" section for the full evaluation.
 *
 * Buffers the entire object in memory before returning — safe because
 * REEL_VIDEO_MAX_SIZE_BYTES already caps a Reel source at 50 MB, and
 * muxReelMusic already runs at 1GiB memory for its own ffmpeg step.
 */
export async function downloadR2ObjectBuffer(key: string): Promise<Buffer> {
  const { client, bucketName } = requireR2Client();
  const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  const body = response.Body;
  if (!body) {
    throw new Error(`R2 object "${key}" has no readable body.`);
  }
  // The AWS SDK v3 client's own Node runtime returns a real Node Readable
  // for `Body` — `transformToByteArray()` is its own documented,
  // cross-runtime-safe way to fully buffer a response body, avoiding a
  // hand-rolled stream-to-buffer loop.
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Step 9B — an AUTHENTICATED write of a REPLACEMENT object's full body,
 * via the S3 API directly (PutObjectCommand) — the server-internal
 * counterpart to createPresignedUploadUrl's own client-facing presigned
 * PUT. Used ONLY by muxReelMusic's own server-internal video write (see
 * reelSourceStorage.ts's uploadMuxedReelSourceToProvider): the client
 * never receives R2 credentials of any kind for this — this function's
 * caller (a trusted Cloud Function) does the actual write.
 *
 * `cacheControl`, when given, is set on the object itself — used
 * specifically for the muxed Reel-source replacement, whose delivery URL
 * is re-versioned (`?v=<version>`) every time this runs (see mediaUrl.ts
 * and the Step 9B report's own "Cache/version strategy"): once an object
 * is reachable ONLY via a version-stamped URL, marking the underlying
 * response long-lived+immutable is safe and correct — a content change
 * always gets a NEW url, never the same one serving different bytes.
 * Every other R2 write in this codebase (createPresignedUploadUrl) sets
 * no Cache-Control at all, unaffected by this new optional parameter.
 */
/**
 * Step 11B — `metadata`, when given, is attached as S3/R2 OBJECT
 * METADATA (arbitrary `x-amz-meta-*` string key/value pairs, read back
 * later via `headR2ObjectDetails` below WITHOUT downloading the object's
 * body) — used specifically to stamp a durable
 * REEL_VIDEO_NORMALIZATION_PROFILE marker onto a Reel's canonical source
 * object the moment this codebase's own server-side ffmpeg pipeline
 * finishes normalizing it (see reelVideoProfile.ts's own doc comment),
 * so a LATER retry (after e.g. a Firestore confirm-write failure) can
 * tell "this object already IS the final normalized asset" from a real,
 * server-verifiable storage fact — never from a URL shape, a codec
 * guess, or client-reported state. S3's own Metadata values must be
 * plain strings (confirmed against this installed @aws-sdk/client-s3
 * version's own PutObjectRequest/HeadObjectOutput types — never numbers/
 * booleans), so callers pass pre-stringified values.
 */
export async function putR2Object(
  key: string,
  data: Buffer,
  contentType: string,
  cacheControl?: string,
  metadata?: Record<string, string>
): Promise<void> {
  const { client, bucketName } = requireR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: data,
      ContentType: contentType,
      ...(cacheControl ? { CacheControl: cacheControl } : {}),
      ...(metadata ? { Metadata: metadata } : {}),
    })
  );
}

/**
 * Step 11B — a METADATA-ONLY read (S3 HeadObjectCommand — never downloads
 * the object's body, unlike downloadR2ObjectBuffer above) of an R2
 * object's current size and custom metadata, used by
 * reelSourceStorage.ts's readReelCanonicalSourceState to check whether a
 * Reel's canonical source object already carries this codebase's own
 * normalization marker, without ever fetching the (potentially tens-of-
 * megabytes) video bytes just to check a flag. Returns `null` for a
 * missing object OR any other read failure — deliberately fail-SAFE: the
 * caller treats `null` as "cannot confirm this is already normalized,"
 * never as "assume it is" — see this codebase's own explicit "metadata
 * read failure must fail safely, not incorrectly assume normalization"
 * requirement.
 */
export async function headR2ObjectDetails(key: string): Promise<{ sizeBytes: number; metadata: Record<string, string> } | null> {
  const { client, bucketName } = requireR2Client();
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    const sizeBytes = typeof result.ContentLength === 'number' ? result.ContentLength : 0;
    if (sizeBytes <= 0) return null;
    return { sizeBytes, metadata: result.Metadata ?? {} };
  } catch {
    return null;
  }
}

/**
 * Step 10A — an AUTHENTICATED, BUCKET-INTERNAL copy from one R2 key to
 * another, via the S3 API's own CopyObjectCommand — Cloudflare R2
 * implements this exactly like S3 (documented, officially supported).
 * Used ONLY by addReelToMyStory's own R2-to-R2 case (an R2-backed Reel
 * reshared as a Story, when R2 is the active Story provider too — see
 * copyReelSourceToR2StoryObject in reelSourceStorage.ts): the bytes never
 * leave R2 at all, let alone pass through this Cloud Function's own
 * memory/disk — strictly better than the "download then re-upload"
 * fallback that's still used for a Firebase-sourced Reel.
 *
 * Deliberately takes no `contentType` parameter — the default
 * `MetadataDirective` ('COPY') carries the SOURCE object's own
 * Content-Type over unchanged, which is already correct (the Reel source
 * was validated/stamped at its own upload time) — there is no reason for
 * this function to ever need to override it.
 *
 * `sourceKey`/`destinationKey` are passed through to `CopySource`/`Key`
 * as-is, with no additional encoding: every key this codebase ever
 * builds comes from objectKey.ts's own `buildKey`, which already
 * restricts every path segment to `[A-Za-z0-9_-]` — there is no
 * character here that AWS's own CopySource percent-encoding requirement
 * could ever actually affect.
 */
export async function copyR2Object(sourceKey: string, destinationKey: string): Promise<void> {
  const { client, bucketName } = requireR2Client();
  await client.send(
    new CopyObjectCommand({
      Bucket: bucketName,
      CopySource: `${bucketName}/${sourceKey}`,
      Key: destinationKey,
    })
  );
}
