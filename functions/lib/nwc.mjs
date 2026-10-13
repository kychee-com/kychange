// A minimal NIP-47 (Nostr Wallet Connect) client for the desk's payout
// pairing: one relay WebSocket per pairing, NIP-44 v2 only, requests matched
// to replies by event id. Ported from @run402/sdk's node/nwc.ts (MIT) so a
// function bundle carries only this and the noble primitives, not the SDK's
// EVM stack. The pairing URI carries the client's secret key: this module
// never logs or returns it.

import { createCipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;
const DEFAULT_TIMEOUT_MS = 30_000;
const RELAY_HANDSHAKE_TIMEOUT_MS = 10_000;
const RELAY_IDLE_CLOSE_MS = 1_500;

export class NwcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NwcError";
    this.code = code;
  }
}

export function parseNwcUri(uri) {
  let url;
  try {
    url = new URL(String(uri).replace(/^nostr\+walletconnect:\/\//i, "nostr+walletconnect://"));
  } catch {
    throw new NwcError("BAD_URI", "pairing URI is not a URL");
  }
  if (!/^nostr\+walletconnect:$/i.test(url.protocol)) throw new NwcError("BAD_URI", "pairing URI must use nostr+walletconnect://");
  const walletPubkey = (url.host || url.pathname.replace(/^\/+/, "")).toLowerCase();
  const relayUrl = url.searchParams.get("relay") ?? "";
  const secretHex = (url.searchParams.get("secret") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(walletPubkey)) throw new NwcError("BAD_URI", "pairing URI lacks the wallet pubkey");
  if (!/^wss?:\/\//.test(relayUrl)) throw new NwcError("BAD_URI", "pairing URI lacks a relay");
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new NwcError("BAD_URI", "pairing URI lacks the connection secret");
  const clientPubkey = Buffer.from(schnorr.getPublicKey(Buffer.from(secretHex, "hex"))).toString("hex");
  return { walletPubkey, relayUrl, secretHex, clientPubkey };
}

// --- NIP-44 v2 ------------------------------------------------------------

function calcPaddedLen(unpaddedLen) {
  if (unpaddedLen <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(unpaddedLen - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

export function nip44ConversationKey(secretHex, peerPubkeyHex) {
  const shared = secp256k1.getSharedSecret(Buffer.from(secretHex, "hex"), Buffer.from("02" + peerPubkeyHex, "hex"), true);
  return extract(sha256, shared.subarray(1, 33), new TextEncoder().encode("nip44-v2"));
}

function messageKeys(conversation, nonce) {
  const keys = expand(sha256, conversation, nonce, 76);
  return { chacha: keys.subarray(0, 32), chachaNonce: keys.subarray(32, 44), hmacKey: keys.subarray(44, 76) };
}

function chacha20(key, nonce12, data) {
  const cipher = createCipheriv("chacha20", Buffer.from(key), Buffer.concat([Buffer.alloc(4), Buffer.from(nonce12)]));
  return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
}

export function nip44Encrypt(conversation, plaintext, nonce = randomBytes(32)) {
  const bytes = new TextEncoder().encode(plaintext);
  if (bytes.length < 1 || bytes.length > 65_535) throw new NwcError("BAD_PAYLOAD", "plaintext length out of range");
  const padded = new Uint8Array(2 + calcPaddedLen(bytes.length));
  padded[0] = bytes.length >> 8;
  padded[1] = bytes.length & 0xff;
  padded.set(bytes, 2);
  const keys = messageKeys(conversation, nonce);
  const ciphertext = chacha20(keys.chacha, keys.chachaNonce, padded);
  const mac = hmac(sha256, keys.hmacKey, Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]));
  return Buffer.concat([Buffer.from([2]), Buffer.from(nonce), Buffer.from(ciphertext), Buffer.from(mac)]).toString("base64");
}

export function nip44Decrypt(conversation, payload) {
  if (payload.startsWith("#")) throw new NwcError("UNSUPPORTED_ENCRYPTION", "unknown NIP-44 version");
  const data = Buffer.from(payload, "base64");
  if (data.length < 99 || data[0] !== 2) throw new NwcError("BAD_PAYLOAD", "NIP-44 payload is malformed");
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const keys = messageKeys(conversation, nonce);
  const expected = Buffer.from(hmac(sha256, keys.hmacKey, Buffer.concat([nonce, ciphertext])));
  if (!timingSafeEqual(expected, mac)) throw new NwcError("BAD_PAYLOAD", "NIP-44 MAC mismatch");
  const padded = chacha20(keys.chacha, keys.chachaNonce, ciphertext);
  const length = (padded[0] << 8) | padded[1];
  return new TextDecoder().decode(padded.subarray(2, 2 + length));
}

export function signNwcEvent(secretHex, kind, tags, content) {
  const pubkey = Buffer.from(schnorr.getPublicKey(Buffer.from(secretHex, "hex"))).toString("hex");
  const created_at = Math.floor(Date.now() / 1000);
  const id = createHash("sha256").update(JSON.stringify([0, pubkey, created_at, kind, tags, content])).digest("hex");
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), Buffer.from(secretHex, "hex"))).toString("hex");
  return { id, pubkey, created_at, kind, tags, content, sig };
}

function verifyEvent(event) {
  try {
    const id = createHash("sha256").update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])).digest("hex");
    if (id !== event.id) return false;
    return schnorr.verify(Buffer.from(event.sig, "hex"), Buffer.from(id, "hex"), Buffer.from(event.pubkey, "hex"));
  } catch {
    return false;
  }
}

