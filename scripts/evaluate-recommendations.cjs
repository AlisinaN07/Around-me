#!/usr/bin/env node
/**
 * Recommendation Engine — Step 6, Step 20 — read-only admin/dev offline
 * evaluation report. Reads the REAL backend aggregates that
 * functions/src/metrics.ts already builds (recommendationMetrics/reels_*,
 * recommendationMetrics/events_*, users/*\/feedSessions/*) and prints a
 * human-readable report. Never fabricates a number — every rate below is
 * either computed from a real aggregate or explicitly printed as "N/A —
 * not tracked" when this pass genuinely cannot compute it (see the
 * KNOWN LIMITATIONS section at the bottom of the report, and this file's
 * own comments next to each metric that can't be computed).
 *
 * This is intentionally a script, not a dashboard — Step 20's own "no
 * polished dashboard; prefer a backend aggregate + a script that prints a
 * report" instruction, and Step 29's "instrumentation first, do not tune
 * production ranking from this data yet."
 *
 * ============================================================================
 * PRIVILEGED ACCESS — same mechanism as scripts/migrations/*.cjs
 * ============================================================================
 * Reuses the already-logged-in `firebase login` CLI session's OAuth token
 * (via `firebase-tools/lib/auth`) — not the Admin SDK, not a service
 * account. Talks to the real Firestore v1 REST API directly, read-only
 * (no `:commit` call anywhere in this file).
 *
 * ============================================================================
 * USAGE
 * ============================================================================
 *   node scripts/evaluate-recommendations.cjs               (last 7 days)
 *   node scripts/evaluate-recommendations.cjs --days=14      (last 14 days)
 */

'use strict';

const apiv2 = require('firebase-tools/lib/apiv2');
const cliAuth = require('firebase-tools/lib/auth');

const PROJECT = 'around-me-6a437';
const PAGE_SIZE = 200;
const MAX_SESSION_PAGES = 500; // safety cap, same idiom as scripts/migrations/*.cjs

const daysArg = process.argv.find((a) => a.startsWith('--days='));
const WINDOW_DAYS = daysArg ? Math.max(1, parseInt(daysArg.split('=')[1], 10) || 7) : 7;

// Kept in sync with src/services/recommendations/experimentAnalysis.ts
// (Step 24/25). Reused here for the OVERALL feed-health report too, not
// just A/B comparisons — Step 25's "do not fake conclusions from a
// handful of sessions" applies just as much to a plain trend report.
const MIN_SESSIONS_PER_VARIANT = 30;
const MIN_MEANINGFUL_VIEWS_PER_VARIANT = 200;

// Kept in sync with src/services/recommendations/guardrails.ts's
// GUARDRAIL_THRESHOLDS (Step 23). Duplicated as plain numbers here
// because this is a standalone .cjs script reading the real Firestore
// REST API directly — it does not run the app's TS build.
const GUARDRAIL_THRESHOLDS = {
  notInterestedRateFactor: 2,
  quickSkipRateFactor: 1.5,
};

function log(...args) {
  console.log(...args);
}
function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Firestore REST value (de)serialization — same shape as scripts/migrations,
// extended with mapValue/arrayValue/doubleValue since this script reads
// nested bucket breakdowns (reels_{date}.known.impressions) and arrays
// (feedSessions.uniqueCreatorIds).
// ---------------------------------------------------------------------------
function decodeValue(v) {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  return undefined;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}
function docIdOf(resourceName) {
  return resourceName.split('/').pop();
}
function num(obj, field) {
  const v = obj && obj[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
/** A percentage-style ratio, printed as "N/A" (never 0, never a fabricated 0%) when the denominator is 0 — a genuinely undefined rate, not a healthy one. */
function ratio(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}
function pct(r) {
  return r === null ? 'N/A (no data)' : `${(r * 100).toFixed(1)}%`;
}

function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}
/** [oldest ... newest] array of YYYY-MM-DD strings, `count` days ending `endOffsetDays` before today (0 = today included). */
function dateRange(count, endOffsetDays) {
  const dates = [];
  const now = new Date();
  for (let i = count - 1 + endOffsetDays; i >= endOffsetDays; i -= 1) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dates.push(utcDateString(d));
  }
  return dates;
}

