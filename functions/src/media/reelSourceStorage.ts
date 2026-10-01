/**
 * Step 9A — provider-aware Reel-source storage operations (delete + read),
 * extracted from functions/src/index.ts into their own file specifically
 * so their actual branching logic (Firebase vs. R2) is directly
 * unit-testable with plain fakes, without needing a real Firebase Admin
 * Storage bucket, a real R2 client, or real network access.
 *
 * Both functions below take their real dependencies (a bucket-like
 * object, the R2 delete primitive, `fetch`, a file-write function) as
 * parameters with real defaults — production call sites
 * (functions/src/index.ts) pass nothing extra and get the exact same
 * behavior as before this file existed; a test passes a fake bucket, a
 * spy delete function, or a `fetchImpl` pointed at a local HTTP test
 * server instead.
 *
 * `BucketFileLike`/`BucketLike` are deliberately the SMALLEST possible
 * structural shape this code actually calls — `@google-cloud/storage`'s
 * real `Bucket`/`File` classes already satisfy them, so
 * `getStorage().bucket()` can be passed directly at every real call site
 * with no adapter/wrapper needed.
 */
import { reelSourceKey, storySourceKey } from './objectKey';
import { copyR2Object, deleteR2Object, downloadR2ObjectBuffer, headR2ObjectDetails, putR2Object } from './r2Storage';
import { buildReelVideoNormalizationMetadata, REEL_VIDEO_NORMALIZATION_METADATA_KEY } from './reelVideoProfile';

export type RawReelData = Record<string, unknown>;

export interface BucketFileLike {
  exists(): Promise<[boolean]>;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  download(options: { destination: string }): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the real
  // @google-cloud/storage File.copy() accepts (string | Bucket | File,
  // options?) with several overloads; typing the destination as `any` here
  // is what lets both the real File (whose own .copy signature is far
  // wider than this minimal structural interface) and a test fake satisfy
  // BucketFileLike at once. Only ever called here with another
  // BucketFileLike/File in practice.
  copy(destination: any): Promise<unknown>;
  save(data: Buffer, options?: { contentType?: string }): Promise<unknown>;
  /**
   * Step 11B — a METADATA-ONLY read (never downloads the object's body) —
   * the real `@google-cloud/storage` File.getMetadata() already returns
   * exactly this shape (confirmed against the installed package's own
   * FileMetadata type: `size` as a string, custom key/value pairs nested
   * under `metadata.metadata`), so no adapter is needed at the one real
   * production call site. Used by readReelCanonicalSourceState below to
   * check a Reel's own normalization marker without fetching its (up to
   * tens-of-megabytes) video bytes just to check a flag.
   */
  getMetadata(): Promise<[{ size?: string | number; metadata?: Record<string, unknown> }, unknown]>;
}

export interface BucketLike {
  file(path: string): BucketFileLike;
  /**
   * Uploads a LOCAL file to `options.destination` — the real
   * `@google-cloud/storage` Bucket.upload's own shape, used only by
   * uploadMuxedReelSourceToProvider's Firebase branch (an unchanged
   * carry-over of muxReelMusic's own pre-Step-9B behavior). Step 11B —
   * `metadata.metadata` is the real GCS "custom metadata" bag (confirmed
   * against the installed package's own FileMetadata type:
   * `metadata?: {[key:string]: string|boolean|number|null}`), used to
   * stamp the same normalization marker R2 gets via putR2Object's own
   * `metadata` parameter.
   */
  upload(localPath: string, options: { destination: string; metadata?: { contentType?: string; metadata?: Record<string, string> } }): Promise<unknown>;
}

/**
 * Step 9A — deletes a Reel's own source media, on whichever backend it
 * actually lives (see the Reel's own `storageProvider` field —
 * src/types/reel.ts's ReelStorageProvider). Never throws: a delete
 * failure on either backend is logged and treated as "not deleted" here,
 * matching this function's own existing pre-Step-9A behavior for
 * Firebase (`{ ignoreNotFound: true }`) — a media-cleanup hiccup must
 * never block the rest of a real, already-decided Reel deletion (likes/
 * comments/reposts/hashtag counts/the Firestore doc itself all still
 * proceed regardless).
 */
