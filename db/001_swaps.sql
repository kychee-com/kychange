-- kychange: the desk's own records. Nothing here is exposed through REST;
-- the functions read and write with the service role.

CREATE TABLE IF NOT EXISTS swaps (
  swap_id        text PRIMARY KEY,
  direction      text NOT NULL CHECK (direction IN ('sats_in', 'usdc_in')),
  payment_id     text NOT NULL UNIQUE,
  payment_hash   text,
  payer          text,
  amount_in      bigint NOT NULL,
  asset_in       text NOT NULL,
  amount_out     bigint NOT NULL,
  asset_out      text NOT NULL,
  destination    text NOT NULL,
  quote_id       text,
  rate_btc_usd   numeric(18, 2) NOT NULL,
  spread_bps     integer NOT NULL,
  state          text NOT NULL CHECK (state IN (
                   'paid', 'payout_pending', 'paid_out', 'refund_due',
                   'refund_pending', 'refunded', 'refund_failed', 'stuck')),
  state_reason   text,
  claim_token    text NOT NULL,
  payout_run_id  text,
  preimage_out   text,
  tx_hash_out    text,
  network_mode   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  paid_out_at    timestamptz
);
CREATE INDEX IF NOT EXISTS swaps_state_created_idx ON swaps (state, created_at);
CREATE INDEX IF NOT EXISTS swaps_direction_created_idx ON swaps (direction, created_at);

CREATE TABLE IF NOT EXISTS quotes (
  quote_id     text PRIMARY KEY,
  side         text NOT NULL,
  venue        text NOT NULL,
  venue_price  numeric(18, 2) NOT NULL,
  spread_bps   integer NOT NULL,
  rate         numeric(18, 2) NOT NULL,
  valid_until  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_attempts (
  attempt_id  text PRIMARY KEY,
  swap_id     text NOT NULL REFERENCES swaps (swap_id),
  run_id      text,
  mode        text NOT NULL,
  outcome     text NOT NULL,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hedges (
  hedge_id         text PRIMARY KEY,
  swap_id          text NOT NULL REFERENCES swaps (swap_id),
  venue            text NOT NULL,
  side             text NOT NULL,
  client_order_id  text NOT NULL,
  status           text NOT NULL,
  response         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  entry_id    bigserial PRIMARY KEY,
  swap_id     text REFERENCES swaps (swap_id),
  asset       text NOT NULL,
  delta       bigint NOT NULL,
  reason      text NOT NULL,
  simulated   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
