import assert from "node:assert/strict";
import test from "node:test";
import { dayKey, orderCode, randomToken } from "../src/core/codes.ts";

test("dayKey memakai WIB, bukan UTC", () => {
  assert.equal(dayKey(new Date("2026-10-17T16:59:00.000Z")), "20261017"); // 23:59 WIB
  assert.equal(dayKey(new Date("2026-10-17T17:00:00.000Z")), "20261018"); // 00:00 WIB
  assert.equal(dayKey(new Date("2026-10-18T09:30:00.000Z")), "20261018"); // 16:30 WIB
});

test("orderCode berformat ZF-YYYYMMDD-NNN", () => {
  assert.equal(orderCode("20261018", 1), "ZF-20261018-001");
  assert.equal(orderCode("20261018", 42), "ZF-20261018-042");
  assert.throws(() => orderCode("20261018", 0), /seq/);
});

test("token akses acak, bukan turunan dari kode order", () => {
  const a = randomToken();
  const b = randomToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 20, `token terlalu pendek: ${a}`);
});