// --- Relay ------------------------------------------------------------------

class Relay {
  constructor(url, clientPubkey) {
    this.url = url;
    this.clientPubkey = clientPubkey;
    this.socket = null;
    this.opening = null;
    this.pending = new Map();
    this.idle = null;
    this.subId = randomBytes(8).toString("hex");
  }

  async send(request, timeoutMs) {
    const socket = await this.connected(timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        this.armIdle();
        reject(new NwcError("TIMEOUT", "no wallet response within the timeout"));
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      if (this.idle) { clearTimeout(this.idle); this.idle = null; }
      try {
        socket.send(JSON.stringify(["EVENT", request]));
      } catch (error) {
        this.settle(request.id, new NwcError("RELAY_CLOSED", error instanceof Error ? error.message : "send failed"));
      }
    });
  }

  close() {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const socket = this.socket;
    this.socket = null;
    this.opening = null;
    if (socket) { try { socket.close(); } catch { /* closed */ } }
    for (const id of [...this.pending.keys()]) this.settle(id, new NwcError("RELAY_CLOSED", "relay connection closed"));
  }

  armIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), RELAY_IDLE_CLOSE_MS);
    this.idle.unref?.();
  }

  settle(id, error, event) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error); else entry.resolve(event);
    if (this.pending.size === 0) this.armIdle();
  }

  connected(timeoutMs) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        this.opening = null;
        reject(new NwcError("RELAY_UNREACHABLE", error instanceof Error ? error.message : "cannot open relay"));
        return;
      }
      let opened = false;
      const handshake = setTimeout(() => {
        if (!opened) { this.opening = null; try { socket.close(); } catch { /* */ } reject(new NwcError("RELAY_UNREACHABLE", "relay handshake timed out")); }
      }, Math.min(timeoutMs, RELAY_HANDSHAKE_TIMEOUT_MS));
      socket.addEventListener("open", () => {
        opened = true;
        clearTimeout(handshake);
        this.socket = socket;
        this.opening = null;
        socket.send(JSON.stringify(["REQ", this.subId, { kinds: [NWC_RESPONSE_KIND], "#p": [this.clientPubkey], since: Math.floor(Date.now() / 1000) - 60 }]));
        resolve(socket);
      });
      socket.addEventListener("message", (message) => this.onMessage(String(message.data)));
      socket.addEventListener("error", () => {
        if (!opened) { clearTimeout(handshake); this.opening = null; reject(new NwcError("RELAY_UNREACHABLE", "relay connection failed")); }
      });
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        if (!opened) { clearTimeout(handshake); this.opening = null; reject(new NwcError("RELAY_UNREACHABLE", "relay closed during handshake")); }
        for (const id of [...this.pending.keys()]) this.settle(id, new NwcError("RELAY_CLOSED", "relay closed the connection"));
      });
    });
    return this.opening;
  }

  onMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(message)) return;
    if (message[0] === "EVENT" && message[1] === this.subId && message[2] && typeof message[2] === "object") {
      const event = message[2];
      if (event.kind !== NWC_RESPONSE_KIND || !Array.isArray(event.tags)) return;
      const ref = event.tags.find((tag) => tag[0] === "e" && typeof tag[1] === "string");
      if (ref?.[1]) this.settle(ref[1], null, event);
      return;
    }
    if (message[0] === "OK" && typeof message[1] === "string" && message[2] === false) {
      this.settle(message[1], new NwcError("RELAY_REJECTED", typeof message[3] === "string" ? message[3] : "relay rejected the request"));
    }
  }
}

const relays = new Map();

function relayFor(connection) {
  const key = `${connection.relayUrl}|${connection.clientPubkey}`;
  let relay = relays.get(key);
  if (!relay) { relay = new Relay(connection.relayUrl, connection.clientPubkey); relays.set(key, relay); }
  return relay;
}

