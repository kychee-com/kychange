## Context

See proposal.md. Route B exists: priced routes on `lightning-testnet`, `swap-sats-in`, the `swaps` table, `payout-usdc` as a durable run keyed by the gateway payment id, demo payout, paper hedge, caps enforced in one `capVerdict`. Route A reuses all of it in the other direction. The gateway settles USDC through the CDP facilitator before invoking the function, so the function sees `payer`, `transaction`, and `amount_usd_micros`; the sats leg is the function's to pay. The desk's node is bob (testnet3) behind an Alby Hub that hands out pairings with scoped methods and budgets.

## Goals / Non-Goals

**Goals:**
- A buyer with USDC and any Lightning wallet receives sats within seconds, with the preimage as the receipt.
- The spend-capable pairing is bounded by the Hub's budget and by the run's own per-payment cap, so a leak costs at most the cap.
- Every outcome a buyer can hit is a swap state with a reason, never a silent failure.

**Non-Goals:**
- A real USDC refund transfer (`PAYOUT_MODE=base` stays the next step).
- Arbitrary amounts (`upto`); denominations only.
- A hedge on a real venue; paper stays.

## Decisions

### D1. Destination: Lightning address or invoice, resolved at payout
The sats amount is fixed when the swap is priced, after payment, so a buyer gives either a Lightning address (LNURL-pay resolves an invoice for the exact sats at payout) or a bolt11 invoice: zero-amount, or carrying exactly the quoted sats within the quote's validity. Any other invoice is refused into `refund_due` with `invoice_amount_mismatch`. Alternative: price before payment and demand an exact invoice; rejected, the quote would have to outlive the payment and the Bazaar flow sends the payment first.

### D2. The payout pairing is spend-capped twice
`PAYOUT_NWC_PAIRING` is minted on the desk's node with `pay_invoice`, a budget, and a renewal period; the run also refuses any single payment above `PAYOUT_MAX_SATS_PER_RUN`. The gateway never sees this pairing; it lives only as a function secret of `payout-sats` and `refund-sats`. Alternative: the operator's main wallet pairing; rejected, a leak would be unbounded.

### D3. One compare-and-set per transition, the payment id as the run key
As in Route B: `UPDATE … WHERE swap_id = $1 AND state = $2`, and `payout-sats` is created with `idempotencyKey = payment_id`, so a replayed delivery or a re-fired run never pays twice. A run that finds the swap past `payout_pending` exits without side effects. An NWC timeout is resolved by `lookup_invoice` on the payment hash before any retry, never by paying again.

### D4. The ask is the index plus the spread
`sats_out = floor(usd / (index × (1 + spread_bps/10000)) × 1e8)`. The paper hedge for a Route A fill is `buy_btc` for the USD amount. Both directions read the same index and spread, so the desk's round trip costs exactly two spreads.

### D5. Refunds in demo mode are records
`refund-usdc` writes a `refunds` row and moves the swap to `refunded` with a `simulated:` reference while `PAYOUT_MODE=demo`; the real transfer is the same adapter `payout-usdc` will use. Alternative: leave `refund_due` swaps for the operator; rejected for the testnet instance, where a stuck demo swap teaches nothing.

### D6. Denominations are instance configuration
`DENOMINATIONS_USD` (a comma list) selects the routes' bodies and the quote's rows; the routes themselves are declared in the manifest, so an instance deploys the denominations it sells. The testnet instance sells `0.10`, `1`, `5` because faucet USDC comes a quarter dollar a day.

## Risks / Trade-offs

- [LNURL-pay resolution reaches an arbitrary host from inside the payout run] → bounded timeout, HTTPS only, response size cap, the resolved invoice's amount and description hash checked against the LNURL metadata before paying.
- [Routing failures on testnet3 are common] → the run retries within its budget, then `refund_due` with `payment_failed`; the testnet proof uses a direct channel.
- [A buyer gives their own Phoenix invoice with an amount] → accepted only when it equals the quoted sats; otherwise `refund_due`, stated in the 202 body and the docs.
- [Hot-wallet refund is simulated] → the status view and README say so; nothing claims money moved.

## Migration Plan

Deploy with the new secrets set first (`PAYOUT_NWC_PAIRING`, `PAYOUT_MAX_SATS_PER_RUN`, `DENOMINATIONS_USD`); the migration is additive. Rollback is a redeploy without the Route A routes; swaps already recorded keep their rows.

## Open Questions

- Whether to accept Lightning offers (BOLT12) as destinations; deferred until a wallet a buyer actually uses asks for it.
