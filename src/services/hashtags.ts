/**
 * hashtags/{hashtagId} — the global hashtag collection (see
 * src/types/hashtag.ts). UI code should only ever import from here, never
 * talk to Firestore directly for hashtag data. Pure text extraction/
 * normalization lives in src/utils/hashtags.ts and is re-exported below
 * so callers that already import from this service layer don't also need
 * a second import for the two together.
 *
 * SCOPE (this step): the technical foundation only — extraction, the
 * collection itself, safe concurrent counting, and read/search
 * primitives. Deliberately NOT included yet (later steps): For You
 * ranking by hashtag, trending, recommendations, or a real hashtag
 * discovery page — see HashtagScreen's own doc comment.
 */
import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type WithFieldValue,
} from 'firebase/firestore';

import type { Hashtag } from '@/types/hashtag';
import { TtlCache } from '@/utils/requestCache';

import { firestore } from './firestore';

export { extractHashtags, normalizeHashtag, getActiveHashtag, replaceActiveHashtag, HASHTAG_MAX_LENGTH } from '@/utils/hashtags';
export type { ActiveHashtag } from '@/utils/hashtags';

const HASHTAGS_COLLECTION = 'hashtags';
const DEFAULT_SEARCH_LIMIT = 20;

// Ranked hashtag search (Step 3 composer autocomplete, Step 4 main
// Search) — one shared TtlCache, same building block publicProfile.ts's
// own profileCache/following.ts's followCache already use, same 60s TTL
// as PUBLIC_PROFILE_CACHE_TTL_MS. Both a composer session and a Search
// visit are almost always well under a minute, so a natural-expiry cache
// already gets "never re-query an identical prefix twice in the same
// session" for free, with no session-lifecycle plumbing needed. Keyed by
// `${limitCount}:${prefix}`, not just `prefix` — the two callers request
// different bounded pool sizes (the composer wants a small pool, Search a
// larger one), and keying on the prefix alone would let whichever caller
// queried first silently cap the other's results at its own smaller
// limit.
const RANKED_SEARCH_CACHE_TTL_MS = 60_000;
const rankedSearchCache = new TtlCache<Hashtag[]>(RANKED_SEARCH_CACHE_TTL_MS);

/** Exported so other services (none yet — Reels' own increment call lives right here) never need to hardcode this path themselves. */
export function hashtagRef(name: string) {
  return doc(firestore!, HASHTAGS_COLLECTION, name);
}

export async function getHashtag(name: string): Promise<Hashtag | null> {
  if (!firestore) return null;
  const snapshot = await getDoc(hashtagRef(name));
  return snapshot.exists() ? (snapshot.data() as Hashtag) : null;
}

/**
 * Prefix search over hashtag names — Step: search preparation (a later
 * step adds the actual "#foo" -> "#football"/"#food"/"#foodie" autocomplete
 * UI on top of this). `hashtagId` IS `name` (see Hashtag's own doc
 * comment), so this ranges over the collection's own document IDs rather
 * than a separate indexed field — the same "prefix range on the canonical
 * key itself" shape src/services/publicProfile.ts's
 * searchPublicProfilesByUsername already uses for usernameLower, and it
 * needs no composite index for the same reason: a single-field (here,
 * document-ID) range query is automatically indexed by Firestore.
 * `normalizedPrefix` must already be normalizeHashtag-clean lowercase —
 * this function does not re-normalize, mirroring
 * searchPublicProfilesByUsername's own contract.
 */
export async function searchHashtags(normalizedPrefix: string, limitCount = DEFAULT_SEARCH_LIMIT): Promise<Hashtag[]> {
  if (!firestore) return [];
  if (!normalizedPrefix) return [];

  // A code point above every real hashtag character (the standard
  // Firestore prefix-range trick — built via String.fromCharCode rather
  // than a literal escape, to keep this exact byte unambiguous in
  // source), same pattern searchPublicProfilesByUsername's own upper
  // bound uses for usernameLower. Applied to documentId() here instead of
  // a separate field, since hashtagId already IS the canonical lowercase
  // name (see Hashtag's own doc comment) — no denormalized search field
  // needed.
  const upperBound = normalizedPrefix + String.fromCharCode(0xf8ff);
  const snapshot = await getDocs(
    query(
      collection(firestore, HASHTAGS_COLLECTION),
      orderBy(documentId()),
      where(documentId(), '>=', normalizedPrefix),
      where(documentId(), '<', upperBound),
      limit(limitCount)
    )
  );
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as Hashtag);
}

