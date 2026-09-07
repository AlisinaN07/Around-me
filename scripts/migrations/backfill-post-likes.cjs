#!/usr/bin/env node
/**
 * Step 41.2H.3 — one-time, additive, resumable backfill of postLikes/{likeId}
 * (Step 41.2H.1's authoritative received-Like relationship) for every
 * CURRENTLY SURVIVING eligible social Post Like that predates the
 * relationship model, or was otherwise never migrated.
 *
 * ============================================================================
 * PRIVILEGED ACCESS MECHANISM — read this before running anything
 * ============================================================================
 * This sandbox/environment has no Application Default Credentials, no
 * gcloud CLI, and no service-account JSON (see Step 41.2C.2's own
 * discovery). This script reuses the already-logged-in `firebase login`
 * CLI session's OAuth token (via `firebase-tools/lib/auth`), exactly like
 * scripts/delete-test-documents.cjs — NOT the Admin SDK, NOT a service
 * account. That session's token carries this GCP project's IAM
 * permissions and writes straight past Firestore Security Rules. There is
 * no credential embedded in this file; it fails loudly if no CLI session
 * exists (run `npx firebase-tools login` first).
 *
 * This script talks to the real Firestore v1 REST API directly (GET,
 * :runQuery, :beginTransaction, :commit, :rollback) — including genuine
 * Firestore transactions (BeginTransaction + Commit-with-transaction-id is
 * Firestore's actual transaction primitive at the protocol level; the
 * Admin/Client SDKs' `runTransaction()` are wrappers around this exact
 * mechanism). This is a real transaction, not a read-sleep-write
 * approximation.
 *
 * ============================================================================
 * SAFETY
 * ============================================================================
 * - Hardcoded to exactly one project: around-me-6a437. Refuses to run
 *   against anything else.
 * - Default mode (no flag, or --dry-run) performs ZERO writes.
 * - --apply is required, explicitly, to write anything.
 * - --verify performs a full integrity check with ZERO writes (not even
 *   the completion marker).
 * - Additive only: creates missing postLikes rows and, at the very end,
 *   the private completion marker. NEVER deletes or rewrites a Like, a
 *   Post/Reel, a user, or an existing valid postLikes row.
 * - Bounded/paginated throughout (no unbounded get(), no offset
 *   pagination — orderBy(__name__) + a document-reference startAt cursor,
 *   Firestore's own stable-pagination idiom).
 * - Safety threshold: if the scan finds more than 100,000 missing
 *   relationships (see SAFETY_THRESHOLD below), --apply refuses to run.
 * - Resumable: every write targets a deterministic ID with a
 *   `currentDocument.exists: false` precondition, so re-running after a
 *   partial failure never double-creates or corrupts anything.
 *
 * ============================================================================
 * USAGE
 * ============================================================================
 *   node scripts/migrations/backfill-post-likes.cjs                (dry-run)
 *   node scripts/migrations/backfill-post-likes.cjs --dry-run       (dry-run)
 *   node scripts/migrations/backfill-post-likes.cjs --apply         (migrate)
 *   node scripts/migrations/backfill-post-likes.cjs --verify        (integrity check only)
 *
 * ============================================================================
 * HISTORICAL LIMITATION — read this before interpreting any output
 * ============================================================================
 * This migration can only ever backfill a Like that is CURRENTLY, STILL
 * VISIBLE in production: a real per-target Like document sitting under a
 * currently-published Reel or legacy text Post. Per the Step 41.2H.3A
 * read-only audit (see README.md), Likes that were already destroyed
 * before the lifetime-preservation architecture existed — because their
 * target was deleted (any reason) before Step 41.2H.2.1, or because the
 * liker's account was deleted before Step 41.2H.2.2 — left no surviving
 * record anywhere in this system (nested Like docs, notifications, and
 * every cross-user cleanup query all destroyed that information
 * unconditionally at the time). This script does not, and cannot, invent
 * or reconstruct those. See the completion marker's own documented
 * meaning at the bottom of this file.
 */

