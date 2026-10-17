import assert from "node:assert/strict";
import test from "node:test";
import type { CallbackOutcome } from "../src/app/service.ts";
import { CALLBACK_SECRET, makeRig, seedFor, signedCallback } from "./helpers.ts";

const BUYER = { name: "Budi", contact: "08123456789" };

async function createOrder(rig: Awaited<ReturnType<typeof makeRig>>, qty = 1) {
  return rig.service.createOrder({ items: [{ variantId: "v1", qty }], buyer: BUYER });
}

test("callback sah: order lunas, isi stok dikirim, ledger tercatat", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const created = await createOrder(rig);
  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount, reference: created.orderCode },
    CALLBACK_SECRET,
    rig.clock.now(),
  );
  const outcome = await rig.service.handlePaymentCallback({
    rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature,
  });
  assert.deepEqual(outcome as CallbackOutcome, {
    kind: "processed", orderCode: created.orderCode, status: "DELIVERED", delivered: true,
  });

  const view = await rig.service.getPublicOrder(created.orderCode, created.accessToken);
  assert.equal(view?.status, "DELIVERED");
  assert.equal(view?.delivered.length, 1);
  assert.match(String(view?.delivered[0]?.payload), /^KODE-v1-/);
  assert.equal(view?.qrisUrl, null, "QR tidak ditampilkan lagi setelah lunas");

  const entries = await rig.repos.ledger.listForOrder(created.orderCode);
  assert.equal(entries.length, 3);
  assert.equal(entries.find((e) => e.kind === "SALE")?.amount, created.pay.chargedAmount);
  assert.equal((await rig.repos.stock.listByOrder(created.orderCode))[0]?.status, "delivered");
  assert.ok(await rig.repos.payments.get(created.pay.invoiceId), "pembayaran tercatat");
});

test("tanda tangan salah ditolak dan tidak mengubah apa pun", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const created = await createOrder(rig);
  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount },
    "secret-yang-salah-tapi-panjang",
    rig.clock.now(),
  );
  const outcome = await rig.service.handlePaymentCallback({
    rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature,
  });
  assert.equal(outcome.kind, "bad_signature");
  assert.equal(rig.delivery.calls, 0);
  const stored = await rig.repos.orders.getByCode(created.orderCode);
  assert.equal(stored?.status, "PENDING_PAYMENT");
});

test("invoice yang bukan milik toko ini diabaikan, bukan dianggap gagal", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const signed = signedCallback({ invoiceId: "inv_punya_orang_lain", amount: 25_001 }, CALLBACK_SECRET, rig.clock.now());
  const outcome = await rig.service.handlePaymentCallback({
    rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature,
  });
  assert.equal(outcome.kind, "unknown_invoice");
  assert.equal(rig.delivery.calls, 0);
});

test("callback ganda hanya mengirim sekali", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const created = await createOrder(rig);
  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount, eventId: "e1" },
    CALLBACK_SECRET, rig.clock.now(),
  );
  const first = await rig.service.handlePaymentCallback({ rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature });
  const second = await rig.service.handlePaymentCallback({ rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature });
  assert.equal(first.kind, "processed");
  assert.deepEqual(second, { kind: "duplicate", orderCode: created.orderCode, status: "DELIVERED" });
  assert.equal(rig.delivery.calls, 1, "pengiriman tidak boleh jalan dua kali");
  assert.equal((await rig.repos.stock.listByOrder(created.orderCode)).filter((i) => i.status === "delivered").length, 1);
});

test("dua callback bersamaan tetap satu pengiriman", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const created = await createOrder(rig);
  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount },
    CALLBACK_SECRET, rig.clock.now(),
  );
  const input = { rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature };
  const results = await Promise.all([
    rig.service.handlePaymentCallback(input),
    rig.service.handlePaymentCallback(input),
  ]);
  assert.equal(rig.delivery.calls, 1, `pengiriman jalan ${rig.delivery.calls}x`);
  const stored = await rig.repos.orders.getByCode(created.orderCode);
  assert.equal(stored?.status, "DELIVERED");
  assert.equal(results.filter((r) => r.kind === "processed").length >= 1, true);
});

