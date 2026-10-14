# kychange

A swap desk between the two rails x402 settles on, USDC on Base and sats on Bitcoin Lightning, built as a [Run402](https://run402.com) application. Pay one rail, receive the other. The desk quotes from a hedge venue plus a spread and back-to-backs each fill there.

Status: both directions are live on the testnet instance at [kychange.com](https://kychange.com). Sats in (Route B) settles real testnet3 Lightning payments through Run402's priced routes on `lnbtc` and pays the USDC leg from the desk's USDC signer (`PAYOUT_MODE=base`: a real transfer on Base, signed by a Run402 KMS signer) or records it (`demo`). USDC in (Route A) settles Base USDC through the x402 facilitator and pays real sats to the buyer's Lightning address or invoice from the desk's own node, with the preimage as the receipt; a swap the desk cannot pay is refunded the same way the payout is made. The hedge is paper. Preimage refunds of sats are the next step. The design is [docs/architecture.md](docs/architecture.md); trying it is [docs/try-it.md](docs/try-it.md).

Run402 never holds the funds on either leg. Whoever deploys this holds the inventory, is the counterparty on every swap, and carries whatever obligations operating it with real money brings in their jurisdiction. Kychee publishes the code and runs a testnet-only instance at kychange.com.

## Layout

| Path | What |
|---|---|
| `run402.json` | the release manifest: two migrations, seven functions, the priced routes with discovery metadata, the two pages |
| `db/` | `swaps`, `quotes`, `payout_attempts`, `hedges`, `inventory_ledger`, `refunds`; nothing is exposed through REST |
| `functions/quote.mjs` | `GET /api/quote`: both directions, the bid and the ask, the denominations, a `quote_id` |
| `functions/swap-sats-in.mjs` | `POST /api/usdc/:sats` (priced on `lightning-testnet`): records the paid swap and enqueues `payout-usdc` |
| `functions/payout-usdc.mjs` | the durable run that pays the USDC leg (`base`: a transfer from the desk's KMS signer, resumed on a re-fire, never repeated; `demo`: a record) and hedges on paper |
| `functions/swap-usdc-in.mjs` | `POST /api/sats/:usd` (priced in USDC on Base): records the paid swap and enqueues `payout-sats` |
| `functions/payout-sats.mjs` | the durable run that resolves the destination (LNURL-pay or the buyer's invoice), pays the sats through the desk's spend-capped NWC pairing, and hedges on paper |
| `functions/refund-usdc.mjs` | the durable run that refunds a USDC-in swap the desk could not pay, through the same signer (`base`) or as a record (`demo`) |
| `functions/swap-status.mjs` | `GET /api/swaps/:swap_id?claim=…`: the buyer's view, with the preimage or the refund |
| `functions/lib/` | config (all env, set as function secrets), pricing, the venue adapter, the swaps table, the Lightning leg (`lightning.mjs`, a BOLT11 decoder, an NWC client), the Base leg (`base.mjs`: USDC transfers and inventory through Run402's contract-call route) |
| `tools/pay.mjs` | a buyer for the sats-in routes through `@run402/sdk/node`; `run402 pay` does both directions |
| `site/` | the landing page and the status page |

## Run your own

1. Deploy once: `run402 up --name kychange` from this directory (prototype tier is enough for a testnet instance; a custom domain needs hobby).
2. Register the organization's receive-only Lightning pairing: `run402 orgs lightning-receiver set <org_id> --uri -` with the `nostr+walletconnect://` URI on stdin. The gateway probes it and refuses any pairing that can spend. This is where sats in land.
3. Mint a second pairing on the same node that can `pay_invoice` with a budget (Alby Hub: a connection with a daily budget), and set it as the `PAYOUT_NWC_PAIRING` secret (`run402 secrets set PAYOUT_NWC_PAIRING --file -`). This is where sats out come from; the payout run also refuses any single payment above `PAYOUT_MAX_SATS_PER_RUN`. Run402 never sees this pairing's methods; it is a function secret, injected into the project's functions and read only by the payout run.
4. Give the desk a USDC signer so sats-in swaps pay real USDC: `run402 contracts provision-signer <project_id> --chain base-sepolia` (`base-mainnet` on mainnet; $1.20 of the organization's allowance prepays a month of rent), then make it the organization's payout address with `run402 orgs payout-wallet <org_id> --signer <signer_id>`, so what the USDC-in routes earn is the inventory the sats-in routes pay from, and set `PAYOUT_SIGNER_ID` and `PAYOUT_MODE=base`. The signer needs no ETH: the desk's functions post to `/contracts/v1/signers/:id/transfers` with the project's service key, Run402 signs the EIP-3009 authorization with the signer's key (which never leaves its custody) and its facilitator settles it and pays the gas; one signing fee per transfer goes to the allowance. The quote reads the signer's balance and closes a denomination it cannot cover. Without a signer, `PAYOUT_MODE=demo` records the USDC leg instead.
5. For mainnet, set `networks: ["lightning"]` on the sats-in routes and `["mainnet"]` on the USDC-in routes, `NETWORK_MODE=mainnet` as a function secret, and read [docs/architecture.md](docs/architecture.md) on custody and the legal line before you do.

Configuration is environment (`run402 secrets set NAME --value v`): `SPREAD_BPS`, `QUOTE_TTL_SECONDS`, `MAX_FILL_USD`, `DAILY_CAP_USD` (both directions, USD notional), `DENOMINATIONS_USD` (the USDC-in routes the manifest declares, `0.10,1,5` on testnet), `PAYOUT_MAX_SATS_PER_RUN`, `PAYOUT_NWC_PAIRING`, `HEDGE_VENUE` (`paper`), `PAYOUT_MODE` (`demo` or `base`), `PAYOUT_SIGNER_ID`, `PAPER_BTC_USD` (0 reads the public index).

## Develop

```bash
npm test                 # pricing arithmetic, the Lightning leg (BOLT11, LNURL-pay, destination checks)
npm run check            # validate the manifest locally
```
