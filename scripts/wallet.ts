/**
 * Manage followed wallets. The running bot picks up changes within ~15 seconds.
 *
 *   npm run wallet -- list
 *   npm run wallet -- add solana <address> "label"
 *   npm run wallet -- add base 0xabc... "label"
 *   npm run wallet -- remove solana <address>
 */
import { loadConfig } from '../src/config.ts';
import { errorMessage } from '../src/core/logger.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createWalletRepository } from '../src/wallets/wallet-repo.ts';

const USAGE = 'Usage: npm run wallet -- list | add <chain> <address> [label] | remove <chain> <address>';

function main(): void {
  const [command, chain, address, ...labelParts] = process.argv.slice(2);
  const wallets = createWalletRepository(openDatabase(loadConfig().dbPath));

  if (command === 'list' || command === undefined) {
    const rows = wallets.list();
    if (rows.length === 0) process.stdout.write('No wallets yet.\n');
    for (const w of rows) process.stdout.write(`${w.chain.padEnd(9)} ${w.address}  ${w.label ?? ''}\n`);
    return;
  }
  if (!chain || !address) throw new Error(USAGE);
  if (command === 'add') {
    const wallet = wallets.add(chain, address, labelParts.join(' '));
    process.stdout.write(`Following ${wallet.chain} ${wallet.address} ${wallet.label ?? ''}\n`);
    return;
  }
  if (command === 'remove') {
    process.stdout.write(wallets.remove(chain, address) ? 'Removed.\n' : 'Not found.\n');
    return;
  }
  throw new Error(USAGE);
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
}
