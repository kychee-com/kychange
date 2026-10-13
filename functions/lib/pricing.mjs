// Pure pricing arithmetic. The desk is a riskless principal: it buys sats from
// the buyer below the index (bid) and sells them on the venue, so its USD
// payout for a sats-in swap is the index price minus the spread.

const SATS_PER_BTC = 100_000_000;

/** USD micros the desk pays out for `sats`, at `btcUsd` minus `spreadBps`. */
export function usdOutMicros({ sats, btcUsd, spreadBps }) {
  if (!Number.isFinite(sats) || sats <= 0) throw new RangeError("sats must be positive");
  if (!Number.isFinite(btcUsd) || btcUsd <= 0) throw new RangeError("btcUsd must be positive");
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) throw new RangeError("spreadBps must be 0..9999");
  const usd = (sats / SATS_PER_BTC) * btcUsd * (1 - spreadBps / 10_000);
  return Math.floor(usd * 1_000_000);
}

/**
 * Sats the desk pays out for `usdMicros`, at `btcUsd` plus `spreadBps` (the
 * ask), floored to a whole sat. $5 at $80,000 and 50 bps is 6,218 sats.
 */
export function satsOut({ usdMicros, btcUsd, spreadBps }) {
  if (!Number.isInteger(usdMicros) || usdMicros <= 0) throw new RangeError("usdMicros must be a positive integer");
  if (!Number.isFinite(btcUsd) || btcUsd <= 0) throw new RangeError("btcUsd must be positive");
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) throw new RangeError("spreadBps must be 0..9999");
  const ask = btcUsd * (1 + spreadBps / 10_000);
  return Math.floor((usdMicros / 1_000_000 / ask) * SATS_PER_BTC);
}

/** The rate quoted to the buyer: the index after the spread, for the desk's side. */
export function rateAfterSpread({ btcUsd, spreadBps, side }) {
  const factor = side === "buy_btc" ? 1 - spreadBps / 10_000 : 1 + spreadBps / 10_000;
  return Math.round(btcUsd * factor * 100) / 100;
}

/** USD micros to a `$1.23` string. */
export function formatUsd(micros) {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  return `${sign}$${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, "0").slice(0, 2)}`;
}

/** Millisatoshis to whole sats, refusing a fractional amount. */
export function msatToSats(msat) {
  if (!Number.isInteger(msat) || msat <= 0 || msat % 1000 !== 0) throw new RangeError("msat must be a positive multiple of 1000");
  return msat / 1000;
}

/**
 * Whether a payout of `usdOutMicros` fits the desk's caps. The verdict is the
 * same for the quote (which marks a denomination unavailable) and the swap
 * (which parks an over-cap payment in `refund_due`), so the two never disagree.
 */
export function capVerdict({ usdOutMicros, maxFillUsd, dailyRemainingMicros }) {
  if (usdOutMicros > maxFillUsd * 1_000_000) {
    return { available: false, reason: "above_max_fill", reason_text: `closed: above the $${maxFillUsd} cap for one swap` };
  }
  if (usdOutMicros > dailyRemainingMicros) {
    return { available: false, reason: "daily_cap", reason_text: `closed: the desk's daily cap is reached (${formatUsd(dailyRemainingMicros)} left today)` };
  }
  return { available: true, reason: null, reason_text: null };
}