async function main() {
  if (PROJECT !== 'around-me-6a437') {
    fail(`Refusing to run — this script is hardcoded to around-me-6a437, not ${PROJECT}.`);
  }
  const account = cliAuth.getGlobalDefaultAccount();
  if (!account) fail('No stored firebase-tools login session found. Run `npx firebase-tools login` first.');
  cliAuth.setRefreshToken(account.tokens.refresh_token);
  const client = new apiv2.Client({ auth: true, apiVersion: 'v1', urlPrefix: 'https://firestore.googleapis.com' });
  const docRoot = `/projects/${PROJECT}/databases/(default)/documents`;

  async function getDoc(path) {
    try {
      const res = await client.get(`${docRoot}/${path}`);
      return decodeFields(res.body.fields);
    } catch (e) {
      if (e?.status === 404 || /NOT_FOUND/i.test(String(e?.message))) return null;
      throw e;
    }
  }

  /** Sums a list of daily recommendationMetrics docs into one totals object. Missing docs (a day with zero recommendation activity — likely, given this project's current volume) simply contribute nothing, exactly as if that day had all-zero fields. */
  function sumDailyDocs(docs, numericFields, nestedBucketFields) {
    const totals = {};
    for (const f of numericFields) totals[f] = 0;
    for (const b of nestedBucketFields) totals[b] = { impressions: 0, meaningfulViews: 0, saves: 0, notInterested: 0 };
    let daysWithData = 0;
    for (const doc of docs) {
      if (!doc) continue;
      daysWithData += 1;
      for (const f of numericFields) totals[f] += num(doc, f);
      for (const b of nestedBucketFields) {
        const bucket = doc[b];
        if (bucket && typeof bucket === 'object') {
          totals[b].impressions += num(bucket, 'impressions');
          totals[b].meaningfulViews += num(bucket, 'meaningfulViews');
          totals[b].saves += num(bucket, 'saves');
          totals[b].notInterested += num(bucket, 'notInterested');
        }
      }
    }
    totals.daysWithData = daysWithData;
    return totals;
  }

  const REEL_FIELDS = [
    'impressions',
    'meaningfulViews',
    'completions',
    'rewatches',
    'quickSkips',
    'likes',
    'saves',
    'shares',
    'comments',
    'notInterested',
    'totalWatchPercentSum',
    'watchSampleCount',
    'sameCityImpressions',
    'secondaryCityImpressions',
  ];
  const REEL_BUCKETS = ['known', 'related', 'discovery', 'collaborativeDiscovery'];
  const EVENT_FIELDS = ['opens', 'sameCityOpens', 'secondaryCityOpens', 'interested', 'going'];

  async function loadReelTotals(dates) {
    const docs = await Promise.all(dates.map((d) => getDoc(`recommendationMetrics/reels_${d}`)));
    return sumDailyDocs(docs, REEL_FIELDS, REEL_BUCKETS);
  }
  async function loadEventTotals(dates) {
    const docs = await Promise.all(dates.map((d) => getDoc(`recommendationMetrics/events_${d}`)));
    return sumDailyDocs(docs, EVENT_FIELDS, []);
  }

  /**
   * Every feedSessions doc across every user, via a collectionGroup query.
   * Deliberately no `where` filter on startedAt — this project's current
   * volume is small enough that a plain paginated scan (same idiom as
   * scripts/migrations/backfill-engagement-stats.cjs's countSubcollection)
   * is fine, and it avoids needing a new composite index just for a
   * one-off report (Step 26's own "don't add a speculative index").
   * Filtering by the requested date window happens client-side below.
   */
  async function loadAllSessions() {
    const sessions = [];
    let cursor = null;
    for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
      const structuredQuery = {
        from: [{ collectionId: 'feedSessions', allDescendants: true }],
        limit: PAGE_SIZE,
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      };
      if (cursor) structuredQuery.startAt = { values: [{ referenceValue: cursor }], before: false };
      const res = await client.post(`${docRoot}:runQuery`, { structuredQuery });
      const docs = (res.body || []).filter((r) => r.document).map((r) => r.document);
      for (const doc of docs) sessions.push({ id: docIdOf(doc.name), ...decodeFields(doc.fields) });
      if (docs.length < PAGE_SIZE) break;
      cursor = docs[docs.length - 1].name;
    }
    return sessions;
  }

  function summarizeSessions(sessions) {
    const s = {
      count: sessions.length,
      itemsShown: 0,
      meaningfulViews: 0,
      likes: 0,
      saves: 0,
      shares: 0,
      notInterested: 0,
      totalUniqueCreators: 0,
      totalUniqueCategories: 0,
      totalDurationMs: 0,
      sessionsWithDuration: 0,
      variantCounts: {},
      rankingVersionCounts: {},
    };
    for (const sess of sessions) {
      s.itemsShown += num(sess, 'itemsShown');
      s.meaningfulViews += num(sess, 'meaningfulViews');
      s.likes += num(sess, 'likes');
      s.saves += num(sess, 'saves');
      s.shares += num(sess, 'shares');
      s.notInterested += num(sess, 'notInterested');
      s.totalUniqueCreators += Array.isArray(sess.uniqueCreatorIds) ? sess.uniqueCreatorIds.length : 0;
      s.totalUniqueCategories += Array.isArray(sess.uniqueCategoryIds) ? sess.uniqueCategoryIds.length : 0;
      if (typeof sess.startedAt === 'number' && typeof sess.lastEventAt === 'number' && sess.lastEventAt >= sess.startedAt) {
        s.totalDurationMs += sess.lastEventAt - sess.startedAt;
        s.sessionsWithDuration += 1;
      }
      const variant = typeof sess.variantId === 'string' && sess.variantId ? sess.variantId : 'control';
      s.variantCounts[variant] = (s.variantCounts[variant] || 0) + 1;
      const rv = typeof sess.rankingVersion === 'string' && sess.rankingVersion ? sess.rankingVersion : 'unknown';
      s.rankingVersionCounts[rv] = (s.rankingVersionCounts[rv] || 0) + 1;
    }
    return s;
  }

  log(`Recommendation evaluation report — project: ${PROJECT} — window: last ${WINDOW_DAYS} day(s) (UTC)`);
  log(`Generated: ${new Date().toISOString()}\n`);

  const currentDates = dateRange(WINDOW_DAYS, 0);
  const baselineDates = dateRange(WINDOW_DAYS, WINDOW_DAYS); // the WINDOW_DAYS days immediately before the current window

  const [reelsCurrent, reelsBaseline, eventsCurrent] = await Promise.all([
    loadReelTotals(currentDates),
    loadReelTotals(baselineDates),
    loadEventTotals(currentDates),
  ]);

  const allSessions = await loadAllSessions();
  const windowStartMs = new Date(currentDates[0]).getTime();
  const sessionsInWindow = allSessions.filter((s) => typeof s.startedAt === 'number' && s.startedAt >= windowStartMs);
  const sessionSummary = summarizeSessions(sessionsInWindow);

  // ---------------------------------------------------------------------
  log(`=== HOME FOR YOU — LAST ${WINDOW_DAYS} DAYS ===`);
  log(`Days with recorded reel activity: ${reelsCurrent.daysWithData} / ${currentDates.length}`);
  log(`Sessions: ${sessionSummary.count}${sessionSummary.count < MIN_SESSIONS_PER_VARIANT ? '  (INSUFFICIENT_DATA — below the ' + MIN_SESSIONS_PER_VARIANT + '-session floor; treat every rate below as directional only)' : ''}`);
  log(`Impressions: ${reelsCurrent.impressions}`);
  log(`Meaningful view rate: ${pct(ratio(reelsCurrent.meaningfulViews, reelsCurrent.impressions))}`);
  log(`Completion rate (of meaningful views): ${pct(ratio(reelsCurrent.completions, reelsCurrent.meaningfulViews))}`);
  log(`Rewatch rate (of meaningful views): ${pct(ratio(reelsCurrent.rewatches, reelsCurrent.meaningfulViews))}`);
  log(`Save rate (of impressions): ${pct(ratio(reelsCurrent.saves, reelsCurrent.impressions))}`);
  log(`Like rate (of impressions): ${pct(ratio(reelsCurrent.likes, reelsCurrent.impressions))}`);
  log(`Share rate (of impressions): ${pct(ratio(reelsCurrent.shares, reelsCurrent.impressions))}`);
  log(`Quick-skip rate (of watch attempts): ${pct(ratio(reelsCurrent.quickSkips, reelsCurrent.quickSkips + reelsCurrent.meaningfulViews))}`);
  log(`Not-interested rate (of impressions): ${pct(ratio(reelsCurrent.notInterested, reelsCurrent.impressions))}`);
  log(`Avg watch % per watch sample: ${pct(ratio(reelsCurrent.totalWatchPercentSum, reelsCurrent.watchSampleCount))}`);
  log(`Same-city impressions: ${reelsCurrent.sameCityImpressions}  |  Secondary-city (exploration) impressions: ${reelsCurrent.secondaryCityImpressions}`);
  log('');
  log('Per-bucket breakdown (exploration bucket the item was shown under):');
  for (const bucket of ['known', 'related', 'discovery']) {
    const b = reelsCurrent[bucket];
    log(`  ${bucket.padEnd(10)} impressions=${b.impressions}  meaningfulViewRate=${pct(ratio(b.meaningfulViews, b.impressions))}  saveRate=${pct(ratio(b.saves, b.impressions))}  notInterestedRate=${pct(ratio(b.notInterested, b.impressions))}`);
  }
  {
    const cd = reelsCurrent.collaborativeDiscovery;
    log(`  ${'collab.disc.'.padEnd(10)} impressions=${cd.impressions}  meaningfulViewRate=${pct(ratio(cd.meaningfulViews, cd.impressions))}  saveRate=${pct(ratio(cd.saves, cd.impressions))}`);
  }
  log('');
  log('Session diversity & engagement:');
  log(`  Avg items shown/session: ${sessionSummary.count ? (sessionSummary.itemsShown / sessionSummary.count).toFixed(1) : 'N/A (no data)'}`);
  log(`  Avg meaningful views/session: ${sessionSummary.count ? (sessionSummary.meaningfulViews / sessionSummary.count).toFixed(1) : 'N/A (no data)'}`);
  log(`  Avg unique creators/session: ${sessionSummary.count ? (sessionSummary.totalUniqueCreators / sessionSummary.count).toFixed(1) : 'N/A (no data)'}`);
  log(`  Avg unique categories/session: ${sessionSummary.count ? (sessionSummary.totalUniqueCategories / sessionSummary.count).toFixed(1) : 'N/A (no data)'}`);
  log(`  Avg session duration: ${sessionSummary.sessionsWithDuration ? `${Math.round(sessionSummary.totalDurationMs / sessionSummary.sessionsWithDuration / 1000)}s (from ${sessionSummary.sessionsWithDuration} sessions with >0 duration)` : 'N/A (no data)'}`);
  log(`  Ranking version distribution: ${JSON.stringify(sessionSummary.rankingVersionCounts)}`);
  log(`  Experiment variant distribution: ${JSON.stringify(sessionSummary.variantCounts)}`);

  // ---------------------------------------------------------------------
  log(`\n=== EVENTS FOR YOU — LAST ${WINDOW_DAYS} DAYS ===`);
  log(`Opens: ${eventsCurrent.opens}  (same-city: ${eventsCurrent.sameCityOpens}, secondary-city: ${eventsCurrent.secondaryCityOpens})`);
  log(`Interested (of opens): ${eventsCurrent.interested}  —  ${pct(ratio(eventsCurrent.interested, eventsCurrent.opens))}`);
  log(`Going (of interested): ${eventsCurrent.going}  —  ${pct(ratio(eventsCurrent.going, eventsCurrent.interested))}`);
  log('NOTE: "event open rate relative to impressions" cannot be computed — Events/Posts/Activities shown in a feed are never given an `impression` recommendationEvent today (only Reels are — see ReelFeedItem.tsx). See KNOWN LIMITATIONS below.');

  // ---------------------------------------------------------------------
  log('\n=== GUARDRAILS (current window vs. the prior window of the same length) ===');
  const curNotInterested = ratio(reelsCurrent.notInterested, reelsCurrent.impressions);
  const baseNotInterested = ratio(reelsBaseline.notInterested, reelsBaseline.impressions);
  const curQuickSkip = ratio(reelsCurrent.quickSkips, reelsCurrent.quickSkips + reelsCurrent.meaningfulViews);
  const baseQuickSkip = ratio(reelsBaseline.quickSkips, reelsBaseline.quickSkips + reelsBaseline.meaningfulViews);

  function reportGuardrail(name, baseline, current, factor, direction) {
    if (baseline === null || current === null || baseline === 0) {
      log(`  ${name}: N/A (insufficient data in one or both windows — baseline=${baseline === null ? 'N/A' : pct(baseline)}, current=${current === null ? 'N/A' : pct(current)})`);
      return;
    }
    const violated = direction === 'up' ? current >= baseline * factor : current <= baseline * factor;
    log(`  ${name}: baseline=${pct(baseline)} current=${pct(current)} — ${violated ? `⚠ VIOLATION (moved ${direction === 'up' ? 'past' : 'below'} ${factor}x baseline)` : 'healthy'}`);
  }
  reportGuardrail('notInterestedRate', baseNotInterested, curNotInterested, GUARDRAIL_THRESHOLDS.notInterestedRateFactor, 'up');
  reportGuardrail('quickSkipRate', baseQuickSkip, curQuickSkip, GUARDRAIL_THRESHOLDS.quickSkipRateFactor, 'up');
  log('  eventOpenRate: N/A — no Events "shown" denominator exists yet (see KNOWN LIMITATIONS).');
  log('  repeatExposureRate: N/A — computed client-side per-viewer for ranking (ranking.ts scoreRepeatExposurePenalty) but never emitted/aggregated server-side (see KNOWN LIMITATIONS).');

  // ---------------------------------------------------------------------
  log('\n=== EXPERIMENT: collaborative_weight_v1 (control=production weight, treatment=0.12) ===');
  const controlSessions = sessionSummary.variantCounts.control || 0;
  const treatmentSessions = sessionSummary.variantCounts.treatment || 0;
  log(`Assigned sessions in window — control: ${controlSessions}, treatment: ${treatmentSessions}`);
  if (treatmentSessions === 0) {
    log('Result: INSUFFICIENT_DATA — the experiment is disabled in production (assignExperimentVariant always resolves to "control" while disabled, per Step 12), so no treatment data exists yet by design. This is expected, not a bug.');
  } else if (controlSessions < MIN_SESSIONS_PER_VARIANT || treatmentSessions < MIN_SESSIONS_PER_VARIANT) {
    log(`Result: INSUFFICIENT_DATA — need at least ${MIN_SESSIONS_PER_VARIANT} sessions per variant (have control=${controlSessions}, treatment=${treatmentSessions}).`);
  } else {
    log('Result: enough sessions exist to attempt src/services/recommendations/experimentAnalysis.ts\'s compareExperimentVariants — re-run with real per-variant meaningful-view-rate values once the experiment is actually enabled.');
  }

  // ---------------------------------------------------------------------
  log('\n=== KNOWN LIMITATIONS (this pass genuinely cannot compute these — not fabricated) ===');
  log('- Follow-after-view rate: a `follow` recommendationEvent always has contentType="content" (it targets the followed USER, not the reel being watched), so it cannot be joined back to "was this reel just viewed" with a simple additive counter.');
  log('- Events funnel excludes not_interested/share: contentType="content" also covers text Posts/Activities with no field distinguishing which, so attributing those two actions to the Events funnel specifically would misreport it.');
  log('- Event open rate vs. impressions: Events/Posts/Activities shown in a feed are never given an `impression` event today (only Reels are), so there is no "shown" denominator for this rate.');
  log('- Repeat exposure rate: tracked client-side only, for ranking purposes (ranking.ts), never emitted as a recommendationEvent field or aggregated server-side.');
  log('- Latency (ForYouReelsPage.latencyMs) and Firestore read-cost estimates: computed client-side and logged via console.log under __DEV__ only — never persisted, so this backend-aggregate script cannot report them. See src/app/(app)/(tabs)/index.tsx.');
}

main().catch((error) => {
  console.error('FATAL', error?.message || error);
  process.exit(1);
});
