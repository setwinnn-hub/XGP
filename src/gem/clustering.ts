import type { SwapRow } from './swap-store.ts';

/**
 * Wallet clustering from signals already on hand (no paid explorer API): who bought in the
 * same block, with the same unusual fee setting, from brand-new wallets, for the same size.
 *
 * Funding sources are NOT checked (the free Etherscan tier does not cover these chains), so a
 * cluster means "probably coordinated", never "proven same owner".
 */

export type LinkEvidence = 'same-block' | 'same-unusual-fee' | 'both-fresh' | 'same-size' | 'repeated-co-buys';

export interface WalletCluster {
  readonly wallets: readonly string[];
  readonly evidence: readonly LinkEvidence[];
}

export interface ClusterResult {
  /** Wallet -> representative wallet of its cluster (itself when independent). */
  readonly rootOf: ReadonlyMap<string, string>;
  /** Only clusters of two or more wallets. */
  readonly clusters: readonly WalletCluster[];
}

/** A wallet whose tx nonce is this low was created for (or just before) this trade. */
export const FRESH_NONCE_MAX = 1;
const SAME_SIZE_TOLERANCE = 0.02;
/**
 * Signal weights; wallets link at 2 or more. Same size is weak (people buy round amounts),
 * so it only counts together with another signal.
 */
const WEIGHT: Readonly<Record<LinkEvidence, number>> = {
  'same-block': 1, 'repeated-co-buys': 1, 'same-unusual-fee': 1, 'both-fresh': 1, 'same-size': 0.5,
};
const LINK_THRESHOLD = 2;
/** Buyers sharing a block beyond this are a busy block, not a coordinated group. */
const MAX_BUYERS_PER_BLOCK = 25;

/**
 * Common wallet defaults (0.001, 0.01, 0.05, 0.1, 1, 1.5, 2 gwei, ...) are shared by
 * thousands of unrelated users; only an exact match on an unusual value is a signal.
 */
function unusualFee(fee: number | null | undefined): fee is number {
  if (fee === null || fee === undefined || fee <= 0) return false;
  const scaled = fee * 1000;
  return Math.abs(scaled - Math.round(scaled)) > 1e-6;
}

const fresh = (s: SwapRow): boolean => s.nonce !== null && s.nonce !== undefined && s.nonce <= FRESH_NONCE_MAX;

function sameSize(a: number, b: number): boolean {
  const max = Math.max(a, b);
  return max > 0 && Math.abs(a - b) / max <= SAME_SIZE_TOLERANCE;
}

/** Evidence between two buys in the same block, beyond the shared block itself. */
function pairEvidence(a: SwapRow, b: SwapRow): LinkEvidence[] {
  const extra: LinkEvidence[] = [];
  if (unusualFee(a.feeGwei) && a.feeGwei === b.feeGwei) extra.push('same-unusual-fee');
  if (fresh(a) && fresh(b)) extra.push('both-fresh');
  if (sameSize(a.tokenAmount, b.tokenAmount)) extra.push('same-size');
  return extra;
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x) ?? x;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/**
 * Links two wallets only on two or more independent signals: a shared block plus another
 * strong signal, or shared blocks on two separate occasions. One shared transaction or block
 * alone never links wallets.
 */
export function clusterWallets(swaps: readonly SwapRow[]): ClusterResult {
  const buys = swaps.filter((s) => s.side === 'BUY' && s.wallet !== 'unknown');
  const byBlock = new Map<number, SwapRow[]>();
  for (const b of buys) byBlock.set(b.block, [...(byBlock.get(b.block) ?? []), b]);

  const coBlocks = new Map<string, Set<number>>();
  const evidence = new Map<string, Set<LinkEvidence>>();
  const key = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const [block, rows] of byBlock) {
    if (rows.length < 2 || rows.length > MAX_BUYERS_PER_BLOCK) continue;
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i]!;
        const b = rows[j]!;
        if (a.wallet === b.wallet) continue;
        const k = key(a.wallet, b.wallet);
        coBlocks.set(k, new Set([...(coBlocks.get(k) ?? []), block]));
        evidence.set(k, new Set([...(evidence.get(k) ?? []), ...pairEvidence(a, b)]));
      }
    }
  }

  const uf = new UnionFind();
  const linkEvidence = new Map<string, LinkEvidence[]>();
  for (const [k, blocks] of coBlocks) {
    const extra = [...(evidence.get(k) ?? [])];
    const signals: LinkEvidence[] = blocks.size >= 2 ? ['same-block', 'repeated-co-buys', ...extra] : ['same-block', ...extra];
    if (signals.reduce((sum, e) => sum + WEIGHT[e], 0) < LINK_THRESHOLD) continue;
    const [a, b] = k.split('|') as [string, string];
    uf.union(a, b);
    linkEvidence.set(k, signals);
  }

  const wallets = [...new Set(buys.map((b) => b.wallet))];
  const rootOf = new Map(wallets.map((w) => [w, uf.find(w)]));
  const members = new Map<string, string[]>();
  for (const [w, root] of rootOf) members.set(root, [...(members.get(root) ?? []), w]);
  const clusters = [...members.values()].filter((m) => m.length >= 2).map((m) => {
    const inCluster = new Set(m);
    const ev = new Set<LinkEvidence>();
    for (const [k, signals] of linkEvidence) {
      const [a] = k.split('|') as [string, string];
      if (inCluster.has(a)) signals.forEach((s) => ev.add(s));
    }
    return { wallets: m.sort(), evidence: [...ev].sort() };
  });
  return { rootOf, clusters };
}
