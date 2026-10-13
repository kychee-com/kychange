# kychange

A swap desk between the two rails x402 settles on, USDC on Base and sats on Bitcoin Lightning, built as a [Run402](https://run402.com) application. Pay one rail, receive the other. The desk quotes from a hedge venue plus a spread and back-to-backs each fill there.

Status: the sats-in direction (Route B) is live on the testnet instance at [kychange.com](https://kychange.com). It settles real testnet3 Lightning payments through Run402's `tenant-lnbtc-priced-routes`, records each swap, and pays the USDC leg in demo mode (a simulated transfer on the swap row) with a paper hedge. The hot-EOA transfer (`PAYOUT_MODE=base`), Route A (USDC in, sats out), and preimage refunds are the next steps. The design is [docs/architecture.md](docs/architecture.md); trying it is [docs/try-it.md](docs/try-it.md).

Run402 never holds the funds on either leg. Whoever deploys this holds the inventory, is the counterparty on every swap, and carries whatever obligations operating it with real money brings in their jurisdiction. Kychee publishes the code and runs a testnet-only instance at kychange.com.

## Layout

| Path | What |
|---|---|
| `run402.json` | the release manifest: one migration, four functions, the priced routes, the two pages |
| `db/001_swaps.sql` | `swaps`, `quotes`, `payout_attempts`, `hedges`, `inventory_ledger`; nothing is exposed through REST |
| `functions/quote.mjs` | `GET /api/quote`: open or closed, the bid, the denominations, a `quote_id` |
| `functions/swap-sats-in.mjs` | `POST /api/usdc/:denomination`: records the paid swap and enqueues the payout run |
| `functions/payout-usdc.mjs` | the durable run that pays (demo: records) the USDC leg and hedges on paper |
| `functions/swap-status.mjs` | `GET /api/swaps/:swap_id?claim=…`: the buyer's view |
| `functions/lib/` | config (all env, set as function secrets), pricing, the venue adapter, the swaps table |
| `tools/pay.mjs` | a buyer: pays a route with any NWC pairing through `@run402/sdk/node` |
| `site/` | the landing page and the status page |

## Run your own

1. Deploy once: `run402 up --name kychange` from this directory (prototype tier is enough for a testnet instance; a custom domain needs hobby).
2. Register the organization's receive-only Lightning pairing: `run402 orgs lightning-receiver set <org_id> --uri -` with the `nostr+walletconnect://` URI on stdin. The gateway probes it and refuses any pairing that can spend.
3. For mainnet, set `networks: ["lightning"]` on the routes and `NETWORK_MODE=mainnet` as a function secret, and read [docs/architecture.md](docs/architecture.md) on custody and the legal line before you do.

Configuration is environment (`run402 secrets set NAME value`): `SPREAD_BPS`, `QUOTE_TTL_SECONDS`, `MAX_FILL_USD`, `DAILY_CAP_USD`, `HEDGE_VENUE` (`paper`), `PAYOUT_MODE` (`demo`), `PAPER_BTC_USD` (0 reads the public index).

## Develop

```bash
npm test                 # pricing arithmetic
npm run check            # validate the manifest locally
```
