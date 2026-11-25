import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextBlockRange } from '../src/chains/evm/block-range.ts';

describe('nextBlockRange', () => {
  it('starts at the head on the first call', () => {
    assert.deepEqual(nextBlockRange(null, 100n, 500n), { from: 100n, to: 100n, skipped: 0n });
  });

  it('returns null when nothing new arrived', () => {
    assert.equal(nextBlockRange(100n, 100n, 500n), null);
    assert.equal(nextBlockRange(100n, 99n, 500n), null);
  });

  it('covers every block since the last processed one (gap-free catch-up)', () => {
    assert.deepEqual(nextBlockRange(100n, 103n, 500n), { from: 101n, to: 103n, skipped: 0n });
  });

  it('caps very long gaps and reports skipped blocks', () => {
    assert.deepEqual(nextBlockRange(100n, 1100n, 500n), { from: 601n, to: 1100n, skipped: 500n });
  });

  it('rejects a zero window', () => {
    assert.throws(() => nextBlockRange(1n, 2n, 0n));
  });
});
