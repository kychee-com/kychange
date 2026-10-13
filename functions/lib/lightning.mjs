// The Lightning leg of a USDC-in swap: what a buyer may name as the
// destination (a Lightning address or a BOLT11 invoice), how an address
// resolves to an invoice for the exact sats (LNURL-pay, LUD-06/LUD-16), and
// what an invoice must satisfy before the desk pays it. Nothing here pays.

import { createHash } from "node:crypto";
import { decodeInvoice } from "./bolt11.mjs";

const LIGHTNING_ADDRESS = /^([a-z0-9][a-z0-9._%+-]{0,63})@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;
const BOLT11_SHAPE = /^ln(?:bc|tb|tbs|bcrt)[0-9]*[munp]?1[ac-hj-np-z02-9]{90,}$/i;
const LNURL_TIMEOUT_MS = 5_000;
const LNURL_MAX_BYTES = 65_536;
/** An invoice must have this much life left when the run reads it. */
const MIN_REMAINING_SECONDS = 120;

export class LnurlError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "LnurlError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** A Lightning address, a BOLT11 invoice (with or without a `lightning:` prefix), or null. */
export function classifyDestination(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 2048) return null;
  const invoice = value.replace(/^lightning:/i, "");
  if (BOLT11_SHAPE.test(invoice)) return { kind: "invoice", bolt11: invoice.toLowerCase() };
  const address = LIGHTNING_ADDRESS.exec(value);
  if (address) {
    const domain = address[2].toLowerCase();
    return { kind: "address", name: address[1], domain, address: `${address[1]}@${domain}` };
  }
  return null;
}

/**
 * Whether the desk may pay `bolt11` for a swap of `satsOut` sats: the invoice
 * decodes and verifies, is on this desk's network, names the exact sats or no
 * amount at all, and has time left. `amountMsat` is what the payment must
 * carry when the invoice names none.
 */
export function checkPayoutInvoice({ bolt11, satsOut, currency, nowSeconds = Math.floor(Date.now() / 1000) }) {
  let decoded;
  try {
    decoded = decodeInvoice(bolt11);
  } catch (error) {
    return { ok: false, reason: "invoice_invalid", detail: String(error?.message ?? error) };
  }
  if (decoded.currency !== currency) {
    return { ok: false, reason: "invoice_network_mismatch", detail: `the invoice is ln${decoded.currency}; this desk pays ln${currency}` };
  }
  const wantMsat = BigInt(satsOut) * 1000n;
  if (decoded.hasAmount && decoded.amountMsat !== wantMsat) {
    return { ok: false, reason: "invoice_amount_mismatch", detail: `the invoice asks ${decoded.amountMsat} msat; the swap pays ${wantMsat} msat` };
  }
  const expiresAt = decoded.timestamp + decoded.expirySeconds;
  if (expiresAt < nowSeconds + MIN_REMAINING_SECONDS) {
    return { ok: false, reason: "invoice_expired", detail: `the invoice expires at ${new Date(expiresAt * 1000).toISOString()}` };
  }
  return { ok: true, paymentHash: decoded.paymentHash, amountMsat: decoded.hasAmount ? null : Number(wantMsat), payee: decoded.payee, expiresAt };
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error", headers: { accept: "application/json" } });
  } catch (error) {
    throw new LnurlError("lnurl_unreachable", `${new URL(url).host}: ${String(error?.message ?? error)}`, true);
  }
  if (!response.ok) throw new LnurlError("lnurl_unreachable", `${new URL(url).host} answered ${response.status}`, response.status >= 500);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > LNURL_MAX_BYTES) throw new LnurlError("lnurl_invalid", "response too large");
  const chunks = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new LnurlError("lnurl_invalid", "empty response");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LNURL_MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new LnurlError("lnurl_invalid", "response too large"); }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LnurlError("lnurl_invalid", "response is not JSON");
  }
}

/**
 * Resolves a Lightning address into an invoice for exactly `amountMsat`:
 * HTTPS only, bounded time and size, the callback's invoice checked for the
 * amount, the network, and the LNURL metadata hash before it is returned.
 */
export async function resolveLnurlPay({ name, domain, amountMsat, currency, fetchImpl = fetch, timeoutMs = LNURL_TIMEOUT_MS }) {
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) throw new LnurlError("lnurl_invalid", "amount must be a positive integer of msat");
  const meta = await fetchJson(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`, fetchImpl, timeoutMs);
  if (meta?.status === "ERROR") throw new LnurlError("lnurl_error", String(meta.reason ?? "the address answered an error"));
  if (meta?.tag !== "payRequest" || typeof meta.callback !== "string" || typeof meta.metadata !== "string") {
    throw new LnurlError("lnurl_invalid", "the address is not an LNURL-pay endpoint");
  }
  let callback;
  try { callback = new URL(meta.callback); } catch { throw new LnurlError("lnurl_invalid", "callback is not a URL"); }
  if (callback.protocol !== "https:") throw new LnurlError("lnurl_invalid", "callback is not https");
  const min = Number(meta.minSendable ?? 1);
  const max = Number(meta.maxSendable ?? Number.MAX_SAFE_INTEGER);
  if (!(amountMsat >= min && amountMsat <= max)) {
    throw new LnurlError("lnurl_amount_out_of_range", `${amountMsat} msat is outside the address's ${min}..${max} msat`);
  }
  callback.searchParams.set("amount", String(amountMsat));
  const pay = await fetchJson(callback.toString(), fetchImpl, timeoutMs);
  if (pay?.status === "ERROR") throw new LnurlError("lnurl_error", String(pay.reason ?? "the callback answered an error"));
  if (typeof pay?.pr !== "string") throw new LnurlError("lnurl_invalid", "the callback returned no invoice");
  let decoded;
  try {
    decoded = decodeInvoice(pay.pr);
  } catch (error) {
    throw new LnurlError("lnurl_invoice_invalid", String(error?.message ?? error));
  }
  if (decoded.currency !== currency) throw new LnurlError("lnurl_invoice_network_mismatch", `the invoice is ln${decoded.currency}; this desk pays ln${currency}`);
  if (!decoded.hasAmount || decoded.amountMsat !== BigInt(amountMsat)) {
    throw new LnurlError("lnurl_invoice_amount_mismatch", `the invoice asks ${decoded.amountMsat} msat, not ${amountMsat}`);
  }
  const metadataHash = createHash("sha256").update(meta.metadata, "utf8").digest("hex");
  if (!decoded.descriptionHashes.includes(metadataHash)) {
    throw new LnurlError("lnurl_invoice_description_mismatch", "the invoice's description hash is not the LNURL metadata");
  }
  if (decoded.timestamp + decoded.expirySeconds < Math.floor(Date.now() / 1000) + MIN_REMAINING_SECONDS) {
    throw new LnurlError("lnurl_invoice_expired", "the callback returned an invoice about to expire", true);
  }
  return { bolt11: pay.pr, paymentHash: decoded.paymentHash, metadataHash, callback: meta.callback, payee: decoded.payee };
}
