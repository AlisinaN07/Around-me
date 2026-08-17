/**
 * Display-only time formatting. Firestore always stores Timestamp/Date —
 * never a preformatted string — these functions only run at render time.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "Just now" / "8 min ago" / "3h ago" / "5d ago" style relative time, for post timestamps. */
export function formatTimeAgo(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < MINUTE_MS) {
    return 'Just now';
  }
  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return `${minutes} min ago`;
  }
  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return `${hours}h ago`;
  }
  const days = Math.floor(diffMs / DAY_MS);
  if (days < 7) {
    return `${days}d ago`;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "Today, 19:00" / "Tomorrow, 18:30" / "Fri, 19:00" style time, for activity/event start times. */
export function formatEventTime(date: Date, now: Date = new Date()): string {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (isSameDay(date, now)) {
    return `Today, ${formatClock(date)}`;
  }
  if (isSameDay(date, tomorrow)) {
    return `Tomorrow, ${formatClock(date)}`;
  }
  const withinWeek = date.getTime() - now.getTime() < 7 * DAY_MS;
  if (withinWeek) {
    return `${date.toLocaleDateString(undefined, { weekday: 'short' })}, ${formatClock(date)}`;
  }
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${formatClock(date)}`;
}

/** Compact "Aug 17, 2026" date label for date-picker pills. */
export function formatDatePill(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Compact "19:00" time label for time-picker pills. */
export function formatTimePill(date: Date): string {
  return formatClock(date);
}

/** Rounds up to the next :00/:30 mark — a sensible default starting point for a new event/activity. */
export function roundUpToNextHalfHour(date: Date): Date {
  const next = new Date(date);
  const remainder = next.getMinutes() % 30;
  if (remainder !== 0) {
    next.setMinutes(next.getMinutes() + (30 - remainder));
  }
  next.setSeconds(0, 0);
  return next;
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
