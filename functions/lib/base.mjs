// The USDC leg on Base in `base` payout mode: an ERC-20 transfer signed by
// the project's Run402 KMS signer through the platform's contract-call
// route. Run402 holds the key in KMS, picks the nonce, pays gas at cost, and
// de-duplicates on the idempotency key, so this module never sees a private
// key and never needs an RPC. The project's service key (in the function
// environment) authorizes the calls.

import { PAYOUT_SIGNER_ID, baseChain } from "./config.mjs";

const TRANSFER_ABI = [{
  type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}];
const BALANCE_ABI = [{
  type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}];
const API_TIMEOUT_MS = 12_000;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export class BaseCallError extends Error {
  constructor(code, message, { retryable = false, details = {} } = {}) {
    super(message);
    this.name = "BaseCallError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function apiBase(env) {
  return (env.RUN402_API_BASE || "https://api.run402.com").replace(/\/$/, "");
}

async function callApi(path, { method = "GET", body, auth = true, headers = {}, fetchImpl = fetch, env = process.env } = {}) {
  const h = { accept: "application/json", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (auth) {
    if (!env.RUN402_SERVICE_KEY) throw new BaseCallError("service_key_missing", "RUN402_SERVICE_KEY is not in the function environment");
    h.authorization = `Bearer ${env.RUN402_SERVICE_KEY}`;
  }
  let response;
  try {
    response = await fetchImpl(`${apiBase(env)}${path}`, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BaseCallError("api_unreachable", String(error?.message ?? error), { retryable: true });
  }
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}

/**
 * Submits `transfer(to, amountMicros)` on the chain's USDC through the
 * signer, idempotent on `idempotencyKey`: a repeat under the same key
 * returns the call Run402 already made. Returns `{ callId, txHash, status }`.
 */
export async function transferUsdc({ to, amountMicros, idempotencyKey, signerId = PAYOUT_SIGNER_ID, fetchImpl, env }) {
  if (!signerId) throw new BaseCallError("signer_missing", "PAYOUT_SIGNER_ID is not set");
  if (!EVM_ADDRESS.test(String(to))) throw new BaseCallError("invalid_destination", `${String(to)} is not an EVM address`);
  if (!Number.isInteger(amountMicros) || amountMicros <= 0) throw new BaseCallError("invalid_amount", "amount must be a positive integer of USDC micros");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) throw new BaseCallError("invalid_key", "an idempotency key is required");
  const { chain, usdc } = baseChain();
  const { status, json } = await callApi("/contracts/v1/call", {
    method: "POST", fetchImpl, env, headers: { "idempotency-key": idempotencyKey },
    body: { signer_id: signerId, chain, contract_address: usdc, abi_fragment: TRANSFER_ABI, function_name: "transfer", args: [to, String(amountMicros)] },
  });
  if ((status === 202 || status === 200) && json?.call_id) {
    return { callId: json.call_id, txHash: TX_HASH.test(String(json.tx_hash)) ? json.tx_hash : null, status: json.status ?? "pending" };
  }
  if (status === 409 && json?.error === "idempotency_key_conflict" && json.call_id) {
    // The key already names a call: adopt it rather than transfer again.
    if (json.status === "failed" && !json.tx_hash) {
      throw new BaseCallError("transfer_failed", String(json.call_error ?? "the recorded call failed"), { details: { call_id: json.call_id } });
    }
    return { callId: json.call_id, txHash: TX_HASH.test(String(json.tx_hash)) ? json.tx_hash : null, status: json.status ?? "pending" };
  }
  if (status === 403) {
    throw new BaseCallError("signer_refused", String(json?.message ?? json?.error ?? "the signer refused the call"), { details: json ?? {} });
  }
  if (status === 502 && json?.call_id) {
    throw new BaseCallError("transfer_failed", String(json.error ?? "transfer failed"), { retryable: json.retryable === true, details: { call_id: json.call_id } });
  }
  if (status >= 500) throw new BaseCallError("api_error", `${status} from the contract call route`, { retryable: true, details: json ?? {} });
  throw new BaseCallError("api_error", `${status} from the contract call route: ${String(json?.error ?? json?.message ?? "")}`.trim(), { details: json ?? {} });
}

/** One read of a call: `{ callId, status, txHash, error, gasCostUsdMicros, receipt }`. */
export async function callStatus(callId, { fetchImpl, env } = {}) {
  const { status, json } = await callApi(`/contracts/v1/calls/${encodeURIComponent(callId)}`, { fetchImpl, env });
  if (status === 404) throw new BaseCallError("call_not_found", `call ${callId} is unknown to the platform`);
  if (status !== 200 || !json) throw new BaseCallError("api_error", `${status} reading call ${callId}`, { retryable: status >= 500 });
  return {
    callId: json.id ?? callId,
    status: json.status ?? "pending",
    txHash: TX_HASH.test(String(json.tx_hash)) ? json.tx_hash : null,
    error: json.error ?? null,
    gasCostUsdMicros: json.gas_cost_usd_micros ?? null,
    receipt: json.receipt ?? null,
  };
}

/** Polls the call until it leaves `pending` or the budget runs out; the last status either way. */
export async function waitForCall(callId, { budgetMs = 15_000, intervalMs = 2_000, fetchImpl, env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const started = Date.now();
  for (;;) {
    const current = await callStatus(callId, { fetchImpl, env });
    if (current.status !== "pending" || Date.now() - started >= budgetMs) return current;
    await sleep(intervalMs);
  }
}

let signerCache = { id: null, address: null };

/** The signer's address, read once per container. */
export async function signerAddress({ signerId = PAYOUT_SIGNER_ID, fetchImpl, env } = {}) {
  if (!signerId) return null;
  if (signerCache.id === signerId && signerCache.address) return signerCache.address;
  const { status, json } = await callApi(`/contracts/v1/signers/${encodeURIComponent(signerId)}`, { fetchImpl, env });
  const address = json?.address ?? json?.wallet_address ?? null;
  if (status !== 200 || !EVM_ADDRESS.test(String(address))) {
    throw new BaseCallError("signer_unreadable", `${status} reading signer ${signerId}`, { retryable: status >= 500 });
  }
  signerCache = { id: signerId, address };
  return address;
}

/** The USDC balance of `address` in micros, read anonymously through the platform. */
export async function usdcBalanceMicros(address, { fetchImpl, env } = {}) {
  const { chain, usdc } = baseChain();
  const { status, json } = await callApi("/contracts/v1/read", {
    method: "POST", auth: false, fetchImpl, env,
    body: { chain, contract_address: usdc, abi_fragment: BALANCE_ABI, function_name: "balanceOf", args: [address] },
  });
  if (status !== 200) throw new BaseCallError("inventory_unreadable", `${status} reading balanceOf`, { retryable: status >= 500, details: json ?? {} });
  const raw = Array.isArray(json?.result) ? json.result[0] : json?.result;
  const value = typeof raw === "string" || typeof raw === "number" || typeof raw === "bigint" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) throw new BaseCallError("inventory_unreadable", "balanceOf returned no number");
  return value;
}

/** The desk's USDC inventory in micros, or null when the signer or the read is unavailable. */
export async function inventoryMicros(options = {}) {
  try {
    const address = await signerAddress(options);
    if (!address) return null;
    return await usdcBalanceMicros(address, options);
  } catch {
    return null;
  }
}

/** The explorer page of a Base transaction, or null for anything that is not a hash. */
export function explorerTxUrl(hash) {
  return TX_HASH.test(String(hash)) ? `${baseChain().explorer}/tx/${hash}` : null;
}
