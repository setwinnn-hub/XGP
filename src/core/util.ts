/** Discord epoch used in snowflake IDs (2015-01-01T00:00:00Z). */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** Server-side creation time (ms) encoded in a Discord snowflake ID. */
export function snowflakeToMs(id: string): number {
  if (!/^\d{1,20}$/.test(id)) throw new Error(`Not a snowflake: ${id}`);
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/**
 * Exponential backoff with full jitter.
 * attempt 0 -> up to baseMs, doubling each attempt, capped at maxMs.
 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** Nearest-rank percentile of a list of numbers; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded set that forgets the oldest keys first. Used as a fast in-memory dedupe guard. */
export class RecentKeys {
  private readonly keys = new Set<string>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Returns true the first time a key is seen, false for repeats. */
  addIfNew(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > this.limit) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.keys.size;
  }
}
