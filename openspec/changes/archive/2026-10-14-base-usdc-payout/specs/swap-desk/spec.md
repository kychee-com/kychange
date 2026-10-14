## ADDED Requirements

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
