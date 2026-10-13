// The refund of a USDC-in swap that could not be paid out, as a durable run
// keyed by the payment id. In `demo` payout mode it records a simulated
// transfer back to the payer (deterministic per swap); `base` mode, the
// hot-EOA ERC-20 transfer, is the same adapter the payout will use and parks
// the swap as `stuck` until it is wired. A sats-in swap owes sats, not USDC,
// and is left for the preimage refund claim.

import { createHash } from "node:crypto";
import { defineFunctionRuns, permanentFunctionRunError } from "@run402/functions";
import { PAYOUT_MODE } from "./lib/config.mjs";
import { getSwap, insertRefund, ledger, transition } from "./lib/swaps.mjs";

async function refundUsdc(ctx, payload) {
  const swapId = typeof payload?.swap_id === "string" ? payload.swap_id : null;
  if (!swapId) throw permanentFunctionRunError("payload.swap_id is required", "refund_payload_invalid");
  const swap = await getSwap(swapId);
  if (!swap) throw permanentFunctionRunError(`no swap ${swapId}`, "swap_not_found");
  if (swap.direction !== "usdc_in") return { ok: true, noop: true, swap_id: swapId, reason: "refund_asset_is_sats" };
  if (swap.state !== "refund_due") return { ok: true, noop: true, swap_id: swapId, state: swap.state };

  const pending = await transition(swapId, "refund_due", "refund_pending");
  if (!pending) return { ok: true, noop: true, swap_id: swapId, state: "moved_elsewhere" };
  if (PAYOUT_MODE !== "demo") {
    await transition(swapId, "refund_pending", "stuck", { state_reason: `refund_mode_${PAYOUT_MODE}_not_wired` });
    throw permanentFunctionRunError(`PAYOUT_MODE=${PAYOUT_MODE} is not wired; the hot EOA transfer is the next step`, "refund_mode_not_wired");
  }
  const reference = "simulated:" + createHash("sha256").update(`kychange:refund:${swapId}`).digest("hex");
  const refundId = await insertRefund({
    swap_id: swapId, run_id: ctx.run.id, asset: "USDC_MICROS", amount: Number(swap.amount_in),
    destination: swap.payer ?? "-", mode: "demo", reference,
  });
  const refunded = await transition(swapId, "refund_pending", "refunded");
  if (!refunded) return { ok: true, noop: true, swap_id: swapId, state: "moved_elsewhere" };
  await ledger({ swap_id: swapId, asset: "USDC_MICROS", delta: Number(swap.amount_in), reason: "swap_in", simulated: true });
  await ledger({ swap_id: swapId, asset: "USDC_MICROS", delta: -Number(swap.amount_in), reason: "refund", simulated: true });
  return { ok: true, swap_id: swapId, state: "refunded", refund_id: refundId, reference };
}

export default defineFunctionRuns({ "refund.usdc": refundUsdc });
