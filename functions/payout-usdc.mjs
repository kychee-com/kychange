// The USDC leg of a sats-in swap, as a durable function run keyed by the
// gateway's payment id. In `demo` payout mode it records a simulated transfer
// (deterministic per swap, so a re-fired run lands on the same hash) and the
// paper hedge; `base` mode, the hot-EOA ERC-20 transfer over viem, is the next
// step and parks the swap as `stuck` until it is wired.

import { createHash } from "node:crypto";
import { defineFunctionRuns, permanentFunctionRunError } from "@run402/functions";
import { HEDGE_VENUE, NETWORK_MODE, PAYOUT_MODE } from "./lib/config.mjs";
import { getSwap, ledger, recordAttempt, recordHedge, transition } from "./lib/swaps.mjs";
import { venue } from "./lib/venue.mjs";

async function payoutUsdc(ctx, payload) {
  const swapId = typeof payload?.swap_id === "string" ? payload.swap_id : null;
  if (!swapId) throw permanentFunctionRunError("payload.swap_id is required", "payout_payload_invalid");
  const swap = await getSwap(swapId);
  if (!swap) throw permanentFunctionRunError(`no swap ${swapId}`, "swap_not_found");
  if (swap.state !== "payout_pending") return { ok: true, noop: true, swap_id: swapId, state: swap.state };

  if (PAYOUT_MODE !== "demo") {
    await transition(swapId, "payout_pending", "stuck", { state_reason: `payout_mode_${PAYOUT_MODE}_not_wired` });
    throw permanentFunctionRunError(`PAYOUT_MODE=${PAYOUT_MODE} is not wired; the hot EOA transfer is the next step`, "payout_mode_not_wired");
  }

  const txHash = "simulated:" + createHash("sha256").update(`kychange:payout:${swapId}`).digest("hex");
  await recordAttempt({
    swap_id: swapId, run_id: ctx.run.id, mode: "demo", outcome: "simulated",
    response: { tx_hash: txHash, amount_out_micros: Number(swap.amount_out), destination: swap.destination },
  });
  const paid = await transition(swapId, "payout_pending", "paid_out", { tx_hash_out: txHash, paid_out_at: new Date().toISOString() });
  if (!paid) return { ok: true, noop: true, swap_id: swapId, state: "moved_elsewhere" };
  await ledger({ swap_id: swapId, asset: "SAT", delta: Number(swap.amount_in), reason: "swap_in", simulated: NETWORK_MODE === "testnet" });
  await ledger({ swap_id: swapId, asset: "USDC_MICROS", delta: -Number(swap.amount_out), reason: "payout", simulated: true });

  // Hedge the sats the desk just took on. Never blocks the payout.
  let hedge;
  try {
    const v = venue();
    const order = await v.placeOrder({ side: "sell_btc", usd: Number(swap.amount_out) / 1_000_000, clientOrderId: swapId });
    await recordHedge({ swap_id: swapId, venue: v.name, side: "sell_btc", client_order_id: swapId, status: order.status, response: order });
    hedge = { venue: v.name, status: order.status, order_id: order.orderId };
  } catch (error) {
    await recordHedge({
      swap_id: swapId, venue: HEDGE_VENUE, side: "sell_btc", client_order_id: swapId, status: "failed",
      response: { error: String(error?.message ?? error) },
    }).catch(() => undefined);
    hedge = { venue: HEDGE_VENUE, status: "failed" };
  }
  return { ok: true, swap_id: swapId, state: "paid_out", tx_hash_out: txHash, hedge };
}

export default defineFunctionRuns({ "payout.usdc": payoutUsdc });
