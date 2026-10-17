import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_KEY, CALLBACK_SECRET, SWEEP_KEY, makeRig, seedFor, signedCallback, startServer } from "./helpers.ts";

const BUYER = { name: "Budi", contact: "08123456789" };
const JSON_HEADERS = { "content-type": "application/json" };

async function createOrderViaHttp(url: string, qty = 1): Promise<Record<string, any>> {
  const res = await fetch(`${url}/api/orders`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ items: [{ variantId: "v1", qty }], buyer: BUYER }),
  });
  assert.equal(res.status, 201, `create order harus 201, dapat ${res.status}: ${await res.clone().text()}`);
  return (await res.json()) as Record<string, any>;
}

test("katalog publik: harga tampil, harga beli (cost) tidak pernah keluar", async (t) => {
  const rig = await makeRig({ seed: seedFor("v1", 3) });
  const server = await startServer(rig.service, { brand: "ZF Store", demo: true });
  t.after(() => server.close());

  const health = await fetch(`${server.url}/health`);
  const healthBody = (await health.json()) as Record<string, any>;
  assert.equal(health.status, 200);
  assert.equal(healthBody.brand, "ZF Store");
  assert.equal(healthBody.demoCatalog, true);
  assert.deepEqual(healthBody.storage, { backend: "memory", durable: false });

  const res = await fetch(`${server.url}/api/catalog`);
  const raw = await res.text();
  assert.equal(res.status, 200);
  assert.equal(raw.includes('"cost"'), false, "cost = harga beli, tidak boleh dikirim ke publik");
  assert.equal(raw.includes("v2"), false, "produk non-aktif tidak boleh muncul");
  const body = JSON.parse(raw) as Record<string, any>;
  assert.equal(body.brand, "ZF Store");
  assert.equal(body.products.length, 1);
  assert.equal(body.products[0].variants[0].priceText, "Rp 25.000");
  assert.equal(body.products[0].variants[0].stock, 3);
});

test("pesanan: token wajib, admin boleh lihat tanpa token", async (t) => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const server = await startServer(rig.service);
  t.after(() => server.close());

  const created = await createOrderViaHttp(server.url);
  assert.match(String(created.orderCode), /^ZF-\d{8}-\d{3}$/);
  assert.equal(created.pay.chargedAmountText.startsWith("Rp "), true);
  assert.equal(created.quote.totalText, "Rp 25.000");
  assert.ok(created.accessToken);

  const noToken = await fetch(`${server.url}/api/orders/${created.orderCode}`);
  assert.equal(noToken.status, 404, "tanpa token = seolah tidak ada");
  const wrongToken = await fetch(`${server.url}/api/orders/${created.orderCode}?t=salah`);
  assert.equal(wrongToken.status, 404);
  const ok = await fetch(`${server.url}/api/orders/${created.orderCode}?t=${created.accessToken}`);
  assert.equal(ok.status, 200);
  const view = (await ok.json()) as Record<string, any>;
  assert.equal(view.status, "PENDING_PAYMENT");
  assert.equal(view.delivered.length, 0);
  assert.equal(JSON.stringify(view).includes(String(created.accessToken)), false, "token tidak boleh ikut di body");

  const admin = await fetch(`${server.url}/api/orders/${created.orderCode}`, { headers: { "x-admin-key": ADMIN_KEY } });
  assert.equal(admin.status, 200);
});

