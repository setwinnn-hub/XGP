import type { ChainId } from '../core/types.ts';

/**
 * honeypot.is free API: simulates a buy and a sell on a fork and reports the taxes it saw.
 * Shape verified live on 2026-11-25 (ETH tokens with a Uniswap V2 pair). It answers
 * {"code":404,"error":"pair not found"} for pairs it does not index (seen for several BSC
 * tokens), which is reported as NOT_COVERED, never as "safe".
 */
const API = 'https://api.honeypot.is/v2/IsHoneypot';
const CHAIN_IDS: Readonly<Partial<Record<ChainId, number>>> = { ethereum: 1, bsc: 56, base: 8453 };
const TIMEOUT_MS = 12_000;

export interface HoneypotResult {
  readonly status: 'SIMULATED' | 'SIMULATION_FAILED' | 'NOT_COVERED';
  readonly isHoneypot: boolean | null;
  readonly buyTaxPct: number | null;
  readonly sellTaxPct: number | null;
  readonly transferTaxPct: number | null;
  readonly isProxy: boolean | null;
  readonly openSource: boolean | null;
  /** honeypot.is's own summary risk word ("low", "high", ...) and flags, kept for display. */
  readonly risk: string | null;
  readonly flags: readonly string[];
  /** Holders that could not sell in honeypot.is's holder analysis. */
  readonly holdersFailedToSell: number | null;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export function parseHoneypot(body: unknown): HoneypotResult {
  const b = obj(body);
  const sim = obj(b.simulationResult);
  const code = obj(b.contractCode);
  const summary = obj(b.summary);
  const flags = [...(Array.isArray(b.flags) ? b.flags : []), ...(Array.isArray(summary.flags) ? summary.flags : [])]
    .map((f) => (typeof f === 'string' ? f : String(obj(f).flag ?? obj(f).description ?? ''))).filter(Boolean);
  const simulated = b.simulationSuccess === true;
  return {
    status: simulated ? 'SIMULATED' : 'SIMULATION_FAILED',
    isHoneypot: bool(obj(b.honeypotResult).isHoneypot),
    buyTaxPct: simulated ? num(sim.buyTax) : null,
    sellTaxPct: simulated ? num(sim.sellTax) : null,
    transferTaxPct: simulated ? num(sim.transferTax) : null,
    isProxy: bool(code.isProxy),
    openSource: bool(code.openSource),
    risk: typeof summary.risk === 'string' ? summary.risk : null,
    flags: [...new Set(flags)],
    holdersFailedToSell: num(obj(b.holderAnalysis).failed),
  };
}

const NOT_COVERED: HoneypotResult = {
  status: 'NOT_COVERED', isHoneypot: null, buyTaxPct: null, sellTaxPct: null, transferTaxPct: null,
  isProxy: null, openSource: null, risk: null, flags: [], holdersFailedToSell: null,
};

/** null when the chain is not supported at all; NOT_COVERED when honeypot.is has no pair for it. */
export async function fetchHoneypot(chain: ChainId, token: string, fetchFn: typeof fetch = fetch): Promise<HoneypotResult | null> {
  const chainId = CHAIN_IDS[chain];
  if (!chainId) return null;
  const response = await fetchFn(`${API}?address=${encodeURIComponent(token)}&chainID=${chainId}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 404) return NOT_COVERED;
  if (!response.ok) throw new Error(`honeypot.is HTTP ${response.status}`);
  return parseHoneypot(await response.json());
}
