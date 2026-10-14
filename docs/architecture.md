# kychange architecture

kychange is a swap desk between the two rails x402 settles on: USDC on Base and sats on Bitcoin Lightning. It runs as one Run402 application: a static site, a few functions, a Postgres database, durable function runs for the payout legs, and live change hints for the status page. Each direction is one priced route; the platform collects the money before the function runs, and the function's whole job is to record the swap and hand the payout to a durable run.

It is a desk, not an order book. The operator holds inventory on both sides, quotes a rate from a hedge venue plus a spread, sells fixed denominations, and back-to-backs each fill on that venue. Run402 never holds the funds on either leg; the operator's wallets receive and pay.

Status: both routes run on the testnet instance. Route B (sats in, USDC out) rides Run402's priced routes on `lnbtc`, which let a priced route accept x402 `exact` on Lightning through the organization's own receiver; its USDC payout is a gasless transfer from the desk's Run402 signer in `base` mode (the platform signs the EIP-3009 authorization and its facilitator settles it; idempotent on the swap; inventory read before a buyer pays; the signer is also the organization's payout address, so USDC-in receipts are that inventory) or a record in `demo` mode. Route A (USDC in, sats out) rides an ordinary USDC-priced route; the payout run resolves the buyer's Lightning address (LNURL-pay) or invoice and pays it through the desk's spend-capped NWC pairing, and a swap the desk cannot pay is refunded through the same signer. The hedge is paper. Preimage refunds of sats are not built yet.

## Topology

```
                 ┌──────────────────────────── Run402 project: kychange ────────────────────────────┐
                 │                                                                                   │
  buyer          │  routes                     functions                 Postgres        durable runs│   operator-owned
  ─────          │  ──────                     ─────────                 ────────        ────────────│   ──────────────
  x402 USDC ────▶│  POST /api/sats/:denom  ──▶ swap-usdc-in ──▶ swaps ──▶ payout-sats ─────────────────▶ Lightning node
   (Base)        │  priced $N, Base            record + enqueue           (NWC pay_invoice, spend-capped pairing)
                 │                                                                                   │
  x402 lnbtc ───▶│  POST /api/usdc/:denom  ──▶ swap-sats-in ──▶ swaps ──▶ payout-usdc ─────────────────▶ hot EOA on Base
   (sats)        │  priced N sats, lnbtc       record + enqueue           (ERC-20 transfer, viem)    │   (key in a function secret)
                 │  ▲ invoice minted by the gateway through the org's receive-only NWC pairing      │
                 │                                                                                   │
  anyone ───────▶│  GET  /api/quote            quote ──────────────────────────────────── hedge venue ─▶ Coinbase / Gemini / Binance
                 │  GET  /api/swaps/:swap_id   status (claim token)                       adapter       (sandbox in demo mode)
                 │  POST /api/refunds          refund claim (preimage or payer sig)                    │
                 │  GET  /_run402/live         change hints for the status page                        │
                 └───────────────────────────────────────────────────────────────────────────────────┘
```

Two NWC pairings on the same node, two scopes. The gateway holds the receive-only one and mints invoices with it. The payout worker holds a spend-capped one and pays with it. Neither can do the other's job, and a leak of either is bounded.

## Route A: USDC in, sats out

`POST /api/sats/:denomination`, one route per denomination (`5`, `20`, `100` USD), each priced `mode: "always"` with the fixed `amount_usd_micros`, `pay_to: "org_default_payout"`, `networks: ["mainnet"]` in production or `["testnet"]` on Base Sepolia, and `pricing.discovery` so agents find it in the Bazaar.

Body: `{ "destination": "<lightning address | zero-amount bolt11>", "quote_id"?: "..." }`. The sats amount is only known at payout time, so the buyer gives a Lightning address (the desk requests an invoice for the exact amount through LNURL-pay) or a zero-amount invoice. A fixed-amount invoice is refused.

The gateway settles the USDC to the organization's payout wallet before invoking `swap-usdc-in`. The function reads the payment context (`payment_id`, `payer`, `transaction`, `amount_usd_micros`), inserts one `swaps` row with `UNIQUE (payment_id)`, prices the sats leg off the hedge venue, and creates a durable run for `payout-sats` with `idempotency_key = payment_id`. It answers 202 with `{ swap_id, status: "payout_pending", claim_token, sats_quoted, status_url }`. Nothing in this function talks to a node or a venue: it has ten seconds on the prototype tier and does one transaction plus one run creation.

`payout-sats` runs at least once. It takes a Postgres advisory lock on the swap, re-reads the state, resolves LNURL-pay for the exact sats, pays over NWC with the spend-capped pairing, stores the preimage, hedges the fill on the venue, and moves the swap to `paid_out`. A payment that cannot route, an expired invoice, or an inventory floor breach moves it to `refund_due`. The refund is a USDC transfer back to `payer` from the hot EOA, run by `refund-usdc`.

