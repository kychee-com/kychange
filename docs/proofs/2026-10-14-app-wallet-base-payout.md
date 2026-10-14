# 2026-10-14 — the USDC leg is real: the signer pays out and refunds without gas

The desk's USDC signer (`cwlt_e84851c19e9d431da7be48cc`, `0x8acF0D190f77878DcC8531480bfeEfd3D6793a73`, Base Sepolia) is the organization's payout address (`run402 orgs payout-wallet f6a3bce3-… --signer cwlt_e848…`, resolution mode `signer`), so every USDC-in route pays into it, and `PAYOUT_MODE=base` pays USDC out of it through Run402's gasless transfer route (`POST /contracts/v1/signers/:signer_id/transfers`). The signer has never held ETH.

## Three swaps, in order

| Swap | Direction | In | Out | Proof |
|---|---|---|---|---|
| `swp_0dc903dcdaaa2b49fd934ee7` | USDC in, sats out | $0.10 USDC from `0x58a7…EAb4` to the signer, tx `0xb8742c10ae2935080095f28d2a54addfd3e6166f6c71630535618af77f628cee` | 119 sats to alice's zero-amount testnet3 invoice | `paid_out`, preimage `6c61142802aba5d62cf343b330b173defe2b14a71b177507aecdce2f4c07d306` |
| `swp_32463e12e89ae94ad8114acd` | sats in, USDC out | 100 sats over Lightning testnet3 from alice's pairing, payment hash `6af58d7a05aabe7bfdc2431fc75785d7493b37a688bb6002f86d5e5dc9c2cbc2` | $0.082902 USDC from the signer to `0x2D41A105d4185c91A1A7d88D5896a17f21354494` | `paid_out` in 9 s, transfer `txf_b5f5aa5a57985093e54f6215` settled, tx `0x090b721869fdb033520973f77df8ae37518ae9adb801195bdd9eb8a5eecdc515` |
| `swp_42d96d91c2449bfe0373d579` | USDC in to an address that answers 404 (`nobody@kychange.com`) | $0.10 USDC to the signer, tx `0x93bf4f8988d388c6c54e44bf5545193d337ef3bad55dfc6ddc5c6a7c781acfc8` | $0.10 USDC refunded from the signer to the payer | `refunded` (`lnurl_unreachable: kychange.com answered 404`), transfer `txf_7e57a619eefaa00570e012b6` settled, tx `0x0c7ef36582bafd99ff7e5dffda8785cceba3a11fe12d4a32be4ca184e4851787` |

The Route A 402 names the signer as `payTo` with `pay_to: "org_default_payout"`; the desk's quote reads the signer's on-chain USDC as inventory (`inventory_usd_micros` 200000 after the two receipts, 117098 after the payout and the refund). The buyer wallet went 0.70 → 0.50 USDC (three payments in, one refund back).

## What the platform charged

The organization's allowance went 4,960,000 → 4,959,990 µ$: one signing fee (5 µ$) per settled transfer and nothing for gas. The facilitator paid the gas for both transfers; the signer's ETH balance was and is zero.

## Commands

```
run402 --wallet lnbtc-scratch orgs payout-wallet f6a3bce3-ce36-4ef6-8e81-24d3638bfff4 --signer cwlt_e84851c19e9d431da7be48cc
run402 --wallet lnbtc-scratch pay https://kychange.com/api/sats/0.10 --method POST --body '{"destination":"<alice invoice>"}'
run402 --wallet bazaar-proof pay https://kychange.com/api/usdc/100 --method POST --body '{"destination":"0x2D41A105d4185c91A1A7d88D5896a17f21354494"}' --lightning-pairing - < payer.nwc
run402 --wallet lnbtc-scratch pay https://kychange.com/api/sats/0.10 --method POST --body '{"destination":"nobody@kychange.com"}'
run402 --wallet lnbtc-scratch contracts transfers list cwlt_e84851c19e9d431da7be48cc --project prj_1791837150791_1488
```

## One open edge

A fourth swap, `swp_9d5f638e8945b14a23be2a9b`, named `nobody@example.invalid`. DNS failure is `lnurl_unreachable` with `retryable: true`, so the payout run keeps retrying under the standard preset and the swap stays `payout_pending` instead of parking for a refund. A destination whose host does not resolve should become a refund after a bounded number of attempts; tracked as the next kychange change.
