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
  type QueryConstraint,
  type WithFieldValue,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getDownloadURL, ref, uploadBytesResumable, type UploadTask } from 'firebase/storage';

import { INTERESTS } from '@/constants/interests';
import type { ActivityContent, Content, EventContent, PostContent } from '@/types/content';
import type { BrowseScope } from '@/types/browseScope';
import { forYouHandoffKey, followingHandoffKey } from '@/utils/eventSectionHandoffKey';
import { removeContentIdFromSections } from '@/utils/eventSectionHandoffCorrection';
import {
  BODY_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  EVENT_COVER_PHOTO_MAX_SIZE_BYTES,
  MAX_PARTICIPANTS_LIMIT,
  PLACE_NAME_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from '@/types/content';
import { getTodayOrTonightWindow, getUpcomingWindow } from '@/utils/dateWindows';

import { fetchFollowingUids } from './following';
import { firestore } from './firestore';
import { functions } from './functions';
import { extractHashtags, incrementHashtagCounts } from './hashtags';
import { getMediaStorageProvider } from './media';
import { uploadEventCoverToR2 } from './media/r2Provider';
import { storage } from './storage';
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
  /**
   * Step 36 — an already-uploaded cover photo's resolved download URL
   * (see uploadEventCoverPhoto below), or omitted/undefined for no cover
   * at all. Never a local file URI — the Create Event screen must finish
   * uploading before calling createEvent, since content documents are
   * immutable after creation and there is no later "attach a photo" edit.
   */
  coverPhotoURL?: string;
};

/**
 * Step 36 — a fresh, random, purely-local identifier reserved by the
 * Create Event screen BEFORE any Storage upload happens, and held for
 * that screen's lifetime (see its own `useState(() => generateEventDraftId())`
 * lazy initializer). It has no meaning in Firestore at all — content
 * documents are created in one atomic setDoc (see createEvent below), not
 * a multi-stage draft the way Reels/Stories are — its ONLY job is to keep
 * each Create Event attempt's cover photo at its own distinct Storage
 * path (eventCovers/{authorUid}/{draftId}/photo), so a LATER event by the
 * same author can never overwrite, and thereby silently change the
 * displayed cover of, an EARLIER already-published one. Reuses Firestore's
 * own random-ID generator purely for convenience (same trick
 * createReelDraft/createStoryDraft use) — no document is ever created at
 * this path.
 */
