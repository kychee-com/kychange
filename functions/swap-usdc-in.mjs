// POST /api/sats/:usd, priced in USD over x402 on Base. The gateway has
// already settled the USDC through the facilitator when this runs, so the
// money is in and the function cannot refuse; it records the swap and hands
// the sats leg to a durable run. An unusable request becomes a swap in
// `refund_due`, and the refund run records (demo) or sends the USDC back.

import { functions, getRoutedPaymentContext } from "@run402/functions";
import {
  BOLT11_CURRENCY, DAILY_CAP_USD, MAX_FILL_USD, NETWORK_MODE, PAYOUT_MAX_SATS_PER_RUN, SPREAD_BPS, usdDenominationById,
} from "./lib/config.mjs";
import { checkPayoutInvoice, classifyDestination } from "./lib/lightning.mjs";
import { capVerdict, formatUsd, rateAfterSpread, satsOut } from "./lib/pricing.mjs";
import { insertSwap, newId, notionalTodayMicros, transition, validQuote } from "./lib/swaps.mjs";
import { venue } from "./lib/venue.mjs";

export default async function handler(req) {
  const headers = { "cache-control": "private, no-store" };
  if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  const payment = getRoutedPaymentContext(req);
  if (!payment) {
    return Response.json({
      error: "payment_context_missing",
      message: "This function only runs behind its priced route (POST /api/sats/:usd); the gateway settles the USDC payment before invoking it.",
    }, { status: 400, headers });
  }
  const url = new URL(req.url);
  const denomination = usdDenominationById(url.pathname.split("/").pop() ?? "");
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const rawDestination = typeof body?.destination === "string" ? body.destination.trim() : "";
  const destination = classifyDestination(rawDestination);
  const usdIn = Number.isInteger(payment.amountUsdMicros) && payment.amountUsdMicros > 0 ? payment.amountUsdMicros : (denomination?.usdMicros ?? 0);

  // Price the sats leg at the ask: a presented, still-valid quote, else a fresh index read.
  let rate = 0;
  let quoteId = null;
  const presented = typeof body?.quote_id === "string" ? await validQuote(body.quote_id) : null;
  if (presented) {
    rate = Number(presented.venue_price);
    quoteId = presented.quote_id;
  } else {
    try { rate = (await venue().quote({ side: "sell_btc", usd: 0 })).price; } catch { rate = 0; }
  }

  let state = "paid";
  let reason = null;
  let sats = 0;
  if (!destination) { state = "refund_due"; reason = "invalid_destination"; }
  else if (!(rate > 0) || usdIn <= 0) { state = "refund_due"; reason = "venue_down"; }
  else {
    sats = satsOut({ usdMicros: usdIn, btcUsd: rate, spreadBps: SPREAD_BPS });
    const dailyRemaining = Math.max(0, DAILY_CAP_USD * 1_000_000 - await notionalTodayMicros());
    const verdict = capVerdict({ usdOutMicros: usdIn, maxFillUsd: MAX_FILL_USD, dailyRemainingMicros: dailyRemaining });
    if (!verdict.available) { state = "refund_due"; reason = verdict.reason; }
    else if (sats > PAYOUT_MAX_SATS_PER_RUN) { state = "refund_due"; reason = "above_payout_cap"; }
    else if (destination.kind === "invoice") {
      // An invoice with an amount must name exactly the quoted sats; the run checks again before paying.
      const check = checkPayoutInvoice({ bolt11: destination.bolt11, satsOut: sats, currency: BOLT11_CURRENCY[NETWORK_MODE] ?? "tb" });
      if (!check.ok) { state = "refund_due"; reason = check.reason; }
    }
  }

  const { swap, created } = await insertSwap({
    swap_id: newId("swp"), direction: "usdc_in",
    payment_id: payment.paymentId, payment_hash: null, payer: payment.payer ?? null,
    amount_in: usdIn, asset_in: "USDC", amount_out: sats, asset_out: "SAT",
    destination: destination ? (destination.kind === "invoice" ? destination.bolt11 : destination.address) : (rawDestination || "-").slice(0, 128),
    quote_id: quoteId, rate_btc_usd: rate, spread_bps: SPREAD_BPS,
    state, state_reason: reason, claim_token: newId("clm"), network_mode: NETWORK_MODE,
    tx_hash_in: payment.transaction ?? null,
  });
  if (!swap) return Response.json({ error: "swap_insert_failed" }, { status: 500, headers });

  let current = swap;
  if (created && swap.state === "paid") {
    try {
      const run = await functions.runs.create("payout-sats", {
        eventType: "payout.sats",
        payload: { swap_id: swap.swap_id },
        idempotencyKey: payment.paymentId,
        retry: { preset: "standard" },
      });
      current = (await transition(swap.swap_id, "paid", "payout_pending", { payout_run_id: run.run_id })) ?? swap;
    } catch (error) {
      const note = `enqueue_failed: ${String(error?.message ?? error).slice(0, 160)}`;
      current = (await transition(swap.swap_id, "paid", "paid", { state_reason: note })) ?? swap;
    }
  } else if (created && swap.state === "refund_due") {
    // The money is in and cannot be used: the refund run records (demo) or sends it back.
    await functions.runs.create("refund-usdc", {
      eventType: "refund.usdc",
      payload: { swap_id: swap.swap_id },
      idempotencyKey: `refund:${payment.paymentId}`,
      retry: { preset: "standard" },
    }).catch(() => undefined);
  }

  const statusUrl = `${url.origin}/api/swaps/${current.swap_id}?claim=${encodeURIComponent(current.claim_token)}`;
  return Response.json({
    swap_id: current.swap_id,
    direction: "usdc_in",
    state: current.state,
    state_reason: current.state_reason ?? null,
    usd_in_micros: Number(current.amount_in),
    usd_in: formatUsd(Number(current.amount_in)),
    sats_out: Number(current.amount_out),
    destination: current.destination,
    rate_btc_usd: Number(current.rate_btc_usd),
    rate_btc_usd_ask: rate > 0 ? rateAfterSpread({ btcUsd: rate, spreadBps: SPREAD_BPS, side: "sell_btc" }) : null,
    spread_bps: current.spread_bps,
    claim_token: current.claim_token,
    status_url: statusUrl,
    payment: {
      payment_id: payment.paymentId, transaction: payment.transaction ?? null, network: payment.network, payer: payment.payer ?? null,
      amount_usd_micros: payment.amountUsdMicros, settled_at: payment.settledAt ?? null,
      delivery: payment.delivery, deduplicated: payment.deduplicated,
    },
    replayed: !created,
  }, { status: created ? 202 : 200, headers });
}
