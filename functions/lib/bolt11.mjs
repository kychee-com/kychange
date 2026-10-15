// A strict BOLT11 decoder with signature verification, ported from
// @run402/sdk's vendored x402 lnbtc decoder (MIT). One deliberate difference:
// an invoice without an amount decodes with `amountMsat: 0n` and
// `hasAmount: false`, because a swap buyer may hand the desk a zero-amount
// invoice and let the payout name the sats.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";

const SIGNATURE_WORDS = 104;
const TIMESTAMP_WORDS = 7;
const DEFAULT_EXPIRY_SECONDS = 3600;
const MSAT_PER_BTC = 100_000_000_000n;
const MULTIPLIERS = { m: 1_000n, u: 1_000_000n, n: 1_000_000_000n, p: 1_000_000_000_000n };
const TAG = { p: 1, s: 16, d: 13, h: 23, x: 6, n: 19, c: 24, features: 5 };
const FIXED_LENGTHS = new Map([[TAG.p, 52], [TAG.s, 52], [TAG.h, 52], [TAG.n, 53]]);
const SINGLETON_TAGS = new Set([TAG.p, TAG.s, TAG.n, TAG.x, TAG.c, TAG.features]);
const MINIMAL_TAGS = new Set([TAG.x, TAG.c, TAG.features]);

/** Decodes a BOLT11 invoice and verifies its signature; throws on anything malformed. */
export function decodeInvoice(invoice) {
  if (typeof invoice !== "string" || invoice.length === 0) throw new Error("empty invoice");
  const { prefix, words } = bech32.decode(invoice, false);
  const { currency, amountMsat, hasAmount } = parseHrp(prefix);
  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) throw new Error("invoice too short");
  const signed = words.slice(0, words.length - SIGNATURE_WORDS);
  const sigBytes = bech32.fromWords(words.slice(words.length - SIGNATURE_WORDS));
  const timestamp = wordsToNumber(signed.slice(0, TIMESTAMP_WORDS));
  const fields = parseTaggedFields(signed.slice(TIMESTAMP_WORDS));
  if (fields.paymentHash === undefined) throw new Error("invoice has no payment hash");
  if (!fields.hasPaymentSecret) throw new Error("invoice has no payment secret");
  const prefixBytes = new TextEncoder().encode(prefix);
  const dataBytes = wordsToPaddedBytes(signed);
  const message = new Uint8Array(prefixBytes.length + dataBytes.length);
  message.set(prefixBytes);
  message.set(dataBytes, prefixBytes.length);
  return {
    currency,
    amountMsat,
    hasAmount,
    timestamp,
    expirySeconds: fields.expiry ?? DEFAULT_EXPIRY_SECONDS,
    paymentHash: fields.paymentHash,
    descriptionHashes: fields.descriptionHashes,
    inlineDescriptionCount: fields.inlineDescriptions,
    payee: verifySignature(sigBytes, sha256(message), fields.payee),
    hasPayeeField: fields.payee !== undefined,
  };
}

function parseHrp(prefix) {
  const match = /^ln([a-z]+?)([0-9]+)?([munp])?$/.exec(prefix);
  if (!match) throw new Error("invalid invoice prefix");
  const [, currency, digits, multiplier] = match;
  if (!digits) return { currency, amountMsat: 0n, hasAmount: false };
  if (digits.length > 1 && digits.startsWith("0")) throw new Error("amount has leading zeros");
  const value = BigInt(digits);
  if (value === 0n) throw new Error("invoice amount is zero");
  const scaled = value * MSAT_PER_BTC;
  if (!multiplier) return { currency, amountMsat: scaled, hasAmount: true };
  const divisor = MULTIPLIERS[multiplier];
  if (scaled % divisor !== 0n) throw new Error("amount is not an integral millisatoshi");
  return { currency, amountMsat: scaled / divisor, hasAmount: true };
}

function parseTaggedFields(words) {
  const out = { hasPaymentSecret: false, descriptionHashes: [], inlineDescriptions: 0 };
  const seen = new Set();
  let i = 0;
  while (i < words.length) {
    if (i + 3 > words.length) throw new Error("truncated tagged field");
    const tag = words[i];
    const length = words[i + 1] * 32 + words[i + 2];
    const data = words.slice(i + 3, i + 3 + length);
    if (data.length !== length) throw new Error("truncated tagged field");
    i += 3 + length;
    const fixedLength = FIXED_LENGTHS.get(tag);
    if (fixedLength !== undefined && length !== fixedLength) throw new Error("tagged field has the wrong length");
    if (SINGLETON_TAGS.has(tag)) {
      if (seen.has(tag)) throw new Error("duplicate tagged field");
      seen.add(tag);
    }
    if (MINIMAL_TAGS.has(tag) && data[0] === 0) throw new Error("non-minimal integer field");
    switch (tag) {
      case TAG.p: out.paymentHash = bytesToHex(bech32.fromWords(data)); break;
      case TAG.s: bech32.fromWords(data); out.hasPaymentSecret = true; break;
      case TAG.h: out.descriptionHashes.push(bytesToHex(bech32.fromWords(data))); break;
      case TAG.d: out.inlineDescriptions += 1; break;
      case TAG.n: out.payee = bytesToHex(bech32.fromWords(data)); break;
      case TAG.x: out.expiry = wordsToNumber(data); break;
      default: break;
    }
  }
  return out;
}

function verifySignature(sigBytes, digest, payeeField) {
  const recovery = sigBytes[64];
  if (recovery > 3) throw new Error("invalid recovery id");
  const compact = sigBytes.subarray(0, 64);
  if (payeeField !== undefined) {
    const valid = secp256k1.verify(compact, digest, hexToBytes(payeeField), { lowS: true, format: "compact", prehash: false });
    if (!valid) throw new Error("invalid invoice signature");
    return payeeField;
  }
  const signature = secp256k1.Signature.fromBytes(compact, "compact").addRecoveryBit(recovery);
  return signature.recoverPublicKey(digest).toHex(true);
}

function wordsToNumber(words) {
  let value = 0;
  for (const word of words) {
    value = value * 32 + word;
    if (!Number.isSafeInteger(value)) throw new Error("integer field too large");
  }
  return value;
}

// BOLT11 signs the 5-bit data words regrouped into bytes, with the final
// partial byte zero-padded (bech32.fromWords is strict and refuses that).
function wordsToPaddedBytes(words) {
  const out = new Uint8Array(Math.ceil((words.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let index = 0;
  for (const word of words) {
    acc = ((acc << 5) | word) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0) out[index] = (acc << (8 - bits)) & 0xff;
  return out;
}
