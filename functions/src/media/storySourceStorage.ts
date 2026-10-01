/**
 * Step 11C — provider-aware Story-source storage operations for
 * finalizeStoryVideo specifically (download for finalization, replace
 * with the normalized output, read canonical state for idempotency) —
 * mirrors reelSourceStorage.ts's own downloadReelSourceForMux/
 * uploadMuxedReelSourceToProvider/readReelCanonicalSourceState field-for-
 * field, but deliberately its OWN, separate file rather than a shared
 * import: Story and Reel are two genuinely separate media families (own
 * collection, own object-key convention, own RawStoryData/RawReelData
 * shape — see storyEligibility.ts's own doc comment for this exact same
 * "no cross-file coupling" reasoning already established for the
 * eligibility layer) that happen to need the structurally IDENTICAL
 * provider-aware read/write/metadata-check operations. The one thing
 * genuinely shared between them — the ffmpeg encode profile and the
 * normalization-marker build/check logic — already lives in its own
 * module (videoNormalizationProfile.ts) and is imported here, not
 * reimplemented.
 *
 * `BucketFileLike`/`BucketLike` are redeclared here (not imported from
 * reelSourceStorage.ts) for the same reason RawStoryData/RawReelData stay
 * separate — both shapes are the real `@google-cloud/storage`
 * Bucket/File's own minimal structural subset, so there is nothing to
 * actually share beyond the TYPE SHAPE, which costs nothing to redeclare
 * and avoids Story importing from a Reel-named file.
 */
import { storySourceKey } from './objectKey';
import { downloadR2ObjectBuffer, headR2ObjectDetails, putR2Object } from './r2Storage';
import { buildVideoNormalizationMetadata, VIDEO_NORMALIZATION_METADATA_KEY } from './videoNormalizationProfile';

export type RawStoryData = Record<string, unknown>;

export interface StoryBucketFileLike {
  exists(): Promise<[boolean]>;
  download(options: { destination: string }): Promise<unknown>;
  getMetadata(): Promise<[{ size?: string | number; metadata?: Record<string, unknown> }, unknown]>;
}

export interface StoryBucketLike {
  file(path: string): StoryBucketFileLike;
  upload(localPath: string, options: { destination: string; metadata?: { contentType?: string; metadata?: Record<string, string> } }): Promise<unknown>;
}

export interface StoryR2ObjectDeps {
  /** Defaults to the real, authenticated downloadR2ObjectBuffer. */
  getObject?: (key: string) => Promise<Buffer>;
  /** Defaults to the real, authenticated putR2Object — `metadata`, when given, is attached as real object metadata (see putR2Object's own doc comment). */
  putObject?: (key: string, data: Buffer, contentType: string, cacheControl?: string, metadata?: Record<string, string>) => Promise<void>;
  /** Defaults to `node:fs/promises`' own `writeFile`. */
  writeFileImpl?: (path: string, data: Buffer) => Promise<void>;
  /** Defaults to `node:fs/promises`' own `readFile`. */
  readFileImpl?: (path: string) => Promise<Buffer>;
  /** Defaults to the real, authenticated headR2ObjectDetails. */
  headObject?: (key: string) => Promise<{ sizeBytes: number; metadata: Record<string, string> } | null>;
}

/**
 * Step 11C — provider-aware Story-source read for finalizeStoryVideo,
 * mirrors reelSourceStorage.ts's downloadReelSourceForMux exactly:
 * authenticated R2 read (GetObjectCommand via downloadR2ObjectBuffer,
 * key derived from storySourceKey(uid, storyId) — never trusted from the
 * Story document's own `storagePath`/`mediaUrl` string fields) or a
 * direct Firebase bucket read. Returns `false` (never throws) when
 * unavailable — the caller maps that to its own failure reason.
 */
