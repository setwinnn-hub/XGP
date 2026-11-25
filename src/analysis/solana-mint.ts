import type { SecurityReport } from './security.ts';

/** Admin powers of a Solana mint, read straight from its account (no third-party API). */
export interface SolanaMintFacts {
  readonly mintable: boolean;
  readonly freezable: boolean;
  readonly token2022: boolean;
  /** Worst of the current and scheduled Token-2022 transfer fee (0–100); 0 for classic SPL. */
  readonly transferFeePct: number;
  /** Someone can still change the transfer fee later. */
  readonly feeChangeable: boolean;
  /** A permanent delegate can move or burn tokens from any wallet. */
  readonly permanentDelegate: boolean;
  /** A transfer-hook program runs on every transfer and can block sells. */
  readonly transferHook: boolean;
}

export const AUTHORITY_SOURCE = 'Solana RPC';

const TOKEN_CLASSIC = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TIMEOUT_MS = 10_000;

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw {
  return value && typeof value === 'object' ? (value as Raw) : {};
}

function present(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

function feeBps(fee: unknown): number {
  const bps = Number(obj(fee).transferFeeBasisPoints);
  return Number.isFinite(bps) && bps > 0 ? bps : 0;
}

/** Parses getAccountInfo(jsonParsed).value of a mint; null when it is not a token mint. */
export function parseMintAccount(value: unknown): SolanaMintFacts | null {
  const account = obj(value);
  const owner = account.owner;
  if (owner !== TOKEN_CLASSIC && owner !== TOKEN_2022) return null;
  const parsed = obj(obj(account.data).parsed);
  if (parsed.type !== 'mint') return null;
  const info = obj(parsed.info);
  const extensions = Array.isArray(info.extensions) ? (info.extensions as unknown[]).map(obj) : [];
  const state = (name: string): Raw | null => {
    const ext = extensions.find((e) => e.extension === name);
    return ext ? obj(ext.state) : null;
  };
  const fee = state('transferFeeConfig');
  return {
    mintable: present(info.mintAuthority),
    freezable: present(info.freezeAuthority),
    token2022: owner === TOKEN_2022,
    transferFeePct: fee ? Math.max(feeBps(fee.newerTransferFee), feeBps(fee.olderTransferFee)) / 100 : 0,
    feeChangeable: fee !== null && present(fee.transferFeeConfigAuthority),
    permanentDelegate: present(state('permanentDelegate')?.delegate),
    transferHook: present(state('transferHook')?.programId),
  };
}

/** Reads the mint account over JSON-RPC. Throws on HTTP/RPC errors; null when it is not a mint. */
export async function fetchSolanaMint(rpcUrl: string, mint: string, fetchFn: typeof fetch = fetch): Promise<SolanaMintFacts | null> {
  const response = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed' }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = (await response.json()) as { result?: { value?: unknown }; error?: { message?: string } };
  if (body.error) throw new Error(`RPC error: ${body.error.message ?? 'unknown'}`);
  return parseMintAccount(body.result?.value);
}

const EMPTY: SecurityReport = {
  honeypot: null, cannotSellAll: null, buyTaxPct: null, sellTaxPct: null,
  mintable: null, freezable: null, ownerCanChangeBalance: null, hiddenOwner: null,
  transferPausable: null, openSource: null, holderCount: null, top10HoldersPct: null, creatorPct: null,
};

/**
 * Overlays on-chain mint facts on a GoPlus report (the chain is the source of truth for
 * authorities and fees). Returns the GoPlus report unchanged when the chain was not read.
 */
export function mergeSolanaMint(goplus: SecurityReport | null, facts: SolanaMintFacts | null): SecurityReport | null {
  if (!facts) return goplus;
  return {
    ...(goplus ?? EMPTY),
    mintable: facts.mintable,
    freezable: facts.freezable,
    ownerCanChangeBalance: facts.permanentDelegate,
    buyTaxPct: facts.transferFeePct,
    sellTaxPct: facts.transferFeePct,
    transferPausable: facts.transferHook,
    authoritySource: AUTHORITY_SOURCE,
  };
}
