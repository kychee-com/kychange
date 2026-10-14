import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.PAYOUT_SIGNER_ID = "sgn_test";
process.env.NETWORK_MODE = "testnet";
const { BaseCallError, callStatus, explorerTxUrl, inventoryMicros, transferUsdc, usdcBalanceMicros, waitForCall } = await import("./base.mjs");

const env = { RUN402_SERVICE_KEY: "sk_test_service", RUN402_API_BASE: "https://api.test.example/" };
const TO = "0x000000000000000000000000000000000000b0b0";
const HASH = "0x" + "ab".repeat(32);
const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const recorder = (handler) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  return { calls, fetchImpl };
};

describe("transferUsdc", () => {
  it("posts a gasless USDC transfer to the signer's transfer route with the idempotency key and the service key", async () => {
    const { calls, fetchImpl } = recorder(() => respond(200, { transfer_id: "txf_1", tx_hash: HASH, status: "settled" }));
    const result = await transferUsdc({ to: TO, amountMicros: 83_000, idempotencyKey: "payout:swp_1", fetchImpl, env });
    assert.deepEqual({ callId: result.callId, txHash: result.txHash, status: result.status }, { callId: "txf_1", txHash: HASH, status: "confirmed" });
    assert.equal(calls[0].url, "https://api.test.example/contracts/v1/signers/sgn_test/transfers");
    assert.equal(calls[0].init.headers.authorization, "Bearer sk_test_service");
    assert.equal(calls[0].init.headers["idempotency-key"], "payout:swp_1");
    assert.deepEqual(JSON.parse(calls[0].init.body), { chain: "base-sepolia", asset: "usdc", to: TO, amount: "83000" });
    const unknown = await transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(202, { transfer_id: "txf_2", tx_hash: null, status: "unknown" }) });
    assert.equal(unknown.status, "pending", "an unknown settle outcome is pending to the run; the next attempt polls it");
  });

  it("adopts the transfer a conflicting replay names, and refuses one that died in settlement", async () => {
    const adopted = await transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(409, { error: "idempotency_key_conflict", transfer_id: "txf_old", status: "settled", tx_hash: HASH }) });
    assert.deepEqual({ callId: adopted.callId, txHash: adopted.txHash, status: adopted.status }, { callId: "txf_old", txHash: HASH, status: "confirmed" });
    await assert.rejects(
      transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(409, { error: "idempotency_key_conflict", transfer_id: "txf_dead", status: "failed", tx_hash: null }) }),
      (error) => error instanceof BaseCallError && error.code === "transfer_failed" && error.retryable === false,
    );
  });

  it("tells a retryable facilitator refusal from an inventory shortfall, a refused signer, and bad input", async () => {
    await assert.rejects(
      transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(422, { code: "TRANSFER_FAILED", message: "the facilitator refused the transfer: invalid_signature", retryable: true }) }),
      (error) => error instanceof BaseCallError && error.code === "transfer_refused" && error.retryable === true,
    );
    await assert.rejects(
      transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(409, { code: "TRANSFER_INSUFFICIENT_BALANCE", message: "the signer holds 0" }) }),
      (error) => error instanceof BaseCallError && error.code === "insufficient_balance" && error.retryable === false,
    );
    await assert.rejects(
      transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(502, { code: "TRANSFER_FAILED", message: "settlement failed: reverted", retryable: false }) }),
      (error) => error instanceof BaseCallError && error.code === "transfer_failed" && error.retryable === false,
    );
    await assert.rejects(
      transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(403, { error: "signer_suspended_unpaid_rent" }) }),
      (error) => error instanceof BaseCallError && error.code === "signer_refused" && error.retryable === false,
    );
    await assert.rejects(transferUsdc({ to: "nope", amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => { throw new Error("never"); } }), (error) => error.code === "invalid_destination");
    await assert.rejects(transferUsdc({ to: TO, amountMicros: 0, idempotencyKey: "k", env, fetchImpl: async () => { throw new Error("never"); } }), (error) => error.code === "invalid_amount");
    await assert.rejects(transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env: { RUN402_API_BASE: env.RUN402_API_BASE }, fetchImpl: async () => { throw new Error("never"); } }), (error) => error.code === "service_key_missing");
  });
});

describe("transfer status and inventory", () => {
  it("reads a transfer and waits for it to leave pending or unknown", async () => {
    let reads = 0;
    const urls = [];
    const fetchImpl = async (url) => { urls.push(url); reads += 1; return respond(200, { transfer_id: "txf_1", status: reads < 3 ? "unknown" : "settled", tx_hash: HASH }); };
    const first = await callStatus("txf_1", { fetchImpl, env });
    assert.equal(first.status, "pending");
    assert.equal(urls[0], "https://api.test.example/contracts/v1/signers/sgn_test/transfers/txf_1");
    const settled = await waitForCall("txf_1", { fetchImpl, env, sleep: async () => undefined, budgetMs: 60_000 });
    assert.deepEqual({ status: settled.status, txHash: settled.txHash }, { status: "confirmed", txHash: HASH });
    assert.equal(reads, 3);
  });

  it("stops at the budget while still pending, and names an unknown transfer", async () => {
    const pending = await waitForCall("txf_2", { env, sleep: async () => undefined, budgetMs: 0, fetchImpl: async () => respond(200, { transfer_id: "txf_2", status: "pending", tx_hash: null }) });
    assert.equal(pending.status, "pending");
    await assert.rejects(callStatus("txf_9", { env, fetchImpl: async () => respond(404, { code: "TRANSFER_NOT_FOUND" }) }), (error) => error.code === "call_not_found");
  });

  it("reads the signer's USDC balance anonymously and answers null inventory when it cannot", async () => {
    const { calls, fetchImpl } = recorder((url) => url.endsWith("/contracts/v1/signers/sgn_test")
      ? respond(200, { id: "sgn_test", address: TO })
      : respond(200, { result: "700000" }));
    assert.equal(await usdcBalanceMicros(TO, { fetchImpl, env }), 700_000);
    assert.equal(calls[0].init.headers.authorization, undefined, "balanceOf needs no credential");
    assert.equal(JSON.parse(calls[0].init.body).function_name, "balanceOf");
    assert.equal(await inventoryMicros({ fetchImpl, env }), 700_000);
    assert.equal(await inventoryMicros({ env, fetchImpl: async () => respond(500, { error: "rpc_failed" }) }), null, "the signer address is cached, so this read fails on balanceOf and inventory is unknown");
    assert.equal(await inventoryMicros({ env, signerId: "sgn_other", fetchImpl: async () => respond(500, { error: "down" }) }), null);
  });

  it("builds explorer links only for transaction hashes", () => {
    assert.equal(explorerTxUrl(HASH), `https://sepolia.basescan.org/tx/${HASH}`);
    assert.equal(explorerTxUrl("simulated:abc"), null);
  });
});
