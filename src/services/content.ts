/**
 * City content data layer — the unified content/{contentId} collection
 * (posts, activities, events). UI code should only ever import from here,
 * never talk to Firestore directly for content.
 */

import {
  Timestamp,
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  type WithFieldValue,
} from 'firebase/firestore';

import { INTERESTS } from '@/constants/interests';
import type { ActivityContent, Content, EventContent, PostContent } from '@/types/content';
import {
  BODY_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  MAX_PARTICIPANTS_LIMIT,
  PLACE_NAME_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from '@/types/content';
import { getTodayOrTonightWindow, getUpcomingWindow } from '@/utils/dateWindows';

import { fetchFollowingUids } from './following';
import { firestore } from './firestore';
import { fetchUserProfile } from './userProfile';

const CONTENT_COLLECTION = 'content';
const DEFAULT_FEED_LIMIT = 20;
const VALID_CATEGORY_IDS = new Set(INTERESTS.map((interest) => interest.id));

// MVP cap on how many followed creators a single Following feed page
// considers (see fetchFollowingFeed below) — matches the limit already
// used by fetchFollowingUids/fetchFollowing in following.ts, so a page
// covers everyone in the caller's Following list before pagination is
// needed. If usage shows people following more than this, the fix is
// cursor-paginating fetchFollowingUids itself, not raising this number.
const MAX_FOLLOWED_UIDS_PER_FEED_PAGE = 30;

// Firestore's JS SDK allows up to 30 values in a single `in` query, but we
// deliberately chunk much smaller (10) for headroom and predictability —
// see fetchFollowingFeed.
const FOLLOWING_UID_CHUNK_SIZE = 10;
const DEFAULT_FOLLOWING_FEED_LIMIT = 20;

export type CreateContentError = 'not-configured' | 'no-profile' | 'invalid-input' | 'unknown';

export type CreateContentResult<T> = { ok: true; content: T } | { ok: false; error: CreateContentError; message: string };

function isValidCategoryId(categoryId: string): boolean {
  return VALID_CATEGORY_IDS.has(categoryId);
}

/**
 * Shared placeId validation for all three create functions. If a known
 * Place was selected (placeId set), a matching placeName must also be
 * present — Firestore rules independently re-verify that this placeId
 * exists, is active, is in the same city, and that placeName matches the
 * place's real name (see firestore.rules); this client-side check only
 * catches the "picked a place but somehow cleared the name" edge case
 * before hitting the network.
 */
function resolvePlaceId(
  placeId: string | null | undefined,
  placeName: string | undefined
): { ok: true; placeId: string | null } | { ok: false; error: CreateContentError; message: string } {
  const trimmed = placeId?.trim();
  if (!trimmed) {
    return { ok: true, placeId: null };
  }
  if (!placeName) {
    return { ok: false, error: 'invalid-input', message: 'A selected place needs a place name.' };
  }
  return { ok: true, placeId: trimmed };
}

type TrustedAuthorFields = {
  authorUid: string;
  authorDisplayName: string;
  authorUsername: string;
  cityName: string;
  countryCode: string;
  cityKey: string;
};

type TrustedAuthorResult =
  | { ok: true; fields: TrustedAuthorFields }
  | { ok: false; error: CreateContentError; message: string };

/**
 * City/author identity always comes from the caller's own completed
 * profile — never from arbitrary UI input — so a modified client can't
 * pretend to post as another user or another city. Firestore rules
 * re-verify this same snapshot server-side on write (defense in depth).
 */
async function resolveTrustedAuthorFields(uid: string): Promise<TrustedAuthorResult> {
  const profile = await fetchUserProfile(uid);
  if (!profile || !profile.onboardingCompleted) {
    return { ok: false, error: 'no-profile', message: 'Complete your profile before posting.' };
  }
  return {
    ok: true,
    fields: {
      authorUid: profile.uid,
      authorDisplayName: profile.displayName,
      authorUsername: profile.username,
      cityName: profile.cityName,
      countryCode: profile.countryCode,
      cityKey: profile.cityKey,
    },
  };
}

export async function fetchContentById(contentId: string): Promise<Content | null> {
  if (!firestore) {
    return null;
  }
  const snapshot = await getDoc(doc(firestore, CONTENT_COLLECTION, contentId));
  return snapshot.exists() ? (snapshot.data() as Content) : null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreatePostInput = {
  uid: string;
  body: string;
  categoryId: string;
  placeName?: string;
  /** A known places/{placeId}, or omitted/null for a manual place name (or no place at all). */
  placeId?: string | null;
};

export async function createPost(input: CreatePostInput): Promise<CreateContentResult<PostContent>> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }

  const trusted = await resolveTrustedAuthorFields(input.uid);
  if (!trusted.ok) {
    return trusted;
  }

  const body = input.body.trim();
  if (!body || body.length > BODY_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: `Post must be 1–${BODY_MAX_LENGTH} characters.` };
  }
  if (!isValidCategoryId(input.categoryId)) {
    return { ok: false, error: 'invalid-input', message: 'Choose a valid category.' };
  }
  const placeName = input.placeName?.trim();
  if (placeName && placeName.length > PLACE_NAME_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: 'Place name is too long.' };
  }
  const placeLink = resolvePlaceId(input.placeId, placeName);
  if (!placeLink.ok) {
    return placeLink;
  }

  const contentRef = doc(collection(firestore, CONTENT_COLLECTION));
  const data = {
    contentId: contentRef.id,
    type: 'post',
    ...trusted.fields,
    categoryId: input.categoryId,
    status: 'published',
    visibility: 'city',
    body,
    placeId: placeLink.placeId,
    ...(placeName ? { placeName } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies WithFieldValue<PostContent>;

  try {
    await setDoc(contentRef, data);
  } catch {
    return { ok: false, error: 'unknown', message: 'Something went wrong creating your post.' };
  }

  const created = await fetchContentById(contentRef.id);
  if (!created || created.type !== 'post') {
    return { ok: false, error: 'unknown', message: 'Post was created but could not be read back.' };
  }
  return { ok: true, content: created };
}

type EventLikeInput = {
  title: string;
  description: string;
  categoryId: string;
  startsAt: Date;
  endsAt: Date;
  placeName: string;
};

type EventLikeValidationResult =
  | { ok: true; title: string; description: string; placeName: string }
  | { ok: false; error: CreateContentError; message: string };

function validateEventLikeFields(input: EventLikeInput): EventLikeValidationResult {
  const title = input.title.trim();
  const description = input.description.trim();
  const placeName = input.placeName.trim();

  if (!title || title.length > TITLE_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: `Title must be 1–${TITLE_MAX_LENGTH} characters.` };
  }
  if (!description || description.length > DESCRIPTION_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: `Description must be 1–${DESCRIPTION_MAX_LENGTH} characters.` };
  }
  if (!placeName || placeName.length > PLACE_NAME_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: 'Enter a valid place name.' };
  }
  if (!isValidCategoryId(input.categoryId)) {
    return { ok: false, error: 'invalid-input', message: 'Choose a valid category.' };
  }
  if (Number.isNaN(input.startsAt.getTime()) || Number.isNaN(input.endsAt.getTime())) {
    return { ok: false, error: 'invalid-input', message: 'Enter valid start and end times.' };
  }
  if (input.startsAt.getTime() >= input.endsAt.getTime()) {
    return { ok: false, error: 'invalid-input', message: 'Start time must be before end time.' };
  }
  return { ok: true, title, description, placeName };
}

