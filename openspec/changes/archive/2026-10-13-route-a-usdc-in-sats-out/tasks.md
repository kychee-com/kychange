## 1. Pricing and the quote

- [x] 1.1 `lib/pricing.mjs`: `satsOut({ usdMicros, btcUsd, spreadBps })` (the ask) and tests, including the $80,000 / 50 bps / $5 → 6,218 sats case.
- [x] 1.2 `lib/config.mjs`: `DENOMINATIONS_USD` (default `0.10,1,5` on testnet, `5,20,100` on mainnet), `PAYOUT_MAX_SATS_PER_RUN`, `PAYOUT_NWC_PAIRING` presence check.
- [x] 1.3 `quote.mjs`: two direction objects with per-denomination availability and `reason_text`; `open` over both; the page renders both tables.

## 2. Route A functions

- [x] 2.1 `lib/lightning.mjs`: Lightning-address and bolt11 detection, LNURL-pay resolution (HTTPS only, timeout, size cap, metadata hash check, exact-amount request), invoice amount and expiry checks; unit tests with recorded fixtures.
- [x] 2.2 `swap-usdc-in.mjs`: payment context → swap (`usdc_in`, `payer`, `amount_in` micros, `sats_out`), caps via `capVerdict`, enqueue `payout-sats` keyed by the payment id, 202 body with `status_url`; 400 on an unpaid direct invocation.
- [x] 2.3 `payout-sats.mjs`: `defineFunctionRuns` handler, compare-and-set transitions, per-run cap, `NwcWallet.payInvoice` with `lookupInvoice` before any retry, `preimage_out`, ledger entries, paper `buy_btc` hedge, failure reasons.
- [x] 2.4 `refund-usdc.mjs`: demo-mode refund record and `refunded` transition; `base` mode parks `stuck`.
- [x] 2.5 Migration `002_route_a`: `refunds` table, `payout_attempts.mode` values, indexes.

## 3. Manifest, site, docs

- [x] 3.1 `run402.json`: `POST /api/sats/0.10|1|5` priced in USD on `testnet` with `pricing.discovery`; discovery on the three sats-in routes; the two new functions; build script entries.
- [x] 3.2 `site/index.html` shows both directions; `status.html` shows `preimage_out` and refund state; `docs/try-it.md` gains the USDC-in walkthrough (`run402 pay`, faucet USDC); README layout and secrets.
- [x] 3.3 Mint the spend-capped pairing on bob's Hub (`pay_invoice`, budget, renewal) and set `PAYOUT_NWC_PAIRING`, `PAYOUT_MAX_SATS_PER_RUN`, `DENOMINATIONS_USD` as project secrets.

## 4. Proof on testnet

- [x] 4.1 `run402 --wallet lnbtc-scratch pay https://kychange.com/api/sats/0.10 --method POST --body '{"destination":"<alice invoice or address>"}'` → 202; the swap reaches `paid_out` with a preimage; alice's channel balance rises by `sats_out`.
- [x] 4.2 The wrong-amount invoice case reaches `refund_due` then `refunded` (simulated); the invalid destination case likewise.
- [x] 4.3 Record the proof in `docs/proofs/` with the payment id, transaction, swap id, preimage; update the architecture status.
