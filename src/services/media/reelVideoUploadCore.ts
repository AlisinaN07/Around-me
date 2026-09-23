/**
 * Step 9A — the PURE business logic behind the Reel-video R2 upload flow,
 * deliberately separated from the native transport it actually runs over
 * (expo-file-system's `File.createUploadTask`, see r2Provider.ts's own
 * `uploadReelVideoToR2`). This file has ZERO import from 'expo-file-system'
 * or any Firebase package — it only knows about a small, injected
 * `UploadAdapter` interface, which is the exact seam a plain-Node test can
 * fill with a fake implementation.
 *
 * WHY THIS SPLIT EXISTS: expo-file-system's native module registry only
 * exists inside a real Expo/React Native runtime — it cannot be
 * `require()`'d or executed under plain Node the way this repo's other
 * pure logic (mediaUploadValidation.ts, reelEligibility.ts, etc.) can be.
 * Rather than leave the ENTIRE upload flow (authorize -> PUT -> confirm
 * gating -> progress -> error handling) untested just because one small
 * piece of it (the actual native PUT) can't run outside a device/
 * simulator, this file carries every byte of logic that CAN be tested,
 * and r2Provider.ts's own `uploadReelVideoToR2` is reduced to the
 * thinnest possible real adapter around it — see that function's own doc
 * comment for exactly what remains unverified by execution (only the
 * native call's own SHAPE, checked by static source review instead — see
 * the Step 9A verification report's own "Upload-adapter contract" section).
 */

export type UploadAdapterResult = { status: number };

/**
 * The seam between this file's pure orchestration and the real native
 * upload mechanism. A real implementation (r2Provider.ts) wraps
 * `expo-file-system`'s `File`/`UploadTask`; a test implementation is a
 * plain object recording what it was called with and returning whatever
 * outcome that test wants to exercise.
 */
export type UploadAdapter = {
  /** The ACTUAL local file's size, read directly off disk — never a caller-supplied/declared value. Returns `null`/`0`/negative if the file can't be read, which the core treats as a hard failure before ever authorizing anything. */
  getFileSize(): number | null;
  /** Performs the actual PUT (or whatever the real transport uses) to `url` with the given headers, reporting `(bytesSent, totalBytes)` progress as it goes. Resolves with the real HTTP status code even for a non-2xx response — only a genuine transport-level failure (network down, etc.) should reject. */
  start(url: string, headers: Record<string, string>, onProgress: (bytesSent: number, totalBytes: number) => void): Promise<UploadAdapterResult>;
  /** Aborts the in-flight transfer, if any. Safe to call even if `start` hasn't been invoked yet or has already settled. */
  cancel(): void;
};

/** The shape requestUploadAuthorization (r2Provider.ts) already returns — redeclared minimally here rather than imported, since this file must stay free of any Firebase import. */
export type ReelVideoAuthorization = {
  uploadUrl: string;
  contentType: string;
  mediaUrl: string | null;
};

export type AuthorizeReelVideoUpload = (contentType: string, fileSizeBytes: number, reelId: string) => Promise<ReelVideoAuthorization>;

export type ReelVideoUploadOutcome = { ok: true; sourceUrl: string } | { ok: false; message: string };

/**
 * The full, pure orchestration: read the real file size -> authorize ->
 * PUT via the injected adapter -> gate success on a real 2xx status AND a
 * real configured `mediaUrl` -> report progress throughout. Never
 * confirms/reports success on a failed or unconfigured upload — see each
 * branch's own comment for exactly which failure produces which message.
 *
 * `onUploadTaskReady`, if provided, is called synchronously with the
 * adapter's own `cancel` the moment the adapter exists (before `start` is
 * even called) — this is what lets a caller (reels.ts's
 * uploadReelVideoViaR2) wire up genuine cancellation before the transfer
 * necessarily begins.
 */
export async function performReelVideoUpload(
  createAdapter: () => UploadAdapter,
  authorize: AuthorizeReelVideoUpload,
  reelId: string,
  contentType: string,
  onProgress: (percent: number) => void,
  onUploadTaskReady?: (cancel: () => void) => void
): Promise<ReelVideoUploadOutcome> {
  const adapter = createAdapter();
  onUploadTaskReady?.(() => adapter.cancel());

  // The ACTUAL local file's own size — never a caller-supplied/declared
  // value (e.g. the Reel's own `fileSizeBytes`, stamped at draft-creation
  // time from the picker's own metadata, which could theoretically drift
  // from the real bytes about to be sent). This is what gets bound into
  // the presigned URL's own signature, so it must match exactly.
  const fileSizeBytes = adapter.getFileSize();
  if (!fileSizeBytes || fileSizeBytes <= 0) {
    return { ok: false, message: "Couldn't read this video file." };
  }

  let authorization: ReelVideoAuthorization;
  try {
    authorization = await authorize(contentType, fileSizeBytes, reelId);
  } catch {
    return { ok: false, message: "Couldn't prepare this upload." };
  }

  onProgress(0);
  let result: UploadAdapterResult;
  try {
    result = await adapter.start(authorization.uploadUrl, { 'Content-Type': authorization.contentType }, (bytesSent, totalBytes) => {
      if (totalBytes > 0) onProgress(Math.round((bytesSent / totalBytes) * 100));
    });
  } catch {
    return { ok: false, message: "Couldn't upload this video." };
  }
  if (result.status < 200 || result.status >= 300) {
    // A non-2xx PUT response (e.g. the presigned URL expired, or the real
    // file size didn't match the signed Content-Length) — never treated
    // as success just because the transfer itself completed.
    return { ok: false, message: "Couldn't upload this video." };
  }
  onProgress(100);

  if (!authorization.mediaUrl) {
    // The upload itself genuinely succeeded — but never fabricate a
    // usable video for a Reel nothing can actually deliver yet (no
    // public media domain configured server-side). See
    // uploadDisplayableMediaToR2's own doc comment in r2Provider.ts for
    // the same "never fabricate a URL" principle applied to every other
    // R2-backed media kind.
    return { ok: false, message: 'Uploaded to R2, but no public media domain is configured yet — this video is not displayable.' };
  }
  return { ok: true, sourceUrl: authorization.mediaUrl };
}
