import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decodeInvoice } from "./bolt11.mjs";
import { LnurlError, checkPayoutInvoice, classifyDestination, resolveLnurlPay } from "./lightning.mjs";

// Real testnet3 invoices from the desk's harness (alice's LND). The 1,000-sat
// one carries the description hash of the LNURL metadata below; the other
// names no amount.
const INVOICE_1000 = "lntb10u1p4vagnvpp53xd5m0mdmvpxgq6flqr4v8vluhjvu7825q85hjfvdwg4fw77383qhp5e55rqf5vnlfmrss56gxhd8xv6g52uzxqhd5z9qfgtthglk4vz88scqzzsxqyz5vqsp5nwc564vkal6u5caqhp5ftsg44m90gfvjz55h3t5khsqsgaagse8q9qxpqysgq3v5vmnfz5cxg6yrfl0p6tedjzkuwdknpkqrhdswjd8dygd9lcy85zm5zggfhhtjzy5ky74euvd47u2pnnzq30dvxfl9xv5ucngt4h2cpsgjmhv";
const INVOICE_1000_HASH = "899b4dbf6ddb02640349f807561d9fe5e4ce78eaa00f4bc92c6b9154bbde89e2";
const INVOICE_ANY = "lntb1p4vagnvpp5r6ya4j9l6hn9ucskv0v3d94ax8sym3z88chuv5dpgm4rpglc575qdqlddukx6rpdenk2grpdeujqctdda6kuaqcqzzsxqyz5vqsp54gryemx69fzgyrhewj0xq3uurga07acxqapj4g46mn8ep7nunshs9qxpqysgqrrw0s74efl8wl35ltvdehnjtz3dneljk989pl6gxwk0xrf7zsw55g7h0srp3lhgyugh2x8hgnkp8yussy2mj6f0qgrwml3w2s06dcpqqu7rcp8";
const INVOICE_ANY_HASH = "1e89dac8bfd5e65e621663d91696bd31e04dc4473e2fc651a146ea30a3f8a7a8";
const LNURL_METADATA = JSON.stringify([["text/plain", "kychange lnurl test"]]);

describe("bolt11", () => {
  it("decodes and verifies a testnet invoice", () => {
    const decoded = decodeInvoice(INVOICE_1000);
    assert.equal(decoded.currency, "tb");
    assert.equal(decoded.hasAmount, true);
    assert.equal(decoded.amountMsat, 1_000_000n);
    assert.equal(decoded.paymentHash, INVOICE_1000_HASH);
    assert.equal(decoded.inlineDescriptionCount, 0);
    assert.deepEqual(decoded.descriptionHashes, ["cd2830268c9fd3b1c214d20d769cccd228ae08c0bb682281285aee8fdaac11cf"]);
    assert.match(decoded.payee, /^0[23][0-9a-f]{64}$/);
  });

  it("decodes an invoice that names no amount", () => {
    const decoded = decodeInvoice(INVOICE_ANY);
    assert.equal(decoded.hasAmount, false);
    assert.equal(decoded.amountMsat, 0n);
    assert.equal(decoded.paymentHash, INVOICE_ANY_HASH);
  });

  it("refuses a tampered invoice", () => {
    const tampered = INVOICE_1000.slice(0, -6) + "qqqqqq";
    assert.throws(() => decodeInvoice(tampered));
  });
});

describe("classifyDestination", () => {
  it("tells a Lightning address from an invoice and refuses the rest", () => {
    assert.deepEqual(classifyDestination(" Alice@Example.COM "), { kind: "address", name: "Alice", domain: "example.com", address: "Alice@example.com" });
    assert.deepEqual(classifyDestination(`lightning:${INVOICE_1000.toUpperCase()}`), { kind: "invoice", bolt11: INVOICE_1000 });
    assert.equal(classifyDestination("0x58A784f2baBd646Ba8f5C3c1CD43493cea9FEAb4"), null);
    assert.equal(classifyDestination("alice@localhost"), null);
    assert.equal(classifyDestination(""), null);
    assert.equal(classifyDestination(42), null);
  });
});

