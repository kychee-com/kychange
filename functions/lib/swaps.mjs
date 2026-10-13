// The swaps table, through the service-role SQL client. Every transition is
// one compare-and-set UPDATE on (swap_id, state), so a re-fired run or a
// replayed delivery finds the row already moved and does nothing.

import { adminDb } from "@run402/functions";
import { randomBytes } from "node:crypto";

export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

const sql = (query, params) => adminDb().sql(query, params);

/** Insert a swap once per payment id; a second insert returns the first row. */
export async function insertSwap(row) {
  const inserted = await sql(
    `INSERT INTO swaps (swap_id, direction, payment_id, payment_hash, payer, amount_in, asset_in,
                        amount_out, asset_out, destination, quote_id, rate_btc_usd, spread_bps,
                        state, state_reason, claim_token, network_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (payment_id) DO NOTHING
     RETURNING *`,
    [row.swap_id, row.direction, row.payment_id, row.payment_hash ?? null, row.payer ?? null,
      row.amount_in, row.asset_in, row.amount_out, row.asset_out, row.destination, row.quote_id ?? null,
      row.rate_btc_usd, row.spread_bps, row.state, row.state_reason ?? null, row.claim_token, row.network_mode],
  );
  if (inserted.rows.length > 0) return { swap: inserted.rows[0], created: true };
  const existing = await sql(`SELECT * FROM swaps WHERE payment_id = $1`, [row.payment_id]);
  return { swap: existing.rows[0] ?? null, created: false };
}

export async function getSwap(swapId) {
  const result = await sql(`SELECT * FROM swaps WHERE swap_id = $1`, [swapId]);
  return result.rows[0] ?? null;
}

const PATCH_COLUMNS = new Set(["payout_run_id", "tx_hash_out", "preimage_out", "paid_out_at", "state_reason"]);

/** Move a swap from one state to the next; null when it was not in `from`. */
export async function transition(swapId, from, to, patch = {}) {
  const sets = ["state = $3", "updated_at = now()"];
  const params = [swapId, from, to];
  for (const [column, value] of Object.entries(patch)) {
    if (!PATCH_COLUMNS.has(column)) throw new RangeError(`not a patchable column: ${column}`);
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  const result = await sql(
    `UPDATE swaps SET ${sets.join(", ")} WHERE swap_id = $1 AND state = $2 RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

export async function recordAttempt({ swap_id, run_id, mode, outcome, response }) {
  await sql(
    `INSERT INTO payout_attempts (attempt_id, swap_id, run_id, mode, outcome, response) VALUES ($1, $2, $3, $4, $5, $6)`,
    [newId("att"), swap_id, run_id ?? null, mode, outcome, JSON.stringify(response ?? null)],
  );
}

export async function recordHedge({ swap_id, venue, side, client_order_id, status, response }) {
  await sql(
    `INSERT INTO hedges (hedge_id, swap_id, venue, side, client_order_id, status, response) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [newId("hdg"), swap_id, venue, side, client_order_id, status, JSON.stringify(response ?? null)],
  );
}

export async function ledger({ swap_id, asset, delta, reason, simulated }) {
  await sql(
    `INSERT INTO inventory_ledger (swap_id, asset, delta, reason, simulated) VALUES ($1, $2, $3, $4, $5)`,
    [swap_id ?? null, asset, delta, reason, simulated === true],
  );
}

/** USD micros paid out in the rolling day, for the daily cap. */
export async function paidOutTodayMicros() {
  const result = await sql(
    `SELECT COALESCE(SUM(amount_out), 0)::bigint AS micros FROM swaps
      WHERE direction = 'sats_in' AND created_at > now() - interval '1 day'
        AND state NOT IN ('refunded', 'refund_failed')`,
  );
  return Number(result.rows[0]?.micros ?? 0);
}

export async function insertQuote(row) {
  await sql(
    `INSERT INTO quotes (quote_id, side, venue, venue_price, spread_bps, rate, valid_until) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.quote_id, row.side, row.venue, row.venue_price, row.spread_bps, row.rate, row.valid_until],
  );
}

/** A quote by id, only while it is still valid. */
export async function validQuote(quoteId) {
  if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64) return null;
  const result = await sql(`SELECT * FROM quotes WHERE quote_id = $1 AND valid_until > now()`, [quoteId]);
  return result.rows[0] ?? null;
}

/** The swap as the buyer may see it: no claim token, no internals. */
export function publicSwap(row) {
  return {
    swap_id: row.swap_id,
    direction: row.direction,
    state: row.state,
    state_reason: row.state_reason ?? null,
    sats_in: row.direction === "sats_in" ? Number(row.amount_in) : null,
    usd_out_micros: row.direction === "sats_in" ? Number(row.amount_out) : null,
    asset_out: row.asset_out,
    destination: row.destination,
    rate_btc_usd: Number(row.rate_btc_usd),
    spread_bps: row.spread_bps,
    payment_hash: row.payment_hash ?? null,
    tx_hash_out: row.tx_hash_out ?? null,
    network_mode: row.network_mode,
    created_at: row.created_at,
    updated_at: row.updated_at,
    paid_out_at: row.paid_out_at ?? null,
  };
}
