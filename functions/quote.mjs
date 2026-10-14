// GET /api/quote: the desk's state in both directions and a quote id a buyer
// may present with the paid request. The desk's "closed" state lives here,
// because a priced route cannot be closed without a deploy; a buyer who pays
// while closed is refunded by the refund run.

import { inventoryMicros } from "./lib/base.mjs";
import {
  BOLT11_CURRENCY, DAILY_CAP_USD, DENOMINATIONS, DENOMINATIONS_USD, EVM_NETWORKS, LNBTC_NETWORKS, MAX_FILL_USD, NETWORK_MODE,
  PAYOUT_MAX_SATS_PER_RUN, PAYOUT_MODE, QUOTE_TTL_SECONDS, SPREAD_BPS, payoutPairing, payoutSignerConfigured,
} from "./lib/config.mjs";
import { capVerdict, formatUsd, rateAfterSpread, satsOut, usdOutMicros } from "./lib/pricing.mjs";
import { insertQuote, newId, notionalTodayMicros } from "./lib/swaps.mjs";
import { venue } from "./lib/venue.mjs";

const closed = (reason, reason_text) => ({ open: false, reason, reason_text });

export default async function handler(req) {
  const headers = { "cache-control": "no-store", "access-control-allow-origin": "*" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  }
  let index;
  try {
    index = await venue().quote({ side: "buy_btc", usd: 0 });
  } catch (error) {
    const down = closed("venue_down", "closed: the index price is unavailable");
    return Response.json({
      ...down, network_mode: NETWORK_MODE, message: String(error?.message ?? error),
      directions: { sats_in: { ...down, denominations: [] }, usdc_in: { ...down, denominations: [] } },
    }, { headers });
  }
  const notionalToday = await notionalTodayMicros();
  const dailyRemaining = Math.max(0, DAILY_CAP_USD * 1_000_000 - notionalToday);
  const quoteId = newId("qt");
  const validUntil = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString();
  const bid = rateAfterSpread({ btcUsd: index.price, spreadBps: SPREAD_BPS, side: "buy_btc" });
  const ask = rateAfterSpread({ btcUsd: index.price, spreadBps: SPREAD_BPS, side: "sell_btc" });
  await insertQuote({
    quote_id: quoteId, side: "buy_btc", venue: index.venueRef, venue_price: index.price,
    spread_bps: SPREAD_BPS, rate: bid, valid_until: validUntil,
  });

  // Route B: sats in, USDC out, at the bid. In base mode the desk's USDC
  // inventory is the signer's balance, read now, so a buyer never pays for a
  // payout the desk cannot make.
  const baseMode = PAYOUT_MODE === "base";
  const inventory = baseMode && payoutSignerConfigured() ? await inventoryMicros() : null;
  const satsIn = DENOMINATIONS.map((d) => {
    const micros = usdOutMicros({ sats: d.sats, btcUsd: index.price, spreadBps: SPREAD_BPS });
    let verdict = capVerdict({ usdOutMicros: micros, maxFillUsd: MAX_FILL_USD, dailyRemainingMicros: dailyRemaining });
    if (verdict.available && baseMode) {
      if (!payoutSignerConfigured()) verdict = { available: false, reason: "payout_unavailable", reason_text: "closed: the desk has no USDC signer" };
      else if (inventory === null) verdict = { available: false, reason: "payout_unavailable", reason_text: "closed: the desk's USDC inventory could not be read" };
      else if (micros > inventory) verdict = { available: false, reason: "inventory_short", reason_text: `closed: the desk's USDC inventory (${formatUsd(inventory)}) cannot cover this payout` };
    }
    return {
      id: d.id, sats_in: d.sats, usd_out_micros: micros, usd_out: formatUsd(micros),
      route: `/api/usdc/${d.id}`, method: "POST",
      available: verdict.available, reason: verdict.reason, reason_text: verdict.reason_text,
    };
  });
  const satsInOpen = satsIn.some((d) => d.available);

  // Route A: USDC in, sats out, at the ask; closed as a whole without a payout pairing.
  const payoutReady = Boolean(payoutPairing());
  const usdcIn = DENOMINATIONS_USD.map((d) => {
    const sats = satsOut({ usdMicros: d.usdMicros, btcUsd: index.price, spreadBps: SPREAD_BPS });
    let verdict = capVerdict({ usdOutMicros: d.usdMicros, maxFillUsd: MAX_FILL_USD, dailyRemainingMicros: dailyRemaining });
    if (verdict.available && sats > PAYOUT_MAX_SATS_PER_RUN) {
      verdict = { available: false, reason: "above_payout_cap", reason_text: `closed: above the ${PAYOUT_MAX_SATS_PER_RUN.toLocaleString("en-US")}-sat cap for one payout` };
    }
    if (verdict.available && !payoutReady) verdict = { available: false, reason: "payout_unavailable", reason_text: "closed: the desk has no payout wallet pairing" };
    return {
      id: d.id, usd_in_micros: d.usdMicros, usd_in: formatUsd(d.usdMicros), sats_out: sats,
      route: `/api/sats/${d.id}`, method: "POST",
      available: verdict.available, reason: verdict.reason, reason_text: verdict.reason_text,
    };
  });
  const usdcInOpen = usdcIn.some((d) => d.available);
  const open = satsInOpen || usdcInOpen;

  return Response.json({
    open, reason: open ? null : "caps", reason_text: open ? null : "closed: every denomination is above a cap right now",
    network_mode: NETWORK_MODE,
    lightning_network: LNBTC_NETWORKS[NETWORK_MODE] ?? null,
    usdc_network: EVM_NETWORKS[NETWORK_MODE] ?? null,
    quote_id: quoteId, valid_until: validUntil,
    rate: { btc_usd_index: index.price, btc_usd_bid: bid, btc_usd_ask: ask, spread_bps: SPREAD_BPS, venue: index.venueRef, as_of: index.asOf },
    directions: {
      sats_in: {
        open: satsInOpen, reason: satsInOpen ? null : "caps", reason_text: satsInOpen ? null : "closed: every denomination is above a cap right now",
        pay: "sats over Bitcoin Lightning (x402 exact on lnbtc)", receive: "USDC on Base",
        rate_btc_usd: bid, denominations: satsIn,
        payout_mode: PAYOUT_MODE,
        inventory_usd_micros: baseMode ? inventory : null,
        body: { destination: "0x… an EVM address on the route's Base network", quote_id: "optional, this quote_id while valid_until holds" },
      },
      usdc_in: {
        open: usdcInOpen,
        reason: usdcInOpen ? null : (payoutReady ? "caps" : "payout_unavailable"),
        reason_text: usdcInOpen ? null : (payoutReady ? "closed: every denomination is above a cap right now" : "closed: the desk has no payout wallet pairing"),
        pay: "USDC on Base (x402 exact on eip155)", receive: "sats over Bitcoin Lightning",
        rate_btc_usd: ask, denominations: usdcIn,
        payout_max_sats_per_run: PAYOUT_MAX_SATS_PER_RUN,
        invoice_currency: BOLT11_CURRENCY[NETWORK_MODE] ?? null,
        body: {
          destination: `a Lightning address (name@domain) or a BOLT11 invoice (ln${BOLT11_CURRENCY[NETWORK_MODE] ?? "tb"}…) for exactly sats_out or with no amount`,
          quote_id: "optional, this quote_id while valid_until holds",
        },
      },
    },
    caps: { max_fill_usd: MAX_FILL_USD, daily_cap_usd: DAILY_CAP_USD, daily_remaining_usd_micros: dailyRemaining, payout_max_sats_per_run: PAYOUT_MAX_SATS_PER_RUN },
    discovery: "/.well-known/x402",
  }, { headers });
}
