const DEXSCREENER_TOKENS_URL = 'https://api.dexscreener.com/tokens/v1';
const TIMEOUT_MS = 2_500;

export interface TokenName {
  readonly name: string | null;
  readonly symbol: string | null;
}

/**
 * Name/symbol of a token from DexScreener's free API (pairs endpoints: ~300 req/min).
 * Returns null when DexScreener does not know the token yet.
 */
export async function fetchDexScreenerTokenName(
  chainSlug: string,
  address: string,
  fetchFn: typeof fetch = fetch,
): Promise<TokenName | null> {
  const url = `${DEXSCREENER_TOKENS_URL}/${encodeURIComponent(chainSlug)}/${encodeURIComponent(address)}`;
  const response = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  const pairs: unknown = await response.json();
  if (!Array.isArray(pairs)) return null;
  for (const pair of pairs) {
    const base = (pair as { baseToken?: { address?: unknown; name?: unknown; symbol?: unknown } }).baseToken;
    if (typeof base?.address === 'string' && base.address.toLowerCase() === address.toLowerCase()) {
      return {
        name: typeof base.name === 'string' ? base.name : null,
        symbol: typeof base.symbol === 'string' ? base.symbol : null,
      };
    }
  }
  return null;
}
