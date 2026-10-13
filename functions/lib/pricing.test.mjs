import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatUsd, msatToSats, rateAfterSpread, usdOutMicros } from "./pricing.mjs";

describe("pricing", () => {
  it("pays out the index minus the spread, floored to a micro", () => {
    // 10k sats at $100,000/BTC is $10; 50 bps off is $9.95.
    assert.equal(usdOutMicros({ sats: 10_000, btcUsd: 100_000, spreadBps: 50 }), 9_950_000);
    assert.equal(usdOutMicros({ sats: 1, btcUsd: 100_000, spreadBps: 0 }), 1_000);
    assert.throws(() => usdOutMicros({ sats: 0, btcUsd: 100_000, spreadBps: 50 }), RangeError);
    assert.throws(() => usdOutMicros({ sats: 10, btcUsd: 100_000, spreadBps: 10_000 }), RangeError);
  });

  it("quotes the bid below and the ask above the index", () => {
    assert.equal(rateAfterSpread({ btcUsd: 100_000, spreadBps: 50, side: "buy_btc" }), 99_500);
    assert.equal(rateAfterSpread({ btcUsd: 100_000, spreadBps: 50, side: "sell_btc" }), 100_500);
  });

  it("formats micros and converts msat", () => {
    assert.equal(formatUsd(9_950_000), "$9.95");
    assert.equal(formatUsd(1_000), "$0.00");
    assert.equal(msatToSats(10_000_000), 10_000);
    assert.throws(() => msatToSats(10_500), RangeError);
  });
});