export function generateEventDraftId(): string {
  if (!firestore) {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return doc(collection(firestore, CONTENT_COLLECTION)).id;
}

export type UploadEventCoverPhotoHandle = { cancel: () => void };

/**
 * Uploads a locally-picked cover image for an in-progress Event draft to
 * eventCovers/{uid}/{draftId}/photo (see generateEventDraftId's own doc
 * comment for why the path is keyed by a throwaway draftId rather than a
 * real contentId). Mutable in place for the SAME draftId — the organizer
 * may pick, then re-pick, a different image before ever publishing — but
 * a fresh draftId is generated per Create Event screen visit, so this
 * never touches any other draft's or any published Event's own image.
 * Does NOT touch Firestore itself — call createEvent with the resolved
 * coverPhotoURL once onComplete reports success, same division of
 * responsibility as uploadProfileCoverPhoto/updateMyProfileCoverPhoto in
 * src/services/userProfile.ts.
 *
 * Step 5D — dispatches on getMediaStorageProvider() (see
 * src/services/media/config.ts), same pattern as userProfile.ts's own
 * uploadProfilePhoto/uploadProfileCoverPhoto. This function's own
 * behavior for the default, production value ('firebase') is completely
 * untouched below — the exact same code that existed before Step 5D. The
 * 'r2' branch (uploadEventCoverViaR2, right below) is a SEPARATE
 * function, reached only when a developer explicitly sets
 * EXPO_PUBLIC_MEDIA_STORAGE_PROVIDER=r2 for controlled testing.
 */
export function uploadEventCoverPhoto(
  uid: string,
  draftId: string,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true; coverPhotoURL: string } | { ok: false; message: string }) => void
): UploadEventCoverPhotoHandle {
  if (getMediaStorageProvider() === 'r2') {
    return uploadEventCoverViaR2(draftId, localUri, onProgress, onComplete);
  }

  let cancelled = false;
  let task: UploadTask | null = null;

  (async () => {
    if (!storage) {
      onComplete({ ok: false, message: 'Storage is not available.' });
      return;
    }

    let blob: Blob;
    try {
      const response = await fetch(localUri);
      blob = await response.blob();
    } catch {
      onComplete({ ok: false, message: "Couldn't read the selected photo." });
      return;
    }
    if (cancelled) return;

    if (blob.size > EVENT_COVER_PHOTO_MAX_SIZE_BYTES) {
      onComplete({ ok: false, message: 'That photo is too large. Choose one under 8 MB.' });
      return;
    }

    const objectRef = ref(storage, `eventCovers/${uid}/${draftId}/photo`);
    task = uploadBytesResumable(objectRef, blob, { contentType: blob.type || 'image/jpeg' });

    task.on(
      'state_changed',
      (snapshot) => {
        const percent = snapshot.totalBytes > 0 ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100) : 0;
        onProgress(percent);
      },
      (error) => {
        if (error.code === 'storage/canceled') {
          onComplete({ ok: false, message: 'Upload cancelled.' });
          return;
        }
        onComplete({ ok: false, message: "Couldn't upload your cover photo." });
      },
      async () => {
        try {
          const coverPhotoURL = await getDownloadURL(objectRef);
          onComplete({ ok: true, coverPhotoURL });
        } catch {
          onComplete({ ok: false, message: "Uploaded, but couldn't finish saving your cover photo." });
        }
      }
    );
  })();

  return {
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}

/**
 * Step 5D's real, end-to-end R2 upload+display path for Event covers —
 * reached ONLY when getMediaStorageProvider() returns 'r2' (never in a
 * default build; see uploadEventCoverPhoto's own doc comment). Delegates
 * to uploadEventCoverToR2 (src/services/media/r2Provider.ts), the exact
 * same proven authorize-then-PUT mechanics as
 * uploadProfilePhotoViaR2/uploadProfileCoverViaR2, just for the
 * `eventCover` media kind and its own `eventCovers/{uid}/{draftId}/photo`
 * object key — `draftId` is passed straight through, unchanged, to the
 * authorization request (see requestMediaUploadAuthorization.ts's own
 * doc comment on why this one media kind needs it). Returns the SAME
 * shape uploadEventCoverPhoto's own Firebase branch above already
 * returns, so the Create Event screen's own upload handler needs no
 * changes at all.
 */
