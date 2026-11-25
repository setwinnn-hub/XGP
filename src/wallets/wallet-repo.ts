import type { DatabaseSync } from 'node:sqlite';
import { EVM_CHAINS } from '../chains/evm/chains.ts';
import type { ChainId } from '../core/types.ts';

export interface TrackedWallet {
  readonly chain: ChainId;
  readonly address: string;
  readonly label: string | null;
  readonly addedAt: number;
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_LABEL = 40;

export function isChainId(value: string): value is ChainId {
  return value === 'solana' || EVM_CHAINS.some((chain) => chain.id === value);
}

/**
 * Validates and normalizes a wallet address for its chain. EVM addresses are stored
 * lower-case so lookups are case-insensitive. Throws with a readable message.
 */
export function normalizeWallet(chain: string, address: string): { chain: ChainId; address: string } {
  if (!isChainId(chain)) throw new Error(`Unknown chain "${chain}". Use solana, ${EVM_CHAINS.map((c) => c.id).join(', ')}`);
  const trimmed = address.trim();
  if (chain === 'solana') {
    if (!SOLANA_ADDRESS.test(trimmed)) throw new Error(`Not a Solana address: ${trimmed}`);
    return { chain, address: trimmed };
  }
  if (!EVM_ADDRESS.test(trimmed)) throw new Error(`Not an EVM address (0x + 40 hex): ${trimmed}`);
  return { chain, address: trimmed.toLowerCase() };
}

export function cleanLabel(label: string | null | undefined): string | null {
  const cleaned = (label ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_LABEL);
  return cleaned.length > 0 ? cleaned : null;
}

/** Wallets the user follows. Public addresses only: the bot never holds keys. */
export interface WalletRepository {
  add(chain: string, address: string, label?: string | null): TrackedWallet;
  remove(chain: string, address: string): boolean;
  list(chain?: ChainId): readonly TrackedWallet[];
}

export function createWalletRepository(db: DatabaseSync, now: () => number = Date.now): WalletRepository {
  const upsert = db.prepare(`
    INSERT INTO wallets (chain, address, label, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (chain, address) DO UPDATE SET label = excluded.label`);
  const select = db.prepare('SELECT chain, address, label, added_at FROM wallets WHERE chain = ? AND address = ?');
  const del = db.prepare('DELETE FROM wallets WHERE chain = ? AND address = ?');
  const all = db.prepare('SELECT chain, address, label, added_at FROM wallets ORDER BY added_at');
  const byChain = db.prepare('SELECT chain, address, label, added_at FROM wallets WHERE chain = ? ORDER BY added_at');

  const toWallet = (row: Record<string, unknown>): TrackedWallet => ({
    chain: String(row.chain) as ChainId,
    address: String(row.address),
    label: typeof row.label === 'string' ? row.label : null,
    addedAt: Number(row.added_at),
  });

  return {
    add(chain, address, label) {
      const wallet = normalizeWallet(chain, address);
      upsert.run(wallet.chain, wallet.address, cleanLabel(label), now());
      const row = select.get(wallet.chain, wallet.address);
      if (!row) throw new Error('wallet insert failed');
      return toWallet(row);
    },
    remove(chain, address) {
      const wallet = normalizeWallet(chain, address);
      return Number(del.run(wallet.chain, wallet.address).changes) > 0;
    },
    list(chain) {
      return (chain ? byChain.all(chain) : all.all()).map(toWallet);
    },
  };
}