'use strict';

const apiv2 = require('firebase-tools/lib/apiv2');
const cliAuth = require('firebase-tools/lib/auth');

const PROJECT = 'around-me-6a437';
const PAGE_SIZE = 200;
// Bounded safety cap on how many PAGES of a single top-level collection (or
// a single target's nested `likes`) this script will ever page through in
// one run — far beyond this project's actual current scale, but a real
// bound rather than an unbounded loop either way.
const MAX_PAGES_PER_SCOPE = 500;
// Section 12's explicit stop condition — this project is cost-sensitive and
// pre-launch; a scope this large signals something unexpected and this
// script refuses to --apply against it without a human looking first.
const SAFETY_THRESHOLD_MISSING = 100_000;

const MARKER_COLLECTION = 'systemMigrations';
const MARKER_DOC_ID = 'postLikesBackfillV1';

const MODE = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--verify') ? 'verify' : 'dry-run';

function log(...args) {
  console.log(...args);
}
function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Firestore REST value encode/decode — this script both reads field values
// (to validate targets/Likes/postLikes) and writes them (to create a
// missing postLikes row), so it needs both directions, unlike this
// project's earlier privileged scripts (which only ever wrote or only ever
// checked existence).
// ---------------------------------------------------------------------------

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  throw new Error(`Cannot encode value: ${JSON.stringify(v)}`);
}
function encodeFields(obj) {
  const fields = {};
  for (const [k, val] of Object.entries(obj)) fields[k] = encodeValue(val);
  return fields;
}
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
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

  log(`Step 41.2H.3 backfill — mode: ${MODE.toUpperCase()} — project: ${PROJECT}`);

  // -------------------------------------------------------------------------
  // Low-level REST helpers
  // -------------------------------------------------------------------------

  async function getDoc(path) {
    try {
      const res = await client.get(`${docRoot}/${path}`);
      return res.body;
    } catch (e) {
      if (e?.status === 404 || /NOT_FOUND/i.test(String(e?.message))) return null;
      throw e;
    }
  }

  /** Root-collection page, ordered by __name__, equality-filtered, resumable via a document-reference cursor. */
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

  /** Subcollection page under one exact parent document — the parent is the URL itself, per the Firestore REST contract (never a body field). */
  async function subPage(parentDocPath, collectionId, cursor) {
    const structuredQuery = {
      from: [{ collectionId }],
      limit: PAGE_SIZE,
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    };
    if (cursor) structuredQuery.startAt = { values: [{ referenceValue: cursor }], before: false };
    const res = await client.post(`${docRoot}/${parentDocPath}:runQuery`, { structuredQuery });
    return (res.body || []).filter((r) => r.document).map((r) => r.document);
  }

  async function beginTransaction() {
    const res = await client.post(`${docRoot}:beginTransaction`, {});
    return res.body.transaction;
  }
  async function rollback(transaction) {
    try {
      await client.post(`${docRoot}:rollback`, { transaction });
    } catch {
      // Best-effort — an expired/already-resolved transaction rolling back
      // is not itself a failure worth surfacing.
    }
  }
  /** Reads several exact document paths inside one transaction's consistent snapshot. Returns a Map keyed by full resource name. */
  // Firestore "resource name" VALUES (as opposed to URL paths) must NOT
  // carry a leading slash — docRoot itself starts with one (correct for
  // apiv2's own path-joining in .get()/.post(path, ...)), so any resource
  // name placed INSIDE a request body (batchGet's `documents`, a write's
  // `update.name`) must use this bare form instead. Mixing the two up is a
  // real, silent-until-tested bug (a leading slash makes the server parse
  // an empty string where it expects "projects", failing with
  // INVALID_ARGUMENT) — verified against production directly before this
  // script was trusted with any real write.
  const resourceRoot = docRoot.slice(1);

  async function batchGetInTransaction(paths, transaction) {
    const documents = paths.map((p) => `${resourceRoot}/${p}`);
    const res = await client.post(`${docRoot}:batchGet`, { documents, transaction });
    const out = new Map();
    for (const entry of res.body || []) {
      if (entry.found) out.set(entry.found.name, { exists: true, fields: entry.found.fields || {} });
      else if (entry.missing) out.set(entry.missing, { exists: false, fields: {} });
    }
    return out;
  }
  /** Commits one create-only write inside the given transaction. Throws on any failure (including a genuine concurrent conflict). */
  async function commitCreate(path, fields, transaction) {
    await client.post(`${docRoot}:commit`, {
      transaction,
      writes: [
        {
          update: { name: `${resourceRoot}/${path}`, fields },
          currentDocument: { exists: false },
        },
      ],
    });
  }

  function postLikeId(likerUid, targetType, targetId) {
    return `${likerUid}_${targetType}_${targetId}`;
  }
  function postLikePath(likerUid, targetType, targetId) {
    return `postLikes/${postLikeId(likerUid, targetType, targetId)}`;
  }
  function realLikePath(targetType, targetId, likerUid) {
    return targetType === 'reel' ? `reels/${targetId}/likes/${likerUid}` : `content/${targetId}/likes/${likerUid}`;
  }

  // -------------------------------------------------------------------------
  // Existing marker check (section 32) — read-only, always performed.
  // -------------------------------------------------------------------------
  const existingMarkerRaw = await getDoc(`${MARKER_COLLECTION}/${MARKER_DOC_ID}`);
  const existingMarker = existingMarkerRaw ? decodeFields(existingMarkerRaw.fields) : null;
  if (existingMarker) {
    log(`Existing completion marker found: version=${existingMarker.version} status=${existingMarker.status} completedAt=${existingMarker.completedAt}`);
  } else {
    log('No existing completion marker found.');
  }
  if (MODE === 'apply' && existingMarker && existingMarker.version === 1 && existingMarker.status === 'complete') {
    log('Marker already reports version 1 / complete. Refusing to blindly re-migrate.');
    log('Run with --verify to confirm integrity instead. Exiting without changes.');
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Phase 1 — forward scan (used by dry-run, apply's pre-flight, apply's
  // post-flight forward verification, and --verify). ALWAYS recomputed
  // fresh; a prior H.3A audit's numbers are never reused as fact here.
  // -------------------------------------------------------------------------
  async function forwardScan({ collectMissingWorklist }) {
    const counts = {
      publishedReelsScanned: 0,
      legacyPostsScanned: 0,
      reelLikesScanned: 0,
      legacyPostLikesScanned: 0,
      selfLikesSkipped: 0,
      eligibleNonSelfLikes: 0,
      postLikesAlreadyPresent: 0,
      postLikesMissing: 0,
      malformedLikes: 0,
      integrityErrors: [],
      hitPageCap: false,
    };
    const worklist = [];

    async function scanTargetLikes(targetType, targetId, targetAuthorUid) {
      let cursor = null;
      for (let page = 0; page < MAX_PAGES_PER_SCOPE; page += 1) {
        const docs = await subPage(targetType === 'reel' ? `reels/${targetId}` : `content/${targetId}`, 'likes', cursor);
        if (docs.length === 0) break;
        for (const likeDoc of docs) {
          if (targetType === 'reel') counts.reelLikesScanned += 1;
          else counts.legacyPostLikesScanned += 1;

          const likerUidFromId = docIdOf(likeDoc.name);
          const likeFields = decodeFields(likeDoc.fields);
          if (!likerUidFromId || likeFields.uid !== likerUidFromId) {
            counts.malformedLikes += 1;
            continue;
          }
          const likerUid = likerUidFromId;
          if (likerUid === targetAuthorUid) {
            counts.selfLikesSkipped += 1;
            continue;
          }
          counts.eligibleNonSelfLikes += 1;

          const plPath = postLikePath(likerUid, targetType, targetId);
          const existing = await getDoc(plPath);
          if (existing) {
            counts.postLikesAlreadyPresent += 1;
            const f = decodeFields(existing.fields);
            if (f.likerUid !== likerUid || f.targetAuthorUid !== targetAuthorUid || f.targetType !== targetType || f.targetId !== targetId) {
              counts.integrityErrors.push(`mismatched existing postLikes for a live ${targetType} Like (fields disagree with live target/Like identity)`);
            }
          } else {
            counts.postLikesMissing += 1;
            if (collectMissingWorklist) {
              worklist.push({ likerUid, targetType, targetId, targetAuthorUid, likeCreatedAt: likeFields.createdAt || null });
            }
          }
        }
        if (docs.length < PAGE_SIZE) break;
        cursor = docs[docs.length - 1].name;
        if (page === MAX_PAGES_PER_SCOPE - 1) counts.hitPageCap = true;
      }
    }

    // Reels
    {
      let cursor = null;
      for (let page = 0; page < MAX_PAGES_PER_SCOPE; page += 1) {
        const docs = await rootPage('reels', [{ field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'published' } }], cursor);
        if (docs.length === 0) break;
        for (const reelDoc of docs) {
          counts.publishedReelsScanned += 1;
          const reelId = docIdOf(reelDoc.name);
          const fields = decodeFields(reelDoc.fields);
          await scanTargetLikes('reel', reelId, fields.authorUid);
        }
        if (docs.length < PAGE_SIZE) break;
        cursor = docs[docs.length - 1].name;
        if (page === MAX_PAGES_PER_SCOPE - 1) counts.hitPageCap = true;
      }
    }

    // Legacy text Posts
    {
      let cursor = null;
      for (let page = 0; page < MAX_PAGES_PER_SCOPE; page += 1) {
        const docs = await rootPage(
          'content',
          [
            { field: { fieldPath: 'type' }, op: 'EQUAL', value: { stringValue: 'post' } },
            { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'published' } },
          ],
          cursor
        );
        if (docs.length === 0) break;
        for (const contentDoc of docs) {
          counts.legacyPostsScanned += 1;
          const contentId = docIdOf(contentDoc.name);
          const fields = decodeFields(contentDoc.fields);
          await scanTargetLikes('post', contentId, fields.authorUid);
        }
        if (docs.length < PAGE_SIZE) break;
        cursor = docs[docs.length - 1].name;
        if (page === MAX_PAGES_PER_SCOPE - 1) counts.hitPageCap = true;
      }
    }

    return { counts, worklist };
  }

  // -------------------------------------------------------------------------
  // Phase 2 — transactional create for one missing relationship (section 14).
  // Re-reads target + real Like + candidate postLike INSIDE the transaction
  // — the scan's worklist is only a set of candidates to attempt, never
  // trusted as still-true by the time we get here (sections 18-20).
  // -------------------------------------------------------------------------
  async function attemptCreate(item) {
    const targetPath = item.targetType === 'reel' ? `reels/${item.targetId}` : `content/${item.targetId}`;
    const likePath = realLikePath(item.targetType, item.targetId, item.likerUid);
    const plPath = postLikePath(item.likerUid, item.targetType, item.targetId);

    const transaction = await beginTransaction();
    let snapshot;
    try {
      snapshot = await batchGetInTransaction([targetPath, likePath, plPath], transaction);
    } catch (e) {
      await rollback(transaction);
      return { outcome: 'error', detail: e?.message };
    }

    const targetEntry = snapshot.get(`${resourceRoot}/${targetPath}`);
    const likeEntry = snapshot.get(`${resourceRoot}/${likePath}`);
    const plEntry = snapshot.get(`${resourceRoot}/${plPath}`);

    if (!plEntry || plEntry.exists) {
      await rollback(transaction);
      return { outcome: 'alreadyPresent' };
    }
    if (!targetEntry || !targetEntry.exists) {
      await rollback(transaction);
      return { outcome: 'skippedConcurrentChange', reason: 'target gone' };
    }
    if (!likeEntry || !likeEntry.exists) {
      await rollback(transaction);
      return { outcome: 'skippedConcurrentChange', reason: 'real Like gone (explicit Unlike or target sweep)' };
    }

    const targetFields = decodeFields(targetEntry.fields);
    if (item.targetType === 'reel') {
      if (targetFields.status !== 'published' || targetFields.authorUid !== item.targetAuthorUid) {
        await rollback(transaction);
        return { outcome: 'skippedConcurrentChange', reason: 'target no longer valid' };
      }
    } else {
      if (targetFields.type !== 'post' || targetFields.status !== 'published' || targetFields.authorUid !== item.targetAuthorUid) {
        await rollback(transaction);
        return { outcome: 'skippedConcurrentChange', reason: 'target no longer valid' };
      }
    }
    if (item.likerUid === item.targetAuthorUid) {
      await rollback(transaction);
      return { outcome: 'selfSkipped' };
    }

    const createdAt = item.likeCreatedAt || decodeFields(likeEntry.fields).createdAt;
    const fields = encodeFields({
      likerUid: item.likerUid,
      targetAuthorUid: item.targetAuthorUid,
      targetType: item.targetType,
      targetId: item.targetId,
    });
    // createdAt preserved from the ORIGINAL real Like doc (section 16) — a
    // real Firestore Timestamp value round-tripped as an ISO string, never
    // the migration's own run time.
    fields.createdAt = createdAt ? { timestampValue: createdAt } : encodeValue(new Date());

    try {
      await commitCreate(plPath, fields, transaction);
      return { outcome: 'created' };
    } catch (e) {
      // ABORTED / ALREADY_EXISTS from the currentDocument precondition —
      // exactly the H.1-concurrent-create race in section 20. Not a
      // failure; re-check once to classify it correctly.
      const nowExists = await getDoc(plPath);
      if (nowExists) return { outcome: 'alreadyPresent' };
      return { outcome: 'failure', detail: e?.message };
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3 — reverse verification (sections 23-26): classify every
  // existing postLikes row. Never deletes or repairs anything.
  // -------------------------------------------------------------------------
  async function reverseVerify() {
    const result = { liveValid: 0, historicalValid: 0, structurallyInvalid: [], totalScanned: 0, hitPageCap: false };
    let cursor = null;
    for (let page = 0; page < MAX_PAGES_PER_SCOPE; page += 1) {
      const docs = await rootPage('postLikes', [], cursor);
      if (docs.length === 0) break;
      for (const d of docs) {
        result.totalScanned += 1;
        const id = docIdOf(d.name);
        const f = decodeFields(d.fields);
        const { likerUid, targetAuthorUid, targetType, targetId, createdAt } = f;

        const structuralOk =
          typeof likerUid === 'string' &&
          likerUid.length > 0 &&
          typeof targetAuthorUid === 'string' &&
          targetAuthorUid.length > 0 &&
          (targetType === 'reel' || targetType === 'post') &&
          typeof targetId === 'string' &&
          targetId.length > 0 &&
          likerUid !== targetAuthorUid &&
          id === postLikeId(likerUid, targetType, targetId) &&
          typeof createdAt === 'string' &&
          createdAt.length > 0;

        if (!structuralOk) {
          result.structurallyInvalid.push(`malformed/mismatched fields or ID (targetType=${targetType || '?'})`);
          continue;
        }

        const targetPath = targetType === 'reel' ? `reels/${targetId}` : `content/${targetId}`;
        const targetDoc = await getDoc(targetPath);
        if (!targetDoc) {
          // No live target — a legitimate HISTORICAL_VALID state (author
          // voluntarily deleted it), per the locked lifetime semantics.
          // Nothing further to check.
          result.historicalValid += 1;
          continue;
        }

        const tf = decodeFields(targetDoc.fields);
        const targetTypeMatches = targetType === 'reel' ? true : tf.type === 'post';
        if (!targetTypeMatches || tf.authorUid !== targetAuthorUid) {
          result.structurallyInvalid.push('live target exists but authorUid/type disagrees with the postLikes row');
          continue;
        }
        // Target exists and identity agrees. Whether it's still 'published'
        // or the real Like still exists doesn't change validity — a
        // moderated-but-not-yet-removed edge case aside, disagreement in
        // authorUid/type is the only thing that makes a live-target row
        // suspicious under the locked semantics.
        if (tf.status === 'published') {
          result.liveValid += 1;
        } else {
          result.historicalValid += 1;
        }
      }
      if (docs.length < PAGE_SIZE) break;
      cursor = docs[docs.length - 1].name;
      if (page === MAX_PAGES_PER_SCOPE - 1) result.hitPageCap = true;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Mode dispatch
  // -------------------------------------------------------------------------

  if (MODE === 'verify') {
    log('\n--- Forward scan (read-only) ---');
    const { counts } = await forwardScan({ collectMissingWorklist: false });
    printCounts(counts);
    log('\n--- Reverse verification (read-only) ---');
    const reverse = await reverseVerify();
    printReverse(reverse);
    const ok = counts.postLikesMissing === 0 && counts.integrityErrors.length === 0 && reverse.structurallyInvalid.length === 0;
    log(`\nVerify result: ${ok ? 'PASS' : 'FAIL'}`);
    process.exit(ok ? 0 : 1);
  }

  if (MODE === 'dry-run') {
    log('\n--- Dry-run forward scan (read-only, no writes) ---');
    const { counts } = await forwardScan({ collectMissingWorklist: false });
    printCounts(counts);
    if (counts.postLikesMissing > SAFETY_THRESHOLD_MISSING) {
      log(`\nSAFETY THRESHOLD EXCEEDED: postLikesMissing (${counts.postLikesMissing}) > ${SAFETY_THRESHOLD_MISSING}. Would refuse --apply.`);
    }
    log('\nDry-run complete. No writes performed. Re-run with --apply to migrate, or --verify to check integrity only.');
    process.exit(0);
  }

  // MODE === 'apply'
  log('\n--- Apply: pre-flight forward scan (read-only) ---');
  const preflight = await forwardScan({ collectMissingWorklist: true });
  printCounts(preflight.counts);

  if (preflight.counts.integrityErrors.length > 0) {
    log('\nINTEGRITY ERRORS found on pre-existing postLikes rows — STOPPING before any write.');
    for (const err of preflight.counts.integrityErrors) log(' -', err);
    process.exit(1);
  }
  if (preflight.counts.postLikesMissing > SAFETY_THRESHOLD_MISSING) {
    log(`\nSAFETY THRESHOLD EXCEEDED: postLikesMissing (${preflight.counts.postLikesMissing}) > ${SAFETY_THRESHOLD_MISSING}. Refusing to --apply.`);
    process.exit(1);
  }

  log(`\n--- Apply: creating ${preflight.worklist.length} missing relationship(s), one transaction each ---`);
  const applyResult = { created: 0, alreadyPresent: 0, skippedConcurrentChange: 0, selfSkipped: 0, failures: 0 };
  for (const item of preflight.worklist) {
    const r = await attemptCreate(item);
    if (r.outcome === 'created') applyResult.created += 1;
    else if (r.outcome === 'alreadyPresent') applyResult.alreadyPresent += 1;
    else if (r.outcome === 'skippedConcurrentChange') applyResult.skippedConcurrentChange += 1;
    else if (r.outcome === 'selfSkipped') applyResult.selfSkipped += 1;
    else {
      applyResult.failures += 1;
      log('  FAILURE:', r.detail || r.outcome);
    }
  }
  log('\nApply result:', JSON.stringify(applyResult));

  if (applyResult.failures > 0) {
    log('\nUnrecoverable write failure(s) occurred — STOPPING. No completion marker will be written.');
    process.exit(1);
  }

  log('\n--- Forward verification (fresh scan, read-only) ---');
  const forwardCheck = await forwardScan({ collectMissingWorklist: false });
  printCounts(forwardCheck.counts);
  if (forwardCheck.counts.postLikesMissing !== 0) {
    log(`\nFORWARD VERIFICATION FAILED: currentEligibleMissingPostLikes = ${forwardCheck.counts.postLikesMissing}, required 0.`);
    log('No completion marker will be written.');
    process.exit(1);
  }
  if (forwardCheck.counts.integrityErrors.length > 0) {
    log('\nFORWARD VERIFICATION FAILED: integrity errors found after apply.');
    for (const err of forwardCheck.counts.integrityErrors) log(' -', err);
    process.exit(1);
  }

  log('\n--- Reverse verification (read-only) ---');
  const reverse = await reverseVerify();
  printReverse(reverse);
  if (reverse.structurallyInvalid.length > 0) {
    log('\nREVERSE VERIFICATION FAILED: structurally invalid postLikes row(s) found. No completion marker will be written.');
    process.exit(1);
  }

  log('\n--- Writing completion marker (last step) ---');
  const markerFields = encodeFields({
    version: 1,
    status: 'complete',
    sourceHead: '532d2f1',
    publishedReelsScanned: forwardCheck.counts.publishedReelsScanned,
    legacyPostsScanned: forwardCheck.counts.legacyPostsScanned,
    eligibleLiveLikesVerified: forwardCheck.counts.eligibleNonSelfLikes,
    relationshipsCreated: applyResult.created,
    relationshipsAlreadyPresent: applyResult.alreadyPresent + forwardCheck.counts.postLikesAlreadyPresent,
    historicalLimitation: 'Pre-lifetime deleted-target/deleted-liker Likes may be irrecoverable',
  });
  markerFields.completedAt = encodeValue(new Date());
  await client.patch(`${docRoot}/${MARKER_COLLECTION}/${MARKER_DOC_ID}`, { fields: markerFields });
  log(`Marker written at ${MARKER_COLLECTION}/${MARKER_DOC_ID}.`);

  log('\nAPPLY COMPLETE.');
  process.exit(0);

  function printCounts(counts) {
    log('publishedReelsScanned:', counts.publishedReelsScanned);
    log('legacyPostsScanned:', counts.legacyPostsScanned);
    log('reelLikesScanned:', counts.reelLikesScanned);
    log('legacyPostLikesScanned:', counts.legacyPostLikesScanned);
    log('selfLikesSkipped:', counts.selfLikesSkipped);
    log('eligibleNonSelfLikes:', counts.eligibleNonSelfLikes);
    log('postLikesAlreadyPresent:', counts.postLikesAlreadyPresent);
    log('postLikesMissing:', counts.postLikesMissing);
    log('malformedLikes:', counts.malformedLikes);
    log('integrityErrors:', counts.integrityErrors.length);
    if (counts.hitPageCap) log('WARNING: hit MAX_PAGES_PER_SCOPE cap — scan may be incomplete.');
  }
  function printReverse(reverse) {
    log('totalScanned:', reverse.totalScanned);
    log('LIVE_VALID:', reverse.liveValid);
    log('HISTORICAL_VALID:', reverse.historicalValid);
    log('STRUCTURALLY_INVALID:', reverse.structurallyInvalid.length);
    if (reverse.structurallyInvalid.length > 0) {
      for (const d of reverse.structurallyInvalid) log(' -', d);
    }
    if (reverse.hitPageCap) log('WARNING: hit MAX_PAGES_PER_SCOPE cap — scan may be incomplete.');
  }
}

main().catch((error) => {
  console.error('FATAL', error?.message || error);
  process.exit(1);
});
