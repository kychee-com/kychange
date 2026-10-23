// The desk's payout wallet over Nostr Wallet Connect (NIP-47). The protocol
// (pairing URIs, NIP-44 v2, signed events, the relay connection) is
// @run402/nwc, which carries only the noble primitives, so the function bundle
// stays small; this module adds the wallet verbs the payout run needs. The
// pairing URI carries the client's secret key: nothing here logs or returns it.

import { NwcError, nwcRequest, parseNwcUri } from "@run402/nwc";

export { NwcError, closeNwcConnections } from "@run402/nwc";

const DEFAULT_TIMEOUT_MS = 30_000;

/** The wallet verbs the payout run needs. Amounts are in sats unless named msat. */
export class NwcWallet {
  constructor(pairingUri, options = {}) {
    this.connection = parseNwcUri(pairingUri);
    this.options = options;
  }

  call(method, params) {
    return nwcRequest(this.connection, method, params, { timeoutMs: DEFAULT_TIMEOUT_MS, ...this.options });
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