test("nominal kurang: uang dicatat, barang TIDAK dikirim, ditandai anomali", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const created = await createOrder(rig);
  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount - 1, reference: created.orderCode },
    CALLBACK_SECRET, rig.clock.now(),
  );
  const outcome = await rig.service.handlePaymentCallback({
    rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature,
  });
  assert.equal(outcome.kind, "anomaly");
  assert.match(String((outcome as { reason: string }).reason), /underpaid/);
  assert.equal(rig.delivery.calls, 0);
  assert.equal((await rig.repos.orders.getByCode(created.orderCode))?.status, "PENDING_PAYMENT");
});

test("bayar setelah kedaluwarsa: tidak dikirim otomatis, ditandai untuk manusia", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const created = await createOrder(rig);
  rig.clock.advance(901_000);
  await rig.service.sweep();
  assert.equal((await rig.repos.orders.getByCode(created.orderCode))?.status, "EXPIRED");
  assert.deepEqual(await rig.service.stockAvailable(), { v1: 1 }, "stok sudah dilepas saat kedaluwarsa");

  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount, reference: created.orderCode },
    CALLBACK_SECRET, rig.clock.now(),
  );
  const outcome = await rig.service.handlePaymentCallback({
    rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature,
  });
  assert.equal(outcome.kind, "anomaly");
  assert.equal((outcome as { reason: string }).reason, "late_payment");
  assert.equal(rig.delivery.calls, 0);
  assert.ok(await rig.repos.payments.get(created.pay.invoiceId), "uangnya tetap dicatat supaya bisa dilacak");
});

test("pengiriman gagal sekali: kembali ke PAID lalu sukses di sweep berikutnya", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1), failTimes: 1 });
  const created = await createOrder(rig);
  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount, reference: created.orderCode },
    CALLBACK_SECRET, rig.clock.now(),
  );
  const outcome = await rig.service.handlePaymentCallback({
    rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature,
  });
  assert.equal(outcome.kind, "processed");
  assert.equal((outcome as { status: string }).status, "PAID", "gagal kirim = balik ke PAID, bukan hilang");
  assert.equal((await rig.repos.orders.getByCode(created.orderCode))?.deliveryError, "gagal kirim (uji)");

  const report = await rig.service.sweep();
  assert.deepEqual(report.redelivered, [created.orderCode]);
  assert.equal((await rig.repos.orders.getByCode(created.orderCode))?.status, "DELIVERED");
  assert.equal(rig.delivery.calls, 2);
});

test("percobaan kirim habis: FAILED, stok tidak dilepas, callback lanjutan jadi anomali", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1), failTimes: 99, maxDeliveryAttempts: 2 });
  const created = await createOrder(rig);
  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount, reference: created.orderCode, eventId: "e9" },
    CALLBACK_SECRET, rig.clock.now(),
  );
  const input = { rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature };
  await rig.service.handlePaymentCallback(input);
  const report = await rig.service.sweep();
  assert.deepEqual(report.stillFailing, [created.orderCode]);
  assert.equal((await rig.repos.orders.getByCode(created.orderCode))?.status, "FAILED");
  assert.equal((await rig.repos.stock.listByOrder(created.orderCode))[0]?.status, "reserved", "barang belum diberikan, jangan dilepas");

  const again = await rig.service.handlePaymentCallback(input);
  assert.equal(again.kind, "anomaly");
  assert.equal((again as { reason: string }).reason, "delivery_failed");
});

test("order yang macet di DELIVERING (proses mati) dilanjutkan sweep", async () => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const created = await createOrder(rig);
  const signed = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount },
    CALLBACK_SECRET, rig.clock.now(),
  );
  // Bayar dulu supaya masuk PAID, lalu paksa status ke DELIVERING seperti proses yang mati di tengah jalan.
  await rig.service.handlePaymentCallback({ rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature });
  const order = await rig.repos.orders.getByCode(created.orderCode);
  assert.ok(order);
  await rig.repos.orders.update(created.orderCode, { status: "DELIVERING", delivered: [], deliveredAt: null });

  // Klaim yang masih segar TIDAK boleh direbut: itu yang mencegah kirim ganda.
  const fresh = await rig.service.sweep();
  assert.deepEqual(fresh.redelivered, [], "klaim yang belum basi tidak boleh direbut proses lain");

  // Setelah sewa klaim lewat, order yang prosesnya mati boleh dilanjutkan.
  rig.clock.advance(121_000);
  const report = await rig.service.sweep();
  assert.deepEqual(report.redelivered, [created.orderCode]);
  assert.equal((await rig.repos.orders.getByCode(created.orderCode))?.status, "DELIVERED");
});