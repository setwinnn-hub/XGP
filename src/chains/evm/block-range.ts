export interface BlockRange {
  readonly from: bigint;
  readonly to: bigint;
  /** Blocks that were too far behind to catch up and were skipped (0 normally). */
  readonly skipped: bigint;
}

/**
 * Next block range to scan for factory logs, given the last fully processed block and the
 * current head. The first call (lastProcessed null) scans only the head block. After an
 * outage the range is capped so one huge eth_getLogs call cannot fail or stall alerts.
 */
export function nextBlockRange(lastProcessed: bigint | null, head: bigint, maxBlocks: bigint): BlockRange | null {
  if (maxBlocks < 1n) throw new Error('maxBlocks must be >= 1');
  if (lastProcessed === null) return { from: head, to: head, skipped: 0n };
  if (head <= lastProcessed) return null;
  const wanted = head - lastProcessed;
  if (wanted <= maxBlocks) return { from: lastProcessed + 1n, to: head, skipped: 0n };
  return { from: head - maxBlocks + 1n, to: head, skipped: wanted - maxBlocks };
}
