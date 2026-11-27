import { describe, expect, it } from "vitest"

import { checkPaidAmountAgainstSnapshot, currencyMinorUnitExponent, toMinorUnits } from "../../src/services/orderState.service.js"

// CS-13 review (B09-008 follow-up): amounts are compared in the currency's
// own minor units, parsed from strings rather than via Number * 100.
describe("checkPaidAmountAgainstSnapshot minor units", () => {
  it("uses 3 decimals for KWD: 10.000 paid against 10.004 expected is underpaid", () => {
    expect(checkPaidAmountAgainstSnapshot({ wooTotal: "10.004", wooCurrency: "KWD" }, { total: "10.000", currency: "KWD" }).ok).toBe(false)
    expect(checkPaidAmountAgainstSnapshot({ wooTotal: "10.004", wooCurrency: "KWD" }, { total: "10.004", currency: "KWD" }).ok).toBe(true)
  })

  it("uses 0 decimals for JPY and 2 for USD", () => {
    expect(currencyMinorUnitExponent("jpy")).toBe(0)
    expect(currencyMinorUnitExponent("KRW")).toBe(0)
    expect(currencyMinorUnitExponent("BHD")).toBe(3)
    expect(currencyMinorUnitExponent("USD")).toBe(2)
    expect(checkPaidAmountAgainstSnapshot({ wooTotal: "1500", wooCurrency: "JPY" }, { total: "1500", currency: "JPY" }).ok).toBe(true)
    expect(checkPaidAmountAgainstSnapshot({ wooTotal: "1500", wooCurrency: "JPY" }, { total: "1499", currency: "JPY" }).ok).toBe(false)
  })

  it("parses decimal strings exactly", () => {
    expect(toMinorUnits("0.29", 2)).toBe(29n)
    expect(toMinorUnits("1.005", 2)).toBe(101n)
    expect(toMinorUnits("10.004", 3)).toBe(10004n)
    expect(toMinorUnits(20, 2)).toBe(2000n)
    expect(toMinorUnits("1e3", 2)).toBeNull()
    expect(toMinorUnits("abc", 2)).toBeNull()
  })
})