function uploadEventCoverViaR2(
  draftId: string,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true; coverPhotoURL: string } | { ok: false; message: string }) => void
): UploadEventCoverPhotoHandle {
  let cancelled = false;

  (async () => {
    const result = await uploadEventCoverToR2(draftId, localUri, onProgress);
    if (cancelled) return;

    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[content] R2 Event cover upload for draft', draftId, '->', result);
    }
    onComplete(result.ok ? { ok: true, coverPhotoURL: result.photoURL } : result);
  })();

  return {
    cancel: () => {
      cancelled = true;
    },
  };
}

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

  // Step 12D — computed once, here, from the exact description this
  // Event is about to store (never re-derived later — this field is
  // immutable after creation, same as every other Event field — see
  // EventContent.hashtags' own doc comment). Same extraction function a
  // Reel's own caption already uses (src/utils/hashtags.ts) — no second
  // hashtag system, no Event-specific normalization.
  const hashtags = extractHashtags(validated.description);

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
    hashtags,
    // Step 36 — omitted entirely when absent, same "absent key, not a
    // blank value" convention placeName already uses on Post above; never
    // trusts a raw string the caller could hand-type (this must already
    // be a resolved download URL from uploadEventCoverPhoto).
    ...(input.coverPhotoURL ? { coverPhotoURL: input.coverPhotoURL } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies WithFieldValue<EventContent>;

  try {
    await setDoc(contentRef, data);
  } catch {
    return { ok: false, error: 'unknown', message: 'Something went wrong creating your event.' };
  }

  // Step 12D — best-effort, same "a hashtag-count hiccup shouldn't turn a
  // successful publish into a reported failure" reasoning as a Reel's own
  // post-publish incrementHashtagCounts call (reels.ts) — this Event is
  // already genuinely created at this point (the setDoc above succeeded).
  try {
    await incrementHashtagCounts(hashtags);
  } catch {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(`[content] Couldn't update hashtag counts for Event "${contentRef.id}" — creation itself still succeeded.`);
    }
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
 * Same exact-count pattern as fetchProfilePostCount above, `type == 'event'`
 * instead — a Business account's Profile header shows this real total in
 * place of the Posts count (see ProfileHeader's own postsLabel prop),
 * never businessEvents.length from the bounded fetchPublicUserContent
 * page, which would silently undercount past PROFILE_CONTENT_LIMIT.
 */
export async function fetchProfileEventCount(uid: string): Promise<number> {
  if (!firestore) {
    return 0;
  }
  const countQuery = query(
    collection(firestore, CONTENT_COLLECTION),
    where('authorUid', '==', uid),
    where('type', '==', 'event'),
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

/**
 * The equality/`in` clause a scoped query filters on — `cityKey`
 * (`==` for one City, `in` for several Cities), `countryCode` for Country
 * scope, or none at all for World (every published document,
 * everywhere). See src/types/browseScope.ts's own doc comment for why
 * this never affects what a new document is created with, only what a
 * query reads back.
 *
 * NEVER use this for a query that already has its own `in`/
 * `array-contains-any` clause (e.g. the Following-scoped queries below,
 * which already filter `authorUid in [...]`) — Firestore allows only ONE
 * such clause per query. Use scopeVariants for those instead.
 */
function scopeWhereClause(scope: BrowseScope): QueryConstraint[] {
  if (scope.kind === 'city') return [where('cityKey', '==', scope.cityKey)];
  if (scope.kind === 'cities') return [where('cityKey', 'in', scope.cityKeys)];
  if (scope.kind === 'country') return [where('countryCode', '==', scope.countryCode)];
  return [];
}

/**
 * Every scope kind EXCEPT 'cities' already reads as a single query variant
 * (one equality clause, or none). 'cities' scope can't reuse the `in`
 * clause scopeWhereClause would build for it here, because these callers
 * already have their OWN `in` clause (`authorUid in [...]`) — Firestore
 * permits only one per query — so a multi-city scope instead expands into
 * one variant per city (`cityKey == that city`), and the caller runs one
 * query per (authorUid chunk × variant) pair and merges everything. Every
 * other scope kind still reuses the exact same composite index it always
 * has (see firestore.indexes.json) since each variant here is structurally
 * identical to scopeWhereClause's own single-variant output.
 */
function scopeVariants(scope: BrowseScope): QueryConstraint[][] {
  if (scope.kind === 'cities') return scope.cityKeys.map((cityKey) => [where('cityKey', '==', cityKey)]);
  return [scopeWhereClause(scope)];
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
 * reuses the same composite index as fetchHappeningNowByType (scope
 * clause, status, type, startsAt ASC): a second range clause on the SAME
 * field (startsAt) is allowed by Firestore in a single query, so no new
 * index is needed for Today/Tonight vs. Upcoming — only for a different
 * `scope` kind (see firestore.indexes.json's countryCode/world-scoped
 * content indexes).
 */
async function fetchByStartsAtWindowByType<T extends ActivityContent | EventContent>(
  type: 'activity' | 'event',
  scope: BrowseScope,
  window: { start: Date; end?: Date },
  limitCount: number
): Promise<T[]> {
  if (!firestore) {
    return [];
  }
  // `end` is optional — omitted entirely for "Upcoming" (see
  // getUpcomingWindow's own doc comment: deliberately open-ended, capped
  // only by `limitCount` below, never a second date cutoff), still
  // required for a genuinely bounded window like Today/Tonight.
  const windowQuery = query(
    collection(firestore, CONTENT_COLLECTION),
    where('type', '==', type),
    ...scopeWhereClause(scope),
    where('status', '==', 'published'),
    where('startsAt', '>=', Timestamp.fromDate(window.start)),
    ...(window.end ? [where('startsAt', '<', Timestamp.fromDate(window.end))] : []),
    orderBy('startsAt', 'asc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(windowQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as T);
}

async function fetchByStartsAtWindow(
  scope: BrowseScope,
  window: { start: Date; end?: Date },
  limitCount: number
): Promise<(ActivityContent | EventContent)[]> {
  const [events, activities] = await Promise.all([
    fetchByStartsAtWindowByType<EventContent>('event', scope, window, limitCount),
    fetchByStartsAtWindowByType<ActivityContent>('activity', scope, window, limitCount),
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
export async function fetchDiscoverySections(scope: BrowseScope, limitCount = DEFAULT_DISCOVERY_SECTION_LIMIT): Promise<DiscoverySections> {
  const now = new Date();
  const todayWindow = getTodayOrTonightWindow(now);
  const upcomingWindow = getUpcomingWindow(todayWindow.end);

  const [happeningNowAll, todayCandidatesAll, upcomingAll] = await Promise.all([
    fetchHappeningNow(scope, limitCount),
    fetchByStartsAtWindow(scope, todayWindow, limitCount),
    fetchByStartsAtWindow(scope, upcomingWindow, limitCount),
  ]);

  // Step 41.2B: legacy Activity is retired from active discovery — Events
  // is now Business-Event-only. Filtered once here, the single place every
  // discovery screen already goes through, rather than duplicated per
  // caller. fetchHappeningNow/fetchByStartsAtWindow themselves are left
  // exactly as they were (still genuinely merge both types) since this is
  // the only current caller and changing their own signature/behavior
  // would be a wider, riskier edit than filtering their result here.
  const happeningNow = happeningNowAll.filter((item) => item.type !== 'activity');
  const todayCandidates = todayCandidatesAll.filter((item) => item.type !== 'activity');
  const upcoming = upcomingAll.filter((item) => item.type !== 'activity');

  const happeningIds = new Set(happeningNow.map((item) => item.contentId));
  const nowMs = now.getTime();
  const today = todayCandidates.filter(
    (item) => !happeningIds.has(item.contentId) && item.endsAt.toMillis() >= nowMs
  );

  return { happeningNow, todayLabel: todayWindow.label, today, upcoming };
}

// ---------------------------------------------------------------------------
// Events "Following" tab — Business Events from companies `currentUid`
// follows only (Events are Business-only, so "people the caller follows
// that make events" always means followed Business accounts). Deliberately
// a SEPARATE set of queries from fetchDiscoverySections above rather than
// a mode flag threaded through it: these need one extra equality filter
// (authorUid 'in' a followed-uid chunk) that the "for everyone" rails never
// use, and never touch the retired legacy Activity type at all (Events are
// the only content type Following-scoped discovery ever shows).
// ---------------------------------------------------------------------------

/**
 * Chunked, authorUid-scoped variant of fetchHappeningNowByType, Events
 * only. Reuses the same (type, scope clause, status, startsAt) index
 * shape as fetchDiscoverySections, with authorUid folded into the
 * equality group ahead of startsAt — see the dedicated
 * (type, cityKey/countryCode, status, authorUid, startsAt) indexes in
 * firestore.indexes.json (one per BrowseScope kind).
 */
async function fetchFollowingHappeningNowEvents(authorUidChunks: string[][], scope: BrowseScope, limitCount: number): Promise<EventContent[]> {
  if (!firestore || authorUidChunks.length === 0) return [];
  const db = firestore;
  const now = Timestamp.now();
  // Cross-product of author chunks × scope variants — see scopeVariants'
  // own doc comment for why a multi-city scope can't just fold into a
  // single `in` clause here (authorUid already owns this query's one
  // allowed `in`).
  const variants = scopeVariants(scope);
  const chunkResults = await Promise.all(
    authorUidChunks.flatMap((chunk) =>
      variants.map((variant) =>
        getDocs(
          query(
            collection(db, CONTENT_COLLECTION),
            where('type', '==', 'event'),
            ...variant,
            where('status', '==', 'published'),
            where('authorUid', 'in', chunk),
            where('startsAt', '<=', now),
            orderBy('startsAt', 'asc'),
            limit(limitCount)
          )
        )
      )
    )
  );
  const seenIds = new Set<string>();
  const items: EventContent[] = [];
  for (const snapshot of chunkResults) {
    for (const docSnapshot of snapshot.docs) {
      const item = docSnapshot.data() as EventContent;
      if (seenIds.has(item.contentId)) continue;
      seenIds.add(item.contentId);
      items.push(item);
    }
  }
  return items.filter((item) => item.endsAt.toMillis() >= now.toMillis());
}

/** Chunked, authorUid-scoped variant of fetchByStartsAtWindowByType, Events only — same index note as fetchFollowingHappeningNowEvents above. */
async function fetchFollowingEventsByStartsAtWindow(
  authorUidChunks: string[][],
  scope: BrowseScope,
  window: { start: Date; end?: Date },
  limitCount: number
): Promise<EventContent[]> {
  if (!firestore || authorUidChunks.length === 0) return [];
  const db = firestore;
  const variants = scopeVariants(scope);
  const chunkResults = await Promise.all(
    authorUidChunks.flatMap((chunk) =>
      variants.map((variant) =>
        getDocs(
          query(
            collection(db, CONTENT_COLLECTION),
            where('type', '==', 'event'),
            ...variant,
            where('status', '==', 'published'),
            where('authorUid', 'in', chunk),
            where('startsAt', '>=', Timestamp.fromDate(window.start)),
            // `end` optional — see fetchByStartsAtWindowByType's own doc
            // comment for why (getUpcomingWindow is now open-ended).
            ...(window.end ? [where('startsAt', '<', Timestamp.fromDate(window.end))] : []),
            orderBy('startsAt', 'asc'),
            limit(limitCount)
          )
        )
      )
    )
  );
  const seenIds = new Set<string>();
  const items: EventContent[] = [];
  for (const snapshot of chunkResults) {
    for (const docSnapshot of snapshot.docs) {
      const item = docSnapshot.data() as EventContent;
      if (seenIds.has(item.contentId)) continue;
      seenIds.add(item.contentId);
      items.push(item);
    }
  }
  return items;
}

export type FollowingDiscoverySections = {
  sections: DiscoverySections;
  /** Same "distinguish don't-follow-anyone from follow-nobody-with-events" reasoning as FollowingReelsResult in src/services/reels.ts. */
  followsAnyone: boolean;
};

/**
 * The Following-scoped equivalent of fetchDiscoverySections — same three
 * time-based rails (Happening Now / Today-or-Tonight / Upcoming) and the
 * same precedence/dedup rules, restricted to published Events authored by
 * companies `currentUid` follows. Mirrors fetchFollowingReels' own
 * resolve-uids-then-chunk-query pattern exactly, including its
 * MAX_FOLLOWED_UIDS_PER_FEED_PAGE/FOLLOWING_UID_CHUNK_SIZE bounds — a v1
 * limitation this inherits rather than solves independently (someone
 * following more than 30 accounts simply has the rest not considered
 * here yet).
 */
export async function fetchFollowingDiscoverySections(
  currentUid: string,
  scope: BrowseScope,
  limitCount = DEFAULT_DISCOVERY_SECTION_LIMIT
): Promise<FollowingDiscoverySections> {
  const emptySections: DiscoverySections = { happeningNow: [], todayLabel: 'Today', today: [], upcoming: [] };
  if (!firestore) return { sections: emptySections, followsAnyone: false };

  const followedUids = await fetchFollowingUids(currentUid, MAX_FOLLOWED_UIDS_PER_FEED_PAGE);
  if (followedUids.length === 0) {
    return { sections: emptySections, followsAnyone: false };
  }
  const chunks = chunkArray(followedUids, FOLLOWING_UID_CHUNK_SIZE);

  const now = new Date();
  const todayWindow = getTodayOrTonightWindow(now);
  const upcomingWindow = getUpcomingWindow(todayWindow.end);

  const [happeningNow, todayCandidates, upcoming] = await Promise.all([
    fetchFollowingHappeningNowEvents(chunks, scope, limitCount),
    fetchFollowingEventsByStartsAtWindow(chunks, scope, todayWindow, limitCount),
    fetchFollowingEventsByStartsAtWindow(chunks, scope, upcomingWindow, limitCount),
  ]);

  const happeningIds = new Set(happeningNow.map((item) => item.contentId));
  const nowMs = now.getTime();
  const today = todayCandidates.filter((item) => !happeningIds.has(item.contentId) && item.endsAt.toMillis() >= nowMs);

  return {
    sections: { happeningNow, todayLabel: todayWindow.label, today, upcoming },
    followsAnyone: true,
  };
}

// ---------------------------------------------------------------------------
// Phase 4 perf pass — a small, short-lived HANDOFF cache from the Events
// tab's own already-fetched DiscoverySections to its "Show more" screen
// (src/app/(app)/events/section.tsx), which today re-runs the exact same
// fetchDiscoverySections/fetchFollowingDiscoverySections call (same scope,
// same SECTION_LIMIT) the instant it opens, even though the Events tab
// almost always already has that exact result in memory. The Events tab
// writes into this on every one of ITS OWN successful real fetches (see
// (tabs)/events.tsx's own loadForYou/loadFollowing) — a real load, an
// explicit retry, AND a silent revalidate alike — so this always reflects
// exactly what the tab itself most recently, successfully saw. The
// Section screen reads it FIRST and only falls back to a real fetch of
// its own on a miss/stale entry, in which case it ALSO writes back here
// (so a second "Show more" tap for a different rail in the same visit
// benefits too, even if the Events tab itself was never revisited).
//
// Deliberately NOT built by wrapping fetchDiscoverySections/
// fetchFollowingDiscoverySections themselves in a cache the way Phase 2
// wrapped fetchPublicProfile: those two functions are also exactly what
// the Events tab's OWN silent-revalidate calls on every refocus (see
// events.tsx's own stale-while-revalidate doc comment) — if a cache lived
// INSIDE them, that revalidate could itself become a same-TTL cache hit
// and silently do nothing, masking real staleness (e.g. right after
// creating a new event) on the Events tab itself, not just on the Section
// screen. This handoff cache is intentionally external to both functions
// and much shorter-lived than Phase 2's own 45-60s convention, so it only
// ever serves the "the tab JUST fetched this, and Show more was tapped
// moments later" case — never a stand-in for the tab's own revalidation
// policy, which keeps calling the real functions directly, completely
// unchanged by this cache's existence.
// ---------------------------------------------------------------------------

const SECTION_HANDOFF_TTL_MS = 20_000;
const forYouSectionsHandoff = new Map<string, { sections: DiscoverySections; fetchedAt: number }>();
const followingSectionsHandoff = new Map<string, { result: FollowingDiscoverySections; fetchedAt: number }>();

/**
 * Step 12A — `uid` joined the key the moment this cache started holding a
 * RANKED result (see setForYouSectionsHandoff's own doc comment): the
 * pre-Step-12A key was scope+limit only, which was correct for a plain
 * chronological fetch (identical for every viewer in that scope) but
 * would let one signed-in viewer's personalized ranked order leak to a
 * different signed-in viewer who happens to open the same city's Events
 * tab within the same 20s window. A signed-out viewer (no ranking at
 * all — see events.tsx's own `user ? rankEventSections(...) : result`)
 * passes `''` here, which can never collide with a real Firebase uid, so
 * guest and signed-in entries never share a slot either.
 */
// Step 12A — the key-generation logic itself now lives in
// src/utils/eventSectionHandoffKey.ts (a dependency-light module, unlike
// this file, directly unit-testable under plain `tsx` — see that file's
// own doc comment and tests/eventsSectionHandoff.test.ts) — imported
// above alongside this file's other top-of-file imports.

/**
 * A fresh-enough peek at the Events tab's own most recent successful
 * result for this exact (uid, scope, limitCount) — RANKED for a signed-in
 * `uid` (see setForYouSectionsHandoff), plain chronological for `''`
 * (signed-out). `undefined` on a miss or a stale entry, in which case the
 * caller (only ever the "Show more" screen — the Events tab itself never
 * reads this back) should fall back to its own real fetch.
 */
export function peekForYouSectionsHandoff(uid: string, scope: BrowseScope, limitCount: number): DiscoverySections | undefined {
  const entry = forYouSectionsHandoff.get(forYouHandoffKey(uid, scope, limitCount));
  if (!entry || Date.now() - entry.fetchedAt >= SECTION_HANDOFF_TTL_MS) return undefined;
  return entry.sections;
}

/** Same as peekForYouSectionsHandoff, Following-scoped (also keyed by uid — see followingHandoffKey). */
export function peekFollowingSectionsHandoff(uid: string, scope: BrowseScope, limitCount: number): FollowingDiscoverySections | undefined {
  const entry = followingSectionsHandoff.get(followingHandoffKey(uid, scope, limitCount));
  if (!entry || Date.now() - entry.fetchedAt >= SECTION_HANDOFF_TTL_MS) return undefined;
  return entry.result;
}

/**
 * Called by the Events tab after its own `rankEventSections` call
 * resolves (or, for a signed-out viewer, after the plain chronological
 * fetch — see events.tsx's own `loadForYou`) — `sections` here is
 * whichever of those two the tab is actually about to RENDER, never the
 * pre-ranking raw fetch. Step 12A fixed exactly this: before, this was
 * called with the raw, unranked result, so "Show more" (which reads this
 * cache) could show a different order than the ranked rail it was opened
 * from. Also called by the "Show more" screen itself on a cache miss —
 * see section.tsx's own doc comment for why that fallback intentionally
 * stays unranked rather than re-running the whole ranking pipeline a
 * second screen away.
 */
export function setForYouSectionsHandoff(uid: string, scope: BrowseScope, limitCount: number, sections: DiscoverySections): void {
  forYouSectionsHandoff.set(forYouHandoffKey(uid, scope, limitCount), { sections, fetchedAt: Date.now() });
}

/**
 * Step 12B — surgically removes one Event the viewer just marked "Not
 * interested" from EVERY cached For-You handoff entry that belongs to
 * them (every scope they've recently viewed, in case they switched
 * scopes within this cache's own short TTL), WITHOUT clearing the entry
 * entirely. This is deliberately a CORRECTION of the already-ranked data
 * in place, not an invalidation that forces a refetch: a refetch on a
 * miss falls back to the plain chronological result (see
 * setForYouSectionsHandoff's own doc comment on why section.tsx's miss
 * path intentionally never re-runs ranking) — wiping the cache here
 * would silently trade a correctly-ranked-minus-one-item list for an
 * unranked one, undoing Step 12A's own guarantee for no good reason.
 * Correcting in place also preserves the entry's original `fetchedAt`
 * (its TTL countdown is unaffected — this is a fix to existing data, not
 * a fresh fetch), and never touches Following's own separate handoff Map
 * at all (Not Interested is a For-You-only concept — see this step's own
 * report for the full reasoning).
 */
export function removeContentIdFromForYouSectionsHandoffForUser(uid: string, contentId: string): void {
  const prefix = `${uid}:`;
  for (const [key, entry] of forYouSectionsHandoff) {
    if (!key.startsWith(prefix)) continue;
    forYouSectionsHandoff.set(key, { sections: removeContentIdFromSections(entry.sections, contentId), fetchedAt: entry.fetchedAt });
  }
}

/** Same as setForYouSectionsHandoff, Following-scoped. */
export function setFollowingSectionsHandoff(uid: string, scope: BrowseScope, limitCount: number, result: FollowingDiscoverySections): void {
  followingSectionsHandoff.set(followingHandoffKey(uid, scope, limitCount), { result, fetchedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Swipe-to-next-Event handoff — a small in-memory peek, same shape and
// same reasoning as the Sections handoff just above (an in-memory,
// short-TTL, "the caller already has this exact list in hand" pass-
// through — never a URL param, since Content items carry Firestore
// Timestamp fields that don't survive URL serialization, same note
// events/section.tsx's own doc comment already makes). Written by any
// screen whose own already-loaded, already-fetched EventContent list is
// what a swipe-through should page through right before it navigates
// into one of its own items — today that's Profile's own Live/Upcoming/
// Past Events tabs and the Events tab's own rails (see their own call
// sites) — and read once by content/[contentId].tsx on mount to decide
// whether to show a plain single Event (a share link, search result, or
// any other entry point that never wrote this) or a full swipeable feed
// through this exact list. A stale/missing entry, or one that doesn't
// actually contain the Event just navigated to, always falls back to the
// single-Event behavior — never a crash, never the wrong list.
const EVENT_FEED_HANDOFF_TTL_MS = 20_000;
let eventFeedHandoff: { events: EventContent[]; fetchedAt: number } | null = null;

/** Call right before navigating into one of `events`' own items — see this handoff's own doc comment above. */
export function setEventFeedHandoff(events: EventContent[]): void {
  eventFeedHandoff = { events, fetchedAt: Date.now() };
}

/** `undefined` on a miss or a stale entry — see this handoff's own doc comment above for what the caller should do then (fall back to a single Event). */
export function peekEventFeedHandoff(): EventContent[] | undefined {
  if (!eventFeedHandoff || Date.now() - eventFeedHandoff.fetchedAt >= EVENT_FEED_HANDOFF_TTL_MS) return undefined;
  return eventFeedHandoff.events;
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
  scope: BrowseScope,
  limitCount: number
): Promise<T[]> {
  if (!firestore) {
    return [];
  }
  const now = Timestamp.now();
  const startedQuery = query(
    collection(firestore, CONTENT_COLLECTION),
    where('type', '==', type),
    ...scopeWhereClause(scope),
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
  scope: BrowseScope,
  limitCount = DEFAULT_FEED_LIMIT
): Promise<(ActivityContent | EventContent)[]> {
  const [events, activities] = await Promise.all([
    fetchHappeningNowByType<EventContent>('event', scope, limitCount),
    fetchHappeningNowByType<ActivityContent>('activity', scope, limitCount),
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

export type DeleteMyContentResult = { ok: true } | { ok: false; message: string };

/**
 * Client wrapper around the deleteMyContent trusted backend (Step 40.1 —
 * functions/src/index.ts). Deletes exactly the one Post/Activity/Event the
 * caller authored — the backend independently re-verifies authorUid
 * server-side, so this never needs (and never sends) anything beyond the
 * contentId. Permanent: no recycle bin, no restore.
 */
export async function deleteMyContent(contentId: string): Promise<DeleteMyContentResult> {
  if (!functions) {
    return { ok: false, message: 'This feature is not available right now.' };
  }
  try {
    await httpsCallable(functions, 'deleteMyContent')({ contentId });
  } catch {
    return { ok: false, message: "Couldn't delete this." };
  }
  return { ok: true };
}
