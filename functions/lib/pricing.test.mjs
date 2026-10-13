import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { capVerdict, formatUsd, msatToSats, rateAfterSpread, satsOut, usdOutMicros } from "./pricing.mjs";

describe("pricing", () => {
  it("pays out the index minus the spread, floored to a micro", () => {
    // 10k sats at $100,000/BTC is $10; 50 bps off is $9.95.
    assert.equal(usdOutMicros({ sats: 10_000, btcUsd: 100_000, spreadBps: 50 }), 9_950_000);
    assert.equal(usdOutMicros({ sats: 1, btcUsd: 100_000, spreadBps: 0 }), 1_000);
    assert.throws(() => usdOutMicros({ sats: 0, btcUsd: 100_000, spreadBps: 50 }), RangeError);
    assert.throws(() => usdOutMicros({ sats: 10, btcUsd: 100_000, spreadBps: 10_000 }), RangeError);
  });

  it("pays out sats at the ask, floored to a whole sat", () => {
    assert.equal(satsOut({ usdMicros: 5_000_000, btcUsd: 80_000, spreadBps: 50 }), 6_218);
    assert.equal(satsOut({ usdMicros: 100_000, btcUsd: 100_000, spreadBps: 0 }), 100);
    assert.throws(() => satsOut({ usdMicros: 0, btcUsd: 80_000, spreadBps: 50 }), RangeError);
    assert.throws(() => satsOut({ usdMicros: 1_000_000, btcUsd: 0, spreadBps: 50 }), RangeError);
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

describe("capVerdict", () => {
  it("closes a denomination above the per-swap cap, then above the daily remainder, in that order", () => {
    assert.deepEqual(capVerdict({ usdOutMicros: 83_000_000, maxFillUsd: 25, dailyRemainingMicros: 100_000_000 }), {
      available: false, reason: "above_max_fill", reason_text: "closed: above the $25 cap for one swap",
    });
    const daily = capVerdict({ usdOutMicros: 8_000_000, maxFillUsd: 25, dailyRemainingMicros: 5_000_000 });
    assert.equal(daily.reason, "daily_cap");
    assert.match(daily.reason_text, /\$5\.00 left today/);
    assert.deepEqual(capVerdict({ usdOutMicros: 8_000_000, maxFillUsd: 25, dailyRemainingMicros: 100_000_000 }), { available: true, reason: null, reason_text: null });
  });
});
