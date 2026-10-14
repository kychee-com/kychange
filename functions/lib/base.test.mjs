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
  it("submits transfer(to, amount) on Sepolia USDC through the signer with the idempotency key and the service key", async () => {
    const { calls, fetchImpl } = recorder(() => respond(202, { call_id: "call_1", tx_hash: HASH, status: "pending" }));
    const result = await transferUsdc({ to: TO, amountMicros: 83_000, idempotencyKey: "payout:swp_1", fetchImpl, env });
    assert.deepEqual(result, { callId: "call_1", txHash: HASH, status: "pending" });
    assert.equal(calls[0].url, "https://api.test.example/contracts/v1/call");
    assert.equal(calls[0].init.headers.authorization, "Bearer sk_test_service");
    assert.equal(calls[0].init.headers["idempotency-key"], "payout:swp_1");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.signer_id, "sgn_test");
    assert.equal(body.chain, "base-sepolia");
    assert.equal(body.contract_address, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    assert.equal(body.function_name, "transfer");
    assert.deepEqual(body.args, [TO, "83000"]);
    assert.equal(body.abi_fragment[0].name, "transfer");
  });

  it("adopts the call a conflicting replay names, and refuses one that died before broadcast", async () => {
    const adopted = await transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(409, { error: "idempotency_key_conflict", call_id: "call_old", status: "confirmed", tx_hash: HASH }) });
    assert.deepEqual(adopted, { callId: "call_old", txHash: HASH, status: "confirmed" });
    await assert.rejects(
      transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(409, { error: "idempotency_key_conflict", call_id: "call_dead", status: "failed", call_error: "estimate reverted", tx_hash: null }) }),
      (error) => error instanceof BaseCallError && error.code === "transfer_failed" && error.retryable === false,
    );
  });

  it("tells a retryable pre-broadcast failure from a refused signer and from bad input", async () => {
    await assert.rejects(
      transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(502, { call_id: "call_x", status: "failed", error: "rpc timeout", retryable: true }) }),
      (error) => error instanceof BaseCallError && error.code === "transfer_failed" && error.retryable === true,
    );
    await assert.rejects(
      transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => respond(403, { error: "signer_suspended", message: "rent unpaid" }) }),
      (error) => error instanceof BaseCallError && error.code === "signer_refused" && error.retryable === false,
    );
    await assert.rejects(transferUsdc({ to: "nope", amountMicros: 1, idempotencyKey: "k", env, fetchImpl: async () => { throw new Error("never"); } }), (error) => error.code === "invalid_destination");
    await assert.rejects(transferUsdc({ to: TO, amountMicros: 0, idempotencyKey: "k", env, fetchImpl: async () => { throw new Error("never"); } }), (error) => error.code === "invalid_amount");
    await assert.rejects(transferUsdc({ to: TO, amountMicros: 1, idempotencyKey: "k", env: { RUN402_API_BASE: env.RUN402_API_BASE }, fetchImpl: async () => { throw new Error("never"); } }), (error) => error.code === "service_key_missing");
  });
});

describe("call status and inventory", () => {
  it("reads a call and waits for it to leave pending", async () => {
    let reads = 0;
    const fetchImpl = async () => { reads += 1; return respond(200, { id: "call_1", status: reads < 3 ? "pending" : "confirmed", tx_hash: HASH, gas_cost_usd_micros: 12, receipt: { blockNumber: "0x1" }, error: null }); };
    const first = await callStatus("call_1", { fetchImpl, env });
    assert.equal(first.status, "pending");
    const settled = await waitForCall("call_1", { fetchImpl, env, sleep: async () => undefined, budgetMs: 60_000 });
    assert.deepEqual({ status: settled.status, txHash: settled.txHash, gas: settled.gasCostUsdMicros }, { status: "confirmed", txHash: HASH, gas: 12 });
    assert.equal(reads, 3);
  });

  it("stops at the budget while still pending, and names an unknown call", async () => {
    const pending = await waitForCall("call_2", { env, sleep: async () => undefined, budgetMs: 0, fetchImpl: async () => respond(200, { id: "call_2", status: "pending", tx_hash: null }) });
    assert.equal(pending.status, "pending");
    await assert.rejects(callStatus("call_9", { env, fetchImpl: async () => respond(404, { error: "call_not_found" }) }), (error) => error.code === "call_not_found");
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
