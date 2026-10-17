import assert from "node:assert/strict";
import test from "node:test";
import { makeRig, seedFor, signedCallback, CALLBACK_SECRET } from "./helpers.ts";

const BUYER = { name: "Budi", contact: "08123456789" };

test("order lewat masa berlaku: EXPIRED dan stok dilepas sekali saja", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 2) });
  const created = await rig.service.createOrder({ items: [{ variantId: "v1", qty: 2 }], buyer: BUYER });
  assert.deepEqual(await rig.service.stockAvailable(), {}, "semua stok sedang ditahan order");

  const tooEarly = await rig.service.sweep();
  assert.deepEqual(tooEarly.expired, [], "belum waktunya, jangan diutak-atik");

  rig.clock.advance(900_001);
  const first = await rig.service.sweep();
  assert.deepEqual(first.expired, [created.orderCode]);
  assert.equal((await rig.repos.orders.getByCode(created.orderCode))?.status, "EXPIRED");
  assert.deepEqual(await rig.service.stockAvailable(), { v1: 2 });

  const second = await rig.service.sweep();
  assert.deepEqual(second.expired, [], "sweep kedua tidak boleh melepas stok dua kali");
  assert.deepEqual(await rig.service.stockAvailable(), { v1: 2 });
});

test("sweep tanpa pekerjaan tidak melakukan apa-apa", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const report = await rig.service.sweep();
  assert.deepEqual(report, { expired: [], redelivered: [], stillFailing: [], checked: 0 });
});

test("order yang sudah dibayar tapi belum terkirim dilanjutkan sweep", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1), failTimes: 1 });
  const created = await rig.service.createOrder({ items: [{ variantId: "v1", qty: 1 }], buyer: BUYER });
  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount },
    CALLBACK_SECRET, rig.clock.now(),
  );
  await rig.service.handlePaymentCallback({ rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature });
  const report = await rig.service.sweep();
  assert.deepEqual(report.redelivered, [created.orderCode]);
});

test("cancel mengembalikan stok dan menolak pembayaran yang datang belakangan", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const created = await rig.service.createOrder({ items: [{ variantId: "v1", qty: 1 }], buyer: BUYER });
  const cancelled = await rig.service.cancelOrder(created.orderCode);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.status, "CANCELLED");
  assert.deepEqual(await rig.service.stockAvailable(), { v1: 1 });

  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount, reference: created.orderCode },
    CALLBACK_SECRET, rig.clock.now(),
  );
  const outcome = await rig.service.handlePaymentCallback({ rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature });
  assert.equal(outcome.kind, "anomaly");
  assert.equal(rig.delivery.calls, 0);
});

test("laporan: laba dihitung dari ledger setelah satu penjualan selesai", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const created = await rig.service.createOrder({ items: [{ variantId: "v1", qty: 1 }], buyer: BUYER });
  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount, reference: created.orderCode },
    CALLBACK_SECRET, rig.clock.now(),
  );
  await rig.service.handlePaymentCallback({ rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature });

  const report = await rig.service.report();
  const expectedFee = Math.round((created.pay.chargedAmount * 70) / 10000);
  assert.equal(report.ledger.revenue, created.pay.chargedAmount);
  assert.equal(report.ledger.fee, expectedFee);
  assert.equal(report.ledger.cogs, 19_000);
  assert.equal(report.ledger.profit, created.pay.chargedAmount - expectedFee - 19_000);
  assert.equal(report.ledger.orders, 1);
  assert.equal(report.storage.backend, "memory");
  assert.equal(report.storage.durable, false);
  assert.deepEqual(report.stock, {});
});