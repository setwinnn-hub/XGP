import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorMessage } from '../src/core/logger.ts';
import { average, backoffDelay, percentile, RecentKeys, snowflakeToMs } from '../src/core/util.ts';

describe('errorMessage', () => {
  it('reads Error, event-like objects and primitives', () => {
    assert.equal(errorMessage(new Error('first\nsecond')), 'first');
    assert.equal(errorMessage({ type: 'error', message: 'getaddrinfo ENOTFOUND' }), 'getaddrinfo ENOTFOUND');
    assert.equal(errorMessage({ type: 'error' }), 'error event (no message)');
    assert.equal(errorMessage('plain'), 'plain');
  });
});

describe('snowflakeToMs', () => {
  it('decodes the creation time of a Discord snowflake', () => {
    // Discord docs example: 175928847299117063 -> 2016-04-30T11:18:25.796Z
    assert.equal(new Date(snowflakeToMs('175928847299117063')).toISOString(), '2016-04-30T11:18:25.796Z');
  });

  it('rejects non-numeric ids', () => {
    assert.throws(() => snowflakeToMs('abc'));
  });
});

describe('backoffDelay', () => {
  it('stays within half to full of the exponential ceiling', () => {
    assert.equal(backoffDelay(0, 1000, 30_000, () => 0), 500);
    assert.equal(backoffDelay(0, 1000, 30_000, () => 1), 1000);
    assert.equal(backoffDelay(3, 1000, 30_000, () => 1), 8000);
  });

  it('caps at maxMs', () => {
    assert.equal(backoffDelay(20, 1000, 30_000, () => 1), 30_000);
  });
});

describe('percentile and average', () => {
  it('returns nearest-rank percentiles', () => {
    const values = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    assert.equal(percentile(values, 50), 5);
    assert.equal(percentile(values, 95), 10);
    assert.equal(percentile(values, 0), 1);
  });

  it('returns null for empty input', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(average([]), null);
  });

  it('averages values', () => {
    assert.equal(average([1, 2, 3]), 2);
  });
});

describe('RecentKeys', () => {
  it('reports repeats and forgets the oldest key past the limit', () => {
    const keys = new RecentKeys(2);
    assert.equal(keys.addIfNew('a'), true);
    assert.equal(keys.addIfNew('a'), false);
    keys.addIfNew('b');
    keys.addIfNew('c');
    assert.equal(keys.size, 2);
    assert.equal(keys.addIfNew('a'), true);
  });
});
