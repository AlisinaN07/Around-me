#!/usr/bin/env node
/**
 * Recommendation Engine — Step 4, Step 24 — one-time, additive, resumable
 * backfill of `likes`/`comments` into reels/{reelId}/stats/engagement and
 * content/{contentId}/stats/engagement for content published BEFORE the
 * Step 4 aggregation triggers existed, so it doesn't start at a
 * misleadingly-neutral 0 forever until its next like/comment.
 *
 * SCOPE — deliberately narrow, per Step 24's own explicit rules:
 *   - Backfills ONLY `likes` and `comments` — both directly reconstructable
 *     by counting each target's own existing `likes`/`comments`
 *     subcollections (the real, trusted source of truth — same one
 *     src/services/reelEngagement.ts/socialEngagement.ts already count via
 *     getCountFromServer today).
 *   - Does NOT backfill `saves`. Reconstructing it would need a
 *     collectionGroup query over every user's private `saved` subcollection
 *     filtered by (targetType, targetId) — a NEW composite index this
 *     project doesn't have, and Step 26 explicitly says not to add a
 *     speculative one just for a one-time backfill. Every stats doc this
 *     script creates simply starts with `saves: 0`, exactly like a doc the
 *     Step 4 triggers would create fresh — not a wrong value, an honestly
 *     incomplete one that any REAL new save from this point on corrects
 *     immediately (the onSavedCreated/onSavedDeleted triggers apply
 *     forward from here regardless of what this script does).
 *   - Does NOT, and NEVER WILL, fabricate watch/completion/notInterested/
 *     share/event-response data — there is no historical record of any of
 *     that to reconstruct (recommendationEvents only exists going forward
 *     from when tracking was added), so every stats doc this script
 *     creates leaves those fields at 0, same as a brand-new doc.
 *   - CREATE-ONLY: never overwrites an EXISTING stats/engagement doc, even
 *     a partial one — a doc that already exists may already reflect real
 *     post-Step-4 trigger activity, and clobbering it would either lose
 *     real data or double-count. `currentDocument: { exists: false }` is
 *     the actual enforcement of this, not just a check-then-write race.
 *
 * ============================================================================
 * PRIVILEGED ACCESS — same mechanism as scripts/migrations/backfill-post-likes.cjs
 * ============================================================================
 * Reuses the already-logged-in `firebase login` CLI session's OAuth token
 * (via `firebase-tools/lib/auth`) — not the Admin SDK, not a service
 * account. Talks to the real Firestore v1 REST API directly. Fails loudly
 * if no CLI session exists (run `npx firebase-tools login` first).
 *
 * ============================================================================
 * SAFETY
 * ============================================================================
 * - Hardcoded to exactly one project: around-me-6a437.
 * - Default mode (no flag, or --dry-run) performs ZERO writes.
 * - --apply is required, explicitly, to write anything.
 * - Bounded/paginated throughout — orderBy(__name__) + a document-reference
 *   cursor, same idiom as backfill-post-likes.cjs.
 * - Safety threshold: refuses --apply if more than SAFETY_THRESHOLD_DOCS
 *   stats documents would be created in one run.
 * - Resumable: every create targets a deterministic path with a
 *   `currentDocument.exists: false` precondition, so re-running after a
 *   partial failure only ever fills in what's still missing.
 *
 * ============================================================================
 * USAGE
 * ============================================================================
 *   node scripts/migrations/backfill-engagement-stats.cjs             (dry-run)
 *   node scripts/migrations/backfill-engagement-stats.cjs --dry-run    (dry-run)
 *   node scripts/migrations/backfill-engagement-stats.cjs --apply      (migrate)
 */

'use strict';

const apiv2 = require('firebase-tools/lib/apiv2');
const cliAuth = require('firebase-tools/lib/auth');

const PROJECT = 'around-me-6a437';
const PAGE_SIZE = 200;
const MAX_PAGES_PER_SCOPE = 500;
const SAFETY_THRESHOLD_DOCS = 50_000;

const MODE = process.argv.includes('--apply') ? 'apply' : 'dry-run';

function log(...args) {
  console.log(...args);
}
function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  throw new Error(`Cannot encode value: ${JSON.stringify(v)}`);
}
function encodeFields(obj) {
  const fields = {};
  for (const [k, val] of Object.entries(obj)) fields[k] = encodeValue(val);
  return fields;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null) out[k] = null;
    else if ('stringValue' in v) out[k] = v.stringValue;
    else if ('integerValue' in v) out[k] = parseInt(v.integerValue, 10);
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else out[k] = undefined;
  }
  return out;
}
function docIdOf(resourceName) {
  return resourceName.split('/').pop();
}

