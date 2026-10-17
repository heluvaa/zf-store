import assert from "node:assert/strict";
import test from "node:test";
import { StoreService } from "../src/app/service.ts";
import { DomainError } from "../src/core/errors.ts";
import type { Product } from "../src/core/types.ts";
import { digitalStockDelivery } from "../src/deliver/digital.ts";
import { staticCatalog } from "../src/repos/catalog-file.ts";
import { memoryRepositories } from "../src/repos/memory.ts";
import { CALLBACK_SECRET, CATALOG, clock, fakeGateway, makeRig, seedFor } from "./helpers.ts";
import { publicProduct } from "../src/web/views.ts";

const BUYER = { name: "Budi", contact: "08123456789" };

test("checkout sukses: kode order, invoice dari gateway, stok tertahan", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 3) });
  const result = await rig.service.createOrder({ items: [{ variantId: "v1", qty: 2 }], buyer: BUYER });

  assert.match(result.orderCode, /^ZF-\d{8}-\d{3}$/);
  assert.equal(result.status, "PENDING_PAYMENT");
  assert.equal(rig.gateway.createCalls, 1);
  assert.equal(result.quote.subtotal, 50_000);
  assert.ok(result.pay.chargedAmount >= 50_001, "nominal dibayar = harga + kode unik gateway");
  assert.equal(result.pay.invoiceId, "inv_test_1");
  assert.deepEqual(await rig.service.stockAvailable(), { v1: 1 });

  const stored = await rig.repos.orders.getByCode(result.orderCode);
  assert.equal(stored?.reservedStockIds.length, 2);
  assert.equal(stored?.chargedAmount, result.pay.chargedAmount);
  assert.equal((await rig.repos.stock.listByOrder(result.orderCode)).length, 2);
});

test("kode order naik urut per hari", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 4) });
  const a = await rig.service.createOrder({ items: [{ variantId: "v1", qty: 1 }], buyer: BUYER });
  const b = await rig.service.createOrder({ items: [{ variantId: "v1", qty: 1 }], buyer: BUYER });
  assert.match(a.orderCode, /-001$/);
  assert.match(b.orderCode, /-002$/);
});

test("stok kurang: order tidak dibuat dan gateway tidak dipanggil", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  await assert.rejects(
    () => rig.service.createOrder({ items: [{ variantId: "v1", qty: 2 }], buyer: BUYER }),
    (e: unknown) => e instanceof DomainError && e.code === "INSUFFICIENT_STOCK",
  );
  assert.equal(rig.gateway.createCalls, 0, "jangan bikin invoice kalau stok tidak ada");
  assert.deepEqual(await rig.service.stockAvailable(), { v1: 1 });
  assert.equal((await rig.repos.orders.listRecent()).length, 0);
});

test("gateway gagal: stok dilepas, tidak ada order nyangkut", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 2) });
  rig.gateway.failNextCreate = true;
  await assert.rejects(
    () => rig.service.createOrder({ items: [{ variantId: "v1", qty: 2 }], buyer: BUYER }),
    (e: unknown) => e instanceof DomainError && e.code === "GATEWAY_HTTP",
  );
  assert.deepEqual(await rig.service.stockAvailable(), { v1: 2 }, "stok harus kembali tersedia");
  assert.equal((await rig.repos.orders.listRecent()).length, 0);
});

test("produk mati, varian asing, dan pembeli cacat ditolak", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 5) });
  await assert.rejects(
    () => rig.service.createOrder({ items: [{ variantId: "v2", qty: 1 }], buyer: BUYER }),
    (e: unknown) => e instanceof DomainError && e.code === "PRODUCT_INACTIVE",
  );
  await assert.rejects(
    () => rig.service.createOrder({ items: [{ variantId: "v_hantu", qty: 1 }], buyer: BUYER }),
    (e: unknown) => e instanceof DomainError && e.code === "VARIANT_NOT_FOUND",
  );
  await assert.rejects(
    () => rig.service.createOrder({ items: [{ variantId: "v1", qty: 1 }], buyer: { name: "B", contact: "081234" } }),
    (e: unknown) => e instanceof DomainError && e.code === "BAD_BUYER",
  );
  await assert.rejects(
    () => rig.service.createOrder({ items: [{ variantId: "v1", qty: 0 }], buyer: BUYER }),
    (e: unknown) => e instanceof DomainError && e.code === "BAD_QTY",
  );
  await assert.rejects(
    () => rig.service.createOrder({ items: [], buyer: BUYER }),
    (e: unknown) => e instanceof DomainError && e.code === "EMPTY_ORDER",
  );
  assert.equal(rig.gateway.createCalls, 0);
});

test("total di luar batas gateway ditolak sebelum memanggil gateway", async () => {
  const cheap: Product[] = [{
    id: "p", slug: "murah", name: "Murah", description: "", active: true, sort: 1,
    variants: [{ id: "vmurah", name: "1x", price: 50, cost: 10, warranty: "G", terms: "T" }],
  }];
  const rig = await makeRig({ catalog: staticCatalog(cheap) });
  await assert.rejects(
    () => rig.service.createOrder({ items: [{ variantId: "vmurah", qty: 1 }], buyer: BUYER }),
    (e: unknown) => e instanceof DomainError && e.code === "AMOUNT_RANGE",
  );
  assert.equal(rig.gateway.createCalls, 0);
});

test("view publik katalog tidak membocorkan harga beli (cost)", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const { products, stock } = await rig.service.catalog();
  assert.equal(products.length, 1, "produk non-aktif tidak ikut");
  assert.equal(stock.v1, 1);
  const view = publicProduct(products[0]!, stock);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("cost"), false, "cost = harga beli, tidak boleh keluar dari server");
  assert.equal(serialized.includes("19.000"), false, "harga beli tidak boleh muncul dalam bentuk teks apa pun");
  assert.equal(view.variants[0]!.priceText, "Rp 25.000");
});

test("view publik menyembunyikan isi stok selama belum lunas dan butuh token", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const created = await rig.service.createOrder({ items: [{ variantId: "v1", qty: 1 }], buyer: BUYER });
  assert.equal(await rig.service.getPublicOrder(created.orderCode, "token-salah"), null);
  const view = await rig.service.getPublicOrder(created.orderCode, created.accessToken);
  assert.equal(view?.status, "PENDING_PAYMENT");
  assert.deepEqual(view?.delivered, []);
  assert.notEqual(view?.qrisUrl, null);
  assert.equal(JSON.stringify(view).includes("token-uji"), false, "access token tidak boleh ikut di view publik");
});

test("service bisa dirakit dengan deps minimal (tanpa clock/token khusus)", async () => {
  const time = clock();
  const repos = await memoryRepositories(staticCatalog(CATALOG), { now: time.now });
  const service = new StoreService({
    repos,
    gateway: fakeGateway(time),
    delivery: digitalStockDelivery(),
    config: { callbackUrl: "https://x.test/cb", callbackSecret: CALLBACK_SECRET, mdrBps: 70 },
    now: time.now,
  });
  assert.equal(service.storage.backend, "memory");
  assert.equal(service.storage.durable, false);
  await service.addStock([{ variantId: "v1", payload: "KODE-X", cost: 19_000 }]);
  const created = await service.createOrder({ items: [{ variantId: "v1", qty: 1 }], buyer: BUYER });
  assert.ok(created.accessToken.length >= 20, "token acak dibuat sendiri kalau tidak disuntik");
});