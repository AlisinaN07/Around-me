/**
 * Recommendation Engine — Step 5 — the client's ONLY point of contact
 * with collaborative filtering: a read of the caller's own already-
 * computed `users/{uid}/recommendationProfile/collaborative` doc, plus a
 * short-lived cache (same shape as profileCache.ts). No similarity
 * computation, no other-user data, ever touches this file or anything it
 * calls — see functions/src/collaborative.ts for where that actually
 * happens.
 */
import { doc, getDoc } from 'firebase/firestore';

import type { CollaborativeProfile } from '@/types/collaborative';
import { EMPTY_COLLABORATIVE_PROFILE } from '@/types/collaborative';

import { firestore } from '../firestore';
import { COLLABORATIVE_PROFILE_CACHE_LIFETIME_MS } from './collaborativeConfig';
import { isCacheFresh } from './reliability';

function collaborativeProfileRef(uid: string) {
  return doc(firestore!, 'users', uid, 'recommendationProfile', 'collaborative');
}

/** Tolerant of a missing/partial doc, same normalize* convention as this codebase's other read paths — never throws. */
function normalizeCollaborativeProfile(data: unknown): CollaborativeProfile {
  if (!data || typeof data !== 'object') return EMPTY_COLLABORATIVE_PROFILE;
  const raw = data as Partial<CollaborativeProfile>;
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  const categoryScores: Record<string, number> = {};
  if (raw.categoryScores && typeof raw.categoryScores === 'object') {
    for (const [category, score] of Object.entries(raw.categoryScores)) {
      if (typeof score === 'number' && Number.isFinite(score)) categoryScores[category] = score;
    }
  }
  return {
    categoryScores,
    neighborCount: num(raw.neighborCount, 0),
    averageSimilarity: num(raw.averageSimilarity, 0),
    confidence: num(raw.confidence, 0),
    sourceInteractionCount: num(raw.sourceInteractionCount, 0),
    generatedAt: num(raw.generatedAt, 0),
    schemaVersion: num(raw.schemaVersion, 1),
  };
}

/**
 * Step 18 — a missing doc (never computed yet, or this account is
 * ineligible — see the backend's own minimum-data gate) must never affect
 * the existing engine: returns EMPTY_COLLABORATIVE_PROFILE (confidence 0)
 * rather than null, so every caller can use the SAME "confidence 0 means
 * no effect" code path regardless of WHY there's no real signal. Never
 * throws — a read failure degrades exactly like a missing doc.
 */
async function fetchCollaborativeProfile(uid: string): Promise<CollaborativeProfile> {
  if (!firestore) return EMPTY_COLLABORATIVE_PROFILE;
  try {
    const snapshot = await getDoc(collaborativeProfileRef(uid));
    if (!snapshot.exists()) return EMPTY_COLLABORATIVE_PROFILE;
    return normalizeCollaborativeProfile(snapshot.data());
  } catch {
    return EMPTY_COLLABORATIVE_PROFILE;
  }
}

type CacheEntry = { profile: CollaborativeProfile; fetchedAtMs: number };
const cache = new Map<string, CacheEntry>();

/** Same short-lived-cache shape as profileCache.ts's getCachedInterestProfile — one read per feed session in the common case, not one per page. */
export async function getCachedCollaborativeProfile(uid: string): Promise<CollaborativeProfile> {
  const cached = cache.get(uid);
  if (cached && isCacheFresh(cached.fetchedAtMs, Date.now(), COLLABORATIVE_PROFILE_CACHE_LIFETIME_MS)) {
    return cached.profile;
  }
  const profile = await fetchCollaborativeProfile(uid);
  cache.set(uid, { profile, fetchedAtMs: Date.now() });
  return profile;
}
