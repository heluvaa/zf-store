import assert from "node:assert/strict";
import test from "node:test";
import { parseProduct, parseRupiahInput, parseVariant } from "../src/core/catalog.ts";
import { DomainError } from "../src/core/errors.ts";

test("parseRupiahInput: terima angka, titik ribuan, 'Rp', dan buang spasi", () => {
  assert.equal(parseRupiahInput(25_000, "x"), 25_000);
  assert.equal(parseRupiahInput("25.000", "x"), 25_000);
  assert.equal(parseRupiahInput("Rp 25.000", "x"), 25_000);
  assert.equal(parseRupiahInput("25 000", "x"), 25_000);
  assert.equal(parseRupiahInput("0", "x"), 0);
});

test("parseRupiahInput: tolak bukan angka, negatif, kosong", () => {
  for (const bad of ["abc", "25.00,5", "-100", "", " ", 12.5, -1]) {
    assert.throws(() => parseRupiahInput(bad, "harga"), (e: unknown) => e instanceof DomainError && e.code === "BAD_AMOUNT" || e instanceof DomainError && e.code === "BAD_PRODUCT", `harus tolak ${JSON.stringify(bad)}`);
  }
});

test("parseVariant: normalisasi id dan tiers terurut", () => {
  const v = parseVariant({ id: "a b", name: "1 Bulan", price: "25.000", cost: "19.000", tiers: [{ minQty: 5, unitPrice: 14_000 }, { minQty: 3, unitPrice: 15_000 }] });
  assert.equal(v.id, "a_b");
  assert.equal(v.price, 25_000);
  assert.equal(v.cost, 19_000);
  assert.deepEqual(v.tiers, [{ minQty: 3, unitPrice: 15_000 }, { minQty: 5, unitPrice: 14_000 }]);
});

test("parseVariant: id sah tanpa spasi lolos apa adanya", () => {
  const v = parseVariant({ id: "v_stream_1m", name: "1", price: 100, cost: 0 });
  assert.equal(v.id, "v_stream_1m");
});

test("parseVariant: minQty tier di bawah 2 ditolak", () => {
  assert.throws(() => parseVariant({ id: "v", name: "n", price: 100, cost: 0, tiers: [{ minQty: 1, unitPrice: 90 }] }), DomainError);
});

test("parseProduct: slug auto dari nama, id auto", () => {
  const p = parseProduct({ name: "Voucher Netflix 30 Hari", variants: [{ id: "v1", name: "1", price: 25_000, cost: 19_000 }] });
  assert.equal(p.slug, "voucher-netflix-30-hari");
  assert.equal(p.id, "p_voucher_netflix_30_hari");
  assert.equal(p.active, true);
});

test("parseProduct: varian ganda ditolak", () => {
  assert.throws(
    () => parseProduct({ name: "X", variants: [{ id: "v", name: "a", price: 100, cost: 0 }, { id: "v", name: "b", price: 200, cost: 0 }] }),
    (e: any) => e.code === "BAD_PRODUCT" && /ganda/.test(e.message),
  );
});

test("parseProduct: modal >= harga ditolak — toko jangan jualan rugi diam-diam", () => {
  assert.throws(
    () => parseProduct({ name: "X", variants: [{ id: "v", name: "a", price: 10_000, cost: 10_000 }] }),
    (e: any) => e.code === "BAD_PRODUCT" && /modal/.test(e.message),
  );
});

test("parseProduct: tanpa varian ditolak", () => {
  assert.throws(() => parseProduct({ name: "X", variants: [] }), (e: any) => e.code === "BAD_PRODUCT");
});

test("parseProduct: karakter kontrol di nama dibersihkan, bukan disimpan", () => {
  const p = parseProduct({ name: "A\u0000B\u001fC", variants: [{ id: "v", name: "x", price: 100, cost: 0 }] });
  assert.equal(p.name, "A B C");
});