export type CreateActivityInput = {
  uid: string;
  title: string;
  description: string;
  categoryId: string;
  startsAt: Date;
  endsAt: Date;
  placeName: string;
  /** A known places/{placeId}, or omitted/null for a manually-typed place name. */
  placeId?: string | null;
  maxParticipants?: number;
};

export async function createActivity(input: CreateActivityInput): Promise<CreateContentResult<ActivityContent>> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }

  const trusted = await resolveTrustedAuthorFields(input.uid);
  if (!trusted.ok) {
    return trusted;
  }

  const validated = validateEventLikeFields(input);
  if (!validated.ok) {
    return validated;
  }
  const placeLink = resolvePlaceId(input.placeId, validated.placeName);
  if (!placeLink.ok) {
    return placeLink;
  }

  if (input.maxParticipants !== undefined) {
    if (!Number.isInteger(input.maxParticipants) || input.maxParticipants <= 0 || input.maxParticipants > MAX_PARTICIPANTS_LIMIT) {
      return {
        ok: false,
        error: 'invalid-input',
        message: `Max participants must be between 1 and ${MAX_PARTICIPANTS_LIMIT}.`,
      };
    }
  }

  const contentRef = doc(collection(firestore, CONTENT_COLLECTION));
  const data = {
    contentId: contentRef.id,
    type: 'activity',
    ...trusted.fields,
    categoryId: input.categoryId,
    status: 'published',
    visibility: 'city',
    title: validated.title,
    description: validated.description,
    placeName: validated.placeName,
    placeId: placeLink.placeId,
    startsAt: Timestamp.fromDate(input.startsAt),
    endsAt: Timestamp.fromDate(input.endsAt),
    ...(input.maxParticipants !== undefined ? { maxParticipants: input.maxParticipants } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies WithFieldValue<ActivityContent>;

  try {
    await setDoc(contentRef, data);
  } catch {
    return { ok: false, error: 'unknown', message: 'Something went wrong creating your activity.' };
  }

  const created = await fetchContentById(contentRef.id);
  if (!created || created.type !== 'activity') {
    return { ok: false, error: 'unknown', message: 'Activity was created but could not be read back.' };
  }
  return { ok: true, content: created };
}

export type CreateEventInput = {
  uid: string;
  title: string;
  description: string;
  categoryId: string;
  startsAt: Date;
  endsAt: Date;
  placeName: string;
  /** A known places/{placeId}, or omitted/null for a manually-typed place name. */
  placeId?: string | null;
};

export async function createEvent(input: CreateEventInput): Promise<CreateContentResult<EventContent>> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }

  const trusted = await resolveTrustedAuthorFields(input.uid);
  if (!trusted.ok) {
    return trusted;
  }

  const validated = validateEventLikeFields(input);
  if (!validated.ok) {
    return validated;
  }
  const placeLink = resolvePlaceId(input.placeId, validated.placeName);
  if (!placeLink.ok) {
    return placeLink;
  }

  const contentRef = doc(collection(firestore, CONTENT_COLLECTION));
  const data = {
    contentId: contentRef.id,
    type: 'event',
    ...trusted.fields,
    categoryId: input.categoryId,
    status: 'published',
    visibility: 'city',
    title: validated.title,
    description: validated.description,
    placeName: validated.placeName,
    placeId: placeLink.placeId,
    startsAt: Timestamp.fromDate(input.startsAt),
    endsAt: Timestamp.fromDate(input.endsAt),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies WithFieldValue<EventContent>;

  try {
    await setDoc(contentRef, data);
  } catch {
    return { ok: false, error: 'unknown', message: 'Something went wrong creating your event.' };
  }

  const created = await fetchContentById(contentRef.id);
  if (!created || created.type !== 'event') {
    return { ok: false, error: 'unknown', message: 'Event was created but could not be read back.' };
  }
  return { ok: true, content: created };
}

