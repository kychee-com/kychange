// The sats leg of a USDC-in swap, as a durable function run keyed by the
// gateway's payment id. The destination resolves to an invoice for exactly
// the quoted sats (a Lightning address through LNURL-pay, or the buyer's
// own invoice), the payment hash is recorded before the desk pays, and a
// run that finds that hash already settled finishes without paying again.
// Every refusal is a swap in `refund_due` with a reason, never a lost run.

import { defineFunctionRuns, functions, permanentFunctionRunError } from "@run402/functions";
import { BOLT11_CURRENCY, HEDGE_VENUE, NETWORK_MODE, PAYOUT_MAX_SATS_PER_RUN, payoutPairing } from "./lib/config.mjs";
import { LnurlError, checkPayoutInvoice, classifyDestination, resolveLnurlPay } from "./lib/lightning.mjs";
import { NwcError, NwcWallet, closeNwcConnections } from "./lib/nwc.mjs";
import { getSwap, ledger, recordAttempt, recordHedge, transition } from "./lib/swaps.mjs";
import { venue } from "./lib/venue.mjs";

/** Wallet answers that will not change on a retry: the swap owes a refund. */
const PERMANENT_WALLET_ERRORS = new Set([
  "INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "RESTRICTED", "UNAUTHORIZED", "PAYMENT_FAILED", "NOT_IMPLEMENTED", "BAD_URI",
]);

async function park(swap, ctx, reason, detail) {
  const note = detail ? `${reason}: ${String(detail).slice(0, 160)}` : reason;
  const moved = await transition(swap.swap_id, "payout_pending", "refund_due", { state_reason: note });
  if (!moved) return { ok: true, noop: true, swap_id: swap.swap_id, state: "moved_elsewhere" };
  await functions.runs.create("refund-usdc", {
    eventType: "refund.usdc",
    payload: { swap_id: swap.swap_id },
    idempotencyKey: `refund:${swap.payment_id}`,
    retry: { preset: "standard" },
  }).catch(() => undefined);
  return { ok: true, swap_id: swap.swap_id, state: "refund_due", reason, run_id: ctx.run.id };
}

async function finalize(swap, ctx, { preimage, paymentHash, feesPaidMsat, via }) {
  await recordAttempt({
    swap_id: swap.swap_id, run_id: ctx.run.id, mode: "lightning", outcome: "paid",
    response: { payment_hash: paymentHash, fees_paid_msat: feesPaidMsat ?? null, via },
  });
  const paid = await transition(swap.swap_id, "payout_pending", "paid_out", { preimage_out: preimage, paid_out_at: new Date().toISOString() });
  if (!paid) return { ok: true, noop: true, swap_id: swap.swap_id, state: "moved_elsewhere" };
  const simulated = NETWORK_MODE === "testnet";
  await ledger({ swap_id: swap.swap_id, asset: "USDC_MICROS", delta: Number(swap.amount_in), reason: "swap_in", simulated });
  await ledger({ swap_id: swap.swap_id, asset: "SAT", delta: -Number(swap.amount_out), reason: "payout", simulated });

  // Hedge the USDC the desk just took on: buy the sats back on the venue. Never blocks the payout.
  let hedge;
  try {
    const v = venue();
    const order = await v.placeOrder({ side: "buy_btc", usd: Number(swap.amount_in) / 1_000_000, clientOrderId: swap.swap_id });
    await recordHedge({ swap_id: swap.swap_id, venue: v.name, side: "buy_btc", client_order_id: swap.swap_id, status: order.status, response: order });
    hedge = { venue: v.name, status: order.status, order_id: order.orderId };
  } catch (error) {
    await recordHedge({
      swap_id: swap.swap_id, venue: HEDGE_VENUE, side: "buy_btc", client_order_id: swap.swap_id, status: "failed",
      response: { error: String(error?.message ?? error) },
    }).catch(() => undefined);
    hedge = { venue: HEDGE_VENUE, status: "failed" };
  }
  return { ok: true, swap_id: swap.swap_id, state: "paid_out", payment_hash: paymentHash, via, hedge };
}

