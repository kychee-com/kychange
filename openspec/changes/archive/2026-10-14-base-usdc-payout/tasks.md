## 1. The Base adapter

- [x] 1.1 `lib/config.mjs`: `PAYOUT_SIGNER_ID`, the chain and USDC table by `NETWORK_MODE`, `payoutSignerConfigured()`; a `100`-sat denomination.
- [x] 1.2 `lib/base.mjs`: `transferUsdc({ to, amountMicros, idempotencyKey })` over `POST /contracts/v1/call` (409 replay handled), `callStatus(callId)`, `usdcBalanceMicros(address)` over `/contracts/v1/read`; unit tests with a mocked fetch.
- [x] 1.3 `payout-usdc.mjs` base mode: resume from the latest attempt's call id, transfer once, wait for `confirmed`, `paid_out` with the real hash; `failed`/`reverted` → `stuck`.
- [x] 1.4 `refund-usdc.mjs` base mode: the same adapter to the payer; `refunds.reference` is the hash.
- [x] 1.5 `quote.mjs` and `swap-sats-in.mjs`: `inventory_short` from the signer's balance; `payout_unavailable` without a signer in base mode.

## 2. Manifest, site, docs

- [x] 2.1 `run402.json`: `POST /api/usdc/100` priced 100 sats with discovery.
- [x] 2.2 `site/status.html` links a real `tx_hash_out` / refund reference to the explorer; `docs/try-it.md`, README (signer setup, secrets), architecture status.

## 3. Proof on testnet

- [x] 3.1 Provision a `base-sepolia` signer on the project, fund it with Sepolia USDC, set the secrets, deploy.
- [x] 3.2 A 100-sat swap reaches `paid_out` with a real Base Sepolia transaction to the buyer's address; a re-fired run does not transfer again.
- [x] 3.3 An invalid-destination USDC-in swap reaches `refunded` with a real transaction back to the payer.
- [x] 3.4 Record the proof in `docs/proofs/`.
