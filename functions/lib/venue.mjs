// The hedge-venue adapter. `paper` marks to a public index price and fills
// every order instantly; it holds no account, so a paper hedge is a record,
// not a position. Real venues implement the same four calls.

import { HEDGE_VENUE, PAPER_BTC_USD } from "./config.mjs";

const COINBASE_SPOT = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

async function indexPrice() {
  if (PAPER_BTC_USD > 0) return { price: PAPER_BTC_USD, venueRef: "PAPER_BTC_USD" };
  const response = await fetch(COINBASE_SPOT, { signal: AbortSignal.timeout(4_000) });
  if (!response.ok) throw new Error(`index price unavailable (${response.status})`);
  const body = await response.json();
  const price = Number(body?.data?.amount);
  if (!Number.isFinite(price) || price <= 0) throw new Error("index price malformed");
  return { price: Math.round(price * 100) / 100, venueRef: "coinbase:BTC-USD/spot" };
}

export function paperVenue() {
  return {
    name: "paper",
    async quote({ side, usd }) {
      if (side !== "buy_btc" && side !== "sell_btc") throw new RangeError("side");
      if (!Number.isFinite(usd) || usd < 0) throw new RangeError("usd");
      const { price, venueRef } = await indexPrice();
      return { price, venueRef, asOf: new Date().toISOString() };
    },
    async placeOrder({ side, usd, clientOrderId }) {
      if (side !== "buy_btc" && side !== "sell_btc") throw new RangeError("side");
      const { price } = await indexPrice();
      return { orderId: `paper:${clientOrderId}`, status: "filled", filledUsd: usd, filledBtc: usd / price, price };
    },
    async getOrder(orderId) {
      return { status: "filled", orderId, filledUsd: 0, filledBtc: 0 };
    },
    async balances() {
      return { usd: 0, btc: 0, simulated: true };
    },
  };
}

export function venue() {
  if (HEDGE_VENUE === "paper") return paperVenue();
  throw new Error(`hedge venue "${HEDGE_VENUE}" is not wired; set HEDGE_VENUE=paper`);
}