export async function deleteReelSourceMedia(
  bucket: BucketLike,
  storagePath: string,
  storageProvider: string | undefined,
  deleteObject: (key: string) => Promise<void> = deleteR2Object
): Promise<boolean> {
  if (storageProvider === 'r2') {
    try {
      await deleteObject(storagePath);
      return true;
    } catch (error) {
      console.warn(`[deleteReelSourceMedia] Could not delete R2 video source at "${storagePath}":`, error);
      return false;
    }
  }
  const file = bucket.file(storagePath);
  const [existedBefore] = await file.exists();
  await file.delete({ ignoreNotFound: true });
  return existedBefore;
}

export interface DownloadDeps {
  /** Defaults to the global `fetch` — overridden in tests to point at a local HTTP test server instead of a real R2 domain. */
  fetchImpl?: typeof fetch;
  /** Defaults to `node:fs/promises`' own `writeFile` — overridden in tests to capture what was "written" without touching a real temp file, or to point at a scratch directory. */
  writeFileImpl?: (path: string, data: Buffer) => Promise<void>;
}

/**
 * Step 9A — provider-aware Reel-SOURCE read, shared by resolveOwnSoundOrigin
 * and addReelToMyStory (functions/src/index.ts) — both operate on an
 * already-PUBLISHED plain video Reel (no music, no pending photo-render),
 * exactly the one variant Step 9A allows onto R2, so both need to read
 * that Reel's source bytes regardless of which backend actually holds
 * them.
 *
 * For 'r2', `reel.sourceUrl` is already a resolved, PUBLIC delivery URL
 * (see requestMediaUploadAuthorization.ts's own mediaUrl computation) —
 * an ordinary HTTPS GET, no R2 credential of any kind needed, which is
 * exactly why neither of those two callables needs an R2 secret bound.
 * Buffering the whole response in memory before writing it is safe
 * specifically because REEL_VIDEO_MAX_SIZE_BYTES already caps a Reel
 * source at 50 MB — both callables already run at 1GiB memory for their
 * own ffmpeg step, so a single 50 MB buffer is a rounding error next to
 * that.
 *
 * Returns `false` (never throws) for: no `sourceUrl` recorded, a
 * non-2xx HTTP response, or a missing Firebase object — the caller is
 * responsible for turning that into whatever HttpsError fits its own
 * context (both current callers do: "video isn't available").
 */
export async function downloadReelSourceToLocalFile(
  bucket: BucketLike,
  reel: RawReelData,
  destination: string,
  deps: DownloadDeps = {}
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (reel.storageProvider === 'r2') {
    const sourceUrl = reel.sourceUrl as string | undefined;
    if (!sourceUrl) return false;
    try {
      const response = await fetchImpl(sourceUrl);
      if (!response.ok) return false;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (deps.writeFileImpl) {
        await deps.writeFileImpl(destination, buffer);
      } else {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(destination, buffer);
      }
      return true;
    } catch {
      return false;
    }
  }
  const file = bucket.file(reel.storagePath as string);
  const [exists] = await file.exists();
  if (!exists) return false;
  await file.download({ destination });
  return true;
}

/**
 * Step 9A — provider-aware counterpart of downloadReelSourceToLocalFile,
 * for addReelToMyStory's FIREBASE-TARGET case (functions/src/index.ts):
 * copies a PUBLISHED Reel's own source into a brand-new Story object
 * ALWAYS written to Firebase Storage, regardless of the source Reel's
 * own provider — a Firebase-backed Reel takes the fast native `.copy()`
 * path (no bytes ever leave Google's own infrastructure), and an
 * R2-backed Reel's bytes are fetched over HTTPS and re-uploaded.
 *
 * Step 10A — Stories themselves became provider-aware too; this function
 * is now used ONLY when the Story's own target provider is 'firebase'
 * (Firebase mode, or R2 not configured) — see
 * copyReelSourceToR2StoryObject below for the R2-target counterpart.
 * Left completely UNCHANGED otherwise, on purpose: every one of its own
 * Step 9A tests keeps passing unmodified, and Firebase-mode Add-to-Story
 * behavior is byte-for-byte what it always was.
 *
 * Throws (never returns false) on failure — matching addReelToMyStory's
 * own existing try/catch-and-wrap-as-HttpsError('internal', ...) shape,
 * unlike the two `boolean`-returning functions above, which have their
 * own distinct "not available" callers.
 */
