/**
 * Pure, dependency-free media delivery URL construction — joins a
 * configured public base URL with an object's own path and a
 * cache-busting version token. Kept pure (no r2Config.ts import, no
 * network) for the same reason objectKey.ts/mediaUploadValidation.ts
 * are — direct unit-testability without R2 credentials or a live
 * Firebase-functions runtime — see
 * functions/scripts/test-media-url-logic.cjs.
 *
 * Media-kind-agnostic by design: originally written for profile photos
 * (Step 5B) and reused as-is for profile covers (Step 5C) — the whole
 * point of keeping this pure and generic is that a new media kind never
 * needs a second URL-construction/cache-busting implementation, only a
 * new caller passing its own path.
 *
 * Cache-busting design: the underlying R2 OBJECT KEY stays exactly
 * `profilePhotos/{uid}/photo` or `profileCovers/{uid}/photo` (unchanged
 * from Step 4/5A) — the SAME object is overwritten in place on every
 * re-upload, matching the existing Firebase behavior exactly
 * (storage.rules already allows `update` on both paths for this reason).
 * Only the DELIVERY URL's own query string changes per upload, via
 * `version` — since both Cloudflare's edge cache and `expo-image`'s own
 * memory/disk cache key on the full URL (query string included), a new
 * version value is what makes a replaced photo/cover actually show up
 * instead of a stale cached one, without needing a second R2 object,
 * without needing to delete anything, and without needing a Cloudflare
 * cache-purge API call.
 */

/** Rejects a path containing anything that could turn "join base + path" into something unintended — protocol injection (`http://`), absolute-URL smuggling, parent-directory traversal, or a leading slash that would collide with the base URL's own path. This function's only real callers (requestMediaUploadAuthorization.ts) always pass an already-safe, server-derived path from objectKey.ts's own profilePhotoKey/profileCoverKey — this check is defense-in-depth, not the primary guarantee. */
function isSafeMediaPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith('/') || path.includes('..') || path.includes('://')) return false;
  return /^[A-Za-z0-9_\-/]+$/.test(path);
}

/** Rejects anything that isn't a plausible `https://` base URL — never `http://` (mixed content / no real reason to serve media unencrypted) and never a bare hostname missing the scheme, which would silently produce a malformed URL. */
function isSafeBaseUrl(baseUrl: string): boolean {
  return typeof baseUrl === 'string' && /^https:\/\/[^\s/]+/.test(baseUrl);
}

/**
 * Builds the final, cache-busted, public delivery URL for a media object
 * at `path` — `<baseUrl>/<path>?v=<version>`. Returns `null` (never
 * throws, never fabricates a best-effort URL) for a malformed base URL
 * or path, so a caller can safely do `buildMediaUrl(...) ?? null` and
 * treat a bad input exactly like "delivery isn't configured" rather than
 * crashing a request over it.
 */
export function buildMediaUrl(baseUrl: string, path: string, version: number): string | null {
  if (!isSafeBaseUrl(baseUrl) || !isSafeMediaPath(path)) return null;
  if (!Number.isFinite(version) || version <= 0) return null;
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  return `${trimmedBase}/${path}?v=${version}`;
}