export function closeNwcConnections() {
  for (const relay of relays.values()) relay.close();
  relays.clear();
}

/**
 * One NIP-47 call. Throws `NwcError` with the wallet's error code
 * (`INSUFFICIENT_BALANCE`, `QUOTA_EXCEEDED`, `NOT_FOUND`, `UNAUTHORIZED`, …)
 * or a transport code (`TIMEOUT`, `RELAY_UNREACHABLE`, `RELAY_REJECTED`, `RELAY_CLOSED`, `BAD_RESPONSE`).
 */
export async function nwcRequest(connection, method, params, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = options.transport ?? ((c, request, t) => relayFor(c).send(request, t));
  const key = nip44ConversationKey(connection.secretHex, connection.walletPubkey);
  const content = nip44Encrypt(key, JSON.stringify({ method, params }));
  const request = signNwcEvent(connection.secretHex, NWC_REQUEST_KIND, [["p", connection.walletPubkey], ["encryption", "nip44_v2"]], content);
  const response = await transport(connection, request, timeoutMs);
  if (response.pubkey !== connection.walletPubkey || !verifyEvent(response)) {
    throw new NwcError("BAD_RESPONSE", "response is not signed by the wallet service");
  }
  let body;
  try {
    body = JSON.parse(nip44Decrypt(key, response.content));
  } catch (error) {
    throw error instanceof NwcError ? error : new NwcError("BAD_RESPONSE", "response payload is not JSON");
  }
  if (body.error && typeof body.error === "object") {
    throw new NwcError(typeof body.error.code === "string" ? body.error.code : "OTHER", typeof body.error.message === "string" ? body.error.message : "wallet error");
  }
  if (body.result_type !== undefined && body.result_type !== method) throw new NwcError("BAD_RESPONSE", `unexpected result_type ${String(body.result_type)}`);
  if (body.result === undefined || body.result === null) throw new NwcError("BAD_RESPONSE", "response carries no result");
  return body.result;
}

/** The wallet verbs the payout run needs. Amounts are in sats unless named msat. */
export class NwcWallet {
  constructor(pairingUri, options = {}) {
    this.connection = parseNwcUri(pairingUri);
    this.options = options;
  }

  call(method, params) {
    return nwcRequest(this.connection, method, params, this.options);
  }

  async getInfo() {
    const result = await this.call("get_info", {});
    return {
      network: typeof result.network === "string" ? result.network.toLowerCase() : null,
      pubkey: typeof result.pubkey === "string" ? result.pubkey.toLowerCase() : null,
      methods: Array.isArray(result.methods) ? result.methods.map(String) : [],
    };
  }

  async getBalanceSats() {
    const result = await this.call("get_balance", {});
    return Math.floor(Number(result.balance ?? 0) / 1_000);
  }

  /** Remaining budget in sats, or null when the wallet has no budget. */
  async getBudgetSats() {
    let result;
    try {
      result = await this.call("get_budget", {});
    } catch (error) {
      if (error instanceof NwcError && (error.code === "NOT_IMPLEMENTED" || error.code === "RESTRICTED")) return null;
      throw error;
    }
    const total = result.total_budget;
    if (total === undefined || total === null) return null;
    return {
      usedSats: Math.floor(Number(result.used_budget ?? 0) / 1_000),
      totalSats: Math.floor(Number(total) / 1_000),
      renewsAtSeconds: typeof result.renews_at === "number" ? result.renews_at : null,
    };
  }

  /** Pays a BOLT11 invoice; `amountMsat` is required for a zero-amount invoice. Returns the preimage (hex). */
  async payInvoice(bolt11, amountMsat = null) {
    const params = { invoice: bolt11 };
    if (amountMsat !== null) params.amount = amountMsat;
    const result = await this.call("pay_invoice", params);
    const preimage = typeof result.preimage === "string" ? result.preimage.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(preimage)) throw new NwcError("BAD_RESPONSE", "pay_invoice returned no preimage");
    return { preimage, feesPaidMsat: typeof result.fees_paid === "number" ? result.fees_paid : null };
  }

  /** Looks a payment up by hash; a settled outgoing payment carries its preimage. Null when the wallet never saw it. */
  async lookupInvoice(paymentHash) {
    try {
      const result = await this.call("lookup_invoice", { payment_hash: paymentHash });
      const preimage = typeof result.preimage === "string" && /^[0-9a-f]{64}$/i.test(result.preimage) ? result.preimage.toLowerCase() : null;
      return { state: typeof result.state === "string" ? result.state.toLowerCase() : null, preimage };
    } catch (error) {
      if (error instanceof NwcError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }
}