// ---------------------------------------------------------------------------
// Read — all one-shot reads with explicit limits, no realtime listeners.
// Cursor pagination can be layered on top of these later by accepting an
// optional "after" document snapshot/cursor; not needed yet.
// ---------------------------------------------------------------------------

/** Newest published content (posts, activities, events mixed) for one city. */
export async function fetchCityFeed(cityKey: string, limitCount = DEFAULT_FEED_LIMIT): Promise<Content[]> {
  if (!firestore) {
    return [];
  }
  const feedQuery = query(
    collection(firestore, CONTENT_COLLECTION),
    where('cityKey', '==', cityKey),
    where('status', '==', 'published'),
    orderBy('createdAt', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(feedQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as Content);
}

/**
 * A single user's own published content (posts, activities, events mixed),
 * newest first — powers the "real content" section of their public
 * profile. Only ever filters by authorUid + status; never reads any
 * private users/{uid} document. UI can filter the returned list by
 * `type` in-memory for the Posts/Activities/Events tabs rather than
 * running three separate queries for one profile page.
 */
export async function fetchPublicUserContent(uid: string, limitCount = DEFAULT_FEED_LIMIT): Promise<Content[]> {
  if (!firestore) {
    return [];
  }
  const contentQuery = query(
    collection(firestore, CONTENT_COLLECTION),
    where('authorUid', '==', uid),
    where('status', '==', 'published'),
    orderBy('createdAt', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(contentQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as Content);
}

/**
 * The exact number of a user's own published Posts — the Profile "Posts"
 * stat (src/components/ProfileHeader.tsx). Deliberately NOT derived from
 * fetchPublicUserContent's mixed, DEFAULT_FEED_LIMIT-bounded result: a
 * user with more than that many total Posts/Activities/Events would have
 * older Posts silently excluded from that array, undercounting a visible
 * statistic. This runs a server-side aggregation instead (Firestore
 * getCountFromServer) — one count read, no documents transferred, no
 * client-side scan — using the same authorUid + status('published') filter
 * as fetchPublicUserContent, plus type=='post', so this never counts a
 * draft/unpublished document a profile wouldn't otherwise show.
 */
export async function fetchProfilePostCount(uid: string): Promise<number> {
  if (!firestore) {
    return 0;
  }
  const countQuery = query(
    collection(firestore, CONTENT_COLLECTION),
    where('authorUid', '==', uid),
    where('type', '==', 'post'),
    where('status', '==', 'published')
  );
  const snapshot = await getCountFromServer(countQuery);
  return snapshot.data().count;
}

/**
 * Published content linked to one known Place (posts, activities, events
 * mixed), newest first — powers a Place page's "What's happening here".
 * Only ever filters by placeId + status; manually-typed places (placeId
 * null) never match this query.
 */
export async function fetchPlaceContent(placeId: string, limitCount = DEFAULT_FEED_LIMIT): Promise<Content[]> {
  if (!firestore) {
    return [];
  }
  const contentQuery = query(
    collection(firestore, CONTENT_COLLECTION),
    where('placeId', '==', placeId),
    where('status', '==', 'published'),
    orderBy('createdAt', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(contentQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as Content);
}

async function fetchUpcomingByType<T extends ActivityContent | EventContent>(
  type: 'activity' | 'event',
  cityKey: string,
  limitCount: number
): Promise<T[]> {
  if (!firestore) {
    return [];
  }
  const upcomingQuery = query(
    collection(firestore, CONTENT_COLLECTION),
    where('type', '==', type),
    where('cityKey', '==', cityKey),
    where('status', '==', 'published'),
    where('startsAt', '>=', Timestamp.now()),
    orderBy('startsAt', 'asc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(upcomingQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as T);
}

export function fetchUpcomingEvents(cityKey: string, limitCount = DEFAULT_FEED_LIMIT): Promise<EventContent[]> {
  return fetchUpcomingByType<EventContent>('event', cityKey, limitCount);
}

export function fetchUpcomingActivities(cityKey: string, limitCount = DEFAULT_FEED_LIMIT): Promise<ActivityContent[]> {
  return fetchUpcomingByType<ActivityContent>('activity', cityKey, limitCount);
}

/**
 * Activities/Events whose startsAt falls in [window.start, window.end) —
 * reuses the same composite index as fetchUpcomingByType/
 * fetchHappeningNowByType (cityKey, status, type, startsAt ASC): a second
 * range clause on the SAME field (startsAt) is allowed by Firestore in a
 * single query, so no new index is needed for Today/Tonight or Upcoming.
 */
async function fetchByStartsAtWindowByType<T extends ActivityContent | EventContent>(
  type: 'activity' | 'event',
  cityKey: string,
  window: { start: Date; end: Date },
  limitCount: number
): Promise<T[]> {
  if (!firestore) {
    return [];
  }
  const windowQuery = query(
    collection(firestore, CONTENT_COLLECTION),
    where('type', '==', type),
    where('cityKey', '==', cityKey),
    where('status', '==', 'published'),
    where('startsAt', '>=', Timestamp.fromDate(window.start)),
    where('startsAt', '<', Timestamp.fromDate(window.end)),
    orderBy('startsAt', 'asc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(windowQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as T);
}

async function fetchByStartsAtWindow(
  cityKey: string,
  window: { start: Date; end: Date },
  limitCount: number
): Promise<(ActivityContent | EventContent)[]> {
  const [events, activities] = await Promise.all([
    fetchByStartsAtWindowByType<EventContent>('event', cityKey, window, limitCount),
    fetchByStartsAtWindowByType<ActivityContent>('activity', cityKey, window, limitCount),
  ]);
  return [...events, ...activities].sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis());
}

const DEFAULT_DISCOVERY_SECTION_LIMIT = 20;

export type DiscoverySections = {
  happeningNow: (ActivityContent | EventContent)[];
  /** "Today" before the evening cutoff, "Tonight" from it on — see getTodayOrTonightWindow. */
  todayLabel: 'Today' | 'Tonight';
  today: (ActivityContent | EventContent)[];
  upcoming: (ActivityContent | EventContent)[];
};

/**
 * The three time-based discovery rails (Happening Now / Today-or-Tonight /
 * Upcoming) for one city, fetched together so duplicate precedence can be
 * applied once, in one place, rather than re-implemented by every screen
 * that shows these rails (Home, /events). Precedence: Happening Now →
 * Today/Tonight → Upcoming — an item already shown in an earlier rail is
 * filtered out of later ones by contentId.
 *
 * Today/Tonight and Upcoming never overlap by construction (Upcoming's
 * window starts exactly where Today/Tonight's ends — see
 * getUpcomingWindow), so only Today/Tonight needs deduping against
 * Happening Now (an item that started earlier today and hasn't ended yet
 * matches both queries).
 */
export async function fetchDiscoverySections(cityKey: string, limitCount = DEFAULT_DISCOVERY_SECTION_LIMIT): Promise<DiscoverySections> {
  const now = new Date();
  const todayWindow = getTodayOrTonightWindow(now);
  const upcomingWindow = getUpcomingWindow(todayWindow.end);

  const [happeningNow, todayCandidates, upcoming] = await Promise.all([
    fetchHappeningNow(cityKey, limitCount),
    fetchByStartsAtWindow(cityKey, todayWindow, limitCount),
    fetchByStartsAtWindow(cityKey, upcomingWindow, limitCount),
  ]);

  const happeningIds = new Set(happeningNow.map((item) => item.contentId));
  const nowMs = now.getTime();
  const today = todayCandidates.filter(
    (item) => !happeningIds.has(item.contentId) && item.endsAt.toMillis() >= nowMs
  );

  return { happeningNow, todayLabel: todayWindow.label, today, upcoming };
}

/**
 * "Happening now" — startsAt <= now AND endsAt >= now.
 *
 * Firestore can only apply a range/inequality filter to ONE field per
 * query, so "startsAt <= now AND endsAt >= now" isn't expressible as a
 * single query. Instead we fetch candidates that have already started
 * (startsAt <= now, ordered ascending) and filter client-side for ones
 * that haven't ended yet. This intentionally reuses the exact same
 * composite index as fetchUpcoming* above (cityKey, status, type,
 * startsAt ASC) rather than requiring a third index — good enough until
 * real usage data shows we need something smarter (e.g. a boolean kept
 * fresh by a scheduled job), which we're deliberately not building yet.
 */
async function fetchHappeningNowByType<T extends ActivityContent | EventContent>(
  type: 'activity' | 'event',
  cityKey: string,
  limitCount: number
): Promise<T[]> {
  if (!firestore) {
    return [];
  }
  const now = Timestamp.now();
  const startedQuery = query(
    collection(firestore, CONTENT_COLLECTION),
    where('type', '==', type),
    where('cityKey', '==', cityKey),
    where('status', '==', 'published'),
    where('startsAt', '<=', now),
    orderBy('startsAt', 'asc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(startedQuery);
  return snapshot.docs
    .map((docSnapshot) => docSnapshot.data() as T)
    .filter((item) => item.endsAt.toMillis() >= now.toMillis());
}

export async function fetchHappeningNow(
  cityKey: string,
  limitCount = DEFAULT_FEED_LIMIT
): Promise<(ActivityContent | EventContent)[]> {
  const [events, activities] = await Promise.all([
    fetchHappeningNowByType<EventContent>('event', cityKey, limitCount),
    fetchHappeningNowByType<ActivityContent>('activity', cityKey, limitCount),
  ]);
  return [...events, ...activities].sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis());
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export type FetchFollowingFeedInput = {
  currentUid: string;
  /**
   * The city to scope the feed to — deliberately a parameter, not derived
   * from the caller's own profile inside this function. Today the only
   * caller passes the signed-in user's own cityKey, but a future
   * city-switcher can pass any city without this function changing (see
   * the "Critical city rule" in the Step 12 spec).
   */
  cityKey: string;
  limit?: number;
};

/**
 * Chronological Following feed: published content from people `currentUid`
 * follows, in one specific city. Never queries the whole content
 * collection and filters locally — always resolves followed uids first,
 * then queries content directly by those uids.
 *
 * Firestore's `in` operator caps at 30 values per query on this SDK; we
 * chunk into groups of FOLLOWING_UID_CHUNK_SIZE (10) for headroom rather
 * than relying on that ceiling. Each chunk is its own
 * (authorUid in [...], cityKey ==, status == 'published') query, ordered
 * newest-first with its own limit — then all chunk results are merged,
 * deduplicated by contentId (a piece of content could theoretically
 * appear in results from more than one chunk if authorUid matching
 * overlapped, though in practice each author only ever falls into one
 * chunk), globally re-sorted by createdAt, and sliced to the requested
 * limit. No realtime listeners — call again to refresh.
 *
 * MVP limit: only the first MAX_FOLLOWED_UIDS_PER_FEED_PAGE (30) followed
 * uids are considered per feed page. Someone following more than that
 * simply won't see the rest reflected in Following yet — this needs
 * cursor pagination on the follow list itself to fix properly, which is
 * out of scope here.
 */
export async function fetchFollowingFeed({
  currentUid,
  cityKey,
  limit: limitCount = DEFAULT_FOLLOWING_FEED_LIMIT,
}: FetchFollowingFeedInput): Promise<Content[]> {
  if (!firestore) {
    return [];
  }
  const db = firestore;

  const followedUids = await fetchFollowingUids(currentUid, MAX_FOLLOWED_UIDS_PER_FEED_PAGE);
  if (followedUids.length === 0) {
    return [];
  }

  const chunks = chunkArray(followedUids, FOLLOWING_UID_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      getDocs(
        query(
          collection(db, CONTENT_COLLECTION),
          where('authorUid', 'in', chunk),
          where('cityKey', '==', cityKey),
          where('status', '==', 'published'),
          orderBy('createdAt', 'desc'),
          limit(limitCount)
        )
      )
    )
  );

  const seenContentIds = new Set<string>();
  const merged: Content[] = [];
  for (const snapshot of chunkResults) {
    for (const docSnapshot of snapshot.docs) {
      const item = docSnapshot.data() as Content;
      if (seenContentIds.has(item.contentId)) continue;
      seenContentIds.add(item.contentId);
      merged.push(item);
    }
  }

  merged.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
  return merged.slice(0, limitCount);
}
