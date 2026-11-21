/**
 * Plain unit tests for src/utils/pushPermissionPolicy.ts's
 * shouldRequestPermissionPrompt. Run via:
 *   npx tsx tests/pushPermissionPolicy.test.ts
 * Same plain assert()/check() convention as tests/mediaProvider.test.ts.
 */
import { shouldRequestPermissionPrompt } from '../src/utils/pushPermissionPolicy';

const assert = {
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  },
};

const results: { name: string; pass: boolean; error?: unknown }[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

check('undetermined (never asked before) is the only status that should prompt', () => {
  assert.equal(shouldRequestPermissionPrompt('undetermined'), true);
});

check('already granted never prompts again', () => {
  assert.equal(shouldRequestPermissionPrompt('granted'), false);
});

check('PERMISSION DENIAL — a real denial is never re-prompted', () => {
  assert.equal(shouldRequestPermissionPrompt('denied'), false);
});

console.log('\n=== Push permission policy test results ===');
let failures = 0;
for (const result of results) {
  if (result.pass) {
    console.log(`PASS — ${result.name}`);
  } else {
    failures += 1;
    console.log(`FAIL — ${result.name}`);
    console.log(`       ${result.error instanceof Error ? result.error.message : result.error}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} passed.`);
if (failures > 0) process.exit(1);
