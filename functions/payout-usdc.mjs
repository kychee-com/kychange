// The USDC leg of a sats-in swap, as a durable function run keyed by the
// gateway's payment id. `demo` records a simulated transfer (deterministic
// per swap). `base` transfers real USDC from the project's Run402 KMS signer
// through the platform's contract-call route, idempotent on the swap, and
// records the call before it waits for confirmation, so a re-fired run
// resumes that call and never transfers twice.

import { createHash } from "node:crypto";
import { defineFunctionRuns, permanentFunctionRunError } from "@run402/functions";
import { BaseCallError, transferUsdc, waitForCall } from "./lib/base.mjs";
import { HEDGE_VENUE, NETWORK_MODE, PAYOUT_MODE, payoutSignerConfigured } from "./lib/config.mjs";
import { getSwap, latestAttempt, ledger, recordAttempt, recordHedge, transition } from "./lib/swaps.mjs";
import { venue } from "./lib/venue.mjs";

async function finalize(swap, ctx, { txHash, simulatedUsdc }) {
  const paid = await transition(swap.swap_id, "payout_pending", "paid_out", { tx_hash_out: txHash, paid_out_at: new Date().toISOString() });
  if (!paid) return { ok: true, noop: true, swap_id: swap.swap_id, state: "moved_elsewhere" };
  await ledger({ swap_id: swap.swap_id, asset: "SAT", delta: Number(swap.amount_in), reason: "swap_in", simulated: NETWORK_MODE === "testnet" });
  await ledger({ swap_id: swap.swap_id, asset: "USDC_MICROS", delta: -Number(swap.amount_out), reason: "payout", simulated: simulatedUsdc });

  // Hedge the sats the desk just took on. Never blocks the payout.
  let hedge;
  try {
    const v = venue();
    const order = await v.placeOrder({ side: "sell_btc", usd: Number(swap.amount_out) / 1_000_000, clientOrderId: swap.swap_id });
    await recordHedge({ swap_id: swap.swap_id, venue: v.name, side: "sell_btc", client_order_id: swap.swap_id, status: order.status, response: order });
    hedge = { venue: v.name, status: order.status, order_id: order.orderId };
  } catch (error) {
    await recordHedge({
      swap_id: swap.swap_id, venue: HEDGE_VENUE, side: "sell_btc", client_order_id: swap.swap_id, status: "failed",
      response: { error: String(error?.message ?? error) },
    }).catch(() => undefined);
    hedge = { venue: HEDGE_VENUE, status: "failed" };
  }
  return { ok: true, swap_id: swap.swap_id, state: "paid_out", tx_hash_out: txHash, hedge, run_id: ctx.run.id };
}

async function payoutDemo(swap, ctx) {
  const txHash = "simulated:" + createHash("sha256").update(`kychange:payout:${swap.swap_id}`).digest("hex");
  await recordAttempt({
    swap_id: swap.swap_id, run_id: ctx.run.id, mode: "demo", outcome: "simulated",
    response: { tx_hash: txHash, amount_out_micros: Number(swap.amount_out), destination: swap.destination },
  });
  return finalize(swap, ctx, { txHash, simulatedUsdc: true });
}

async function park(swap, reason) {
  await transition(swap.swap_id, "payout_pending", "stuck", { state_reason: reason.slice(0, 200) });
}

async function payoutBase(swap, ctx) {
  if (!payoutSignerConfigured()) {
    await park(swap, "payout_signer_missing");
    throw permanentFunctionRunError("PAYOUT_SIGNER_ID is not set; the desk cannot pay USDC out", "payout_signer_missing");
  }
  // A previous attempt may have made the call: resume it, never repeat it.
  const prior = await latestAttempt(swap.swap_id, "base");
  let callId = typeof prior?.response?.call_id === "string" ? prior.response.call_id : null;
  if (!callId) {
    let submitted;
    try {
      submitted = await transferUsdc({ to: swap.destination, amountMicros: Number(swap.amount_out), idempotencyKey: `payout:${swap.swap_id}` });
    } catch (error) {
      if (error instanceof BaseCallError && !error.retryable) {
        await recordAttempt({ swap_id: swap.swap_id, run_id: ctx.run.id, mode: "base", outcome: "failed", response: { code: error.code, message: error.message, ...error.details } });
        await park(swap, `payout_failed: ${error.code}: ${error.message}`);
        throw permanentFunctionRunError(`USDC transfer refused: ${error.code}: ${error.message}`, "payout_failed");
      }
      // Unknown outcome: the next run submits under the same key, which the platform de-duplicates.
      await recordAttempt({ swap_id: swap.swap_id, run_id: ctx.run.id, mode: "base", outcome: "unknown", response: { code: error?.code ?? "OTHER", message: String(error?.message ?? error) } });
      throw error;
    }
    callId = submitted.callId;
    await recordAttempt({ swap_id: swap.swap_id, run_id: ctx.run.id, mode: "base", outcome: "broadcast", response: { call_id: callId, tx_hash: submitted.txHash, status: submitted.status } });
    if (submitted.txHash) await transition(swap.swap_id, "payout_pending", "payout_pending", { tx_hash_out: submitted.txHash });
  }
  const settled = await waitForCall(callId, { budgetMs: 15_000 });
  if (settled.status === "confirmed") {
    await recordAttempt({ swap_id: swap.swap_id, run_id: ctx.run.id, mode: "base", outcome: "confirmed", response: { call_id: callId, tx_hash: settled.txHash, gas_cost_usd_micros: settled.gasCostUsdMicros } });
    return finalize(swap, ctx, { txHash: settled.txHash ?? swap.tx_hash_out ?? `call:${callId}`, simulatedUsdc: false });
  }
  if (settled.status === "failed") {
    await recordAttempt({ swap_id: swap.swap_id, run_id: ctx.run.id, mode: "base", outcome: "failed", response: { call_id: callId, tx_hash: settled.txHash, error: settled.error } });
    await park(swap, `payout_failed: ${settled.error ?? "the transfer failed on chain"}`);
    throw permanentFunctionRunError(`USDC transfer ${callId} failed: ${settled.error ?? "unknown"}`, "payout_failed");
  }
  throw new Error(`USDC transfer ${callId} is still pending`);
}

async function payoutUsdc(ctx, payload) {
  const swapId = typeof payload?.swap_id === "string" ? payload.swap_id : null;
  if (!swapId) throw permanentFunctionRunError("payload.swap_id is required", "payout_payload_invalid");
  const swap = await getSwap(swapId);
  if (!swap) throw permanentFunctionRunError(`no swap ${swapId}`, "swap_not_found");
  if (swap.direction !== "sats_in") throw permanentFunctionRunError(`swap ${swapId} is ${swap.direction}; this run pays USDC out`, "wrong_direction");
  if (swap.state !== "payout_pending") return { ok: true, noop: true, swap_id: swapId, state: swap.state };
  if (PAYOUT_MODE === "demo") return payoutDemo(swap, ctx);
  if (PAYOUT_MODE === "base") return payoutBase(swap, ctx);
  await park(swap, `payout_mode_${PAYOUT_MODE}_unknown`);
  throw permanentFunctionRunError(`PAYOUT_MODE=${PAYOUT_MODE} is not a mode; use demo or base`, "payout_mode_unknown");
}

export default defineFunctionRuns({ "payout.usdc": payoutUsdc });
