/**
 * Hashtag extraction/normalization — pure text functions only, no
 * Firestore (see src/services/hashtags.ts for the collection/query layer
 * built on top of these). Placed alongside src/utils/username.ts, the
 * closest existing precedent for "normalize free-typed text into a
 * canonical, storage-safe key" in this codebase.
 *
 * Today the only real source of hashtags is a Reel's own `caption` (see
 * src/services/reels.ts's createReelDraft) — the "post creation/composer"
 * this feature was requested for. Kept independent of the Reel type on
 * purpose: nothing here assumes a caption/description field name, so a
 * future content type (Post/Event) could reuse this same extraction with
 * zero changes.
 */

/**
 * Same "reasonable letters, numbers, underscore" charset the task
 * describes, expressed with Unicode property escapes (`\p{L}`/`\p{N}`)
 * rather than a fixed a-z/0-9 range — this is what makes Swedish
 * characters (å, ä, ö) and every other language's own letters work
 * out of the box, not a hardcoded allowlist of extra characters.
 * Deliberately excludes emoji/symbols (neither \p{L} nor \p{N}), so
 * "#nightlife🔥" extracts just "nightlife" — the emoji simply isn't part
 * of the token, not an error.
 */
const HASHTAG_TOKEN_PATTERN = '[\\p{L}\\p{N}_]+';

/**
 * Finds every "#token" in `text`, wherever it appears — not just one
 * being actively typed (contrast with the caption composer's own
 * @-mention detection, src/app/(app)/create/reel/index.tsx's
 * detectActiveMentionQuery, which deliberately only looks at the tail of
 * the string). The negative lookbehind requires "#" to start a fresh
 * token (string start, or preceded by anything that ISN'T itself a
 * hashtag character) — so "word#tag" (no real separator) is never read as
 * a hashtag, same reasoning as an email-shaped "foo@bar" never triggering
 * the mention detector.
 */
const HASHTAG_EXTRACT_PATTERN = new RegExp(`(?<![\\p{L}\\p{N}_])#(${HASHTAG_TOKEN_PATTERN})`, 'gu');

/** A hashtag doc ID this long would be an obvious abuse case (pasted paragraph, not a real tag) long before hitting Firestore's own much higher document-ID limit. */
export const HASHTAG_MAX_LENGTH = 100;

/**
 * Normalizes one already-isolated hashtag candidate (the "#" already
 * stripped) into its canonical, lowercase, storage-safe form — or `null`
 * if it isn't a valid hashtag at all (empty, too long, or containing a
 * character outside the allowed set — e.g. a caller passing raw
 * user-typed text that still has the "#", or stray punctuation, gets
 * rejected here rather than silently stored malformed).
 */