/** Every field the schema expects, so a created stats doc is immediately valid for firestore.rules' own future validation and for the client's own normalizeEngagementStats. */
function emptyStatsFields(likes, comments) {
  return encodeFields({
    impressions: 0,
    videoStarts: 0,
    meaningfulViews: 0,
    completions: 0,
    rewatches: 0,
    totalWatchMs: 0,
    totalWatchPercent: 0,
    watchSampleCount: 0,
    likes,
    comments,
    saves: 0,
    shares: 0,
    notInterestedCount: 0,
    eventOpens: 0,
    eventInterested: 0,
    eventGoing: 0,
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  });
}

async function main() {
  if (PROJECT !== 'around-me-6a437') {
    fail(`Refusing to run — this script is hardcoded to around-me-6a437, not ${PROJECT}.`);
  }

  const account = cliAuth.getGlobalDefaultAccount();
  if (!account) {
    fail('No stored firebase-tools login session found. Run `npx firebase-tools login` first.');
  }
  cliAuth.setRefreshToken(account.tokens.refresh_token);
  const client = new apiv2.Client({ auth: true, apiVersion: 'v1', urlPrefix: 'https://firestore.googleapis.com' });
  const docRoot = `/projects/${PROJECT}/databases/(default)/documents`;
  const resourceRoot = docRoot.slice(1);

  log(`Engagement-stats backfill — mode: ${MODE.toUpperCase()} — project: ${PROJECT}`);

  async function getDoc(path) {
    try {
      const res = await client.get(`${docRoot}/${path}`);
      return res.body;
    } catch (e) {
      if (e?.status === 404 || /NOT_FOUND/i.test(String(e?.message))) return null;
      throw e;
    }
  }

  async function rootPage(collectionId, whereClauses, cursor) {
    const structuredQuery = {
      from: [{ collectionId }],
      limit: PAGE_SIZE,
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    };
    if (whereClauses.length === 1) structuredQuery.where = { fieldFilter: whereClauses[0] };
    else if (whereClauses.length > 1) structuredQuery.where = { compositeFilter: { op: 'AND', filters: whereClauses.map((f) => ({ fieldFilter: f })) } };
    if (cursor) structuredQuery.startAt = { values: [{ referenceValue: cursor }], before: false };
    const res = await client.post(`${docRoot}:runQuery`, { structuredQuery });
    return (res.body || []).filter((r) => r.document).map((r) => r.document);
  }

  /** Counts every document in one target's subcollection — plain pagination, not a count aggregation query, so it works identically regardless of index availability. Fine at this project's current per-target scale (a handful of likes/comments per Reel/Post, not millions). */
  async function countSubcollection(parentDocPath, collectionId) {
    let total = 0;
    let cursor = null;
    for (let page = 0; page < MAX_PAGES_PER_SCOPE; page += 1) {
      const structuredQuery = {
        from: [{ collectionId }],
        limit: PAGE_SIZE,
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        select: { fields: [{ fieldPath: '__name__' }] }, // only need doc identity to count — no field data transferred
      };
      if (cursor) structuredQuery.startAt = { values: [{ referenceValue: cursor }], before: false };
      const res = await client.post(`${docRoot}/${parentDocPath}:runQuery`, { structuredQuery });
      const docs = (res.body || []).filter((r) => r.document).map((r) => r.document);
      total += docs.length;
      if (docs.length < PAGE_SIZE) break;
      cursor = docs[docs.length - 1].name;
    }
    return total;
  }

  async function createStatsIfAbsent(kind, id, likes, comments) {
    const statsPath = `${kind === 'reel' ? 'reels' : 'content'}/${id}/stats/engagement`;
    try {
      await client.post(`${docRoot}:commit`, {
        writes: [
          {
            update: { name: `${resourceRoot}/${statsPath}`, fields: emptyStatsFields(likes, comments) },
            currentDocument: { exists: false },
          },
        ],
      });
      return 'created';
    } catch (e) {
      // FAILED_PRECONDITION — a stats doc already exists (created by a
      // real Step 4 trigger, or a prior run of this same script).
      // Correctly skipped, never overwritten.
      if (/FAILED_PRECONDITION|ALREADY_EXISTS/i.test(String(e?.message))) return 'alreadyExists';
      throw e;
    }
  }

  async function scanAndBackfill(kind, collectionId, whereClauses) {
    const counts = { scanned: 0, alreadyHadStats: 0, created: 0, wouldCreate: 0, errors: 0, hitPageCap: false };
    let cursor = null;
    for (let page = 0; page < MAX_PAGES_PER_SCOPE; page += 1) {
      const docs = await rootPage(collectionId, whereClauses, cursor);
      if (docs.length === 0) break;
      for (const doc of docs) {
        counts.scanned += 1;
        const id = docIdOf(doc.name);
        const statsPath = `${kind === 'reel' ? 'reels' : 'content'}/${id}/stats/engagement`;
        const existingStats = await getDoc(statsPath);
        if (existingStats) {
          counts.alreadyHadStats += 1;
          continue;
        }
        const parentPath = kind === 'reel' ? `reels/${id}` : `content/${id}`;
        const [likes, comments] = await Promise.all([countSubcollection(parentPath, 'likes'), countSubcollection(parentPath, 'comments')]);

        if (MODE === 'dry-run') {
          counts.wouldCreate += 1;
          continue;
        }
        try {
          const outcome = await createStatsIfAbsent(kind, id, likes, comments);
          if (outcome === 'created') counts.created += 1;
          else counts.alreadyHadStats += 1;
        } catch (e) {
          counts.errors += 1;
          log(`  ERROR creating stats for ${statsPath}:`, e?.message || e);
        }
      }
      if (docs.length < PAGE_SIZE) break;
      cursor = docs[docs.length - 1].name;
      if (page === MAX_PAGES_PER_SCOPE - 1) counts.hitPageCap = true;
    }
    return counts;
  }

  if (MODE === 'apply') {
    // Pre-flight dry count against BOTH collections before writing anything.
    log('\n--- Pre-flight scan (read-only, counting how many stats docs would be created) ---');
    const preflightReels = await scanAndBackfillDryCountOnly('reel', 'reels', [{ field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'published' } }]);
    const preflightContent = await scanAndBackfillDryCountOnly('content', 'content', [{ field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'published' } }]);
    const totalWouldCreate = preflightReels.wouldCreate + preflightContent.wouldCreate;
    log(`Reels missing stats: ${preflightReels.wouldCreate} (of ${preflightReels.scanned} published)`);
    log(`Content missing stats: ${preflightContent.wouldCreate} (of ${preflightContent.scanned} published)`);
    if (totalWouldCreate > SAFETY_THRESHOLD_DOCS) {
      fail(`SAFETY THRESHOLD EXCEEDED: would create ${totalWouldCreate} stats docs > ${SAFETY_THRESHOLD_DOCS}. Refusing to --apply.`);
    }
  }

  async function scanAndBackfillDryCountOnly(kind, collectionId, whereClauses) {
    const counts = { scanned: 0, wouldCreate: 0 };
    let cursor = null;
    for (let page = 0; page < MAX_PAGES_PER_SCOPE; page += 1) {
      const docs = await rootPage(collectionId, whereClauses, cursor);
      if (docs.length === 0) break;
      for (const doc of docs) {
        counts.scanned += 1;
        const id = docIdOf(doc.name);
        const statsPath = `${kind === 'reel' ? 'reels' : 'content'}/${id}/stats/engagement`;
        const existingStats = await getDoc(statsPath);
        if (!existingStats) counts.wouldCreate += 1;
      }
      if (docs.length < PAGE_SIZE) break;
      cursor = docs[docs.length - 1].name;
    }
    return counts;
  }

  log(`\n--- ${kindLabel('reel')} ---`);
  const reelCounts = await scanAndBackfill('reel', 'reels', [{ field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'published' } }]);
  printCounts(reelCounts);

  log(`\n--- ${kindLabel('content')} ---`);
  const contentCounts = await scanAndBackfill('content', 'content', [{ field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'published' } }]);
  printCounts(contentCounts);

  if (MODE === 'dry-run') {
    log('\nDry-run complete. No writes performed. Re-run with --apply to actually create the missing stats docs.');
  } else {
    log('\nApply complete.');
    if (reelCounts.errors > 0 || contentCounts.errors > 0) {
      log('Some documents failed — safe to re-run this script; it only ever fills in what is still missing.');
      process.exit(1);
    }
  }

  function kindLabel(kind) {
    return kind === 'reel' ? 'Reels' : 'Content (Posts/Activities/Events)';
  }
  function printCounts(counts) {
    log('scanned:', counts.scanned);
    log('alreadyHadStats:', counts.alreadyHadStats);
    if (MODE === 'dry-run') log('wouldCreate:', counts.wouldCreate);
    else log('created:', counts.created);
    log('errors:', counts.errors);
    if (counts.hitPageCap) log('WARNING: hit MAX_PAGES_PER_SCOPE cap — scan may be incomplete, re-run to continue.');
  }
}

main().catch((error) => {
  console.error('FATAL', error?.message || error);
  process.exit(1);
});
