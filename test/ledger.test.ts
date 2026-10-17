import assert from "node:assert/strict";
import test from "node:test";
import { entriesForPaidOrder, summarize } from "../src/core/ledger.ts";
import { makeRig } from "./helpers.ts";

test("entri ledger: SALE, GATEWAY_FEE, COGS dengan tanda yang benar", () => {
  const entries = entriesForPaidOrder({
    orderCode: "ZF-20261018-001",
    paidAmount: 25_002,
    saleAmount: 25_000,
    cogs: 19_000,
    mdrBps: 70,
    at: "2026-10-18T03:00:00.000Z",
  });
  assert.equal(entries.length, 3);
  const sale = entries.find((e) => e.kind === "SALE")!;
  const fee = entries.find((e) => e.kind === "GATEWAY_FEE")!;
  const cogs = entries.find((e) => e.kind === "COGS")!;
  assert.equal(sale.amount, 25_002, "SALE = uang yang benar-benar masuk (termasuk kode unik)");
  assert.equal(sale.note, "harga 25000");
  assert.ok(fee.amount < 0);
  assert.equal(-fee.amount, Math.round((25_002 * 70) / 10000));
  assert.equal(cogs.amount, -19_000);
});

test("summarize menghitung laba dari satu sumber", () => {
  const entries = entriesForPaidOrder({
    orderCode: "ZF-1", paidAmount: 100_000, saleAmount: 100_000, cogs: 80_000, mdrBps: 70, at: "2026-10-18T03:00:00.000Z",
  });
  const summary = summarize(entries);
  assert.equal(summary.revenue, 100_000);
  assert.equal(summary.fee, 700);
  assert.equal(summary.cogs, 80_000);
  assert.equal(summary.profit, 19_300);
  assert.equal(summary.orders, 1);
});

test("append bersifat idempoten: callback ganda tidak menghitung laba dua kali", async () => {
  const rig = await makeRig();
  const entries = entriesForPaidOrder({
    orderCode: "ZF-IDEMP", paidAmount: 50_000, saleAmount: 50_000, cogs: 40_000, mdrBps: 70, at: "2026-10-18T03:00:00.000Z",
  });
  assert.equal(await rig.repos.ledger.append(entries), 3);
  assert.equal(await rig.repos.ledger.append(entries), 0, "penulisan kedua tidak menambah apa pun");
  assert.equal((await rig.repos.ledger.listForOrder("ZF-IDEMP")).length, 3);
  assert.equal(summarize(await rig.repos.ledger.listAll()).profit, 50_000 - 350 - 40_000);
});