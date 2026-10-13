#!/usr/bin/env node
// Pay a kychange sats-in route with your own Lightning wallet (a Nostr Wallet
// Connect pairing that can pay_invoice), then print the swap and its status URL.
//
//   node tools/pay.mjs <denomination> <0xDestination> --pairing <file> [--base https://kychange.com] [--quote]
//
// The pairing file holds one nostr+walletconnect:// URI and is never printed.
// Needs @run402/sdk 4.117.1 or later (the Lightning payer is exported from @run402/sdk/node).

import fs from "node:fs";
import { NwcWallet, closeNwcConnections, payX402Lightning, readX402LightningOffer } from "@run402/sdk/node";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const [denomination, destination] = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
const pairingFile = flag("--pairing");
const base = (flag("--base") ?? "https://kychange.com").replace(/\/$/, "");
const useQuote = args.includes("--quote");
if (!denomination || !destination || !pairingFile) {
  console.error("usage: node tools/pay.mjs <denomination> <0xDestination> --pairing <file> [--base <url>] [--quote]");
  process.exit(2);
}

const quote = await (await fetch(`${base}/api/quote`)).json();
const satsIn = quote.directions?.sats_in;
const offer = satsIn?.denominations?.find((d) => d.id === denomination);
if (!satsIn?.open || !offer?.available) {
  console.error("desk closed or denomination unavailable:", JSON.stringify({ open: satsIn?.open ?? false, reason: satsIn?.reason ?? quote.reason, denomination: offer ?? null }));
  process.exit(1);
}
console.log(`quote: ${offer.sats_in} sats -> ${offer.usd_out} USDC at bid ${quote.rate.btc_usd_bid}/BTC (${quote.network_mode})`);

const url = `${base}${offer.route}`;
const body = JSON.stringify(useQuote ? { destination, quote_id: quote.quote_id } : { destination });
const init = { method: "POST", headers: { "content-type": "application/json" }, body };
const challenge = await fetch(url, init);
const lightning = readX402LightningOffer(challenge);
if (!lightning) { console.error("no Lightning offer:", challenge.status, (await challenge.text()).slice(0, 300)); process.exit(1); }

const wallet = new NwcWallet(fs.readFileSync(pairingFile, "utf8").trim(), { timeoutMs: 45_000 });
let paymentHash = null;
try {
  const paid = await payX402Lightning({
    input: url, init, offer: lightning, wallet, baseFetch: fetch,
    fail: (code, message, details) => Object.assign(new Error(`${code}: ${message}`), { code, details }),
    checkCaps: async (sats) => { if (sats > offer.sats_in) throw new Error(`invoice asks ${sats} sats, more than the quoted ${offer.sats_in}`); console.log(`paying ${sats} sats…`); },
    onPaid: (hash) => { paymentHash = hash; },
  });
  const swap = await paid.json();
  console.log(JSON.stringify({ status: paid.status, payment_hash: paymentHash, ...swap }, null, 2));
  if (swap.status_url) console.log(`watch: ${base}/status?swap=${encodeURIComponent(swap.swap_id)}&claim=${encodeURIComponent(swap.claim_token)}`);
} finally {
  closeNwcConnections();
}