export async function copyReelSourceToFirebaseStoryObject(
  bucket: BucketLike,
  reel: RawReelData,
  destinationPath: string,
  deps: DownloadDeps = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (reel.storageProvider === 'r2') {
    const sourceUrl = reel.sourceUrl as string | undefined;
    if (!sourceUrl) throw new Error('Missing R2 source URL.');
    const response = await fetchImpl(sourceUrl);
    if (!response.ok) throw new Error(`R2 fetch failed with status ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await bucket.file(destinationPath).save(buffer, { contentType: reel.storageContentType as string });
    return;
  }
  await bucket.file(reel.storagePath as string).copy(bucket.file(destinationPath));
}

export interface R2StoryCopyDeps {
  /** Defaults to the real, authenticated copyR2Object — overridden in tests with a fake in-memory R2 store's own copy function. */
  copyObject?: (sourceKey: string, destinationKey: string) => Promise<void>;
  /** Defaults to the real, authenticated putR2Object. */
  putObject?: (key: string, data: Buffer, contentType: string) => Promise<void>;
  /** Defaults to `node:fs/promises`' own `readFile`. */
  readFileImpl?: (path: string) => Promise<Buffer>;
}

/**
 * Step 10A — the R2-TARGET counterpart of copyReelSourceToFirebaseStoryObject
 * above, for addReelToMyStory when the Story's own target provider is
 * 'r2' (R2 configured with a real public media base URL — see
 * addReelToMyStory's own doc comment in functions/src/index.ts for
 * exactly how that decision is made). Two genuinely different paths,
 * chosen by the SOURCE Reel's own provider:
 *
 *  - R2 Reel -> R2 Story: a single authenticated, BUCKET-INTERNAL
 *    CopyObjectCommand (copyR2Object, r2Storage.ts) — the bytes never
 *    leave R2, let alone pass through this Cloud Function's own memory.
 *    The SOURCE key is derived from the Reel document's own
 *    `authorUid`/`reelId` fields via reelSourceKey — safe to trust here
 *    specifically because this is a READ-only reference into an
 *    ALREADY-PUBLISHED, publicly-reachable Reel (not a delete/write
 *    target), exactly the same reasoning muxReelMusic's own
 *    downloadReelSourceForMux already established for a Reel's own
 *    uid/reelId-derived key.
 *  - Firebase Reel -> R2 Story: no bucket-internal equivalent exists
 *    across providers, so this downloads the Firebase object to
 *    `localTempPath` (the caller's own managed temp file — same
 *    mkdtemp/cleanup pattern as muxReelMusic/renderPhotoToVideo) and
 *    PUTs its bytes to the new Story's own deterministic R2 key.
 *
 * The DESTINATION key is always storySourceKey(uid, storyId) — `uid` the
 * CALLING user's own authenticated uid (the Story's real owner), never
 * anything read off the Reel document, and `storyId` a freshly generated
 * Firestore document id — never a client-supplied path of any kind.
 *
 * Throws (never returns false) on failure — same contract as
 * copyReelSourceToFirebaseStoryObject above.
 */
export async function copyReelSourceToR2StoryObject(
  bucket: BucketLike,
  reel: RawReelData,
  uid: string,
  storyId: string,
  localTempPath: string,
  deps: R2StoryCopyDeps = {}
): Promise<void> {
  const destinationKey = storySourceKey(uid, storyId);

  if (reel.storageProvider === 'r2') {
    const copyObject = deps.copyObject ?? copyR2Object;
    const sourceKey = reelSourceKey(reel.authorUid as string, reel.reelId as string);
    await copyObject(sourceKey, destinationKey);
    return;
  }

  await bucket.file(reel.storagePath as string).download({ destination: localTempPath });
  const readFileImpl =
    deps.readFileImpl ??
    (async (path: string) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(path);
    });
  const data = await readFileImpl(localTempPath);
  const putObject = deps.putObject ?? putR2Object;
  await putObject(destinationKey, data, reel.storageContentType as string);
}

export interface R2ObjectDeps {
  /** Defaults to the real, authenticated downloadR2ObjectBuffer — overridden in tests with a fake in-memory object store. */
  getObject?: (key: string) => Promise<Buffer>;
  /** Defaults to the real, authenticated putR2Object — overridden in tests the same way. Step 11B — `metadata`, when given, is attached as real object metadata (see putR2Object's own doc comment). */
  putObject?: (key: string, data: Buffer, contentType: string, cacheControl?: string, metadata?: Record<string, string>) => Promise<void>;
  /** Defaults to `node:fs/promises`' own `writeFile` — see DownloadDeps' own doc comment on why this is overridable. */
  writeFileImpl?: (path: string, data: Buffer) => Promise<void>;
  /** Defaults to `node:fs/promises`' own `readFile`. */
  readFileImpl?: (path: string) => Promise<Buffer>;
  /** Step 11B — defaults to the real, authenticated headR2ObjectDetails — overridden in tests. Used only by readReelCanonicalSourceState below. */
  headObject?: (key: string) => Promise<{ sizeBytes: number; metadata: Record<string, string> } | null>;
}

/**
 * Step 9B — provider-aware Reel-SOURCE read for muxReelMusic specifically
 * (reelMuxOrchestration.ts's own performReelMux), deliberately SEPARATE
 * from downloadReelSourceToLocalFile above rather than a third branch
 * bolted onto it: that function's R2 read goes through the object's own
 * PUBLIC delivery URL (fine for resolveOwnSoundOrigin/addReelToMyStory,
 * whose own correctness doesn't depend on bypassing whatever Cloudflare's
 * edge cache currently holds); mux is different — it needs the OBJECT'S
 * OWN, exactly-current bytes, so this uses an AUTHENTICATED R2 read
 * (downloadR2ObjectBuffer, GetObjectCommand) instead, and derives the R2
 * key itself via reelSourceKey(uid, reelId) — the same trusted,
 * server-computed derivation every other R2 primitive in this codebase
 * uses — rather than trusting the Reel document's own `storagePath`/
 * `sourceUrl` string fields as if they were themselves authorization.
 *
 * Returns `false` (never throws) exactly like downloadReelSourceToLocalFile
 * — the caller (performReelMux) turns that into a specific mux-failure
 * reason.
 */
export async function downloadReelSourceForMux(
  bucket: BucketLike,
  reel: RawReelData,
  uid: string,
  reelId: string,
  destination: string,
  deps: R2ObjectDeps = {}
): Promise<boolean> {
  if (reel.storageProvider === 'r2') {
    const getObject = deps.getObject ?? downloadR2ObjectBuffer;
    try {
      const buffer = await getObject(reelSourceKey(uid, reelId));
      if (deps.writeFileImpl) {
        await deps.writeFileImpl(destination, buffer);
      } else {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(destination, buffer);
      }
      return true;
    } catch {
      return false;
    }
  }
  const file = bucket.file(reel.storagePath as string);
  const [exists] = await file.exists();
  if (!exists) return false;
  await file.download({ destination });
  return true;
}

/**
 * Step 9B — provider-aware REPLACEMENT write for muxReelMusic: uploads
 * the freshly-muxed local video file back to the SAME deterministic
 * source object the original video occupied — `reels/{uid}/{reelId}/source`
 * either way, on whichever backend that Reel actually uses. Never creates
 * a new/different object; this is always an overwrite-in-place, matching
 * muxReelMusic's own pre-existing Firebase behavior exactly (unchanged by
 * this function for the Firebase branch).
 *
 * `cacheControl` is only ever meaningful for the R2 branch — see
 * putR2Object's own doc comment — and is ignored for Firebase (Firebase
 * Storage's own metadata/caching is unrelated to this step's scope).
 *
 * Step 11B — EVERY call site of this function (finalizeReelVideo/
 * muxReelMusic/renderPhotoToVideo) is, by construction, writing a real,
 * final, normalized asset at REEL_VIDEO_PROFILE — so this unconditionally
 * stamps buildReelVideoNormalizationMetadata()'s marker onto the object
 * on BOTH backends, in the exact same write that replaces its bytes. This
 * is what makes a LATER retry (after e.g. a Firestore confirm-write
 * failure) able to tell "already normalized" from "still raw" via a real
 * storage fact, never a guess — see readReelCanonicalSourceState below,
 * the read-side counterpart.
 */
export async function uploadMuxedReelSourceToProvider(
  bucket: BucketLike,
  reel: RawReelData,
  uid: string,
  reelId: string,
  localFilePath: string,
  contentType: string,
  cacheControl: string | undefined,
  deps: R2ObjectDeps = {}
): Promise<void> {
  const normalizationMetadata = buildReelVideoNormalizationMetadata();
  if (reel.storageProvider === 'r2') {
    const putObject = deps.putObject ?? putR2Object;
    const readFileImpl =
      deps.readFileImpl ??
      (async (path: string) => {
        const { readFile } = await import('node:fs/promises');
        return readFile(path);
      });
    const data = await readFileImpl(localFilePath);
    await putObject(reelSourceKey(uid, reelId), data, contentType, cacheControl, normalizationMetadata);
    return;
  }
  await bucket.upload(localFilePath, { destination: reel.storagePath as string, metadata: { contentType, metadata: normalizationMetadata } });
}

/**
 * Step 11B — the READ-side counterpart to uploadMuxedReelSourceToProvider's
 * normalization stamp: a METADATA-ONLY check (never downloads the
 * object's full video bytes) of whether a Reel's CURRENT canonical source
 * object already carries this codebase's own current-profile
 * normalization marker. Returns `null` when the object doesn't exist yet,
 * or on ANY read failure — deliberately fail-SAFE (see
 * isReelSourceAlreadyNormalized's own doc comment): the caller
 * (performReelVideoFinalization/performReelMux) treats `null` as "cannot
 * confirm — run the full finalization pipeline," never as "assume
 * already done."
 *
 * Provider-aware exactly like downloadReelSourceForMux above: an
 * AUTHENTICATED read either way (bucket.file().getMetadata() for
 * Firebase, headR2ObjectDetails/HeadObjectCommand for R2) — never the
 * object's own public delivery URL, and never trusts `reel.sourceUrl`/
 * `reel.sourceNormalized` as if either were itself proof of the object's
 * real current state (that's exactly the gap this step closes: Firestore
 * can say `sourceNormalized: false` while the OBJECT already holds the
 * final bytes, if a prior confirm-write failed after the upload already
 * succeeded).
 */
export async function readReelCanonicalSourceState(
  bucket: BucketLike,
  reel: RawReelData,
  uid: string,
  reelId: string,
  deps: R2ObjectDeps = {}
): Promise<{ sizeBytes: number; normalizationMarker: string | null } | null> {
  if (reel.storageProvider === 'r2') {
    const headObject = deps.headObject ?? headR2ObjectDetails;
    const result = await headObject(reelSourceKey(uid, reelId));
    if (!result) return null;
    return { sizeBytes: result.sizeBytes, normalizationMarker: result.metadata[REEL_VIDEO_NORMALIZATION_METADATA_KEY] ?? null };
  }
  try {
    const file = bucket.file(reel.storagePath as string);
    const [metadata] = await file.getMetadata();
    const sizeBytes = typeof metadata.size === 'string' ? Number.parseInt(metadata.size, 10) : (metadata.size ?? 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
    const rawMarker = metadata.metadata?.[REEL_VIDEO_NORMALIZATION_METADATA_KEY];
    return { sizeBytes, normalizationMarker: typeof rawMarker === 'string' ? rawMarker : null };
  } catch {
    // Object doesn't exist yet, or a transient metadata-read error — fail
    // safe: treat exactly like "not normalized," never like "already
    // done."
    return null;
  }
}
