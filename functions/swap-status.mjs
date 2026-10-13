// GET /api/swaps/:swap_id?claim=<token>: the buyer's view of one swap. The
// claim token from the 202 is the only credential; without it, or with the
// wrong one, a swap id reads as not found.

import { timingSafeEqual } from "node:crypto";
import { getSwap, latestRefund, publicSwap } from "./lib/swaps.mjs";

function sameToken(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export default async function handler(req) {
  const headers = { "cache-control": "private, no-store", "access-control-allow-origin": "*" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  }
  const url = new URL(req.url);
  const swapId = url.pathname.split("/").pop() ?? "";
  const claim = url.searchParams.get("claim") ?? "";
  const swap = swapId ? await getSwap(swapId) : null;
  if (!swap || !sameToken(claim, swap.claim_token)) {
    return Response.json({ error: "swap_not_found" }, { status: 404, headers });
  }
  const body = publicSwap(swap);
  if (["refund_due", "refund_pending", "refunded", "refund_failed"].includes(swap.state)) {
    const refund = await latestRefund(swap.swap_id);
    body.refund = swap.direction === "usdc_in"
      ? {
          reason: swap.state_reason ?? null,
          asset: "USDC",
          amount_usd_micros: Number(swap.amount_in),
          destination: swap.payer ?? null,
          mode: refund?.mode ?? null,
          reference: refund?.reference ?? null,
          how: refund ? "recorded by the refund run" : "the refund run records (demo) or sends the USDC back to the payer",
        }
      : {
          reason: swap.state_reason ?? null,
          asset: "SAT",
          how: "POST /api/refunds { preimage, bolt11 } (not yet available on this instance; the operator refunds by hand)",
        };
  }
  return Response.json(body, { headers });
}
