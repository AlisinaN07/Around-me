/**
 * Step 11D — pure, dependency-free tests for
 * src/utils/reelPreparationPolicy.ts: the staged ACTIVE/WARM/LIGHT/COLD
 * preparation-level decision behind ReelFeed.tsx's own `shouldPrepare`
 * prop and its new LIGHT-tier thumbnail/playback-URL warmup effect. No
 * React, no expo-video, no Firestore — this file only ever tests the
 * pure index/network-class -> level decision, run via:
 *   npx tsx tests/reelPreparationPolicy.test.ts
 * Same plain assert()/check() convention as tests/reel-video-r2.test.ts.
 */
import assert from 'node:assert/strict';

import {
  computeReelPreparationLevel,
  isWithinWarmWindow,
  shouldPrepareVideoPlayer,
  shouldWarmThumbnailAndUrl,
  type ReelNetworkClass,
} from '../src/utils/reelPreparationPolicy';

const results: { name: string; pass: boolean; error?: unknown }[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

function levelAt(index: number, activeIndex: number, networkClass: ReelNetworkClass) {
  return computeReelPreparationLevel({ index, activeIndex, networkClass });
}

// ---------------------------------------------------------------------------
// Wi-Fi — active, ±1 warm, ±2/3 light, farther cold.
// ---------------------------------------------------------------------------

check('wifi: the active index itself is "active"', () => {
  assert.equal(levelAt(5, 5, 'wifi'), 'active');
});

check('wifi: ±1 is "warm"', () => {
  assert.equal(levelAt(4, 5, 'wifi'), 'warm');
  assert.equal(levelAt(6, 5, 'wifi'), 'warm');
});

check('wifi: ±2 and ±3 are "light"', () => {
  assert.equal(levelAt(3, 5, 'wifi'), 'light');
  assert.equal(levelAt(7, 5, 'wifi'), 'light');
  assert.equal(levelAt(2, 5, 'wifi'), 'light');
  assert.equal(levelAt(8, 5, 'wifi'), 'light');
});

check('wifi: ±4 and beyond are "cold"', () => {
  assert.equal(levelAt(1, 5, 'wifi'), 'cold');
  assert.equal(levelAt(9, 5, 'wifi'), 'cold');
  assert.equal(levelAt(0, 5, 'wifi'), 'cold');
  assert.equal(levelAt(100, 5, 'wifi'), 'cold');
});

// ---------------------------------------------------------------------------
// Cellular — active, ±1 warm (never shrunk — see the policy's own doc
// comment for why), ±2 light (conservative, not zero), ±3+ cold.
// ---------------------------------------------------------------------------

check('cellular: active + ±1 warm, identical to Wi-Fi — the player/WARM tier never shrinks by network class', () => {
  assert.equal(levelAt(5, 5, 'cellular'), 'active');
  assert.equal(levelAt(4, 5, 'cellular'), 'warm');
  assert.equal(levelAt(6, 5, 'cellular'), 'warm');
});

check('cellular: ±2 is "light" — one conservative step of cheap metadata/thumbnail warmup, never a full video prefetch', () => {
  assert.equal(levelAt(3, 5, 'cellular'), 'light');
  assert.equal(levelAt(7, 5, 'cellular'), 'light');
});

check('cellular: ±3 and beyond are "cold" — meaningfully narrower reach than Wi-Fi\'s own ±3 light', () => {
  assert.equal(levelAt(2, 5, 'cellular'), 'cold');
  assert.equal(levelAt(8, 5, 'cellular'), 'cold');
});

check('unknown (no network-detection API installed) behaves IDENTICALLY to cellular — the conservative default', () => {
  for (const index of [2, 3, 4, 5, 6, 7, 8]) {
    assert.equal(levelAt(index, 5, 'unknown'), levelAt(index, 5, 'cellular'), `index ${index} must match cellular's own level`);
  }
});

// ---------------------------------------------------------------------------
// Offline — no intentional remote warmup beyond the already-existing WARM
// tier (which relies on whatever the native player/cache already does,
// not a NEW fetch this policy itself initiates).
// ---------------------------------------------------------------------------

check('offline: active + ±1 warm are unchanged (existing player lifecycle, not a new fetch this policy adds)', () => {
  assert.equal(levelAt(5, 5, 'offline'), 'active');
  assert.equal(levelAt(4, 5, 'offline'), 'warm');
  assert.equal(levelAt(6, 5, 'offline'), 'warm');
});

check('offline: EVERYTHING beyond ±1 is immediately "cold" — zero LIGHT tier, no intentional remote warmup at all', () => {
  assert.equal(levelAt(3, 5, 'offline'), 'cold');
  assert.equal(levelAt(7, 5, 'offline'), 'cold');
  assert.equal(levelAt(2, 5, 'offline'), 'cold');
});

// ---------------------------------------------------------------------------
// Photo — no VideoPlayer warm state at any level.
// ---------------------------------------------------------------------------

check('photo: shouldPrepareVideoPlayer is false at EVERY level, including active and warm', () => {
  assert.equal(shouldPrepareVideoPlayer('active', 'photo'), false);
  assert.equal(shouldPrepareVideoPlayer('warm', 'photo'), false);
  assert.equal(shouldPrepareVideoPlayer('light', 'photo'), false);
  assert.equal(shouldPrepareVideoPlayer('cold', 'photo'), false);
});

check('video: shouldPrepareVideoPlayer is true ONLY at active/warm, matching isWithinWarmWindow exactly', () => {
  assert.equal(shouldPrepareVideoPlayer('active', 'video'), true);
  assert.equal(shouldPrepareVideoPlayer('warm', 'video'), true);
  assert.equal(shouldPrepareVideoPlayer('light', 'video'), false);
  assert.equal(shouldPrepareVideoPlayer('cold', 'video'), false);
});

// ---------------------------------------------------------------------------
// isWithinWarmWindow / shouldWarmThumbnailAndUrl — the two booleans the
// real components actually consume.
// ---------------------------------------------------------------------------

check('isWithinWarmWindow matches the pre-11D shouldPrepare prop exactly: true for active/warm, false otherwise', () => {
  assert.equal(isWithinWarmWindow('active'), true);
  assert.equal(isWithinWarmWindow('warm'), true);
  assert.equal(isWithinWarmWindow('light'), false);
  assert.equal(isWithinWarmWindow('cold'), false);
});

check('shouldWarmThumbnailAndUrl is true ONLY at light — active/warm already warm themselves via ReelFeedItem\'s own effects, cold warms nothing', () => {
  assert.equal(shouldWarmThumbnailAndUrl('active'), false);
  assert.equal(shouldWarmThumbnailAndUrl('warm'), false);
  assert.equal(shouldWarmThumbnailAndUrl('light'), true);
  assert.equal(shouldWarmThumbnailAndUrl('cold'), false);
});

// ---------------------------------------------------------------------------
// Fast-scroll jumps — Part 20 of the spec: no sticky/growing prefetch
// window. Recomputing a FIXED index's level against a NEW activeIndex
// must reflect ONLY the new distance, never "remember" a prior window.
// ---------------------------------------------------------------------------

check('fast scroll 0 -> 1: index 0 immediately becomes "warm" (still ±1 of the new active), not stuck "active"', () => {
  assert.equal(levelAt(0, 0, 'wifi'), 'active');
  assert.equal(levelAt(0, 1, 'wifi'), 'warm');
});

check('fast scroll 0 -> 3: the item that WAS active/warm immediately reflects its new distance — never stuck at its old level', () => {
  // Jumping from activeIndex 0 to 3: the item that WAS active (index 0)
  // is now distance 3 away.
  assert.equal(levelAt(0, 0, 'wifi'), 'active');
  assert.equal(levelAt(0, 3, 'wifi'), 'light', 'distance 3 on wifi is light, not stuck active/warm');
  assert.equal(levelAt(0, 3, 'cellular'), 'cold', 'distance 3 on cellular is cold — conservative reach is narrower');
  // The item that WAS warm (index 1, distance 1 from old active 0) is now
  // distance 2 from the new active index 3.
  assert.equal(levelAt(1, 0, 'wifi'), 'warm');
  assert.equal(levelAt(1, 3, 'wifi'), 'light', 'no longer warm once the active index moves past it — never sticky');
});

check('fast scroll 5 -> 10: every index near the OLD active (5) immediately reflects its distance from the NEW active (10), never a leftover window around 5', () => {
  // Old active=5: indices 4,5,6 were active/warm.
  assert.equal(levelAt(5, 5, 'wifi'), 'active');
  assert.equal(levelAt(4, 5, 'wifi'), 'warm');
  assert.equal(levelAt(6, 5, 'wifi'), 'warm');
  // New active=10: recompute the SAME indices — none are active/warm/light
  // any more (distance 5+, beyond even Wi-Fi's own ±3 light reach).
  assert.equal(levelAt(5, 10, 'wifi'), 'cold');
  assert.equal(levelAt(4, 10, 'wifi'), 'cold');
  assert.equal(levelAt(6, 10, 'wifi'), 'cold');
  // The NEW active/warm/light window is centered on 10, not 5.
  assert.equal(levelAt(10, 10, 'wifi'), 'active');
  assert.equal(levelAt(9, 10, 'wifi'), 'warm');
  assert.equal(levelAt(11, 10, 'wifi'), 'warm');
  assert.equal(levelAt(8, 10, 'wifi'), 'light');
  assert.equal(levelAt(12, 10, 'wifi'), 'light');
  assert.equal(levelAt(7, 10, 'wifi'), 'light', 'distance 3 is still within wifi\'s own light reach');
  assert.equal(levelAt(13, 10, 'wifi'), 'light', 'distance 3 is still within wifi\'s own light reach');
  assert.equal(levelAt(14, 10, 'wifi'), 'cold', 'distance 4 is beyond wifi\'s own light reach');
});

// ---------------------------------------------------------------------------
// Feed boundaries — active index 0 (no negative-index work) and the last
// item (no out-of-range future warmup). computeReelPreparationLevel
// itself is pure index-distance math with no concept of array bounds —
// it's REELFEED'S OWN `if (!reel) continue` guard (ReelFeed.tsx's
// LIGHT-tier effect) that actually prevents a lookup on a nonexistent
// array slot; these tests prove the function itself never throws or
// misbehaves for a negative/out-of-range index, which is exactly the
// kind of value that guard's own loop computes and hands it BEFORE
// checking whether `reels[index]` exists.
// ---------------------------------------------------------------------------

check('boundary: active index 0 — negative indices (what ReelFeed\'s own loop computes before its `if (!reel) continue` guard runs) never throw, and resolve to the correct level by pure distance', () => {
  assert.doesNotThrow(() => levelAt(-1, 0, 'wifi'));
  assert.doesNotThrow(() => levelAt(-3, 0, 'wifi'));
  assert.equal(levelAt(-1, 0, 'wifi'), 'warm', 'distance 1 is warm regardless of which side of 0 it falls on');
  assert.equal(levelAt(-2, 0, 'wifi'), 'light');
  assert.equal(levelAt(-4, 0, 'wifi'), 'cold');
});

check('boundary: the LAST item active — indices beyond the end of a conceptual feed (e.g. activeIndex = length-1) never throw, same pure distance math applies', () => {
  const lastIndex = 9; // a 10-item feed, activeIndex = 9
  assert.doesNotThrow(() => levelAt(lastIndex + 1, lastIndex, 'wifi'));
  assert.doesNotThrow(() => levelAt(lastIndex + 5, lastIndex, 'wifi'));
  assert.equal(levelAt(lastIndex + 1, lastIndex, 'wifi'), 'warm');
  assert.equal(levelAt(lastIndex + 3, lastIndex, 'wifi'), 'light');
  assert.equal(levelAt(lastIndex + 10, lastIndex, 'wifi'), 'cold');
});

check('boundary: a single-item feed (activeIndex === 0 === lastIndex) — every neighboring index is still well-defined, never throws', () => {
  assert.doesNotThrow(() => levelAt(1, 0, 'wifi'));
  assert.doesNotThrow(() => levelAt(-1, 0, 'wifi'));
  assert.equal(levelAt(0, 0, 'wifi'), 'active');
});

// ---------------------------------------------------------------------------
// Determinism / purity
// ---------------------------------------------------------------------------

check('computeReelPreparationLevel is a pure function of its inputs — identical inputs always produce identical output', () => {
  const a = levelAt(7, 10, 'wifi');
  const b = levelAt(7, 10, 'wifi');
  assert.equal(a, b);
});

check('level is symmetric around activeIndex — the same distance on either side produces the same level', () => {
  for (const networkClass of ['wifi', 'cellular', 'offline', 'unknown'] as const) {
    for (let distance = 0; distance <= 5; distance += 1) {
      assert.equal(levelAt(10 - distance, 10, networkClass), levelAt(10 + distance, 10, networkClass), `distance ${distance} on ${networkClass} must be symmetric`);
    }
  }
});

console.log('\n=== src/ Reel preparation policy logic test results ===');
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
