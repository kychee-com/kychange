# First USDC-in swap on testnet (2026-10-13)

Route A, live on kychange.com: a buyer paid $0.10 of Base Sepolia USDC to `POST /api/sats/0.10` with `run402 pay` (4.118.0) and received 119 testnet3 sats on a zero-amount invoice from its own node, nine seconds after the 202. Index $83,343.86, ask $83,760.58 (50 bps).

| What | Value |
|---|---|
| Buyer | `0xABa51B26D0cF100EB7c59590451A7e40F5A12830` (a `lightning`-rail wallet; the USDC-only 402 fell back to the x402 USDC payer) |
| Run402 payment | `txp_73b6b78a348041f08f844f70b41f9dad`, settled 2026-10-13T21:38:31Z on `eip155:84532` |
| USDC transaction | `0x66d7664c73964c69a09c6f2f8b44e9dfdb862f490c8c5bf0b956784201d0e283` (to the org's payout wallet `0x58a7…feab4`) |
| Swap | `swp_e73f6737f98c32874abf446a`, `usdc_in`, 100,000 µUSD in, 119 sats out |
| Destination | a zero-amount invoice from alice's LND, payment hash `83ad293e8338c4cd2080a35ab9706306990b2dfca05a24d704e056025a5e9671` |
| Payout | `payout-sats` paid it through the desk's spend-capped pairing (bob's Hub, 20,000 sats/day); `preimage_out` `e8ec1cdf57ceb0cf174032f3e77b8d94da9c25025584543af10eda304f7165ae`, `paid_out_at` 2026-10-13T21:38:40Z |
| Receiver's view | `lncli lookupinvoice` on alice: `SETTLED`, `amt_paid_sat: 119`, the same preimage |
| Hedge | paper `buy_btc` for $0.10 |

## Refund paths, same day

| Case | Swap | 202 said | Then |
|---|---|---|---|
| An invoice for 1,000 sats on a 119-sat swap | `swp_1db8efbf77144e0c79bc919d` (USDC tx `0xb742…aba6`) | `refund_due`, `invoice_amount_mismatch` | `refund-usdc` recorded the demo refund (`simulated:5b22c0ac…`) to the payer; state `refunded` |
| `"destination": "not-a-lightning-destination"` | `swp_2fc874da449a51ab08400376` (USDC tx `0x4b20…108d`) | `refund_due`, `invalid_destination` | `refunded`, `simulated:93306663…` |

Nothing paid twice: each payout run is keyed by the gateway's payment id, the payment hash is written on the swap before the wallet is asked to pay, and a re-fired run looks that hash up before anything else.

## Sats in, from the standard client

The same release was paid in the other direction by `run402 pay https://kychange.com/api/usdc/10k … --lightning-pairing -` with alice's pairing on stdin: swap `swp_d4a6bfb056cec5c6aefa2d7a`, payment hash `82b7fdf383773be153dd51d1316fe2f24d8a36d4221f0700a44044099a0208dd`, 10,000 sats in, $8.29 out (demo), `paid_out`. The pairing appeared nowhere in the output.

## What this does not prove

- The USDC refund and payout are demo-mode records; no USDC moved back to the buyer.
- LNURL-pay was exercised only by the unit tests (recorded responses); the live destination was an invoice.
- The desk's node is a direct channel to the buyer's; routing failures on testnet3 were not exercised.