export async function downloadStorySourceForFinalization(
  bucket: StoryBucketLike,
  story: RawStoryData,
  uid: string,
  storyId: string,
  destination: string,
  deps: StoryR2ObjectDeps = {}
): Promise<boolean> {
  if (story.storageProvider === 'r2') {
    const getObject = deps.getObject ?? downloadR2ObjectBuffer;
    try {
      const buffer = await getObject(storySourceKey(uid, storyId));
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
  const file = bucket.file(story.storagePath as string);
  const [exists] = await file.exists();
  if (!exists) return false;
  await file.download({ destination });
  return true;
}

/**
 * Step 11C — provider-aware REPLACEMENT write for finalizeStoryVideo:
 * overwrites the Story's own deterministic canonical source object in
 * place (`stories/{uid}/{storyId}/source`, same object the raw upload
 * occupied), on whichever backend that Story actually uses — mirrors
 * reelSourceStorage.ts's uploadMuxedReelSourceToProvider exactly,
 * including unconditionally stamping buildVideoNormalizationMetadata()'s
 * marker on BOTH backends, in the same write that replaces the bytes —
 * see videoNormalizationProfile.ts's own doc comment for why this is the
 * idempotency fix's own write side.
 */
export async function uploadNormalizedStorySourceToProvider(
  bucket: StoryBucketLike,
  story: RawStoryData,
  uid: string,
  storyId: string,
  localFilePath: string,
  contentType: string,
  cacheControl: string | undefined,
  deps: StoryR2ObjectDeps = {}
): Promise<void> {
  const normalizationMetadata = buildVideoNormalizationMetadata();
  if (story.storageProvider === 'r2') {
    const putObject = deps.putObject ?? putR2Object;
    const readFileImpl =
      deps.readFileImpl ??
      (async (path: string) => {
        const { readFile } = await import('node:fs/promises');
        return readFile(path);
      });
    const data = await readFileImpl(localFilePath);
    await putObject(storySourceKey(uid, storyId), data, contentType, cacheControl, normalizationMetadata);
    return;
  }
  await bucket.upload(localFilePath, { destination: story.storagePath as string, metadata: { contentType, metadata: normalizationMetadata } });
}

/**
 * Step 11C — the READ-side counterpart: a METADATA-ONLY check (never
 * downloads the object's full video bytes) of whether a Story's CURRENT
 * canonical source object already carries the current-profile
 * normalization marker — mirrors reelSourceStorage.ts's
 * readReelCanonicalSourceState exactly. Returns `null` (fail-SAFE) for a
 * missing object or any read failure.
 */
export async function readStoryCanonicalSourceState(
  bucket: StoryBucketLike,
  story: RawStoryData,
  uid: string,
  storyId: string,
  deps: StoryR2ObjectDeps = {}
): Promise<{ sizeBytes: number; normalizationMarker: string | null } | null> {
  if (story.storageProvider === 'r2') {
    const headObject = deps.headObject ?? headR2ObjectDetails;
    const result = await headObject(storySourceKey(uid, storyId));
    if (!result) return null;
    return { sizeBytes: result.sizeBytes, normalizationMarker: result.metadata[VIDEO_NORMALIZATION_METADATA_KEY] ?? null };
  }
  try {
    const file = bucket.file(story.storagePath as string);
    const [metadata] = await file.getMetadata();
    const sizeBytes = typeof metadata.size === 'string' ? Number.parseInt(metadata.size, 10) : (metadata.size ?? 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
    const rawMarker = metadata.metadata?.[VIDEO_NORMALIZATION_METADATA_KEY];
    return { sizeBytes, normalizationMarker: typeof rawMarker === 'string' ? rawMarker : null };
  } catch {
    return null;
  }
}

/**
 * Step 11C — the ONE line of logic behind addReelToMyStory's own trust
 * decision (functions/src/index.ts), pulled out into its own pure,
 * directly-testable function rather than left as an inline expression in
 * that onCall body: a Story copied from an already-published Reel never
 * needs its own ffmpeg pass — that Reel could only reach `published` with
 * its OWN `sourceNormalized` already `true` for a video (see
 * firestore.rules' own isValidReelPublish), so copying that already-
 * trusted Firestore field forward is correct WITHOUT re-touching storage
 * metadata or depending on whether the underlying R2 CopyObjectCommand
 * happens to preserve custom object metadata (audited, not assumed — see
 * addReelToMyStory's own doc comment for the full reasoning).
 *
 * `=== true` rather than a bare truthy check is the one thing that
 * actually matters here: a legacy Reel predating this field reads as
 * `undefined`, which must be treated as "not normalized," never silently
 * coerced to `true`. A photo Reel's own `sourceNormalized` is always
 * `false` (it's never flipped — see Reel.sourceNormalized's own doc
 * comment, src/types/reel.ts), which is exactly correct for a copied
 * photo Story too, since isValidStoryPublish exempts photo Stories from
 * the normalization gate entirely regardless of this value.
 */
export function deriveCopiedStorySourceNormalized(reel: Record<string, unknown>): boolean {
  return reel.sourceNormalized === true;
}
