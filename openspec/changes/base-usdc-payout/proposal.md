## Why

Both directions settle real sats on Lightning, but the USDC leg of a sats-in swap and the USDC refund of a USDC-in swap are still demo records: a mainnet sats-in swap would take real sats and pay nothing back. `PAYOUT_MODE=base` is the last piece of code between the testnet instance and a mainnet dry run, and it can be proven on Base Sepolia before any mainnet money moves.

## What Changes

- `payout-usdc` and `refund-usdc` gain `PAYOUT_MODE=base`: the USDC transfer is an ERC-20 `transfer` signed by a Run402 KMS signer owned by the project (`POST /contracts/v1/call`), keyed by an idempotency key derived from the swap, with the call id and transaction hash written on the swap before the run waits for confirmation; a re-fired run resumes from the recorded call instead of transferring again.
- The desk's USDC inventory is the signer's USDC balance (`POST /contracts/v1/read balanceOf`, free): the quote closes a sats-in denomination the inventory cannot cover (`inventory_short`), and the swap enforces the same verdict.
- A confirmed transfer is `paid_out` (or `refunded`) with the real transaction hash; a reverted or failed call parks the swap as `stuck` with the reason, never a second transfer.
- A `100`-sat denomination joins Route B so the proof and a first mainnet run move cents, not dollars.
- Configuration: `PAYOUT_MODE=base`, `PAYOUT_SIGNER_ID`; the chain and the USDC address follow `NETWORK_MODE`.

## Capabilities

### Modified Capabilities

- `swap-desk`: the USDC leg of both directions moves real USDC from the desk's KMS signer in `base` mode; inventory closes the desk; demo mode keeps recording.

## Impact

- `functions/payout-usdc.mjs`, `functions/refund-usdc.mjs`, `functions/quote.mjs`, `functions/swap-sats-in.mjs`, `functions/lib/base.mjs` (new), `functions/lib/config.mjs`, `run402.json`, `site/`, `docs/`.
- No private key enters a function secret: the signer's key lives in AWS KMS under Run402's non-custodial terms; the project's service key (already in the function environment) authorizes the call. Rent ($0.04/day), the sign fee, and gas at cost are billed to the organization's allowance.
