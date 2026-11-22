/**
 * City discovery date-window helpers (Step 22) — centralizes the
 * Happening Now / Today / Tonight / Upcoming boundary math so it isn't
 * scattered as ad-hoc `new Date(...)` arithmetic across screens.
 *
 * TIMEZONE MVP LIMITATION: content/{contentId} has no timezone field —
 * startsAt/endsAt are plain UTC Timestamps, and the app launches
 * Sweden-first, so "today"/"tonight" day boundaries are computed against
 * a single fixed CITY_TIMEZONE ('Europe/Stockholm') rather than each
 * city's real local timezone. This is intentionally NOT persisted onto
 * any content doc — it's a display/query-boundary constant only. Real
 * per-city timezone metadata is future work for international expansion
 * (see README).
 */

export const CITY_TIMEZONE = 'Europe/Stockholm';

/** The hour (in CITY_TIMEZONE) at which "Today" becomes "Tonight". */
const EVENING_START_HOUR = 17;

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  // Intl can format the midnight hour as "24" for hour12: false in some
  // environments — normalize back to 0 so downstream arithmetic (and the
  // 17:00 evening-start comparison) stays correct.
  const hour = Number(map.hour) % 24;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour, minute: Number(map.minute), second: Number(map.second) };
}

/**
 * Converts a wall-clock date/time IN `timeZone` to the absolute UTC
 * instant it represents. Handles DST correctly by resampling the zone's
 * actual offset at the guessed instant rather than assuming a fixed
 * offset — necessary since Europe/Stockholm shifts by an hour twice a
 * year.
 */
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): Date {
  const utcGuessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const guessDate = new Date(utcGuessMs);
  const partsAtGuess = getZonedParts(guessDate, timeZone);
  const guessAsIfUtc = Date.UTC(
    partsAtGuess.year,
    partsAtGuess.month - 1,
    partsAtGuess.day,
    partsAtGuess.hour,
    partsAtGuess.minute,
    partsAtGuess.second
  );
  const offsetMs = guessAsIfUtc - utcGuessMs;
  return new Date(utcGuessMs - offsetMs);
}

/** Adds `delta` calendar days to a Y-M-D triple, independent of any timezone. */
function addCalendarDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() + delta);
  return { year: utcDate.getUTCFullYear(), month: utcDate.getUTCMonth() + 1, day: utcDate.getUTCDate() };
}

export type DateWindow = { start: Date; end: Date };

/** [start, end) covering one full calendar day in `timeZone`, containing `now`. */
export function getCityDayWindow(now: Date = new Date(), timeZone: string = CITY_TIMEZONE): DateWindow {
  const { year, month, day } = getZonedParts(now, timeZone);
  const start = zonedTimeToUtc(year, month, day, 0, 0, 0, timeZone);
  const tomorrow = addCalendarDays(year, month, day, 1);
  const end = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0, 0, timeZone);
  return { start, end };
}

/** [17:00 local, next midnight local) — the "Tonight" subset of today. */
export function getTonightWindow(now: Date = new Date(), timeZone: string = CITY_TIMEZONE): DateWindow {
  const { year, month, day } = getZonedParts(now, timeZone);
  const start = zonedTimeToUtc(year, month, day, EVENING_START_HOUR, 0, 0, timeZone);
  const tomorrow = addCalendarDays(year, month, day, 1);
  const end = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0, 0, timeZone);
  return { start, end };
}

/**
 * The single "Today"-hierarchy discovery section (see Section 5 of the
 * Step 22 spec: one clean UI, not two near-duplicate sections). Before
 * the evening cutoff it covers the whole remaining day ("Today"); from
 * the cutoff on, it narrows to the evening-only window and relabels
 * itself "Tonight" — so the section never shows the same handful of
 * items under both labels.
 */
export function getTodayOrTonightWindow(now: Date = new Date(), timeZone: string = CITY_TIMEZONE): DateWindow & { label: 'Today' | 'Tonight' } {
  const { hour } = getZonedParts(now, timeZone);
  if (hour >= EVENING_START_HOUR) {
    return { ...getTonightWindow(now, timeZone), label: 'Tonight' };
  }
  return { ...getCityDayWindow(now, timeZone), label: 'Today' };
}

/**
 * [windowEnd, +∞) — deliberately starts exactly where the Today/Tonight
 * window ends (not at `now`), so Upcoming and Today/Tonight never overlap
 * by construction and need no client-side dedup between themselves.
 * Happening Now can still overlap with Today/Tonight (an already-started
 * item that hasn't ended yet) — that dedup is handled by the caller
 * filtering Today's results against Happening Now's contentIds (see
 * fetchDiscoverySections in src/services/content.ts).
 *
 * Deliberately open-ended, no further cutoff — "Coming Up" is meant to
 * show every real upcoming Event, however far out, not just the next few
 * days. This used to cap at `afterWindowEnd + 7 days`; per explicit
 * product feedback that a real, further-out Event was going missing,
 * that date cutoff is gone. The read cost stays bounded exactly the same
 * way it already was — fetchByStartsAtWindowByType's own `limitCount`
 * (SECTION_LIMIT on the Events tab), ordered soonest-first — this only
 * removes a SECOND, redundant cap that was cutting things off before
 * that limit ever came into play.
 */
export function getUpcomingWindow(afterWindowEnd: Date): { start: Date } {
  return { start: afterWindowEnd };
}

/**
 * The real local weekend (Saturday 00:00 through Monday 00:00, exclusive)
 * in `timeZone` — Step 26 Section 18: weekend means Saturday+Sunday only,
 * never Friday. If `now` already falls on a Saturday or Sunday, the window
 * starts at the beginning of today rather than next week's Saturday, so an
 * in-progress weekend isn't skipped. Deliberately pure date math with no
 * query of its own — callers filter an already-fetched Upcoming list
 * against this window client-side (see events.tsx), so no new Firestore
 * query or index is introduced by "This Weekend" as a concept.
 */
export function getWeekendWindow(now: Date = new Date(), timeZone: string = CITY_TIMEZONE): DateWindow {
  const { year, month, day } = getZonedParts(now, timeZone);
  // JS getDay()-style weekday (0=Sun..6=Sat), derived from the same Y-M-D
  // triple via a UTC anchor so it reflects the zoned calendar date, not the
  // machine's local date.
  const weekdayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  // Offset (in days, possibly negative) from today to "this weekend"'s
  // Saturday: 0 if today already is Saturday, -1 if today is Sunday
  // (Saturday was yesterday), otherwise however many days until the next
  // Saturday.
  const saturdayOffset = weekdayIndex === 6 ? 0 : weekdayIndex === 0 ? -1 : 6 - weekdayIndex;
  const saturday = addCalendarDays(year, month, day, saturdayOffset);
  const start = zonedTimeToUtc(saturday.year, saturday.month, saturday.day, 0, 0, 0, timeZone);
  const mondayAfter = addCalendarDays(saturday.year, saturday.month, saturday.day, 2);
  const end = zonedTimeToUtc(mondayAfter.year, mondayAfter.month, mondayAfter.day, 0, 0, 0, timeZone);
  return { start, end };
}

/** startsAt <= now AND endsAt >= now — the exact Happening Now definition (Step 22 Section 4). */
export function isHappeningNow(item: { startsAt: { toMillis(): number }; endsAt: { toMillis(): number } }, now: Date = new Date()): boolean {
  const nowMs = now.getTime();
  return item.startsAt.toMillis() <= nowMs && item.endsAt.toMillis() >= nowMs;
}
