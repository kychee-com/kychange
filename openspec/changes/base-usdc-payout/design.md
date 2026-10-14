## Context

Route A and Route B are live on testnet with demo USDC. The gateway offers KMS signers per project: `POST /contracts/v1/signers { chain }` provisions one, `POST /contracts/v1/call { signer_id, chain, contract_address, abi_fragment, function_name, args }` signs and broadcasts a write call with Run402 handling nonce, gas, and confirmation tracking, idempotent on `Idempotency-Key`, and `GET /contracts/v1/calls/:call_id` reports the status and receipt. The function runtime carries `RUN402_SERVICE_KEY` and `RUN402_API_BASE`.

## Goals / Non-Goals

**Goals:**
- A sats-in swap pays real USDC on Base to the buyer; a failed USDC-in swap refunds real USDC to the payer; both exactly once.
- No private key in a secret; a leak of the function environment yields a service key the operator can rotate, not a signing key.
- The desk closes itself when inventory or allowance cannot cover a payout, before a buyer pays.

**Non-Goals:**
- A hot EOA with viem (rejected: a key in a secret, nonce and gas management, an RPC dependency, and the same confirmation loop, for no gain over the signer).
- Moving USDC-in receipts into the signer automatically (the organization's payout wallet receives them; the operator sweeps to the signer).
- Batching or an on-chain hedge.

## Decisions

### D1. The transfer is a KMS signer call keyed by the swap
`functions/lib/base.mjs` posts `transfer(to, amount)` on the chain's USDC contract through `/contracts/v1/call` with `Idempotency-Key: payout:<swap_id>` (or `refund:<swap_id>`), authorized by the project's service key. The call id and tx hash land on the swap (`payout_run_id` keeps the run; `tx_hash_out` the hash; the attempt row the call id) before the run waits. A re-fired run reads the latest attempt and polls the call instead of transferring; a 409 replay carries the stored call's hash and status and is treated the same way.

### D2. Confirmation is the gateway's call status, not a receipt poll
The run polls `GET /contracts/v1/calls/:call_id` within its time budget; `confirmed` finalizes, `pending` throws a retryable error so the durable run returns later, `failed`/`reverted` parks the swap `stuck` with the gateway's error. Nothing is re-sent on failure: a failed transfer after sats were taken is an operator decision.

### D3. Inventory is read, never assumed
The quote and the swap read the signer's USDC balance through the free `/contracts/v1/read balanceOf`; a sats-in denomination whose payout exceeds it is `inventory_short`, the same shape as the cap verdicts. The balance read is cached for a few seconds inside one invocation only.

### D4. Chain and asset follow the network mode
`NETWORK_MODE=testnet` → `base-sepolia`, USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; `mainnet` → `base-mainnet`, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. One table in `config.mjs`.

### D5. Demo mode stays
`PAYOUT_MODE=demo` keeps writing simulated references so a fork can run without a signer or allowance.

## Risks / Trade-offs

- [Allowance runs dry: rent, sign fees, and gas stop] → the gateway suspends the signer and refuses calls with 403; the run parks the swap `stuck` with that reason, and the quote shows the inventory read failing as `payout_unavailable`.
- [A confirmed transfer whose status read times out] → the next run reads the call again; the idempotency key prevents a second transfer.
- [The testnet proof's inventory is faucet USDC] → the `100`-sat denomination keeps a payout under a dime.

## Migration Plan

Provision the signer, fund it with USDC, set `PAYOUT_SIGNER_ID` and `PAYOUT_MODE=base`, deploy. Rollback is `PAYOUT_MODE=demo`; recorded swaps keep their rows.

## Open Questions

- Run402's `app-wallet` change (proposed 2026-10-14) adds a facilitator-settled transfer route for signers (no ETH on the signer, one signing fee) and lets the organization select the signer as its payout address. Once it ships, `lib/base.mjs` moves from `/contracts/v1/call` to `POST /contracts/v1/signers/:id/transfers` and the inventory becomes the receipts; until then the signer needs native gas as well as USDC.
