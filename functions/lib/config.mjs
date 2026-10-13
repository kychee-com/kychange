// Operator configuration. Every value is an environment variable set through
// Run402 function secrets (`run402 secrets set NAME value`); the defaults are
// the public testnet instance's.

const env = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};
const num = (name, fallback) => {
  const value = Number(env(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
};

/** `testnet` (Base Sepolia + Lightning testnet3) or `mainnet`. */
export const NETWORK_MODE = env("NETWORK_MODE", "testnet");
/** Hedge venue adapter: `paper` marks to a public index and fills instantly. */
export const HEDGE_VENUE = env("HEDGE_VENUE", "paper");
/** `demo` records a simulated USDC transfer; `base` sends one from the hot EOA (not wired yet). */
export const PAYOUT_MODE = env("PAYOUT_MODE", "demo");
export const SPREAD_BPS = num("SPREAD_BPS", 50);
export const QUOTE_TTL_SECONDS = num("QUOTE_TTL_SECONDS", 60);
export const MAX_FILL_USD = num("MAX_FILL_USD", 25);
export const DAILY_CAP_USD = num("DAILY_CAP_USD", 100);
/** A fixed BTC/USD price for the paper venue; 0 reads the public index. */
export const PAPER_BTC_USD = num("PAPER_BTC_USD", 0);

/** Route B denominations: the sats a buyer pays, one priced route each. */
export const DENOMINATIONS = Object.freeze([
  { id: "10k", sats: 10_000 },
  { id: "100k", sats: 100_000 },
  { id: "1m", sats: 1_000_000 },
]);

export const USDC_DECIMALS = 6;

/** The x402 `lnbtc` network ids the gateway settles on. */
export const LNBTC_NETWORKS = Object.freeze({
  testnet: "lnbtc:000000000933ea01ad0ee984209779ba",
  mainnet: "lnbtc:000000000019d6689c085ae165831e93",
});

export function denominationById(id) {
  return DENOMINATIONS.find((d) => d.id === id) ?? null;
}
