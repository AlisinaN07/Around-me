/**
 * Profile Activities — Step 41.2G. NOT the retired legacy
 * content.type=='activity' object (Step 41.2B retired that from creation
 * entirely, and it stays retired). "Activities" here means exactly one
 * thing: the set of published Events a profile owner has marked
 * Interested or Going, derived entirely from the EXISTING
 * content/{eventId}/responses/{uid} documents (Step 9/38's response
 * model) — no new collection, no new Firestore document type.
 *
 * PUBLIC on Profiles, same as Reposts (Step 41.2F) — unlike Saved (Step
 * 41.2E), which stays private. `content/{eventId}/responses/{uid}` is
 * already readable by any signed-in user (see firestore.rules), and its
 * fields (uid, displayName, username, status, timestamps) are already a
 * public-safe snapshot, not private account data.
 *
 * WHY A CLOUD FUNCTION, NOT A DIRECT CLIENT QUERY: the natural client-side
 * implementation — `collectionGroup('responses').where('uid','==',
 * profileUid)` — is denied outright by this Firebase project for any
 * client SDK caller, regardless of Rules content. This is the exact same
 * platform-level restriction already investigated and documented in this
 * README under "Event card interaction state" (Step 26.1): a bare,
 * filterless collectionGroup() query against a *different* top-level
 * collection with a trivially permissive rule was ALSO denied there,
 * isolating the cause to the query type itself, not this feature's rule
 * content, not a missing index, and not propagation delay. Only the Admin
 * SDK's collectionGroup() queries work in this project (already relied on
 * by deleteMyAccountData's cross-user cleanup) — so this reuses that same
 * proven, trusted-backend path via the `fetchProfileActivities` callable
 * (functions/src/index.ts), which runs the identical query server-side and
 * returns exactly what a client with real Rules access would already be
 * entitled to read. No new privilege is granted — the callable enforces
 * nothing beyond "caller is signed in," the same floor firestore.rules
 * already sets for this data.
 */

import { httpsCallable } from 'firebase/functions';
import { Timestamp } from 'firebase/firestore';

import { functions } from './functions';
import type { EventContent, EventResponseStatus } from '@/types/content';

// A bounded v1 page, same order of magnitude as this codebase's other
// bounded profile-tab fetches (fetchSavedPosts/fetchProfileReposts both
// default to 40); kept in sync with functions/src/index.ts's own
// PROFILE_ACTIVITIES_LIMIT constant, which is the one actually enforced
// (this client-side value is documentation, not a real cap — the callable
// never returns more than its own bound regardless of what's requested
// here). See the README's "v1 bounded-history limitation" note: a profile
// with more than 50 live Event responses will not have every one resolved
// in this step — a P2 limitation, not solved here.
const DEFAULT_PROFILE_ACTIVITIES_LIMIT = 50;

export type ProfileActivity = {
  event: EventContent;
  responseStatus: EventResponseStatus;
};

// The callable serializes each Event's four Timestamp fields as epoch
// milliseconds (see functions/src/index.ts) rather than relying on
// unverified Timestamp auto-marshalling through the callable transport —
// this reconstructs real firebase/firestore Timestamp instances so the
// resolved event is a genuine EventContent, usable everywhere one is
// (EventCard, formatEventTime, etc.) without special-casing.
type RawProfileActivity = {
  event: Omit<EventContent, 'startsAt' | 'endsAt' | 'createdAt' | 'updatedAt'> & {
    startsAt: number;
    endsAt: number;
    createdAt: number;
    updatedAt: number;
  };
  responseStatus: EventResponseStatus;
};

function isPastEvent(event: EventContent, now: Date): boolean {
  return event.endsAt.toMillis() < now.getTime();
}

// Sorting is locked to EVENT time, never response createdAt/updatedAt (see
// this step's spec, Section 9-10): ongoing/upcoming Events first (soonest
// startsAt first), then past Events (most-recently-started first).
function compareProfileActivities(a: ProfileActivity, b: ProfileActivity, now: Date): number {
  const aPast = isPastEvent(a.event, now);
  const bPast = isPastEvent(b.event, now);
  if (aPast !== bPast) return aPast ? 1 : -1;
  return aPast ? b.event.startsAt.toMillis() - a.event.startsAt.toMillis() : a.event.startsAt.toMillis() - b.event.startsAt.toMillis();
}

/**
 * A bounded page of one profile's Activities (Events they've responded
 * Interested/Going to), resolved against each Event's real current
 * document and sorted by Event time. The callable already skips
 * gracefully: a missing parent Event, a non-'event'/unpublished parent,
 * and — defensively — an Event the profile owner themselves authored (a
 * Business account should never see its own authored Event doubled into
 * its own Activities tab; see this step's Section 29). Callable for ANY
 * uid (own or someone else's), since Activities is public exactly like
 * Reposts.
 */
export async function fetchProfileActivities(profileUid: string, limitCount = DEFAULT_PROFILE_ACTIVITIES_LIMIT): Promise<ProfileActivity[]> {
  if (!functions) return [];

  void limitCount; // enforced server-side; kept as a documented parameter, not forwarded as a request override.

  let raw: RawProfileActivity[];
  try {
    const call = httpsCallable<{ profileUid: string }, { activities: RawProfileActivity[] }>(functions, 'fetchProfileActivities');
    const result = await call({ profileUid });
    raw = result.data.activities;
  } catch {
    return [];
  }

  const resolved: ProfileActivity[] = raw.map(({ event, responseStatus }) => ({
    event: {
      ...event,
      startsAt: Timestamp.fromMillis(event.startsAt),
      endsAt: Timestamp.fromMillis(event.endsAt),
      createdAt: Timestamp.fromMillis(event.createdAt),
      updatedAt: Timestamp.fromMillis(event.updatedAt),
    },
    responseStatus,
  }));

  const now = new Date();
  return resolved.sort((a, b) => compareProfileActivities(a, b, now));
}