export function normalizeHashtag(raw: string): string | null {
  const withoutHash = raw.trim().replace(/^#+/, '');
  if (!withoutHash) return null;
  if (withoutHash.length > HASHTAG_MAX_LENGTH) return null;
  if (!new RegExp(`^${HASHTAG_TOKEN_PATTERN}$`, 'u').test(withoutHash)) return null;
  return withoutHash.toLowerCase();
}

/**
 * Extracts every hashtag from free-typed `text` (e.g. a Reel's own
 * caption), normalized and de-duplicated — case differences collapse to
 * one entry ("#Football"/"#FOOTBALL" both become "football"), and only
 * the FIRST occurrence's position determines result order. The original
 * `text` itself is never modified here — callers still store the exact
 * string the user typed (see createReelDraft) and only ever persist this
 * function's OWN return value as the separate `hashtags` field.
 */
export function extractHashtags(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(HASHTAG_EXTRACT_PATTERN)) {
    const normalized = normalizeHashtag(match[1]);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** A single reusable "is this one character a valid hashtag character" test — every walk below uses this, never a fresh ad hoc check. */
const HASHTAG_TOKEN_CHAR_PATTERN = new RegExp(`^${HASHTAG_TOKEN_PATTERN}$`, 'u');
function isHashtagTokenChar(char: string | undefined): boolean {
  return char !== undefined && HASHTAG_TOKEN_CHAR_PATTERN.test(char);
}

export type ActiveHashtag = {
  /** The typed text after "#", not yet normalized/validated — e.g. "Foo", "", or a Swedish "trä". */
  query: string;
  /** Index of the "#" itself (inclusive). */
  start: number;
  /** Index one past the query's last character (exclusive) — together with `start`, `text.slice(start, end)` is the whole "#query" token. */
  end: number;
};

/**
 * Finds the "#token" the cursor is CURRENTLY positioned inside of, if any —
 * e.g. `getActiveHashtag("Hello #foo", 10)` (cursor right after "foo")
 * returns `{ query: "foo", start: 6, end: 10 }`. Unlike
 * detectActiveMentionQuery (create/reel/index.tsx — deliberately only
 * looks at the END of the whole string), this genuinely walks outward
 * from the given `cursorPosition` in both directions, so it stays correct
 * with multiple hashtags in the same text and a cursor that isn't at the
 * very end (e.g. "#football with #karl|" mid-caption, or the cursor
 * sitting inside an earlier token after the user moved it back).
 *
 * Reuses HASHTAG_TOKEN_PATTERN — the exact same charset
 * extractHashtags/normalizeHashtag validate against — so the composer's
 * autocomplete, the stored `hashtags` field, and a caption's own
 * clickable spans (splitTextWithHashtags) can never disagree on what a
 * hashtag even is. Also reuses the same "# must start a fresh token"
 * boundary rule HASHTAG_EXTRACT_PATTERN's negative lookbehind enforces
 * (so a cursor inside "word#tag" is never read as active either).
 *
 * Returns `null` when the cursor isn't inside a "#token" at all, or the
 * token is already longer than any real hashtag could be
 * (HASHTAG_MAX_LENGTH) — both are "nothing to autocomplete" as far as any
 * caller is concerned.
 */
export function getActiveHashtag(text: string, cursorPosition: number): ActiveHashtag | null {
  const cursor = Math.max(0, Math.min(cursorPosition, text.length));

  let queryStart = cursor;
  while (queryStart > 0 && isHashtagTokenChar(text[queryStart - 1])) {
    queryStart -= 1;
  }
  const hashIndex = queryStart - 1;
  if (hashIndex < 0 || text[hashIndex] !== '#') return null;
  // The "#" must start a fresh token — string start, or preceded by
  // something that isn't itself a hashtag character.
  if (isHashtagTokenChar(text[hashIndex - 1])) return null;

  let queryEnd = cursor;
  while (queryEnd < text.length && isHashtagTokenChar(text[queryEnd])) {
    queryEnd += 1;
  }

  const query = text.slice(queryStart, queryEnd);
  if (query.length > HASHTAG_MAX_LENGTH) return null;
  return { query, start: hashIndex, end: queryEnd };
}

/**
 * Replaces ONE active "#token" (as located by getActiveHashtag) with a
 * chosen canonical hashtag name — used by the composer's autocomplete
 * suggestion tap. Only `text.slice(active.start, active.end)` is ever
 * touched; everything before `start` and after `end` (other hashtags,
 * emojis, line breaks, unrelated words) passes through completely
 * untouched — this never re-serializes the description from parsed
 * hashtags.
 *
 * Appends a trailing space to match this app's existing "insert then keep
 * typing" convention (see e.g. the caption composer's own @mention
 * insertion) — but only when one isn't already there, so accepting
 * "#foo" in "Great #foo tonight" (cursor right before the existing space)
 * produces "Great #football tonight", never a double space.
 */
export function replaceActiveHashtag(text: string, active: Pick<ActiveHashtag, 'start' | 'end'>, hashtagName: string): { text: string; cursor: number } {
  const insertion = `#${hashtagName}`;
  const nextChar = text[active.end];
  const replacement = nextChar !== undefined && /\s/.test(nextChar) ? insertion : `${insertion} `;
  const newText = text.slice(0, active.start) + replacement + text.slice(active.end);
  return { text: newText, cursor: active.start + replacement.length };
}

export type HashtagTextSegment = { type: 'text'; value: string } | { type: 'hashtag'; raw: string; normalized: string };

/**
 * Splits `text` into plain-text and hashtag segments, in order, covering
 * every character of the original string — used to render a caption with
 * clickable hashtags (see src/components/HighlightedText.tsx) without a
 * separate, second copy of the "what counts as a hashtag" pattern. Reuses
 * the exact same HASHTAG_EXTRACT_PATTERN extractHashtags itself matches
 * against, so a caption's clickable spans and its stored `hashtags` field
 * can never disagree on what a hashtag even is.
 *
 * Unlike extractHashtags, this keeps the raw, as-typed casing for display
 * ("#Nightlife" segment `raw` stays "Nightlife") — only `normalized`
 * (what a tap actually navigates with) is lowercased. Every match this
 * regex produces is, by construction, already `normalizeHashtag`-valid,
 * so there's no separate re-validation step here.
 */
export function splitTextWithHashtags(text: string): HashtagTextSegment[] {
  const segments: HashtagTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(HASHTAG_EXTRACT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, index) });
    }
    const raw = match[1];
    segments.push({ type: 'hashtag', raw, normalized: raw.toLowerCase() });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }
  return segments;
}