/**
 * Ranked, cached hashtag prefix search — the ONE shared layer both the
 * composer's "# Hashtag" autocomplete (Step 3, create/reel/index.tsx) and
 * main Search's Hashtags section (Step 4, search.tsx) call, built
 * directly on top of searchHashtags above (the exact same bounded
 * documentId() prefix range query Step 1 already put in place) rather
 * than either caller running its own query:
 *
 *     searchHashtags(prefix, limit)   <- Step 1's raw Firestore query
 *              ↓
 *     searchHashtagsRanked(prefix, limit)   <- this function
 *          ↓                    ↓
 *     composer autocomplete   main Search
 *
 * Adds exactly two things a raw prefix search doesn't have on its own:
 *
 *  1. Local ranking by `postCount` (descending, alphabetical as a
 *     deterministic tie-break) — Firestore's own prefix query naturally
 *     returns alphabetical order, but a more-used hashtag is a much more
 *     useful suggestion than an obscure one with the same prefix. This is
 *     the ONLY ranking signal used — no personalization, no location, no
 *     interest data (explicitly out of scope for both callers).
 *  2. An in-memory TtlCache (keyed by limit+prefix — see its own doc
 *     comment above) so retyping/backspacing to a prefix already searched
 *     this session, or the composer and Search racing on the same
 *     prefix, never re-hits Firestore twice — `dedupe()` also collapses
 *     two truly concurrent callers for the same still-in-flight
 *     limit+prefix into one request.
 *
 * Returns `[]` immediately for an empty prefix WITHOUT touching Firestore
 * at all — a bare "#" has no useful query to run yet in either caller
 * (see this feature's own spec: "do not perform unnecessary Firestore
 * queries for an empty prefix"); both callers simply show no hashtag
 * results in that case rather than needing a separate "popular hashtags"
 * fetch path.
 *
 * `prefix` must already be normalizeHashtag-clean lowercase, same
 * contract as searchHashtags itself.
 */
export async function searchHashtagsRanked(prefix: string, limitCount = DEFAULT_SEARCH_LIMIT): Promise<Hashtag[]> {
  if (!prefix) return [];

  const cacheKey = `${limitCount}:${prefix}`;
  const cached = rankedSearchCache.getFresh(cacheKey);
  if (cached) return cached;

  const results = await rankedSearchCache.dedupe(cacheKey, () => searchHashtags(prefix, limitCount));
  const ranked = [...results].sort((a, b) => b.postCount - a.postCount || a.name.localeCompare(b.name));
  rankedSearchCache.set(cacheKey, ranked);
  return ranked;
}

/**
 * Increments `postCount` for every hashtag in `hashtags` by exactly 1 —
 * called once a Reel carrying them actually PUBLISHES (see
 * src/services/reels.ts's publishReel), never at draft-creation time,
 * since only a published Reel is a real, visible post to count. Each
 * hashtag's own read-then-write happens inside ONE Firestore transaction
 * per call (same "read current value, compute the new one, write it
 * back" shape src/services/engagement.ts's joinActivity already uses for
 * its own participantCount, rather than a bare increment() sentinel) —
 * safe under concurrent publishes of the SAME hashtag, since Firestore
 * automatically retries a transaction whose read was invalidated by
 * another write landing first.
 *
 * Deliberately its own transaction, separate from the Reel's own
 * publish write (a plain updateDoc — see publishReel) rather than one
 * transaction spanning both: this keeps the existing publish path
 * unchanged and this feature purely additive. A hashtag count that fails
 * to update after a successful publish is a rare, self-healing-adjacent
 * inconsistency (the Reel itself is still correctly published) rather
 * than data corruption — callers treat this as best-effort (see
 * publishReel's own try/catch around this call).
 *
 * Firestore Rules independently enforce that a client can only ever
 * create a hashtag doc with `postCount == 1` or update one with exactly
 * `+1` from its current value — see firestore.rules'
 * `match /hashtags/{hashtagId}`. Decrementing (post deletion) is NEVER
 * done from the client at all — only the trusted Cloud Functions delete
 * backend (Admin SDK, bypassing these Rules) does that; see
 * functions/src/index.ts's decrementHashtagCounts.
 */
export async function incrementHashtagCounts(hashtags: string[]): Promise<void> {
  if (!firestore || hashtags.length === 0) return;
  const db = firestore;

  for (const name of hashtags) {
    await runTransaction(db, async (tx) => {
      const ref = hashtagRef(name);
      const snap = await tx.get(ref);
      if (snap.exists()) {
        const current = (snap.data() as Hashtag).postCount;
        tx.update(ref, { postCount: current + 1, updatedAt: serverTimestamp() });
      } else {
        tx.set(ref, {
          name,
          postCount: 1,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        } satisfies WithFieldValue<Hashtag>);
      }
    });
  }
}
