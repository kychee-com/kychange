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
/** `demo` records a simulated USDC transfer; `base` sends one from the project's Run402 KMS signer. */
export const PAYOUT_MODE = env("PAYOUT_MODE", "demo");
/** The Run402 KMS signer (`run402 contracts provision-signer`) that holds the desk's USDC and signs its transfers in `base` mode. */
export const PAYOUT_SIGNER_ID = env("PAYOUT_SIGNER_ID", "");
export function payoutSignerConfigured() {
  return PAYOUT_SIGNER_ID.length > 0;
}
/** The Base chain, its USDC contract, and its explorer, by network mode. */
export const BASE_CHAINS = Object.freeze({
  testnet: Object.freeze({ chain: "base-sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", explorer: "https://sepolia.basescan.org" }),
  mainnet: Object.freeze({ chain: "base-mainnet", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", explorer: "https://basescan.org" }),
});
export function baseChain() {
  return BASE_CHAINS[NETWORK_MODE] ?? BASE_CHAINS.testnet;
}
export const SPREAD_BPS = num("SPREAD_BPS", 50);
export const QUOTE_TTL_SECONDS = num("QUOTE_TTL_SECONDS", 60);
export const MAX_FILL_USD = num("MAX_FILL_USD", 25);
export const DAILY_CAP_USD = num("DAILY_CAP_USD", 100);
/** A fixed BTC/USD price for the paper venue; 0 reads the public index. */
export const PAPER_BTC_USD = num("PAPER_BTC_USD", 0);

/** Route A: the USD a buyer pays, one priced route each (`/api/sats/<id>`). */
function parseUsdDenominations(list) {
  const out = [];
  for (const raw of String(list).split(",")) {
    const id = raw.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(id)) continue;
    const micros = Math.round(Number(id) * 1_000_000);
    if (micros > 0 && !out.some((d) => d.usdMicros === micros)) out.push({ id, usdMicros: micros });
  }
  return out;
}
export const DENOMINATIONS_USD = Object.freeze(
  parseUsdDenominations(env("DENOMINATIONS_USD", NETWORK_MODE === "mainnet" ? "5,20,100" : "0.10,1,5")),
);
/** The most sats one payout run may send; the pairing's own budget bounds the day. */
export const PAYOUT_MAX_SATS_PER_RUN = num("PAYOUT_MAX_SATS_PER_RUN", 20_000);
/** The desk's spend-capped NWC pairing for paying sats out; read only by the payout run. */
export function payoutPairing() {
  return env("PAYOUT_NWC_PAIRING", "");
}
/** The x402 EVM network ids the gateway settles USDC on. */
export const EVM_NETWORKS = Object.freeze({ testnet: "eip155:84532", mainnet: "eip155:8453" });
/** The BOLT11 currency prefix a payout invoice must carry. */
export const BOLT11_CURRENCY = Object.freeze({ testnet: "tb", mainnet: "bc" });

/** Route B denominations: the sats a buyer pays, one priced route each. */
export const DENOMINATIONS = Object.freeze([
  { id: "100", sats: 100 },
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

export function usdDenominationById(id) {
  return DENOMINATIONS_USD.find((d) => d.id === id) ?? null;
}
