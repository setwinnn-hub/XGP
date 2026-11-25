export type NewsTag = 'LISTING' | 'LAUNCH' | 'PARTNERSHIP' | 'WHALE' | 'HACK_RUG' | 'AIRDROP' | 'REGULATION';

export interface NewsSignals {
  /** Upper-case tickers written as $SYMBOL, in order of first appearance. */
  readonly tickers: readonly string[];
  /** Contract addresses found in the text (EVM 0x… and Solana base58). */
  readonly addresses: readonly string[];
  readonly tags: readonly NewsTag[];
  /** Well-known meme coins named in plain text (e.g. "Dogecoin", "PEPE"). */
  readonly memeNames: readonly string[];
  readonly memeRelated: boolean;
}

const EXCHANGES = 'Binance|Coinbase|OKX|Bybit|Upbit|Kraken|Robinhood|Bithumb|KuCoin|Gate\\.io|Bitget|HTX|MEXC|Hyperliquid';

const TAG_RULES: ReadonlyArray<readonly [NewsTag, RegExp]> = [
  ['LISTING', new RegExp(`\\b(list(s|ed|ing)?|delist(s|ed|ing)?|adds?|added)\\b[^.]{0,60}\\b(${EXCHANGES})\\b|\\b(${EXCHANGES})\\b[^.]{0,60}\\b(list(s|ed|ing)?|delist(s|ed|ing)?|adds?|added)\\b`, 'i')],
  ['LAUNCH', /\b(launch(es|ed|ing)?|debut(s|ed)?|goes live|token generation event|TGE)\b/i],
  ['PARTNERSHIP', /\b(partner(s|ed|ship)?|collaborat(e|es|ion)|team(s|ed)? up)\b/i],
  ['WHALE', /\bwhales?\b/i],
  ['HACK_RUG', /\b(hack(ed|er|s)?|exploit(ed|s)?|rug ?pull(ed|s)?|scam|drain(ed|er)?|stolen)\b/i],
  ['AIRDROP', /\bairdrops?\b/i],
  ['REGULATION', /\b(SEC|CFTC|lawsuit|ban(s|ned)?|regulat(or|ion|ory))\b/],
];

/** Meme coins well enough known to count as meme-coin news when named without a $ sign. */
const KNOWN_MEMES: ReadonlyArray<readonly [string, RegExp]> = [
  ['DOGE', /\bdogecoin\b|\bDOGE\b/i],
  ['SHIB', /\b(shiba inu|SHIB)\b/i],
  ['PEPE', /\bPEPE\b/],
  ['WIF', /\bdogwifhat\b|\bWIF\b/i],
  ['BONK', /\bBONK\b/i],
  ['FLOKI', /\bFLOKI\b/i],
  ['TRUMP', /(?<![\w$])\$TRUMP\b|\bTRUMP (meme )?(coin|token)\b/i],
  ['PENGU', /\b(PENGU|Pudgy Penguins token)\b/],
  ['POPCAT', /\bPOPCAT\b/i],
  ['FARTCOIN', /\bfartcoin\b/i],
  ['BRETT', /\bBRETT\b/],
  ['MOG', /\bMOG\b/],
];

const MEME_TERMS = /\b(meme ?coins?|memecoins?|pump\.fun|pumpfun|letsbonk|four\.meme|degen)\b/i;
const TICKER = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;
const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/g;
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
/** Fiat/stable symbols written with $ that are prices or dollars, not meme tokens. */
const NOT_TICKERS = new Set(['USD', 'USDT', 'USDC', 'BTC', 'ETH', 'SOL', 'BNB', 'B', 'M', 'K', 'BN', 'MN', 'BILLION', 'MILLION', 'TRILLION']);

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Only look for Solana addresses when the text says it is giving one (slugs and IDs look alike). */
const ADDRESS_CONTEXT = /\b(CA|contract|token address|mint address|pump\.fun|solscan|dexscreener)\b/i;

function solanaAddresses(text: string): string[] {
  if (!ADDRESS_CONTEXT.test(text)) return [];
  // Real addresses mix digits and letters; this filters out long plain words.
  return [...text.matchAll(SOLANA_ADDRESS)].map((m) => m[0]).filter((a) => /\d/.test(a) && /[a-z]/.test(a) && /[A-Z]/.test(a));
}

const MAX_TEXT = 4_000;

/** Facts extracted from a headline + summary. Pure and deterministic. */
export function extractSignals(title: string, summary: string): NewsSignals {
  const text = `${title}\n${summary}`.slice(0, MAX_TEXT);
  const tickers = unique([...text.matchAll(TICKER)].map((m) => (m[1] ?? '').toUpperCase()).filter((t) => !NOT_TICKERS.has(t)));
  const addresses = unique([...[...text.matchAll(EVM_ADDRESS)].map((m) => m[0]), ...solanaAddresses(text)]);
  const tags = TAG_RULES.filter(([, rule]) => rule.test(text)).map(([tag]) => tag);
  const memeNames = KNOWN_MEMES.filter(([, rule]) => rule.test(text)).map(([name]) => name);
  const memeRelated = MEME_TERMS.test(text) || memeNames.length > 0;
  return { tickers, addresses, tags, memeNames, memeRelated };
}

const TAG_REASONS: Readonly<Record<NewsTag, string>> = {
  LISTING: 'ข่าว listing/delisting บนกระดานใหญ่ มักทำให้ volume และราคาเปลี่ยนแรงในเวลาสั้น',
  LAUNCH: 'มีการเปิดตัวเหรียญหรือผลิตภัณฑ์ใหม่',
  PARTNERSHIP: 'มีการประกาศความร่วมมือ ซึ่งมักเป็นตัวเร่งกระแส',
  WHALE: 'มีความเคลื่อนไหวของรายใหญ่ (whale)',
  HACK_RUG: '⚠️ ความเสี่ยง: เกี่ยวกับการแฮ็ก, exploit, rug pull หรือ scam',
  AIRDROP: 'มีข่าว airdrop ซึ่งมักดึงคนเข้ามาจำนวนมาก',
  REGULATION: 'เกี่ยวข้องกับหน่วยงานกำกับดูแลหรือกฎหมาย อาจกระทบทั้งตลาด',
};

/** Rule-based "why this matters" lines (no AI). Empty when nothing specific matched. */
export function explainSignals(signals: NewsSignals): string[] {
  const reasons = signals.tags.map((tag) => TAG_REASONS[tag]);
  const named = unique([...signals.tickers, ...signals.memeNames]);
  if (named.length > 0) reasons.push(`กล่าวถึงเหรียญ: ${named.slice(0, 6).map((t) => `$${t}`).join(', ')}`);
  if (signals.addresses.length > 0) reasons.push('มี contract address ในข่าว ตรวจสอบได้ทันที');
  return reasons;
}
