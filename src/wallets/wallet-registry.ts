import { errorMessage, type Logger } from '../core/logger.ts';
import type { ChainId } from '../core/types.ts';
import type { TrackedWallet, WalletRepository } from './wallet-repo.ts';

export type WalletListener = (wallets: ReadonlyMap<string, TrackedWallet>) => void;

/**
 * In-memory view of followed wallets per chain, refreshed from the database so wallets
 * added with the CLI (or later the dashboard) take effect without a restart.
 */
export class WalletRegistry {
  private readonly repo: WalletRepository;
  private readonly logger: Logger;
  private byChain = new Map<ChainId, ReadonlyMap<string, TrackedWallet>>();
  private readonly listeners = new Map<ChainId, WalletListener[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(repo: WalletRepository, logger: Logger) {
    this.repo = repo;
    this.logger = logger;
  }

  /** Subscribes to wallet-list changes of one chain; called once immediately. */
  onChange(chain: ChainId, listener: WalletListener): void {
    this.listeners.set(chain, [...(this.listeners.get(chain) ?? []), listener]);
    listener(this.wallets(chain));
  }

  wallets(chain: ChainId): ReadonlyMap<string, TrackedWallet> {
    return this.byChain.get(chain) ?? new Map();
  }

  find(chain: ChainId, address: string): TrackedWallet | undefined {
    return this.wallets(chain).get(chain === 'solana' ? address : address.toLowerCase());
  }

  /** Reloads from the database and notifies listeners of chains whose list changed. */
  refresh(): void {
    const next = new Map<ChainId, Map<string, TrackedWallet>>();
    for (const wallet of this.repo.list()) {
      const chainMap = next.get(wallet.chain) ?? new Map<string, TrackedWallet>();
      next.set(wallet.chain, chainMap.set(wallet.address, wallet));
    }
    const chains = new Set<ChainId>([...this.byChain.keys(), ...next.keys()]);
    const previous = this.byChain;
    this.byChain = next;
    for (const chain of chains) {
      const before = previous.get(chain) ?? new Map();
      const after = next.get(chain) ?? new Map();
      if (sameWallets(before, after)) continue;
      this.logger.info('wallet list changed', { chain, count: after.size });
      for (const listener of this.listeners.get(chain) ?? []) listener(after);
    }
  }

  start(intervalMs: number): void {
    this.refresh();
    this.timer = setInterval(() => {
      try {
        this.refresh();
      } catch (error: unknown) {
        this.logger.error('wallet refresh failed', { error: errorMessage(error) });
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function sameWallets(a: ReadonlyMap<string, TrackedWallet>, b: ReadonlyMap<string, TrackedWallet>): boolean {
  if (a.size !== b.size) return false;
  for (const [address, wallet] of a) {
    if (b.get(address)?.label !== wallet.label || !b.has(address)) return false;
  }
  return true;
}
