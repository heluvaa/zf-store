import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "../src/core/errors.ts";
import { planFifo, totalCost } from "../src/core/stock.ts";
import type { StockItem } from "../src/core/types.ts";
import { makeRig } from "./helpers.ts";

const item = (id: string, createdAt: string, variantId = "v1"): StockItem => ({
  id, variantId, payload: `P-${id}`, cost: 1_000, status: "available", orderCode: null, createdAt, updatedAt: createdAt,
});

test("planFifo mengambil yang tertua dulu", () => {
  const items = [item("b", "2026-10-02T00:00:00.000Z"), item("a", "2026-10-01T00:00:00.000Z")];
  assert.deepEqual(planFifo(items, "v1", 1).map((i) => i.id), ["a"]);
  assert.equal(totalCost(planFifo(items, "v1", 2)), 2_000);
});

test("reservasi FIFO di repo: batch lama keluar lebih dulu", async () => {
  const rig = await makeRig();
  await rig.service.addStock([{ variantId: "v1", payload: "LAMA", cost: 19_000 }]);
  rig.clock.advance(60_000);
  await rig.service.addStock([{ variantId: "v1", payload: "BARU", cost: 19_000 }]);

  const taken = await rig.repos.stock.reserve("v1", 1, "ZF-UJI");
  assert.equal(taken.length, 1);
  assert.equal(taken[0]!.payload, "LAMA");
  assert.equal(taken[0]!.status, "reserved");
  assert.equal(taken[0]!.orderCode, "ZF-UJI");
});

test("stok kurang: error DAN tidak ada yang tertahan", async () => {
  const rig = await makeRig();
  await rig.service.addStock([
    { variantId: "v1", payload: "A", cost: 1_000 },
    { variantId: "v1", payload: "B", cost: 1_000 },
  ]);
  await assert.rejects(
    () => rig.repos.stock.reserve("v1", 5, "ZF-GAGAL"),
    (e: unknown) => e instanceof DomainError && e.code === "INSUFFICIENT_STOCK",
  );
  assert.deepEqual(await rig.service.stockAvailable(), { v1: 2 }, "stok harus tetap utuh setelah gagal");
  assert.equal((await rig.repos.stock.listByOrder("ZF-GAGAL")).length, 0);
});

test("dua reservasi bersamaan tidak boleh dapat item yang sama", async () => {
  const rig = await makeRig();
  await rig.service.addStock([
    { variantId: "v1", payload: "A", cost: 1_000 },
    { variantId: "v1", payload: "B", cost: 1_000 },
    { variantId: "v1", payload: "C", cost: 1_000 },
  ]);
  const results = await Promise.allSettled([
    rig.repos.stock.reserve("v1", 2, "ZF-1"),
    rig.repos.stock.reserve("v1", 2, "ZF-2"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "hanya satu yang boleh berhasil");
  assert.equal(failed.length, 1);
  assert.deepEqual(await rig.service.stockAvailable(), { v1: 1 }, "sisa stok harus pas 1");
});

test("release mengembalikan stok ke available", async () => {
  const rig = await makeRig();
  await rig.service.addStock([{ variantId: "v1", payload: "A", cost: 1_000 }]);
  await rig.repos.stock.reserve("v1", 1, "ZF-LEPAS");
  assert.equal(await rig.repos.stock.releaseByOrder("ZF-LEPAS"), 1);
  assert.deepEqual(await rig.service.stockAvailable(), { v1: 1 });
  assert.equal((await rig.repos.stock.listByOrder("ZF-LEPAS")).length, 0);
});