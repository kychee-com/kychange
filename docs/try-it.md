# Try it on testnet

The public instance at kychange.com runs both directions on testnet: Lightning testnet3 against the desk's own node and Base Sepolia USDC through the x402 facilitator. The sats leg is a real testnet3 Lightning payment; the USDC leg (payout and refund) is a real Base Sepolia transfer from the desk's signer when the quote reports `payout_mode: "base"`, and a simulated record when it reports `demo`; the hedge is paper. No real money is involved anywhere.

## What you need

- The `run402` CLI (4.118.0 or later): `npm install -g run402`, then `run402 wallets new buyer` for a wallet. It pays USDC routes from the wallet's Base Sepolia balance and Lightning routes from a Nostr Wallet Connect pairing you hand it.
- For USDC in: testnet USDC in that wallet. `run402 wallets fund` asks Run402's faucet for 0.25 USDC on Base Sepolia (once a day).
- For sats in: a Lightning wallet on testnet3 that can pay invoices and exposes an NWC pairing with `pay_invoice`, holding at least 10,000 sats. The desk's own harness (two LND nodes behind two Alby Hubs) is one way to get one.
- A Lightning destination for sats out: a Lightning address, or an invoice from any testnet3 wallet, either with no amount or for exactly the sats the quote names.

## USDC in, sats out

```bash
run402 pay https://kychange.com/api/sats/0.10 --method POST --body '{"destination":"you@your-wallet.example"}'
```

The CLI takes the 402 from the route, pays $0.10 of USDC on Base Sepolia, retries, and prints the swap. Name a Lightning address or an invoice as the destination; the quote at `GET /api/quote` says how many sats the route pays right now (`directions.usdc_in.denominations[].sats_out`). The payout run resolves an address into an invoice for exactly that amount (LNURL-pay), or pays your invoice if it names that amount or none, and the status shows `preimage_out` once the sats are in your wallet.

## Sats in, USDC out

```bash
run402 pay https://kychange.com/api/usdc/10k --method POST --body '{"destination":"0xYourBaseAddress"}' --lightning-pairing ./payer.nwc
```

The 402 carries one x402 `exact` entry on `lnbtc` whose invoice is bound to this exact request. The CLI checks that binding, pays the invoice through your pairing (a file, or `-` for stdin; the pairing is never printed), retries with the preimage, and prints the swap. The repo's `tools/pay.mjs` does the same through `@run402/sdk/node` if you want to read the code.

## Reading the result

Every 202 carries a `claim_token`; the status page at `/status?swap=<swap_id>&claim=<claim_token>` polls until the swap is terminal, and `GET /api/swaps/<swap_id>?claim=<claim_token>` is the same view.

| Field | Meaning |
|---|---|
| `state` | `payout_pending` right after the 202, then `paid_out`; or `refund_due` → `refunded` when the desk could not pay (`state_reason` says why) |
| `preimage_out` | sats out: the preimage of your invoice, the proof the sats arrived |
| `tx_hash_in` | USDC in: the Base Sepolia transaction that paid the route |
| `tx_hash_out` | sats in: the Base transaction that paid you (`simulated:<sha256>` while the instance runs in demo mode) |
| `payment_hash` | the Lightning payment hash of the leg that moved sats (in or out) |
| `refund` | for a `usdc_in` swap the desk could not pay: the amount, the payer it goes back to, and the reference (the Base transaction, or a `simulated:` record in demo mode) |

## Discovery

`GET https://kychange.com/.well-known/x402` lists every priced route with its methods and the networks it takes payment on: `eip155:84532` for the USDC routes, `lnbtc:000000000933ea01ad0ee984209779ba` for the sats routes. The USDC routes are also indexed by the x402 Bazaar once the facilitator settles a payment on them; the sats routes never are, which is why the host lists them itself.

## What you cannot do yet

- Claim a sats refund with a preimage: `POST /api/refunds` is not built; the operator refunds by hand.
- Swap an arbitrary amount: denominations only.
