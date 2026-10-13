## Why

kychange is a one-way desk: sats in, USDC out. The other direction, USDC in and sats out, is the half agents can pay today with the Run402 clients they already hold (`run402 pay` settles USDC on Base), and the half the x402 Bazaar can list, because the Bazaar indexes what the CDP facilitator settles and Lightning settles elsewhere. Without it the desk is a demo of one platform feature rather than an exchange.

## What Changes

- Route A: `POST /api/sats/:denomination` for the configured USD denominations (testnet instance: `0.10`, `1`, `5`; mainnet default: `5`, `20`, `100`), each priced `mode: "always"` in USD with `pay_to: "org_default_payout"`, on `testnet` (Base Sepolia) or `mainnet`, and declaring `pricing.discovery` so the Bazaar lists it. Body: `{ "destination": "<lightning address | bolt11 invoice>", "quote_id"?: "…" }`.
- `swap-usdc-in` records the swap from the payment context (`payment_id`, `payer`, `transaction`, `amount_usd_micros`), prices the sats leg at the index plus the spread (the ask), and enqueues `payout-sats` with the payment id as idempotency key; answers 202 with the swap, the sats quoted, the claim token, and the status URL. A destination that is neither a Lightning address nor an invoice becomes a swap in `refund_due`.
- `payout-sats` runs at least once: re-reads the swap, resolves a Lightning address through LNURL-pay for the exact sats or validates the given invoice (zero-amount, or exact-amount matching the quote), pays over a spend-capped Nostr Wallet Connect pairing held as the function secret `PAYOUT_NWC_PAIRING`, stores the preimage as `preimage_out`, moves the swap to `paid_out`, records the ledger and a paper hedge (`buy_btc`). A payment that cannot route, an expired or mismatched invoice, or a cap breach moves it to `refund_due`.
- `refund-usdc` returns the USDC to `payer` from the hot wallet. In demo payout mode it records the refund as simulated; `PAYOUT_MODE=base` is still the next step and parks the swap `stuck` until wired.
- `GET /api/quote` reports both directions: `sats_in` (the bid, unchanged) and `usdc_in` (the ask, per USD denomination, with `sats_out`), each with its own availability and reason text; the caps apply per direction.
- Route B's routes also declare `pricing.discovery`; the Bazaar will not list them (no EVM settlement), and the host's own discovery document, once the platform ships it, will.
- Status: `GET /api/swaps/:swap_id?claim=…` shows `preimage_out` for a paid Route A swap.

## Capabilities

### New Capabilities
- `swap-desk`: the desk's observable contract for both directions: the quote, the priced routes and their bodies, the swap states a buyer can observe, and the payout and refund outcomes.

### Modified Capabilities
<!-- none: kychange has no prior specs -->

## Impact

- `run402.json`: three new routes with discovery metadata, discovery on the sats-in routes, two new functions (`swap-usdc-in`, `payout-sats`), one new run handler in `refund-usdc` (demo), a migration adding `preimage_out` use and the `payout_attempts.mode` values.
- `functions/lib/pricing.mjs`: the ask side; `lib/lightning.mjs`: LNURL-pay resolution and invoice checks; `lib/venue.mjs`: `buy_btc` hedge.
- Secrets: `PAYOUT_NWC_PAIRING` (spend-capped, the desk's node), `PAYOUT_MAX_SATS_PER_RUN`, `DENOMINATIONS_USD`.
- Testnet proof: the deploy wallet's Base Sepolia USDC pays a `0.10` route; sats go from bob to alice over a second, capped pairing on bob's Hub.