async function payoutSats(ctx, payload) {
  const swapId = typeof payload?.swap_id === "string" ? payload.swap_id : null;
  if (!swapId) throw permanentFunctionRunError("payload.swap_id is required", "payout_payload_invalid");
  const swap = await getSwap(swapId);
  if (!swap) throw permanentFunctionRunError(`no swap ${swapId}`, "swap_not_found");
  if (swap.direction !== "usdc_in") throw permanentFunctionRunError(`swap ${swapId} is ${swap.direction}; this run pays sats out`, "wrong_direction");
  if (swap.state !== "payout_pending") return { ok: true, noop: true, swap_id: swapId, state: swap.state };

  const pairing = payoutPairing();
  if (!pairing) {
    await transition(swapId, "payout_pending", "stuck", { state_reason: "payout_pairing_missing" });
    throw permanentFunctionRunError("PAYOUT_NWC_PAIRING is not set; the desk cannot pay sats out", "payout_pairing_missing");
  }
  const sats = Number(swap.amount_out);
  if (!(sats > 0)) return park(swap, ctx, "venue_down", "the swap carries no sats amount");
  if (sats > PAYOUT_MAX_SATS_PER_RUN) return park(swap, ctx, "above_payout_cap", `${sats} sats is above the ${PAYOUT_MAX_SATS_PER_RUN}-sat cap for one payout`);
  const currency = BOLT11_CURRENCY[NETWORK_MODE] ?? "tb";
  // The function has 30 seconds on the hobby tier; a direct-channel payment takes two.
  const wallet = new NwcWallet(pairing, { timeoutMs: 18_000 });

  try {
    // A previous attempt may have paid before it could record the result: the
    // hash it stored is looked up first, and nothing is paid twice.
    if (swap.payment_hash) {
      const seen = await wallet.lookupInvoice(swap.payment_hash);
      if (seen?.state === "settled" && seen.preimage) {
        return await finalize(swap, ctx, { preimage: seen.preimage, paymentHash: swap.payment_hash, feesPaidMsat: null, via: "lookup" });
      }
      if (seen?.state === "pending") throw new Error(`payment ${swap.payment_hash} is still in flight`);
    }

    // Resolve the destination into an invoice for exactly the quoted sats.
    const destination = classifyDestination(swap.destination);
    let invoice;
    if (destination?.kind === "invoice") {
      const check = checkPayoutInvoice({ bolt11: destination.bolt11, satsOut: sats, currency });
      if (!check.ok) return await park(swap, ctx, check.reason, check.detail);
      invoice = { bolt11: destination.bolt11, paymentHash: check.paymentHash, amountMsat: check.amountMsat };
    } else if (destination?.kind === "address") {
      try {
        const resolved = await resolveLnurlPay({ name: destination.name, domain: destination.domain, amountMsat: sats * 1000, currency });
        invoice = { bolt11: resolved.bolt11, paymentHash: resolved.paymentHash, amountMsat: null };
      } catch (error) {
        if (error instanceof LnurlError && !error.retryable) return await park(swap, ctx, error.code, error.message);
        throw error;
      }
    } else {
      return await park(swap, ctx, "invalid_destination");
    }

    // The hash goes on the row before the payment, so a timeout is reconciled, never repaid.
    const armed = await transition(swapId, "payout_pending", "payout_pending", { payment_hash: invoice.paymentHash });
    if (!armed) return { ok: true, noop: true, swap_id: swapId, state: "moved_elsewhere" };
    let paid;
    try {
      paid = await wallet.payInvoice(invoice.bolt11, invoice.amountMsat);
    } catch (error) {
      const code = error instanceof NwcError ? error.code : "OTHER";
      if (error instanceof NwcError && PERMANENT_WALLET_ERRORS.has(code)) {
        await recordAttempt({ swap_id: swapId, run_id: ctx.run.id, mode: "lightning", outcome: "failed", response: { payment_hash: invoice.paymentHash, code, message: error.message } });
        return await park({ ...swap, payment_hash: invoice.paymentHash }, ctx, "payment_failed", `${code}: ${error.message}`);
      }
      // Unknown outcome (timeout, relay): the next attempt looks the hash up before anything else.
      await recordAttempt({ swap_id: swapId, run_id: ctx.run.id, mode: "lightning", outcome: "unknown", response: { payment_hash: invoice.paymentHash, code, message: String(error?.message ?? error) } });
      throw error;
    }
    return await finalize(swap, ctx, { preimage: paid.preimage, paymentHash: invoice.paymentHash, feesPaidMsat: paid.feesPaidMsat, via: "pay_invoice" });
  } finally {
    closeNwcConnections();
  }
}

export default defineFunctionRuns({ "payout.sats": payoutSats });
