import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/core/errors.ts";
import { addRupiah, applyBps, assertRupiah, rp } from "../src/core/money.ts";

test("rp mengelompokkan ribuan sendiri, bukan toLocaleString", () => {
  assert.equal(rp(0), "Rp 0");
  assert.equal(rp(999), "Rp 999");
  assert.equal(rp(1000), "Rp 1.000");
  assert.equal(rp(22_255_985), "Rp 22.255.985");
  assert.equal(rp(-1_500), "-Rp 1.500");
});

test("applyBps: persen lewat basis point supaya eksak", () => {
  assert.equal(applyBps(50_000, 70), 350);      // 0,7% dari 50.000
  assert.equal(applyBps(1_000, 70), 7);
  assert.equal(applyBps(65_000, 1250), 8_125);  // 12,5%
  assert.equal(applyBps(333, 100), 3);          // dibulatkan, bukan dipotong
});

test("uang wajib integer rupiah dan tidak negatif", () => {
  assert.throws(() => assertRupiah(1_000.5), (e: unknown) => e instanceof DomainError && e.code === "BAD_AMOUNT");
  assert.throws(() => assertRupiah(-1), /negatif/);
  assert.throws(() => addRupiah(1_000, 0.5), /integer/);
  assert.equal(addRupiah(1_000, 2_000, 3_000), 6_000);
});