describe("checkPayoutInvoice", () => {
  const now = decodeInvoice(INVOICE_1000).timestamp + 60;

  it("accepts an invoice for exactly the quoted sats on the desk's network", () => {
    const check = checkPayoutInvoice({ bolt11: INVOICE_1000, satsOut: 1_000, currency: "tb", nowSeconds: now });
    assert.deepEqual({ ok: check.ok, paymentHash: check.paymentHash, amountMsat: check.amountMsat }, { ok: true, paymentHash: INVOICE_1000_HASH, amountMsat: null });
  });

  it("accepts an invoice with no amount and names the msat the payment must carry", () => {
    const check = checkPayoutInvoice({ bolt11: INVOICE_ANY, satsOut: 1_000, currency: "tb", nowSeconds: now });
    assert.deepEqual({ ok: check.ok, paymentHash: check.paymentHash, amountMsat: check.amountMsat }, { ok: true, paymentHash: INVOICE_ANY_HASH, amountMsat: 1_000_000 });
  });

  it("refuses the wrong amount, the wrong network, an expired invoice, and garbage, each by name", () => {
    assert.equal(checkPayoutInvoice({ bolt11: INVOICE_1000, satsOut: 999, currency: "tb", nowSeconds: now }).reason, "invoice_amount_mismatch");
    assert.equal(checkPayoutInvoice({ bolt11: INVOICE_1000, satsOut: 1_000, currency: "bc", nowSeconds: now }).reason, "invoice_network_mismatch");
    assert.equal(checkPayoutInvoice({ bolt11: INVOICE_1000, satsOut: 1_000, currency: "tb", nowSeconds: now + 100 * 86_400 }).reason, "invoice_expired");
    assert.equal(checkPayoutInvoice({ bolt11: "lntb1notaninvoice", satsOut: 1_000, currency: "tb", nowSeconds: now }).reason, "invoice_invalid");
  });
});

describe("resolveLnurlPay", () => {
  const metadata = LNURL_METADATA;
  const fetchFor = (routes) => async (url) => {
    const handler = routes[new URL(url).pathname];
    if (!handler) return new Response("not here", { status: 404 });
    const body = handler(new URL(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  it("resolves an address into an invoice for the exact sats whose description hash is the metadata", async () => {
    const fetchImpl = fetchFor({
      "/.well-known/lnurlp/alice": () => ({ tag: "payRequest", callback: "https://wallet.example/lnurlp/alice/cb", minSendable: 1000, maxSendable: 100_000_000, metadata }),
      "/lnurlp/alice/cb": (url) => (url.searchParams.get("amount") === "1000000" ? { pr: INVOICE_1000, routes: [] } : { status: "ERROR", reason: "bad amount" }),
    });
    const resolved = await resolveLnurlPay({ name: "alice", domain: "wallet.example", amountMsat: 1_000_000, currency: "tb", fetchImpl });
    assert.equal(resolved.bolt11, INVOICE_1000);
    assert.equal(resolved.paymentHash, INVOICE_1000_HASH);
    assert.equal(resolved.metadataHash, "cd2830268c9fd3b1c214d20d769cccd228ae08c0bb682281285aee8fdaac11cf");
  });

  it("refuses a callback invoice whose description hash is not the LNURL metadata, or whose amount differs", async () => {
    const other = JSON.stringify([["text/plain", "someone else's metadata"]]);
    const fetchImpl = fetchFor({
      "/.well-known/lnurlp/alice": () => ({ tag: "payRequest", callback: "https://wallet.example/lnurlp/alice/cb", minSendable: 1000, maxSendable: 100_000_000, metadata: other }),
      "/lnurlp/alice/cb": () => ({ pr: INVOICE_1000, routes: [] }),
    });
    await assert.rejects(
      resolveLnurlPay({ name: "alice", domain: "wallet.example", amountMsat: 1_000_000, currency: "tb", fetchImpl }),
      (error) => error instanceof LnurlError && error.code === "lnurl_invoice_description_mismatch",
    );
    await assert.rejects(
      resolveLnurlPay({ name: "alice", domain: "wallet.example", amountMsat: 2_000_000, currency: "tb", fetchImpl }),
      (error) => error instanceof LnurlError && error.code === "lnurl_invoice_amount_mismatch",
    );
  });

  it("refuses an amount outside the address's range, a non-payRequest, and an http callback, without calling the callback", async () => {
    let callbackCalls = 0;
    const fetchImpl = fetchFor({
      "/.well-known/lnurlp/small": () => ({ tag: "payRequest", callback: "https://wallet.example/cb", minSendable: 1000, maxSendable: 5000, metadata }),
      "/.well-known/lnurlp/plain": () => ({ tag: "withdrawRequest" }),
      "/.well-known/lnurlp/http": () => ({ tag: "payRequest", callback: "http://wallet.example/cb", minSendable: 1, maxSendable: 1e9, metadata }),
      "/cb": () => { callbackCalls += 1; return { pr: INVOICE_1000 }; },
    });
    for (const [name, code] of [["small", "lnurl_amount_out_of_range"], ["plain", "lnurl_invalid"], ["http", "lnurl_invalid"], ["nobody", "lnurl_unreachable"]]) {
      await assert.rejects(
        resolveLnurlPay({ name, domain: "wallet.example", amountMsat: 1_000_000, currency: "tb", fetchImpl }),
        (error) => error instanceof LnurlError && error.code === code,
        name,
      );
    }
    assert.equal(callbackCalls, 0);
  });
});
