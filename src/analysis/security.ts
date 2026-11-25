import type { ChainId } from '../core/types.ts';

/** Contract / token-program facts from GoPlus. null = GoPlus did not say. */
export interface SecurityReport {
  readonly honeypot: boolean | null;
  readonly cannotSellAll: boolean | null;
  readonly buyTaxPct: number | null;
  readonly sellTaxPct: number | null;
  readonly mintable: boolean | null;
  readonly freezable: boolean | null;
  readonly ownerCanChangeBalance: boolean | null;
  readonly hiddenOwner: boolean | null;
  readonly transferPausable: boolean | null;
  readonly openSource: boolean | null;
  readonly holderCount: number | null;
  /** Share of supply held by the 10 largest holders, excluding pools, burn and lock addresses (0–100). */
  readonly top10HoldersPct: number | null;
  readonly creatorPct: number | null;
  /** Extra EVM facts used by the Early Gem security engine (optional: older callers ignore them). */
  readonly extra?: SecurityExtra;
}

export interface SecurityExtra {
  readonly cannotBuy: boolean | null;
  readonly transferTaxPct: number | null;
  readonly proxy: boolean | null;
  readonly blacklist: boolean | null;
  readonly whitelist: boolean | null;
  readonly takeBackOwnership: boolean | null;
  readonly slippageModifiable: boolean | null;
  readonly personalSlippageModifiable: boolean | null;
  readonly tradingCooldown: boolean | null;
  readonly externalCall: boolean | null;
  readonly selfDestruct: boolean | null;
  readonly honeypotSameCreator: boolean | null;
  /** Owner is the zero/dead address (renounced); null when GoPlus gave no owner field. */
  readonly ownerRenounced: boolean | null;
  readonly ownerPct: number | null;
  /** Share of LP tokens burned or in a locker (0–100); null when GoPlus has no LP holder list. */
  readonly lpLockedPct: number | null;
  /** Pool fee (fraction) by pair/pool address, lower-cased, from GoPlus's DEX list. */
  readonly poolFees: Readonly<Record<string, number>>;
}

const BURN_ADDRESS = /^0x0{40}$|^0x0{36}dead$/i;

const GOPLUS = 'https://api.gopluslabs.io/api/v1';
const EVM_CHAIN_IDS: Readonly<Partial<Record<ChainId, string>>> = { ethereum: '1', bsc: '56', base: '8453' };
const TIMEOUT_MS = 10_000;
/** Holder tags that are pools, burn or lockers, not real holders. */
const NOT_A_HOLDER = /pancake|uniswap|aerodrome|raydium|pump|null|dead|burn|lock|pinklock|unicrypt|team finance|bonding/i;

type Raw = Record<string, unknown>;

function flag(value: unknown): boolean | null {
  if (value === '1' || value === 1) return true;
  if (value === '0' || value === 0) return false;
  return null;
}

function pct(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n * 100 : null;
}

function solanaStatus(value: unknown): boolean | null {
  return flag((value as Raw | undefined)?.status);
}

/** True when GoPlus actually answered the key safety questions (a brand-new token is often all-null). */
export function isVerified(report: SecurityReport | null): boolean {
  if (!report) return false;
  return [report.honeypot, report.mintable, report.freezable, report.ownerCanChangeBalance, report.openSource].some((v) => v !== null);
}

function top10(holders: unknown, lpHolders: unknown): number | null {
  if (!Array.isArray(holders) || holders.length === 0) return null;
  const lp = new Set(Array.isArray(lpHolders) ? (lpHolders as Raw[]).map((h) => String(h.address ?? '').toLowerCase()) : []);
  // Pools, lockers and other contracts hold supply on behalf of others; only wallets count.
  const real = (holders as Raw[]).filter((h) =>
    !NOT_A_HOLDER.test(String(h.tag ?? ''))
    && String(h.is_contract) !== '1'
    && String(h.is_locked) !== '1'
    && !lp.has(String(h.address ?? '').toLowerCase()));
  const shares = real.map((h) => Number(h.percent)).filter(Number.isFinite).sort((a, b) => b - a).slice(0, 10);
  return shares.reduce((sum, p) => sum + p, 0) * 100;
}