## Route B: sats in, USDC out

`POST /api/usdc/:denomination`, one route per denomination (`10k`, `100k`, `1m` sats), priced with a pinned `amount_msat` and `networks: ["lightning"]` or `["lightning-testnet"]`. The gateway mints the invoice through the organization's receive-only pairing, binds it to the exact request, and settles the preimage in process; the function never sees an unpaid request.

Body: `{ "destination": "0x…", "quote_id"?: "..." }`. The destination is an EVM address on the route's Base network.

`swap-sats-in` reads the payment context (`payment_id`, `amount_msat`, `transaction` = payment hash, no payer), inserts the `swaps` row, prices the USDC leg off the venue, enqueues `payout-usdc` with `idempotency_key = payment_id`, and answers 202.

`payout-usdc` sends an ERC-20 `transfer` from the hot EOA with viem. Nonces are serialized by one advisory lock across all USDC-sending runs, and the transaction hash is stored before broadcast completes so a crash after broadcast is recoverable. A follow-up run with a short delay confirms the receipt and marks `paid_out`; a revert or a stuck transaction after the retry budget moves the swap to `refund_due`. A Lightning payer is anonymous, so the refund is a claim: `POST /api/refunds { preimage, bolt11 }`. Whoever holds the preimage paid, and the desk pays the refund to the invoice they name.

Until the platform change ships, Route A ships alone. The alternative, a function that answers its own 402 and mints its own invoices, would be a second settlement engine without the gateway's allowlist, replay store, or idempotency, and is not built.

## The swap state machine

```
  challenge ──▶ paid ──▶ payout_pending ──▶ paid_out
   (gateway)    (fn)        (run)              │
                             │                 └──▶ hedged           (venue order filled; informational)
                             ├──▶ refund_due ──▶ refund_pending ──▶ refunded
                             │                                   └──▶ refund_failed  (operator attention)
                             └──▶ stuck      (USDC tx unconfirmed past the budget; operator attention)
```

| State | Set by | Means | Exit |
|---|---|---|---|
| `paid` | the gateway, before invocation | money is in; the row exists | the function enqueues the payout in the same transaction as the insert |
| `payout_pending` | `swap-*-in` | a durable run owns the payout | the run moves it |
| `paid_out` | `payout-*` | the buyer has the asset; preimage or tx hash stored | hedge is attempted, never blocks |
| `refund_due` | `payout-*` | payout failed terminally | `refund-*` run enqueued |
| `refund_pending` | `refund-*` | refund in flight | receipt or preimage |
| `refunded` | `refund-*` | money is back with the buyer | terminal |
| `refund_failed`, `stuck` | runs | needs the operator | manual, through the admin page |

Every transition is a single `UPDATE … WHERE swap_id = $1 AND state = $2` under the advisory lock. The gateway's `payment_id` is the idempotency key for the insert and for every run, so a replayed delivery or a re-fired run never pays twice. A run that finds the swap already past its state exits without side effects.

Two things the platform decides that the app must respect. Settlement precedes invocation, so the app can never refuse a paid request; it can only refund. And a priced route cannot be closed without a deploy, so the desk's "closed" state lives in `GET /api/quote` (`{ open: false, reason }`), which clients call first; a buyer who pays while closed is refunded automatically by the payout run.

## Data model

- `swaps`: `swap_id`, `direction`, `payment_id` (unique), `payer` (nullable), `payment_hash` (nullable), `amount_in`, `asset_in`, `amount_out`, `asset_out`, `destination`, `quote_id`, `state`, `claim_token`, `preimage_out`, `tx_hash_out`, timestamps.
- `quotes`: `quote_id`, `side`, `size`, `venue`, `venue_price`, `spread_bps`, `rate`, `valid_until`.
- `payout_attempts`, `refunds`, `hedges`: one row per attempt, with the venue or node response stored verbatim.
- `inventory_ledger`: every movement on each side, so the two balances are derivable and auditable.

Row-level security: the anon role reads nothing. The status page calls `GET /api/swaps/:swap_id` with the `claim_token` from the 202; the function reads with the service role. `swaps` is marked `live: true` with the public policy, which leaks only primary keys in change hints, and a swap id without its claim token reads nothing.

## Pricing and the hedge-venue adapter

The desk is a riskless principal. For each fill it places the opposite order on a venue, so inventory drifts only by the spread and by rebalancing lag.