test("jalur uang: 401 tanda tangan salah, 400 payload rusak, 200 untuk yang sah", async (t) => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const server = await startServer(rig.service);
  t.after(() => server.close());
  const created = await createOrderViaHttp(server.url);

  const bad = signedCallback({ invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount }, "secret-lain-yang-panjang", rig.clock.now());
  const badRes = await fetch(`${server.url}/api/pay/callback`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-callback-timestamp": bad.timestamp, "x-callback-signature": bad.signature },
    body: bad.rawBody,
  });
  assert.equal(badRes.status, 401, "tanda tangan salah harus 401, bukan 200");

  const broken = "{bukan json";
  const timestamp = String(Math.floor(rig.clock.now().getTime() / 1000));
  const { createHmac } = await import("node:crypto");
  const signature = "sha256=" + createHmac("sha256", CALLBACK_SECRET).update(`${timestamp}.${broken}`).digest("hex");
  const brokenRes = await fetch(`${server.url}/api/pay/callback`, {
    method: "POST", headers: { ...JSON_HEADERS, "x-callback-timestamp": timestamp, "x-callback-signature": signature }, body: broken,
  });
  assert.equal(brokenRes.status, 400, "ditandatangani sah tapi bukan JSON = 400");

  const foreign = signedCallback({ invoiceId: "inv_milik_orang_lain", amount: 1_000 }, CALLBACK_SECRET, rig.clock.now());
  const foreignRes = await fetch(`${server.url}/api/pay/callback`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-callback-timestamp": foreign.timestamp, "x-callback-signature": foreign.signature },
    body: foreign.rawBody,
  });
  assert.equal(foreignRes.status, 200, "invoice asing dibalas 200 supaya gateway berhenti retry");
  assert.equal(((await foreignRes.json()) as Record<string, any>).ignored, "unknown_invoice");

  const good = signedCallback(
    { invoiceId: created.pay.invoiceId, amount: created.pay.chargedAmount, reference: created.orderCode },
    CALLBACK_SECRET, rig.clock.now(),
  );
  const goodRes = await fetch(`${server.url}/api/pay/callback`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-callback-timestamp": good.timestamp, "x-callback-signature": good.signature },
    body: good.rawBody,
  });
  assert.equal(goodRes.status, 200);
  const outcome = (await goodRes.json()) as Record<string, any>;
  assert.equal(outcome.status, "DELIVERED");
  assert.equal(outcome.delivered, true);

  const after = await fetch(`${server.url}/api/orders/${created.orderCode}?t=${created.accessToken}`);
  const view = (await after.json()) as Record<string, any>;
  assert.equal(view.status, "DELIVERED");
  assert.equal(view.delivered.length, 1);
  assert.match(String(view.delivered[0].payload), /^KODE-v1-/);

  const again = await fetch(`${server.url}/api/pay/callback`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-callback-timestamp": good.timestamp, "x-callback-signature": good.signature },
    body: good.rawBody,
  });
  assert.equal(((await again.json()) as Record<string, any>).duplicate, true);
  assert.equal(rig.delivery.calls, 1);
});

test("sweep internal butuh kunci; admin report butuh kunci admin", async (t) => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const server = await startServer(rig.service);
  t.after(() => server.close());

  const noKey = await fetch(`${server.url}/internal/sweep`, { method: "POST" });
  assert.equal(noKey.status, 401);
  const headerKey = await fetch(`${server.url}/internal/sweep`, { method: "POST", headers: { "x-sweep-key": SWEEP_KEY } });
  assert.equal(headerKey.status, 200);
  // Bentuk yang dipakai cron Vercel: Authorization: Bearer <CRON_SECRET>.
  const bearer = await fetch(`${server.url}/internal/sweep`, { headers: { authorization: `Bearer ${SWEEP_KEY}` } });
  assert.equal(bearer.status, 200);

  const reportNoKey = await fetch(`${server.url}/api/admin/report`);
  assert.equal(reportNoKey.status, 401);
  const report = await fetch(`${server.url}/api/admin/report`, { headers: { "x-admin-key": ADMIN_KEY } });
  assert.equal(report.status, 200);
  const reportBody = (await report.json()) as Record<string, any>;
  assert.equal(reportBody.report.storage.backend, "memory");
  assert.equal(typeof reportBody.report.ledger.profit, "number");
});

test("badan rusak dan rute asing tidak menjatuhkan server", async (t) => {
  const rig = await makeRig({ seed: seedFor("v1", 1) });
  const server = await startServer(rig.service);
  t.after(() => server.close());

  const notJson = await fetch(`${server.url}/api/orders`, { method: "POST", headers: JSON_HEADERS, body: "bukan json" });
  assert.equal(notJson.status, 400);
  const noItems = await fetch(`${server.url}/api/orders`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
  assert.equal(noItems.status, 400);
  const unknown = await fetch(`${server.url}/apa-ini`);
  assert.equal(unknown.status, 404);
  const health = await fetch(`${server.url}/health`);
  assert.equal(health.status, 200, "server harus tetap hidup setelah input cacat");
});

test("batas laju pesanan dihitung setelah body lolos parse", async (t) => {
  const rig = await makeRig({ seed: seedFor("v1", 20) });
  const server = await startServer(rig.service);
  t.after(() => server.close());

  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    const res = await fetch(`${server.url}/api/orders`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400), "10 pertama ditolak karena isi kosong");
  assert.equal(statuses[10], 429, "yang ke-11 kena batas laju");
});