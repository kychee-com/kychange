// The refund of a USDC-in swap that could not be paid out, as a durable run
// keyed by the payment id. `demo` records a simulated transfer back to the
// payer; `base` transfers real USDC from the project's Run402 KMS signer,
// idempotent on the swap, resuming a recorded call on a re-fire. A sats-in
// swap owes sats, not USDC, and is left for the preimage refund claim.

import { createHash } from "node:crypto";
import { defineFunctionRuns, permanentFunctionRunError } from "@run402/functions";
import { BaseCallError, transferUsdc, waitForCall } from "./lib/base.mjs";
import { PAYOUT_MODE, payoutSignerConfigured } from "./lib/config.mjs";
import { getSwap, insertRefund, latestAttempt, ledger, recordAttempt, transition } from "./lib/swaps.mjs";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

async function complete(swap, ctx, { reference, mode, simulated }) {
  const refundId = await insertRefund({
    swap_id: swap.swap_id, run_id: ctx.run.id, asset: "USDC_MICROS", amount: Number(swap.amount_in),
    destination: swap.payer ?? "-", mode, reference,
  });
  const refunded = await transition(swap.swap_id, "refund_pending", "refunded");
  if (!refunded) return { ok: true, noop: true, swap_id: swap.swap_id, state: "moved_elsewhere" };
  await ledger({ swap_id: swap.swap_id, asset: "USDC_MICROS", delta: Number(swap.amount_in), reason: "swap_in", simulated });
  await ledger({ swap_id: swap.swap_id, asset: "USDC_MICROS", delta: -Number(swap.amount_in), reason: "refund", simulated });
  return { ok: true, swap_id: swap.swap_id, state: "refunded", refund_id: refundId, reference };
}

async function fail(swap, reason) {
  await transition(swap.swap_id, "refund_pending", "refund_failed", { state_reason: reason.slice(0, 200) });
}

async function refundBase(swap, ctx) {
  if (!payoutSignerConfigured()) {
    await fail(swap, "refund_signer_missing");
    throw permanentFunctionRunError("PAYOUT_SIGNER_ID is not set; the desk cannot refund USDC", "refund_signer_missing");
  }
  if (!EVM_ADDRESS.test(String(swap.payer))) {
    await fail(swap, "refund_payer_unknown");
    throw permanentFunctionRunError(`swap ${swap.swap_id} records no payer address`, "refund_payer_unknown");
  }
  const prior = await latestAttempt(swap.swap_id, "base_refund");
  let callId = typeof prior?.response?.call_id === "string" ? prior.response.call_id : null;
  if (!callId) {
    let submitted;
    try {
      submitted = await transferUsdc({ to: swap.payer, amountMicros: Number(swap.amount_in), idempotencyKey: `refund:${swap.swap_id}` });
    } catch (error) {
      if (error instanceof BaseCallError && !error.retryable) {
        await recordAttempt({ swap_id: swap.swap_id, run_id: ctx.run.id, mode: "base_refund", outcome: "failed", response: { code: error.code, message: error.message, ...error.details } });
        await fail(swap, `refund_failed: ${error.code}: ${error.message}`);
        throw permanentFunctionRunError(`USDC refund refused: ${error.code}: ${error.message}`, "refund_failed");
      }
      await recordAttempt({ swap_id: swap.swap_id, run_id: ctx.run.id, mode: "base_refund", outcome: "unknown", response: { code: error?.code ?? "OTHER", message: String(error?.message ?? error) } });
      throw error;
    }
    callId = submitted.callId;
    await recordAttempt({ swap_id: swap.swap_id, run_id: ctx.run.id, mode: "base_refund", outcome: "broadcast", response: { call_id: callId, tx_hash: submitted.txHash, status: submitted.status } });
  }
  const settled = await waitForCall(callId, { budgetMs: 15_000 });
  if (settled.status === "confirmed") {
    await recordAttempt({ swap_id: swap.swap_id, run_id: ctx.run.id, mode: "base_refund", outcome: "confirmed", response: { call_id: callId, tx_hash: settled.txHash, gas_cost_usd_micros: settled.gasCostUsdMicros } });
    return complete(swap, ctx, { reference: settled.txHash ?? `call:${callId}`, mode: "base", simulated: false });
  }
  if (settled.status === "failed") {
    await recordAttempt({ swap_id: swap.swap_id, run_id: ctx.run.id, mode: "base_refund", outcome: "failed", response: { call_id: callId, tx_hash: settled.txHash, error: settled.error } });
    await fail(swap, `refund_failed: ${settled.error ?? "the transfer failed on chain"}`);
    throw permanentFunctionRunError(`USDC refund ${callId} failed: ${settled.error ?? "unknown"}`, "refund_failed");
  }
  throw new Error(`USDC refund ${callId} is still pending`);
}

async function refundUsdc(ctx, payload) {
  const swapId = typeof payload?.swap_id === "string" ? payload.swap_id : null;
  if (!swapId) throw permanentFunctionRunError("payload.swap_id is required", "refund_payload_invalid");
  const swap = await getSwap(swapId);
  if (!swap) throw permanentFunctionRunError(`no swap ${swapId}`, "swap_not_found");
  if (swap.direction !== "usdc_in") return { ok: true, noop: true, swap_id: swapId, reason: "refund_asset_is_sats" };

  let current = swap;
  if (swap.state === "refund_due") {
    current = await transition(swapId, "refund_due", "refund_pending");
    if (!current) return { ok: true, noop: true, swap_id: swapId, state: "moved_elsewhere" };
  } else if (!(swap.state === "refund_pending" && PAYOUT_MODE === "base")) {
    // Only a base-mode refund can be mid-flight; anything else in refund_pending is not ours to resume.
    return { ok: true, noop: true, swap_id: swapId, state: swap.state };
  }

  if (PAYOUT_MODE === "demo") {
    const reference = "simulated:" + createHash("sha256").update(`kychange:refund:${swapId}`).digest("hex");
    return complete(current, ctx, { reference, mode: "demo", simulated: true });
  }
  if (PAYOUT_MODE === "base") return refundBase(current, ctx);
  await fail(current, `refund_mode_${PAYOUT_MODE}_unknown`);
  throw permanentFunctionRunError(`PAYOUT_MODE=${PAYOUT_MODE} is not a mode; use demo or base`, "refund_mode_unknown");
}

export default defineFunctionRuns({ "refund.usdc": refundUsdc });
