# Try it on testnet

The public instance at kychange.com runs the sats-in direction on Lightning testnet3 against the desk's own node, pays out USDC in demo mode (a simulated transfer recorded on the swap), and hedges on paper. No real money is involved anywhere.

## What you need

- A Lightning wallet on testnet3 that can pay invoices and exposes a Nostr Wallet Connect pairing with `pay_invoice`. Any NWC-capable wallet works; the desk's own harness (two LND nodes behind two Alby Hubs) is one way to get one.
- Testnet sats in that wallet. The desk's smallest denomination is 10,000 sats.
- Node 22 and the kychange repo: `git clone https://github.com/kychee-com/kychange && cd kychange && npm install`.

## Swap

```bash
node tools/pay.mjs 10k 0xYourBaseAddress --pairing ./payer.nwc
```

The tool reads `GET /api/quote`, takes the 402 from `POST /api/usdc/10k`, checks that the invoice is bound to that exact request, pays it through your pairing, retries with the preimage, and prints the swap. The 202 carries a `claim_token`; the status page at `/status?swap=<swap_id>&claim=<claim_token>` polls until the swap is `paid_out`.

## Reading the result

| Field | Meaning |
|---|---|
| `state` | `payout_pending` right after the 202, then `paid_out` once the payout run has recorded the USDC leg |
| `tx_hash_out` | on this instance `simulated:<sha256>`; on a mainnet operator's instance, the Base transaction hash |
| `payment.payment_hash` | the Lightning payment hash; the proof that the sats arrived on the desk's node |
| `usd_out_micros` | the USDC leg in micro-dollars, the index price minus the spread at the time of the swap |

## What you cannot do yet

- Receive real USDC: the payout is demo mode until the hot-EOA transfer is wired (`PAYOUT_MODE=base`).
- Swap USDC into sats (Route A): not built on this instance.
- Claim a refund with a preimage: `POST /api/refunds` is not built; the operator refunds by hand.
