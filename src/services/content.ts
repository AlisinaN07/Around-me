/**
 * City content data layer — the unified content/{contentId} collection
 * (posts, activities, events). UI code should only ever import from here,
 * never talk to Firestore directly for content.
 */

import {
  Timestamp,
  collection,
  doc,
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

import { firestore } from './firestore';
import { fetchUserProfile } from './userProfile';

const CONTENT_COLLECTION = 'content';
const DEFAULT_FEED_LIMIT = 20;
const VALID_CATEGORY_IDS = new Set(INTERESTS.map((interest) => interest.id));

export type CreateContentError = 'not-configured' | 'no-profile' | 'invalid-input' | 'unknown';

export type CreateContentResult<T> = { ok: true; content: T } | { ok: false; error: CreateContentError; message: string };

function isValidCategoryId(categoryId: string): boolean {
  return VALID_CATEGORY_IDS.has(categoryId);
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

  const contentRef = doc(collection(firestore, CONTENT_COLLECTION));
  const data = {
    contentId: contentRef.id,
    type: 'post',
    ...trusted.fields,
    categoryId: input.categoryId,
    status: 'published',
    visibility: 'city',
    body,
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