```ts
interface HedgeVenue {
  readonly name: string;
  quote(input: { side: "buy_btc" | "sell_btc"; usd: number }): Promise<{ price: number; venueRef: string; asOf: string }>;
  placeOrder(input: { side: "buy_btc" | "sell_btc"; usd: number; clientOrderId: string }): Promise<{ orderId: string; status: "filled" | "open" | "rejected" }>;
  getOrder(orderId: string): Promise<{ status: "filled" | "open" | "rejected" | "canceled"; filledUsd: number; filledBtc: number }>;
  balances(): Promise<{ usd: number; btc: number }>;
}
```

Implementations: `paper` (marks to a public index price, fills instantly, holds no account), `coinbase-sandbox`, `gemini-sandbox`, `binance-demo`, and for production `coinbase` and `gemini`; Kraken spot has no self-service sandbox. The `clientOrderId` is the `swap_id`, so a hedge is idempotent on the venue too.

Quote policy, all operator config:

| Setting | Meaning |
|---|---|
| `SPREAD_BPS` | added to the venue price on each side |
| `QUOTE_TTL_SECONDS` | how long a quote id is honored; the swap uses the quote if presented and valid, else a fresh one |
| `MAX_FILL_USD`, `DAILY_CAP_USD` | per-swap and rolling-day limits; above them `GET /api/quote` reports closed |
| `INVENTORY_FLOOR_SATS`, `INVENTORY_FLOOR_USDC` | below a floor the affected direction closes |
| `VENUE_DOWN_POLICY` | `index_wide` (quote off the index with a wider spread, hedge later) or `close` |

Rebalancing is a runbook, not code: withdraw BTC from the venue to the node and open or splice capacity, deposit USDC to the venue. In demo mode the venue holds sandbox balances that cannot be withdrawn, so the ledger records simulated rebalances and says so.

## Testnet modes

`NETWORK_MODE` selects everything at once.

| | `testnet` (the public kychange.com instance) | `mainnet` (an operator's own instance) |
|---|---|---|
| USDC leg | Base Sepolia, `networks: ["testnet"]`; faucet USDC and ETH in the hot EOA | Base mainnet |
| Lightning leg | `networks: ["lightning-testnet"]` against the operator's own testnet node; today that is testnet3, the only test network id the `lnbtc` scheme defines | mainnet node |
| Hedge | a venue sandbox or `paper` | a real venue account |
| Caps | small | the operator's |
| Money | none anywhere | real, with the legal obligations that brings |

A visitor needs testnet sats to try Route B and a testnet Lightning destination to try Route A. The public instance hands out a budgeted sub-wallet on the demo's own testnet node (an NWC pairing with starter sats, the same pattern Run402 uses for agents), and `docs/try-it.md` ships a small `lnbtc` client. The Lightning test network itself is in flux: Bitcoin Core has removed testnet3, the scheme has no testnet4 or signet id yet, and Mutinynet is the only public Lightning test network with a faucet. The network id is an upstream spec question Kychee can raise as the mechanism's author; until it is settled, the demo's Lightning leg is a closed loop on nodes the demo runs.

## Secrets and configuration

| Secret | Held by | Scope |
|---|---|---|
| receive-only NWC pairing | Run402 (encrypted, the org's Lightning receiver) | `get_info`, `make_invoice`, `lookup_invoice` |
| spend-capped NWC pairing | `payout-sats` and `refund-sats` function secret | `pay_invoice` with a budget |
| hot EOA private key | `payout-usdc` and `refund-usdc` function secret | signs USDC transfers; holds only working inventory |
| venue API key | `payout-*` function secret | trade only, no withdrawal permission |

The organization's payout wallet is where Route A's USDC lands, and today it must be a wallet linked to the org, which the deploying wallet is. The hot EOA is a different key; the operator sweeps from the payout wallet to it. Run402's `proven-payout-address` change would let the hot EOA be the payout destination directly.

## Custody and the legal line

Architectural facts, stated the same way everywhere: Run402 never holds the funds on either leg; the USDC settles to the operator's wallet through the x402 facilitator, the sats settle on the operator's node, and Run402 holds only a receive-only pairing. Run402 takes no cut of tenant route revenue. The operator is the counterparty on every swap and the custodian of the inventory. Operating this software with real money is, in most jurisdictions, regulated activity, and it is the operator's to assess. Kychee publishes the code and runs the testnet instance only.

## Open items

- `PAYOUT_MODE=base`: the hot-EOA ERC-20 transfer over viem, with the nonce lock and the confirmation follow-up run.
- The refund claim for sats (`POST /api/refunds`).
- Letting the organization's payout wallet be the signer itself, so USDC-in receipts become inventory without a sweep.
- The `lnbtc` test network id after testnet3; upstream.
- `proven-payout-address`: lets the hot wallet receive directly.
- A way to close a priced route without a deploy; feedback to the platform.
- x402 `upto` for arbitrary amounts on Route A; later, and never on Route B.