function lpLocked(lpHolders: unknown): number | null {
  if (!Array.isArray(lpHolders) || lpHolders.length === 0) return null;
  const locked = (lpHolders as Raw[])
    .filter((h) => String(h.is_locked) === '1' || BURN_ADDRESS.test(String(h.address ?? '')))
    .map((h) => Number(h.percent))
    .filter(Number.isFinite);
  return Math.min(100, locked.reduce((sum, p) => sum + p, 0) * 100);
}

function poolFees(dex: unknown): Record<string, number> {
  if (!Array.isArray(dex)) return {};
  return Object.fromEntries((dex as Raw[]).flatMap((d) => {
    const fee = Number(d.pool_fee);
    return typeof d.pair === 'string' && Number.isFinite(fee) && fee >= 0 && fee < 1 ? [[d.pair.toLowerCase(), fee]] : [];
  }));
}

function evmExtra(r: Raw): SecurityExtra {
  const owner = typeof r.owner_address === 'string' ? r.owner_address : null;
  return {
    cannotBuy: flag(r.cannot_buy), transferTaxPct: pct(r.transfer_tax), proxy: flag(r.is_proxy),
    blacklist: flag(r.is_blacklisted), whitelist: flag(r.is_whitelisted), takeBackOwnership: flag(r.can_take_back_ownership),
    slippageModifiable: flag(r.slippage_modifiable), personalSlippageModifiable: flag(r.personal_slippage_modifiable),
    tradingCooldown: flag(r.trading_cooldown), externalCall: flag(r.external_call), selfDestruct: flag(r.selfdestruct),
    honeypotSameCreator: flag(r.honeypot_with_same_creator),
    ownerRenounced: owner === null || owner === '' ? null : BURN_ADDRESS.test(owner),
    ownerPct: pct(r.owner_percent), lpLockedPct: lpLocked(r.lp_holders), poolFees: poolFees(r.dex),
  };
}

/** Normalizes one GoPlus result entry (EVM or Solana shape). */
export function parseSecurity(entry: unknown, solana: boolean): SecurityReport {
  const r = (entry ?? {}) as Raw;
  if (solana) {
    // Token-2022 transfer fees are not read: their GoPlus shape was not seen in live data yet.
    return {
      honeypot: null, cannotSellAll: null,
      buyTaxPct: null, sellTaxPct: null,
      mintable: solanaStatus(r.mintable), freezable: solanaStatus(r.freezable),
      ownerCanChangeBalance: solanaStatus(r.balance_mutable_authority),
      hiddenOwner: null, transferPausable: null, openSource: null,
      holderCount: null, top10HoldersPct: null, creatorPct: null,
    };
  }
  return {
    honeypot: flag(r.is_honeypot), cannotSellAll: flag(r.cannot_sell_all),
    buyTaxPct: pct(r.buy_tax), sellTaxPct: pct(r.sell_tax),
    mintable: flag(r.is_mintable), freezable: null,
    ownerCanChangeBalance: flag(r.owner_change_balance), hiddenOwner: flag(r.hidden_owner),
    transferPausable: flag(r.transfer_pausable), openSource: flag(r.is_open_source),
    holderCount: typeof r.holder_count === 'string' && r.holder_count !== '' ? Number(r.holder_count) : null,
    top10HoldersPct: top10(r.holders, r.lp_holders), creatorPct: pct(r.creator_percent),
    extra: evmExtra(r),
  };
}

/** Token security from GoPlus's free API (Ethereum, BNB, Base, Solana). null when unsupported/unknown. */
export async function fetchSecurity(chain: ChainId, token: string, fetchFn: typeof fetch = fetch): Promise<SecurityReport | null> {
  const solana = chain === 'solana';
  const evmId = EVM_CHAIN_IDS[chain];
  if (!solana && !evmId) return null;
  const url = solana
    ? `${GOPLUS}/solana/token_security?contract_addresses=${encodeURIComponent(token)}`
    : `${GOPLUS}/token_security/${evmId}?contract_addresses=${encodeURIComponent(token)}`;
  const response = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GoPlus HTTP ${response.status}`);
  const body = (await response.json()) as { code?: number; message?: string; result?: Record<string, unknown> };
  if (body.code !== 1) throw new Error(`GoPlus code ${String(body.code)} ${body.message ?? ''}`);
  const entry = Object.entries(body.result ?? {}).find(([key]) => key.toLowerCase() === token.toLowerCase())?.[1];
  return entry ? parseSecurity(entry, solana) : null;
}
