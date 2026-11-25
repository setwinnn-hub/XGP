/**
 * Constant-product (x*y=k) swap maths. Exact for Uniswap-V2-style pairs; for concentrated
 * liquidity (V3/V4) it treats the pool as full-range, which overstates slippage for small
 * trades, so it is only ever reported as an estimate.
 *
 * "Slippage" here = price impact + pool fee, versus the pool's mid price. Token taxes are
 * not included (the security engine reports those separately).
 */

function check(reserveIn: number, reserveOut: number, amountIn: number, fee: number): void {
  if (!(reserveIn > 0 && reserveOut > 0 && amountIn > 0)) throw new Error('reserves and amount must be positive');
  if (!(fee >= 0 && fee < 1)) throw new Error('fee must be a fraction in [0, 1)');
}

/** Output of a swap of `amountIn` into a constant-product pool. */
export function cpAmountOut(reserveIn: number, reserveOut: number, amountIn: number, fee: number): number {
  check(reserveIn, reserveOut, amountIn, fee);
  const inAfterFee = amountIn * (1 - fee);
  return (reserveOut * inAfterFee) / (reserveIn + inAfterFee);
}

/** Percent lost versus the mid price when swapping `amountIn` (same units as `reserveIn`). */
export function cpSlippagePct(reserveIn: number, reserveOut: number, amountIn: number, fee: number): number {
  const out = cpAmountOut(reserveIn, reserveOut, amountIn, fee);
  const atMid = amountIn * (reserveOut / reserveIn);
  return (1 - out / atMid) * 100;
}

export interface SlippageEstimate {
  readonly buyPct: number;
  readonly sellPct: number;
}

/**
 * Buy: spend `tradeQuote` of the quote token. Sell: sell the token amount worth `tradeQuote`
 * at the mid price. Both in human units of the reserves.
 */
export function estimateSlippage(tokenReserve: number, quoteReserve: number, tradeQuote: number, fee: number): SlippageEstimate {
  const tokensWorth = tradeQuote * (tokenReserve / quoteReserve);
  return {
    buyPct: cpSlippagePct(quoteReserve, tokenReserve, tradeQuote, fee),
    sellPct: cpSlippagePct(tokenReserve, quoteReserve, tokensWorth, fee),
  };
}
