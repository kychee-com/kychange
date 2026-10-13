// GET /api/quote: the desk's state and a quote id a buyer may present with
// the paid request. The desk's "closed" state lives here, because a priced
// route cannot be closed without a deploy; a buyer who pays while closed is
// refunded by the payout run.

import {
  DAILY_CAP_USD, DENOMINATIONS, LNBTC_NETWORKS, MAX_FILL_USD, NETWORK_MODE, QUOTE_TTL_SECONDS, SPREAD_BPS,
} from "./lib/config.mjs";
import { capVerdict, formatUsd, rateAfterSpread, usdOutMicros } from "./lib/pricing.mjs";
import { insertQuote, newId, paidOutTodayMicros } from "./lib/swaps.mjs";
import { venue } from "./lib/venue.mjs";

export default async function handler(req) {
  const headers = { "cache-control": "no-store", "access-control-allow-origin": "*" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  }
  let index;
  try {
    index = await venue().quote({ side: "buy_btc", usd: 0 });
  } catch (error) {
    return Response.json({
      open: false, reason: "venue_down", network_mode: NETWORK_MODE, direction: "sats_in",
      reason_text: "closed: the index price is unavailable",
      message: String(error?.message ?? error),
    }, { headers });
  }
  const paidToday = await paidOutTodayMicros();
  const dailyRemaining = Math.max(0, DAILY_CAP_USD * 1_000_000 - paidToday);
  const quoteId = newId("qt");
  const validUntil = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString();
  const bid = rateAfterSpread({ btcUsd: index.price, spreadBps: SPREAD_BPS, side: "buy_btc" });
  await insertQuote({
    quote_id: quoteId, side: "buy_btc", venue: index.venueRef, venue_price: index.price,
    spread_bps: SPREAD_BPS, rate: bid, valid_until: validUntil,
  });
  const denominations = DENOMINATIONS.map((d) => {
    const micros = usdOutMicros({ sats: d.sats, btcUsd: index.price, spreadBps: SPREAD_BPS });
    const verdict = capVerdict({ usdOutMicros: micros, maxFillUsd: MAX_FILL_USD, dailyRemainingMicros: dailyRemaining });
    return {
      id: d.id, sats_in: d.sats, usd_out_micros: micros, usd_out: formatUsd(micros),
      route: `/api/usdc/${d.id}`, method: "POST",
      available: verdict.available, reason: verdict.reason, reason_text: verdict.reason_text,
    };
  });
  const open = denominations.some((d) => d.available);
  return Response.json({
    open, reason: open ? null : "caps", reason_text: open ? null : "closed: every denomination is above a cap right now",
    direction: "sats_in", network_mode: NETWORK_MODE,
    lightning_network: LNBTC_NETWORKS[NETWORK_MODE] ?? null,
    quote_id: quoteId, valid_until: validUntil,
    rate: { btc_usd_index: index.price, btc_usd_bid: bid, spread_bps: SPREAD_BPS, venue: index.venueRef, as_of: index.asOf },
    denominations,
    caps: { max_fill_usd: MAX_FILL_USD, daily_cap_usd: DAILY_CAP_USD, daily_remaining_usd_micros: dailyRemaining },
    body: { destination: "0x… an EVM address on the route's Base network", quote_id: "optional, this quote_id while valid_until holds" },
  }, { headers });
}
