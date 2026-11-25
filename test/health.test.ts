import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HealthRegistry, type HealthTransition } from '../src/core/health.ts';

function clock(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

describe('HealthRegistry', () => {
  it('goes starting -> up -> down -> up and notifies each transition', () => {
    const time = clock(0);
    const health = new HealthRegistry(time.now);
    const seen: HealthTransition[] = [];
    health.onTransition((t) => seen.push(t));
    health.register('src', 1000);

    health.beat('src');
    time.advance(1500);
    assert.equal(health.sweep().length, 1);
    time.advance(500);
    health.beat('src');

    assert.deepEqual(seen.map((t) => `${t.from}->${t.to}`), ['starting->up', 'up->down', 'down->up']);
    assert.equal(seen[1]?.silentForMs, 1500);
    assert.equal(seen[2]?.silentForMs, 2000);
  });

  it('does not report a source down twice', () => {
    const time = clock(0);
    const health = new HealthRegistry(time.now);
    health.register('src', 100);
    health.beat('src');
    time.advance(200);
    assert.equal(health.sweep().length, 1);
    time.advance(200);
    assert.equal(health.sweep().length, 0);
  });

  it('reports a source that never produced data as down', () => {
    const time = clock(0);
    const health = new HealthRegistry(time.now);
    health.register('dead', 100);
    time.advance(150);
    const [transition] = health.sweep();
    assert.equal(transition?.from, 'starting');
    assert.equal(transition?.to, 'down');
    assert.equal(transition?.silentForMs, 150);
  });

  it('counts events and reconnects', () => {
    const health = new HealthRegistry(() => 0);
    health.register('a', 100);
    health.beat('a');
    health.countEvent('a');
    health.countReconnect('a');
    const a = health.snapshot().find((s) => s.name === 'a');
    assert.equal(a?.events, 1);
    assert.equal(a?.reconnects, 1);
  });

  it('throws for unknown sources', () => {
    assert.throws(() => new HealthRegistry().beat('missing'));
  });
});
