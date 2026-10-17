import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { bootstrap } from "../src/app/bootstrap.ts";
import { createRequestHandler } from "../src/web/server.ts";

/**
 * Uji asap end-to-end LOKAL:
 *   1. bikin pesanan lewat HTTP  → toko memanggil gateway QRIS SUNGGUHAN
 *   2. gateway balas invoice asli (invoice_id + QR)
 *   3. callback bergaya gateway (HMAC atas body mentah, seperti yang dikirim worker)
 *      dikirim ke server lokal → pesanan lunas + isi stok keluar
 *
 * Yang TIDAK diuji di sini: perjalanan jaringan gateway → URL publik toko, karena
 * localhost tidak bisa dijangkau internet. Itu diuji setelah deploy.
 *
 * Jalankan:  QH=... STORE_CALLBACK_SECRET=... node scripts/smoke.ts
 */
process.env.STORE_PUBLIC_URL ??= "http://127.0.0.1:3199";
process.env.STORE_QRIS_URL ??= "https://qris-gateway.nybaee888.workers.dev";
process.env.STORE_QRIS_SECRET = process.env.QH ?? process.env.STORE_QRIS_SECRET ?? "";
process.env.STORE_CALLBACK_SECRET ??= "smoke-callback-secret-1234567890";
process.env.STORE_SWEEP_SECRET ??= "smoke-sweep-secret-1234567890";
process.env.STORE_ADMIN_KEY ??= "smoke-admin-key-1234567890";
process.env.PORT ??= "3199";

const boot = await bootstrap();
const handle = createRequestHandler({
  service: boot.service, adminKey: boot.config.adminKey, sweepSecret: boot.config.sweepSecret,
  brand: boot.brand, demoCatalog: boot.demoCatalog,
});
const server = http.createServer((req, res) => { void handle(req, res); });
await new Promise<void>((resolve) => server.listen(boot.config.port, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const ok = (label: string, extra = "") => console.log(`✅ ${label}${extra ? ` — ${extra}` : ""}`);
const fail = (label: string, extra = "") => { console.log(`❌ ${label}${extra ? ` — ${extra}` : ""}`); process.exitCode = 1; };

try {
  const { products } = await boot.service.catalog();
  const product = products[0];
  const variant = product?.variants[0];
  if (!product || !variant) throw new Error("katalog kosong");
  await boot.service.addStock([{ variantId: variant.id, payload: "SMOKE-KODE-001", cost: variant.price - 5_000 }]);
  ok("stok contoh disiapkan", `${variant.id} = 1`);

  const orderRes = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ variantId: variant.id, qty: 1 }], buyer: { name: "Smoke Test", contact: "08120000000" } }),
  });
  const order = await orderRes.json() as Record<string, any>;
  if (orderRes.status !== 201) { fail("buat pesanan", `${orderRes.status} ${JSON.stringify(order)}`); throw new Error("stop"); }
  ok("pesanan dibuat", `${order.orderCode} total ${order.quote.totalText} → bayar ${order.pay.chargedAmountText}`);
  ok("invoice dari gateway SUNGGUHAN", order.pay.invoiceId);

  const gatewayView = await fetch(`${boot.config.qrisUrl}/invoice?id=${order.pay.invoiceId}`, {
    headers: { "X-Webhook-Secret": process.env.STORE_QRIS_SECRET ?? "", "User-Agent": "zf-store-smoke/1.0" },
  });
  const gatewayJson = await gatewayView.json() as Record<string, any>;
  if (gatewayView.status !== 200 || gatewayJson.status !== "pending") {
    fail("gateway mengenali invoice itu", `${gatewayView.status} ${JSON.stringify(gatewayJson)}`);
  } else {
    ok("gateway mengenali invoice itu", `status=${gatewayJson.status} charged=${gatewayJson.charged_amount} reference=${gatewayJson.reference}`);
  }

  // Callback persis seperti yang dikirim worker: HMAC atas `<ts>.<body mentah>`.
  const payload = {
    invoice_id: order.pay.invoiceId,
    amount: order.pay.chargedAmount,
    base_amount: order.quote.total,
    reference: order.orderCode,
    status: "paid",
    sender_name: "SMOKE",
    event_id: "smoke-1",
    paid_at: new Date().toISOString(),
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "sha256=" + createHmac("sha256", boot.config.callbackSecret).update(`${timestamp}.${rawBody}`).digest("hex");

  const badRes = await fetch(`${base}/api/pay/callback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-callback-timestamp": timestamp, "x-callback-signature": "sha256=palsu" },
    body: rawBody,
  });
  badRes.status === 401 ? ok("callback dengan tanda tangan palsu ditolak", "401") : fail("callback palsu harus 401", String(badRes.status));

  const goodRes = await fetch(`${base}/api/pay/callback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-callback-timestamp": timestamp, "x-callback-signature": signature },
    body: rawBody,
  });
  const goodJson = await goodRes.json() as Record<string, any>;
  goodRes.status === 200 && goodJson.status === "DELIVERED"
    ? ok("callback sah: pesanan lunas + terkirim", `${goodJson.order} ${goodJson.status}`)
    : fail("callback sah harus 200/DELIVERED", `${goodRes.status} ${JSON.stringify(goodJson)}`);

  const dupRes = await fetch(`${base}/api/pay/callback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-callback-timestamp": timestamp, "x-callback-signature": signature },
    body: rawBody,
  });
  const dupJson = await dupRes.json() as Record<string, any>;
  dupJson.duplicate === true ? ok("callback ganda tidak mengirim dua kali", JSON.stringify(dupJson)) : fail("callback ganda harus ditandai duplicate", JSON.stringify(dupJson));

  const orderView = await fetch(`${base}/api/orders/${order.orderCode}?t=${order.accessToken}`);
  const view = await orderView.json() as Record<string, any>;
  view.delivered?.length === 1
    ? ok("pembeli melihat isi pesanannya", `${view.status} → ${view.delivered[0].payload}`)
    : fail("isi pesanan tidak terlihat pembeli", JSON.stringify(view));

  const report = await fetch(`${base}/api/admin/report`, { headers: { "x-admin-key": boot.config.adminKey } });
  const reportJson = await report.json() as Record<string, any>;
  const ledger = reportJson.report.ledger;
  ok("laporan laba dari ledger", `omzet ${ledger.revenue} fee ${ledger.fee} hpp ${ledger.cogs} laba ${ledger.profit}`);

  const noToken = await fetch(`${base}/api/orders/${order.orderCode}`);
  noToken.status === 404 ? ok("pesanan tanpa token = 404", "tidak membocorkan keberadaan") : fail("tanpa token harus 404", String(noToken.status));

  console.log(process.exitCode === 1 ? "\nSMOKE GAGAL" : "\nSMOKE LULUS");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await boot.close();
}