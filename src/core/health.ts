export type SourceState = 'starting' | 'up' | 'down';

export interface SourceStatus {
  readonly name: string;
  readonly state: SourceState;
  readonly lastBeatAt: number | null;
  readonly registeredAt: number;
  readonly staleAfterMs: number;
  readonly events: number;
  readonly reconnects: number;
}

export interface HealthTransition {
  readonly name: string;
  readonly from: SourceState;
  readonly to: SourceState;
  readonly silentForMs: number | null;
}

/**
 * Tracks liveness of every data source. A source "beats" whenever it receives data
 * (a message, a block). No beat within staleAfterMs flips it to "down".
 */
export class HealthRegistry {
  private sources = new Map<string, SourceStatus>();
  private readonly now: () => number;
  private listener: ((transition: HealthTransition) => void) | null = null;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Called for every state change (starting->up, up->down, down->up). */
  onTransition(listener: (transition: HealthTransition) => void): void {
    this.listener = listener;
  }

  register(name: string, staleAfterMs: number): void {
    this.sources = new Map(this.sources).set(name, {
      name, state: 'starting', lastBeatAt: null, registeredAt: this.now(), staleAfterMs, events: 0, reconnects: 0,
    });
  }

  /** Stops tracking a source that was switched off on purpose (no "down" alert for it). */
  unregister(name: string): void {
    this.sources = new Map([...this.sources].filter(([key]) => key !== name));
  }

  beat(name: string): HealthTransition | null {
    return this.update(name, (s) => ({ ...s, lastBeatAt: this.now() }), 'up');
  }

  /** Counts an event for a source; ignored for sources that are not registered (e.g. switched off). */
  countEvent(name: string): void {
    if (!this.sources.has(name)) return;
    this.update(name, (s) => ({ ...s, events: s.events + 1 }), null);
  }

  countReconnect(name: string): void {
    this.update(name, (s) => ({ ...s, reconnects: s.reconnects + 1 }), null);
  }

  /**
   * Marks stale sources as down; returns the transitions that happened. A source that never
   * produced data is measured from registration, so a dead endpoint is reported too.
   */
  sweep(): readonly HealthTransition[] {
    const now = this.now();
    const transitions = [...this.sources.values()].flatMap((s) => {
      const reference = s.lastBeatAt ?? s.registeredAt;
      if (s.state === 'down' || now - reference <= s.staleAfterMs) return [];
      this.sources = new Map(this.sources).set(s.name, { ...s, state: 'down' });
      return [{ name: s.name, from: s.state, to: 'down' as const, silentForMs: now - reference }];
    });
    for (const transition of transitions) this.listener?.(transition);
    return transitions;
  }

  snapshot(): readonly SourceStatus[] {
    return [...this.sources.values()];
  }

  private update(
    name: string,
    change: (s: SourceStatus) => SourceStatus,
    nextState: SourceState | null,
  ): HealthTransition | null {
    const current = this.sources.get(name);
    if (!current) throw new Error(`Unknown health source: ${name}`);
    const changed = change(current);
    const next = nextState ? { ...changed, state: nextState } : changed;
    this.sources = new Map(this.sources).set(name, next);
    if (!nextState || current.state === nextState) return null;
    const silentForMs = current.lastBeatAt === null ? null : this.now() - current.lastBeatAt;
    const transition = { name, from: current.state, to: nextState, silentForMs };
    this.listener?.(transition);
    return transition;
  }
}
