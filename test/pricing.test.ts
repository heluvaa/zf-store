import assert from "node:assert/strict";
import test from "node:test";
import { applyBps } from "../src/core/money.ts";
import { buildQuote, DEFAULT_MDR_BPS, GATEWAY_RATES_ARE_PLACEHOLDER, unitPriceFor } from "../src/core/pricing.ts";
import { CATALOG } from "./helpers.ts";

const v1 = CATALOG[0]!.variants[0]!;
const v1b = CATALOG[0]!.variants[1]!;

test("harga per unit mengikuti tier yang berlaku", () => {
  assert.equal(unitPriceFor(v1b, 1), 65_000);
  assert.equal(unitPriceFor(v1b, 2), 65_000);
  assert.equal(unitPriceFor(v1b, 3), 60_000);
  assert.equal(unitPriceFor(v1b, 10), 60_000);
  assert.throws(() => unitPriceFor(v1b, 0), /qty/);
});

test("quote dihitung server dari katalog, bukan dari kiriman klien", () => {
  const quote = buildQuote([{ productName: "Voucher A", variant: v1, qty: 2 }]);
  assert.equal(quote.subtotal, 50_000);
  assert.equal(quote.total, 50_000);
  assert.equal(quote.lines.length, 1);
  assert.equal(quote.lines[0]!.lineTotal, 50_000);
});

test("MDR adalah biaya merchant, tidak ditambahkan ke pembeli", () => {
  const quote = buildQuote([{ productName: "Voucher A", variant: v1, qty: 2 }], 70);
  assert.equal(quote.total, quote.subtotal, "pembeli membayar harga barang saja");
  assert.equal(quote.merchantFeeEstimate, applyBps(50_000, 70));
  assert.equal(quote.merchantNetEstimate, 50_000 - quote.merchantFeeEstimate);
});

test("order tanpa item ditolak", () => {
  assert.throws(() => buildQuote([]), /tanpa item/);
});

test("angka MDR masih placeholder: kalau ditandai nyata, angkanya wajib sudah diganti", () => {
  // Penjaga supaya angka karangan tidak diam-diam dianggap fakta.
  if (!GATEWAY_RATES_ARE_PLACEHOLDER) {
    assert.notEqual(DEFAULT_MDR_BPS, 70, "MDR dinyatakan nyata tapi angkanya masih nilai placeholder 0,7%");
  }
});