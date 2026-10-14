// POST /api/usdc/:denomination, priced in sats over x402 `exact` on `lnbtc`.
// The gateway has already settled the invoice when this runs, so the money is
// in and the function cannot refuse; it records the swap and hands the USDC
// leg to a durable run. An unusable request becomes a swap in `refund_due`.

import { functions, getRoutedPaymentContext } from "@run402/functions";
import { inventoryMicros } from "./lib/base.mjs";
import { DAILY_CAP_USD, MAX_FILL_USD, NETWORK_MODE, PAYOUT_MODE, SPREAD_BPS, denominationById, payoutSignerConfigured } from "./lib/config.mjs";
import { capVerdict, formatUsd, msatToSats, usdOutMicros } from "./lib/pricing.mjs";
import { insertSwap, newId, notionalTodayMicros, transition, validQuote } from "./lib/swaps.mjs";
import { venue } from "./lib/venue.mjs";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export default async function handler(req) {
  const headers = { "cache-control": "private, no-store" };
  if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  const payment = getRoutedPaymentContext(req);
  if (!payment) {
    // A direct or unpaid invocation: nothing was paid, so nothing is swapped.
    return Response.json({
      error: "payment_context_missing",
      message: "This function only runs behind its priced route (POST /api/usdc/:denomination); the gateway settles the Lightning payment before invoking it.",
    }, { status: 400, headers });
  }
  const url = new URL(req.url);
  const denomination = denominationById(url.pathname.split("/").pop() ?? "");
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const destination = typeof body?.destination === "string" ? body.destination.trim() : "";
  const validDestination = EVM_ADDRESS.test(destination);
  const satsIn = typeof payment.amountMsat === "number" ? msatToSats(payment.amountMsat) : (denomination?.sats ?? 0);

  // Price the USDC leg: a presented, still-valid quote, else a fresh index read.
  let rate = 0;
  let quoteId = null;
  const presented = typeof body?.quote_id === "string" ? await validQuote(body.quote_id) : null;
  if (presented) {
    rate = Number(presented.venue_price);
    quoteId = presented.quote_id;
  } else {
    try { rate = (await venue().quote({ side: "buy_btc", usd: 0 })).price; } catch { rate = 0; }
  }

  let state = "paid";
  let reason = null;
  let usdOut = 0;
  if (!validDestination) { state = "refund_due"; reason = "invalid_destination"; }
  else if (!(rate > 0) || satsIn <= 0) { state = "refund_due"; reason = "venue_down"; }
  else {
    usdOut = usdOutMicros({ sats: satsIn, btcUsd: rate, spreadBps: SPREAD_BPS });
    // The caps the quote advertises are enforced here: the money is in, so an
    // over-cap payment becomes a swap that owes a refund, never a payout.
    const dailyRemaining = Math.max(0, DAILY_CAP_USD * 1_000_000 - await notionalTodayMicros());
    const verdict = capVerdict({ usdOutMicros: usdOut, maxFillUsd: MAX_FILL_USD, dailyRemainingMicros: dailyRemaining });
    if (!verdict.available) { state = "refund_due"; reason = verdict.reason; }
    else if (PAYOUT_MODE === "base") {
      // The quote closed this before payment; the same verdict here is the backstop.
      if (!payoutSignerConfigured()) { state = "refund_due"; reason = "payout_unavailable"; }
      else {
        const inventory = await inventoryMicros();
        if (inventory === null) { state = "refund_due"; reason = "payout_unavailable"; }
        else if (usdOut > inventory) { state = "refund_due"; reason = "inventory_short"; }
      }
    }
  }

  const { swap, created } = await insertSwap({
    swap_id: newId("swp"), direction: "sats_in",
    payment_id: payment.paymentId, payment_hash: payment.transaction ?? null, payer: null,
    amount_in: satsIn, asset_in: "SAT", amount_out: usdOut, asset_out: "USDC",
    destination: validDestination ? destination : (destination || "-").slice(0, 128),
    quote_id: quoteId, rate_btc_usd: rate, spread_bps: SPREAD_BPS,
    state, state_reason: reason, claim_token: newId("clm"), network_mode: NETWORK_MODE,
  });
  if (!swap) return Response.json({ error: "swap_insert_failed" }, { status: 500, headers });

  let current = swap;
  if (created && swap.state === "paid") {
    try {
      const run = await functions.runs.create("payout-usdc", {
        eventType: "payout.usdc",
        payload: { swap_id: swap.swap_id },
        idempotencyKey: payment.paymentId,
        retry: { preset: "standard" },
      });
      current = (await transition(swap.swap_id, "paid", "payout_pending", { payout_run_id: run.run_id })) ?? swap;
    } catch (error) {
      // The money is in and the row exists; the sweep (or an operator) re-enqueues from `paid`.
      const note = `enqueue_failed: ${String(error?.message ?? error).slice(0, 160)}`;
      current = (await transition(swap.swap_id, "paid", "paid", { state_reason: note })) ?? swap;
    }
  }

  const statusUrl = `${url.origin}/api/swaps/${current.swap_id}?claim=${encodeURIComponent(current.claim_token)}`;
  return Response.json({
    swap_id: current.swap_id,
    state: current.state,
    state_reason: current.state_reason ?? null,
    sats_in: Number(current.amount_in),
    usd_out_micros: Number(current.amount_out),
    usd_out: formatUsd(Number(current.amount_out)),
    destination: current.destination,
    rate_btc_usd: Number(current.rate_btc_usd),
    spread_bps: current.spread_bps,
    claim_token: current.claim_token,
    status_url: statusUrl,
    payment: {
      payment_id: payment.paymentId, payment_hash: payment.transaction ?? null, network: payment.network,
      amount_msat: payment.amountMsat ?? null, settled_at: payment.settledAt ?? null,
      delivery: payment.delivery, deduplicated: payment.deduplicated,
    },
    replayed: !created,
  }, { status: created ? 202 : 200, headers });
}
