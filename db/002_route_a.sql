-- kychange Route A (USDC in, sats out): the USDC transaction of a usdc_in swap
-- and the refund records. Additive; nothing is exposed through REST.

ALTER TABLE swaps ADD COLUMN IF NOT EXISTS tx_hash_in text;
CREATE INDEX IF NOT EXISTS swaps_payer_created_idx ON swaps (payer, created_at);

CREATE TABLE IF NOT EXISTS refunds (
  refund_id    text PRIMARY KEY,
  swap_id      text NOT NULL REFERENCES swaps (swap_id),
  run_id       text,
  asset        text NOT NULL,
  amount       bigint NOT NULL,
  destination  text NOT NULL,
  mode         text NOT NULL,
  reference    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refunds_swap_idx ON refunds (swap_id);
