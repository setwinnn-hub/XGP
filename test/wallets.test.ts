import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { silentLogger } from '../src/core/logger.ts';
import { openDatabase } from '../src/storage/db.ts';
import { WalletRegistry } from '../src/wallets/wallet-registry.ts';
import { cleanLabel, createWalletRepository, normalizeWallet, type TrackedWallet } from '../src/wallets/wallet-repo.ts';

const SOL = '99pdD9jqnyGRhBL88Aw7bcuxQYVvawuo6brbe5o6ssXG';
const EVM = '0xAbCdEf0123456789aBcDeF0123456789ABCDEF01';

describe('normalizeWallet', () => {
  it('accepts valid addresses and lower-cases EVM ones', () => {
    assert.deepEqual(normalizeWallet('solana', ` ${SOL} `), { chain: 'solana', address: SOL });
    assert.deepEqual(normalizeWallet('base', EVM), { chain: 'base', address: EVM.toLowerCase() });
  });

  it('rejects bad chains and addresses', () => {
    assert.throws(() => normalizeWallet('dogechain', SOL), /Unknown chain/);
    assert.throws(() => normalizeWallet('solana', '0OIl'), /Not a Solana address/);
    assert.throws(() => normalizeWallet('bsc', '0x123'), /Not an EVM address/);
  });

  it('cleans labels', () => {
    assert.equal(cleanLabel('  Alpha\u0007 '), 'Alpha');
    assert.equal(cleanLabel(''), null);
    assert.equal(cleanLabel('x'.repeat(100))?.length, 40);
  });
});

describe('WalletRepository', () => {
  it('adds, relabels, lists and removes wallets', () => {
    const repo = createWalletRepository(openDatabase(':memory:'), () => 1);
    repo.add('solana', SOL, 'Alpha');
    repo.add('solana', SOL, 'Renamed');
    repo.add('base', EVM);
    assert.equal(repo.list().length, 2);
    assert.equal(repo.list('solana')[0]?.label, 'Renamed');
    assert.equal(repo.remove('base', EVM.toUpperCase().replace('0X', '0x')), true);
    assert.equal(repo.remove('base', EVM), false);
  });
});

describe('WalletRegistry', () => {
  it('notifies only the chains whose list changed', () => {
    const repo = createWalletRepository(openDatabase(':memory:'));
    const registry = new WalletRegistry(repo, silentLogger);
    const seen: Array<ReadonlyMap<string, TrackedWallet>> = [];
    registry.onChange('solana', (wallets) => seen.push(wallets));
    repo.add('solana', SOL, 'Alpha');
    registry.refresh();
    registry.refresh();
    repo.add('base', EVM);
    registry.refresh();
    assert.equal(seen.length, 2); // initial empty + one change
    assert.equal(registry.find('solana', SOL)?.label, 'Alpha');
    assert.equal(registry.find('base', EVM)?.address, EVM.toLowerCase());
  });
});
