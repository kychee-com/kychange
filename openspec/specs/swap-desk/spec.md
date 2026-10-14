# swap-desk Specification

## Purpose
kychange's contract with a buyer: what the quote states, what each priced route takes and answers, which swap states a buyer can observe and what they mean, and what the payout and refund runs owe.
## Requirements
### Requirement: The quote states both directions

`GET /api/quote` SHALL answer `open`, `reason`, `reason_text`, the index price with its venue and time, the spread, a `quote_id` with `valid_until`, and two direction objects: `sats_in` (the bid, with the sats denominations and the USDC each pays out) and `usdc_in` (the ask, with the USD denominations and the sats each pays out). Each denomination SHALL carry `route`, `method`, `available`, `reason`, and `reason_text`, and SHALL be `available: false` with `above_max_fill` or `daily_cap` when the desk's caps exclude it. The desk SHALL be `open` when any denomination in any direction is available.

#### Scenario: A buyer reads the ask
- **WHEN** the index is $80,000, the spread is 50 bps, and a `5` USD denomination is sold
- **THEN** `usdc_in` SHALL list it with `sats_out` of 6,218 sats and `available: true` while the caps allow it

### Requirement: A USDC payment buys sats

`POST /api/sats/:denomination` SHALL be priced `mode: "always"` in the denomination's USD on the instance's Base network, SHALL declare Bazaar discovery metadata, and SHALL take `{ destination, quote_id? }` where `destination` is a Lightning address or a bolt11 invoice. On a settled payment the function SHALL record one swap keyed by the gateway's `payment_id`, price the sats at the presented valid quote or a fresh index read, enqueue the payout run with that payment id as its idempotency key, and answer `202` with `swap_id`, `state: "payout_pending"`, `usd_in_micros`, `sats_out`, `payer`, `claim_token`, and `status_url`. A replayed delivery SHALL answer `200` with the existing swap and `replayed: true`.

#### Scenario: Agent pays with run402
- **WHEN** an agent runs `run402 pay https://kychange.com/api/sats/0.10 --method POST --body '{"destination":"alice@ln.example"}'` on Base Sepolia
- **THEN** the response SHALL be `202` with a swap in `payout_pending` and the sats quoted

#### Scenario: Unusable destination
- **WHEN** the body's `destination` is neither a Lightning address nor a bolt11 invoice
- **THEN** the swap SHALL be recorded in `refund_due` with `state_reason: "invalid_destination"` and the response SHALL still be `202`

### Requirement: The payout run pays exactly the quoted sats, once

`payout-sats` SHALL run at least once per swap, SHALL exit without side effects unless the swap is `payout_pending`, SHALL resolve a Lightning address through LNURL-pay for the exact `sats_out` or accept an invoice that is zero-amount or carries exactly `sats_out`, SHALL refuse any single payment above the instance's per-run cap, SHALL pay over the desk's spend-capped pairing, SHALL store the preimage as `preimage_out`, and SHALL move the swap to `paid_out`. An invoice with another amount, a payment that cannot route within the run's budget, or a cap breach SHALL move the swap to `refund_due` with `invoice_amount_mismatch`, `payment_failed`, or `above_payout_cap`. After an unknown payment outcome the run SHALL look the payment up by hash before any retry and SHALL never pay the same swap twice.

#### Scenario: Address destination
- **WHEN** a `payout_pending` swap names a Lightning address
- **THEN** the run SHALL pay an invoice for exactly `sats_out` resolved from that address and the status SHALL show `paid_out` with `preimage_out`

#### Scenario: Invoice for the wrong amount
- **WHEN** the destination is a bolt11 invoice whose amount differs from `sats_out`
- **THEN** the swap SHALL move to `refund_due` with `invoice_amount_mismatch` and nothing SHALL be paid

### Requirement: A refund-due USDC swap is refunded by a run

`refund-usdc` SHALL run for every `usdc_in` swap in `refund_due`, SHALL return `usd_in_micros` to `payer` from the hot wallet, SHALL record a `refunds` row with the transfer reference, and SHALL move the swap to `refunded`. While `PAYOUT_MODE` is `demo` the reference SHALL be `simulated:` plus a digest and the status view SHALL say the refund is simulated.

#### Scenario: Demo refund
- **WHEN** a `usdc_in` swap is `refund_due` on an instance in demo payout mode
- **THEN** the swap SHALL reach `refunded` with a `simulated:` reference and the status view SHALL name it simulated

### Requirement: Discovery metadata is declared on every priced route

Every priced route in both directions SHALL declare `pricing.discovery` with a description that names the direction, the amount, and the body shape. The desk SHALL document that the Bazaar lists only the USDC-priced routes and that the sats-priced routes are found on the host.

#### Scenario: Bazaar lists the USDC routes
- **WHEN** the CDP facilitator settles a payment on `POST /api/sats/5`
- **THEN** the Bazaar SHALL list that route with the declared description

### Requirement: The USDC leg moves real USDC from the desk's signer in base mode

With `PAYOUT_MODE=base`, the payout of a sats-in swap and the refund of a USDC-in swap SHALL be ERC-20 transfers of USDC on the instance's Base network, signed by the project's Run402 KMS signer through the platform's contract-call route with an idempotency key derived from the swap, so that a re-fired run resumes the recorded call and never transfers twice. The swap SHALL carry the transaction hash once the call is broadcast and SHALL become `paid_out` (or `refunded`) only when the platform reports the call confirmed; a failed or reverted call SHALL park the swap as `stuck` with the reason.

#### Scenario: A sats-in swap is paid in real USDC
- **WHEN** a sats-in swap enters `payout_pending` on an instance with `PAYOUT_MODE=base`
- **THEN** the payout run submits one transfer of `usd_out_micros` to the destination through the signer and marks the swap `paid_out` with the confirmed transaction hash

#### Scenario: A run fires twice
- **WHEN** the payout run is re-fired after it recorded a call id
- **THEN** it reads that call's status and finishes from it, submitting no second transfer

### Requirement: Inventory closes the desk before a buyer pays

In base mode the quote SHALL mark a sats-in denomination `inventory_short` when the signer's USDC balance cannot cover its payout, and the swap SHALL enforce the same verdict; without a configured signer the direction SHALL be closed as `payout_unavailable`.

#### Scenario: Inventory below a denomination
- **WHEN** the signer holds less USDC than a denomination pays out
- **THEN** that denomination is `available: false` with `reason: "inventory_short"` while cheaper denominations stay open

