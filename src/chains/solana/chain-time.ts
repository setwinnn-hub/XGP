import { errorMessage, type Logger } from '../../core/logger.ts';
import { sleep } from '../../core/util.ts';

const FIRST_LOOKUP_DELAY_MS = 4_000;
const RETRY_DELAY_MS = 6_000;
const MAX_ATTEMPTS = 3;
const MIN_GAP_MS = 400;
const MAX_PENDING = 500;
const REQUEST_TIMEOUT_MS = 10_000;

export interface SolanaChainTimeDeps {
  readonly rpcUrl: string;
  readonly logger: Logger;
  readonly onResolved: (key: string, chainMs: number) => void;
  readonly fetchFn?: typeof fetch;
}

/** Reads blockTime (seconds) of a confirmed transaction via JSON-RPC getTransaction. */
export async function fetchSolanaBlockTime(rpcUrl: string, signature: string, fetchFn: typeof fetch = fetch): Promise<number | null> {
  const response = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1, encoding: 'json' }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null) throw new Error('RPC returned non-object');
  const record = body as { error?: { message?: string }; result?: { blockTime?: unknown } | null };
  if (record.error) throw new Error(`RPC error: ${record.error.message ?? 'unknown'}`);
  const blockTime = record.result?.blockTime;
  return typeof blockTime === 'number' ? blockTime : null;
}

/**
 * Background, rate-limited lookups of on-chain time for a sample of events. Never on the
 * alert path: alerts go out first, the timestamp is filled in afterwards for latency stats.
 */
export function createSolanaChainTimeResolver(deps: SolanaChainTimeDeps): (key: string, signature: string) => void {
  const queue: Array<{ key: string; signature: string; attempt: number; notBefore: number }> = [];
  let running = false;

  const runOne = async (job: (typeof queue)[number]): Promise<void> => {
    try {
      const blockTime = await fetchSolanaBlockTime(deps.rpcUrl, job.signature, deps.fetchFn);
      if (blockTime !== null) return deps.onResolved(job.key, blockTime * 1000);
      if (job.attempt + 1 < MAX_ATTEMPTS) {
        queue.push({ ...job, attempt: job.attempt + 1, notBefore: Date.now() + RETRY_DELAY_MS });
      }
    } catch (error: unknown) {
      deps.logger.debug('solana block time lookup failed', { key: job.key, error: errorMessage(error) });
    }
  };

  const drain = async (): Promise<void> => {
    running = true;
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      const wait = job.notBefore - Date.now();
      if (wait > 0) await sleep(wait);
      await runOne(job);
      await sleep(MIN_GAP_MS);
    }
    running = false;
  };

  return (key, signature) => {
    if (queue.length >= MAX_PENDING) return;
    queue.push({ key, signature, attempt: 0, notBefore: Date.now() + FIRST_LOOKUP_DELAY_MS });
    if (!running) void drain();
  };
}
