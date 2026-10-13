# First sats-in swap on testnet (2026-10-13)

The public instance (`prj_1791837150791_1488`, release `rel_1791877127420_af176df2`, serving `kychange.com` and `lnbtc-scratch.run402.com`) took its first Route B swap. The receiver was the desk's testnet3 node (`03fd7e39b23e3667ec6b0f5ed742d8f871e53e7111dc9451a322d2e69b873cb4d2`) through a receive-only NWC pairing registered as the organization's Lightning receiver; the payer was the harness's other node.

## The challenge

`POST /api/usdc/10k` answered 402 with one `exact` entry on `lnbtc:000000000933ea01ad0ee984209779ba`, `amount` `10000000` msat, `payTo` the receiver's node key, the invoice bound to the request (`http:1`, bound header `content-type`).

## The paid retry (the function's view)

```json
{
  "swap_id": "swp_b263407e2ac0fa4762aeec00",
  "state": "payout_pending",
  "sats_in": 10000,
  "usd_out_micros": 8348233,
  "usd_out": "$8.34",
  "destination": "0x000000000000000000000000000000000000dEaD",
  "rate_btc_usd": 83901.84,
  "spread_bps": 50,
  "status_url": "https://lnbtc-scratch.run402.com/api/swaps/swp_b263407e2ac0fa4762aeec00?claim=…",
  "payment": {
    "payment_id": "txp_5decddd8f42a4446b98a1a40df4d5cd7",
    "payment_hash": "ce487594b0bc4ef2ff0b787a5f1f8f2bf5a9eea115fa1ea7740df51d9fd850f9",
    "network": "lnbtc:000000000933ea01ad0ee984209779ba",
    "amount_msat": 10000000,
    "settled_at": "2026-10-13T07:39:32.653Z",
    "delivery": "first",
    "deduplicated": false
  },
  "replayed": false
}
```

The index was Coinbase BTC-USD spot at $83,901.84; the bid after 50 bps was $83,482.33, so 10,000 sats bought $8.348233 of USDC.

## The payout run

Durable run `fnrun_fd1ba67b718b4233b9b87ad1` (`payout.usdc`, idempotency key = the payment id) succeeded on its first attempt at 07:39:39Z, four seconds after the 202, and moved the swap to `paid_out` with the demo-mode transfer `simulated:1bd409dc5bc1e725f6457885f17cca89dd1d827597ce1deabc4d3d3978efb1cb` and a paper hedge (`sell_btc`, filled).

## Status read

`GET /api/swaps/swp_b263407e2ac0fa4762aeec00?claim=<token>` at 07:39:41Z:

```json
{ "state": "paid_out", "sats_in": 10000, "usd_out_micros": 8348233, "payment_hash": "ce487594b0bc4ef2ff0b787a5f1f8f2bf5a9eea115fa1ea7740df51d9fd850f9", "tx_hash_out": "simulated:1bd409dc5bc1e725f6457885f17cca89dd1d827597ce1deabc4d3d3978efb1cb", "paid_out_at": "2026-10-13T07:39:38.973Z" }
```

What this does not prove: a real USDC transfer (demo mode), a hedge on a real venue (paper), or a refund.

## Caps are enforced, not advisory (same day)

With `MAX_FILL_USD=5` set on the instance, `GET /api/quote` listed every denomination as "closed: above the $5 cap for one swap", and a 10,000-sat payment made anyway (the gateway still mints the invoice; a priced route cannot be closed without a deploy) produced swap `swp_702715ad35d31add53b08579` in `refund_due` with `state_reason: above_max_fill` and no payout run. Its status view carries the refund instructions. The testnet instance then went back to `MAX_FILL_USD=100` and `DAILY_CAP_USD=1000`, so 10k and 100k are open and 1m stays closed as the visible example of a cap.
