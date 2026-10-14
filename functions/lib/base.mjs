// The USDC leg on Base in `base` payout mode: a gasless transfer from the
// project's Run402 signer through the platform's transfer route. The signer
// is the payer of an x402 payment: Run402 signs the token's EIP-3009
// authorization with the signer's key and its facilitator settles it and
// pays the gas, idempotent on the key this module sends. No private key, no
// RPC, no ETH on the signer. The project's service key (in the function
// environment) authorizes the calls.

import { PAYOUT_SIGNER_ID, baseChain } from "./config.mjs";

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

/** The run's view of a transfer: `settled` is confirmed, `failed` is failed, anything else is still pending. */
function transferView(json, fallbackId) {
  const status = json?.status === "settled" ? "confirmed" : json?.status === "failed" ? "failed" : "pending";
  return {
    callId: json?.transfer_id ?? fallbackId,
    status,
    txHash: TX_HASH.test(String(json?.tx_hash)) ? json.tx_hash : null,
    error: json?.facilitator_reason ?? null,
    gasCostUsdMicros: null,
    receipt: null,
  };
}

/**
 * Transfers `amountMicros` of USDC from the signer to `to` through the
 * platform's gasless transfer route, idempotent on `idempotencyKey`: a
 * repeat under the same key returns the transfer Run402 already made.
 * Returns `{ callId, txHash, status }` where `callId` is the transfer id.
 */
export async function transferUsdc({ to, amountMicros, idempotencyKey, signerId = PAYOUT_SIGNER_ID, fetchImpl, env }) {
  if (!signerId) throw new BaseCallError("signer_missing", "PAYOUT_SIGNER_ID is not set");
  if (!EVM_ADDRESS.test(String(to))) throw new BaseCallError("invalid_destination", `${String(to)} is not an EVM address`);
  if (!Number.isInteger(amountMicros) || amountMicros <= 0) throw new BaseCallError("invalid_amount", "amount must be a positive integer of USDC micros");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) throw new BaseCallError("invalid_key", "an idempotency key is required");
  const { chain } = baseChain();
  const { status, json } = await callApi(`/contracts/v1/signers/${encodeURIComponent(signerId)}/transfers`, {
    method: "POST", fetchImpl, env, headers: { "idempotency-key": idempotencyKey },
    body: { chain, asset: "usdc", to, amount: String(amountMicros) },
  });
  if ((status === 200 || status === 202) && json?.transfer_id) return transferView(json, null);
  if (status === 409 && json?.error === "idempotency_key_conflict" && json.transfer_id) {
    // The key already names a transfer: adopt it rather than transfer again.
    if (json.status === "failed" && !json.tx_hash) {
      throw new BaseCallError("transfer_failed", "the recorded transfer failed", { details: { transfer_id: json.transfer_id } });
    }
    return transferView(json, json.transfer_id);
  }
  const code = json?.code ?? json?.error ?? null;
  if (status === 409 && code === "TRANSFER_INSUFFICIENT_BALANCE") {
    throw new BaseCallError("insufficient_balance", String(json?.message ?? "the signer holds less USDC than the transfer"), { details: json ?? {} });
  }
  if (status === 403) {
    throw new BaseCallError("signer_refused", String(json?.message ?? json?.error ?? "the signer refused the transfer"), { details: json ?? {} });
  }
  if (status === 422 || status === 503 || (status === 502 && json?.retryable === true)) {
    throw new BaseCallError("transfer_refused", String(json?.message ?? code ?? "the facilitator refused the transfer"), { retryable: true, details: json ?? {} });
  }
  if (status === 502) {
    throw new BaseCallError("transfer_failed", String(json?.message ?? "settlement failed"), { details: json ?? {} });
  }
  if (status >= 500) throw new BaseCallError("api_error", `${status} from the transfer route`, { retryable: true, details: json ?? {} });
  throw new BaseCallError("api_error", `${status} from the transfer route: ${String(code ?? json?.message ?? "")}`.trim(), { details: json ?? {} });
}

/** One read of a transfer, in the run's view: `{ callId, status, txHash, error }`. */
export async function callStatus(transferId, { signerId = PAYOUT_SIGNER_ID, fetchImpl, env } = {}) {
  const { status, json } = await callApi(`/contracts/v1/signers/${encodeURIComponent(signerId)}/transfers/${encodeURIComponent(transferId)}`, { fetchImpl, env });
  if (status === 404) throw new BaseCallError("call_not_found", `transfer ${transferId} is unknown to the platform`);
  if (status !== 200 || !json) throw new BaseCallError("api_error", `${status} reading transfer ${transferId}`, { retryable: status >= 500 });
  return transferView(json, transferId);
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
