/**
 * Step 11E — pure tests for src/utils/reelPlaybackSessionState.ts: the
 * first-view/scroll-back classification, prewarmed-activation decision,
 * completed-vs-aborted outcome, duplicate-readyToPlay guard, and bounded
 * session-map eviction behind ReelFeedItem's own dev playback metrics. No
 * React, no expo-video, no expo-network (this file only imports from
 * reelPreparationPolicy.ts and reelPlaybackSessionState.ts, both
 * confirmed zero-native-dependency — see that file's own top doc
 * comment), run via:
 *   npx tsx tests/reelPlaybackSessionState.test.ts
 */
import assert from 'node:assert/strict';

import {
  buildReelPlaybackCompletionRecord,
  classifyStartupType,
  consumePendingStartup,
  determineStartupOutcome,
  evictOldestIfAtCapacity,
  isPrewarmedActivation,
  recordActivation,
  recordStartupMsForReel,
  type ReelPlaybackSessionRecord,
} from '../src/utils/reelPlaybackSessionState';

const results: { name: string; pass: boolean; error?: unknown }[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

// ---------------------------------------------------------------------------
// First-view vs scroll-back classification
// ---------------------------------------------------------------------------

check('first activation (count 1) classifies as first-view', () => {
  assert.equal(classifyStartupType(1), 'first-view');
});

check('second activation (count 2) classifies as scroll-back', () => {
  assert.equal(classifyStartupType(2), 'scroll-back');
});

check('every further activation (count 3+) still classifies as scroll-back, not some third bucket', () => {
  assert.equal(classifyStartupType(3), 'scroll-back');
  assert.equal(classifyStartupType(50), 'scroll-back');
});

check('recordActivation on a fresh Map: first call for a reelId returns activationCount 1 / first-view, second call returns 2 / scroll-back', () => {
  const map = new Map<string, ReelPlaybackSessionRecord>();
  const first = recordActivation(map, 'reel-a');
  assert.equal(first.activationCount, 1);
  assert.equal(first.startupType, 'first-view');
  const second = recordActivation(map, 'reel-a');
  assert.equal(second.activationCount, 2);
  assert.equal(second.startupType, 'scroll-back');
});

check('recordActivation tracks separate reelIds independently', () => {
  const map = new Map<string, ReelPlaybackSessionRecord>();
  recordActivation(map, 'reel-a');
  const first = recordActivation(map, 'reel-b');
  assert.equal(first.activationCount, 1);
  assert.equal(first.startupType, 'first-view');
});

// ---------------------------------------------------------------------------
// WARM / LIGHT / COLD -> ACTIVE prewarmed classification
// ---------------------------------------------------------------------------

check('WARM -> ACTIVE, already ready (was buffering in the background): prewarmed', () => {
  assert.equal(isPrewarmedActivation('warm', true), true);
});

check('WARM -> ACTIVE, NOT yet ready (still buffering): not prewarmed — needs a pending measurement', () => {
  assert.equal(isPrewarmedActivation('warm', false), false);
});

check('LIGHT -> ACTIVE: never prewarmed, even if wasAlreadyReady were somehow true (no player exists at LIGHT by construction)', () => {
  assert.equal(isPrewarmedActivation('light', false), false);
  assert.equal(isPrewarmedActivation('light', true), false);
});

check('COLD -> ACTIVE: never prewarmed, same reasoning as LIGHT', () => {
  assert.equal(isPrewarmedActivation('cold', false), false);
  assert.equal(isPrewarmedActivation('cold', true), false);
});

// ---------------------------------------------------------------------------
// Completed vs aborted startup
// ---------------------------------------------------------------------------

check('a startup that reaches readyToPlay is completed', () => {
  assert.equal(determineStartupOutcome({ reachedReady: true }), 'completed');
});

check('a startup that never reaches readyToPlay before the Reel stops being active is aborted — never logged as a real latency', () => {
  assert.equal(determineStartupOutcome({ reachedReady: false }), 'aborted');
});

// ---------------------------------------------------------------------------
// Duplicate readyToPlay protection
// ---------------------------------------------------------------------------

check('a pending startup is consumed exactly once: first readyToPlay records it, a second readyToPlay (nothing pending) does not', () => {
  const pending = { activatedAt: Date.now(), priorLevel: 'cold' as const, startupType: 'first-view' as const };
  const firstCall = consumePendingStartup(pending);
  assert.equal(firstCall.shouldRecord, true);
  // The real caller (ReelFeedItem) sets pendingStartupRef.current = null
  // immediately after a true shouldRecord — modeling that exact sequence:
  const afterConsumption: typeof pending | null = null;
  const secondCall = consumePendingStartup(afterConsumption);
  assert.equal(secondCall.shouldRecord, false, 'a rebuffer/second readyToPlay with nothing pending must never re-record');
});

check('consumePendingStartup on an activation that was never armed (e.g. prewarmed, which never sets a pending record) never records', () => {
  assert.equal(consumePendingStartup(null).shouldRecord, false);
});

// ---------------------------------------------------------------------------
// Bounded session-map eviction (200-entry cap)
// ---------------------------------------------------------------------------

check('evictOldestIfAtCapacity: a map under capacity is left untouched', () => {
  const map = new Map([['a', 1]]);
  evictOldestIfAtCapacity(map, 'b', 5);
  assert.equal(map.size, 1);
  assert.ok(map.has('a'));
});

check('evictOldestIfAtCapacity: a map already holding the key is left untouched, even at capacity (an update, not a new entry)', () => {
  const map = new Map([['a', 1], ['b', 2]]);
  evictOldestIfAtCapacity(map, 'a', 2);
  assert.equal(map.size, 2);
});

check('evictOldestIfAtCapacity: a full map receiving a genuinely new key evicts the OLDEST (first-inserted) entry, keeping size bounded', () => {
  const map = new Map([['a', 1], ['b', 2]]);
  evictOldestIfAtCapacity(map, 'c', 2);
  assert.equal(map.size, 1);
  assert.ok(!map.has('a'), 'oldest-inserted key should be evicted');
  assert.ok(map.has('b'), 'newer existing key should survive');
});

check('recordActivation respects a small maxSize end-to-end: the 201st distinct Reel this session evicts the 1st, size never exceeds the bound', () => {
  const map = new Map<string, ReelPlaybackSessionRecord>();
  const maxSize = 200;
  for (let i = 0; i < 200; i += 1) {
    recordActivation(map, `reel-${i}`, maxSize);
  }
  assert.equal(map.size, 200);
  assert.ok(map.has('reel-0'));
  recordActivation(map, 'reel-200', maxSize);
  assert.equal(map.size, 200, 'size must never exceed the bound');
  assert.ok(!map.has('reel-0'), 'the oldest-inserted Reel should have been evicted');
  assert.ok(map.has('reel-200'), 'the newly activated Reel should be present');
});

// ---------------------------------------------------------------------------
// Startup-ms bookkeeping (the dev log's own "previous attempt" comparison)
// ---------------------------------------------------------------------------

check('recordStartupMsForReel returns null as the previous value the first time, then the prior value on a later call', () => {
  const map = new Map<string, ReelPlaybackSessionRecord>();
  recordActivation(map, 'reel-a');
  const first = recordStartupMsForReel(map, 'reel-a', 420);
  assert.equal(first.previousStartupMs, null);
  const second = recordStartupMsForReel(map, 'reel-a', 110);
  assert.equal(second.previousStartupMs, 420);
  assert.equal(map.get('reel-a')?.lastStartupMs, 110);
});

// ---------------------------------------------------------------------------
// Completion-record field fidelity (networkClass / urlSource survive
// unchanged — Step 11E spec section 15's explicit ask)
// ---------------------------------------------------------------------------

check('buildReelPlaybackCompletionRecord preserves networkClass unchanged', () => {
  const record = buildReelPlaybackCompletionRecord({
    reelId: 'reel-a',
    networkClass: 'cellular',
    priorLevel: 'warm',
    startupType: 'scroll-back',
    urlSource: 'cache-hit',
    urlResolutionMs: 12,
    sourceToReadyMs: 340,
    activeToReadyMs: 340,
    prewarmed: false,
  });
  assert.equal(record.networkClass, 'cellular');
});

check('buildReelPlaybackCompletionRecord preserves urlSource unchanged across every real value', () => {
  for (const urlSource of ['r2-persisted', 'cache-hit', 'cache-miss'] as const) {
    const record = buildReelPlaybackCompletionRecord({
      reelId: 'reel-a',
      networkClass: 'wifi',
      priorLevel: 'light',
      startupType: 'first-view',
      urlSource,
      urlResolutionMs: null,
      sourceToReadyMs: 500,
      activeToReadyMs: 500,
      prewarmed: false,
    });
    assert.equal(record.urlSource, urlSource);
  }
});

check('buildReelPlaybackCompletionRecord preserves every other field exactly (pure pass-through, no derived/mutated values)', () => {
  const input = {
    reelId: 'reel-z',
    networkClass: 'offline' as const,
    priorLevel: 'cold' as const,
    startupType: 'first-view' as const,
    urlSource: 'r2-persisted' as const,
    urlResolutionMs: 0,
    sourceToReadyMs: null,
    activeToReadyMs: 0,
    prewarmed: true,
  };
  assert.deepEqual(buildReelPlaybackCompletionRecord(input), input);
});

console.log('\n=== src/ Reel playback session-state logic test results ===');
let failures = 0;
for (const result of results) {
  if (result.pass) {
    console.log(`PASS — ${result.name}`);
  } else {
    failures += 1;
    console.log(`FAIL — ${result.name}`);
    console.log(`       ${result.error instanceof Error ? result.error.stack : result.error}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} passed.`);
if (failures > 0) process.exit(1);
