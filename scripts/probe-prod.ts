/**
 * Uji jalur uang LENGKAP di produksi:
 *   toko (Vercel) → gateway QRIS (worker) → hook dari HP → callback gateway → toko → kirim barang
 *
 * Yang membedakan ini dari scripts/smoke.ts: callback-nya benar-benar datang dari
 * internet (worker → URL produksi), bukan disimulasikan lokal.
 *
 * Env yang dipakai: PROBE_BASE (default STORE_PUBLIC_URL), STORE_ADMIN_KEY,
 * STORE_QRIS_URL, STORE_QRIS_SECRET, VARIANT (default v_stream_1m).
 */
const base = (process.env.PROBE_BASE ?? process.env.STORE_PUBLIC_URL ?? "").replace(/\/+$/, "");
const adminKey = process.env.STORE_ADMIN_KEY ?? "";
const gateway = (process.env.STORE_QRIS_URL ?? "").replace(/\/+$/, "");
const hookSecret = process.env.STORE_QRIS_SECRET ?? "";
const variantId = process.env.VARIANT ?? "v_stream_1m";

if (!base || !adminKey || !gateway || !hookSecret) {
  console.error("env belum lengkap (PROBE_BASE/STORE_ADMIN_KEY/STORE_QRIS_URL/STORE_QRIS_SECRET)");
  process.exit(1);
}

const UA = { "User-Agent": "zf-store-probe/1.0" };
const ok = (label: string, extra = "") => console.log(`✅ ${label}${extra ? ` — ${extra}` : ""}`);
const bad = (label: string, extra = "") => { console.log(`❌ ${label}${extra ? ` — ${extra}` : ""}`); process.exitCode = 1; };

const health = await fetch(`${base}/health`, { headers: UA });
const healthJson = await health.json() as Record<string, any>;
health.status === 200 && healthJson.storage?.backend === "postgres"
  ? ok("produksi hidup + penyimpanan durable", JSON.stringify(healthJson.storage))
  : bad("produksi tidak sehat", `${health.status} ${JSON.stringify(healthJson)}`);

const orderRes = await fetch(`${base}/api/orders`, {
  method: "POST",
  headers: { "content-type": "application/json", ...UA },
  body: JSON.stringify({ items: [{ variantId, qty: 1 }], buyer: { name: "Probe Produksi", contact: "08120000000" } }),
});
const order = await orderRes.json() as Record<string, any>;
if (orderRes.status !== 201) { bad("buat pesanan di produksi", `${orderRes.status} ${JSON.stringify(order)}`); process.exit(1); }
ok("pesanan produksi dibuat", `${order.orderCode} bayar ${order.pay.chargedAmountText} (${order.pay.invoiceId})`);

// Hook ini yang menirukan notifikasi DANA masuk; gateway harus mencocokkan nominalnya
// lalu mengirim callback bertanda tangan ke URL produksi toko.
const hookRes = await fetch(`${gateway}/hook`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-Webhook-Secret": hookSecret, ...UA },
  body: JSON.stringify({
    event_id: `probe-${Date.now()}`,
    payment: { amount: order.pay.chargedAmount, currency: "IDR", sender_name: "PROBE" },
    notification: { received_at: new Date().toISOString() },
  }),
});
const hookJson = await hookRes.json() as Record<string, any>;
hookJson.matched === order.pay.invoiceId
  ? ok("gateway mencocokkan pembayaran", String(hookJson.matched))
  : bad("gateway tidak mencocokkan pembayaran", JSON.stringify(hookJson));

let view: Record<string, any> | null = null;
for (let i = 0; i < 15; i++) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const res = await fetch(`${base}/api/orders/${order.orderCode}?t=${order.accessToken}`, { headers: UA });
  if (!res.ok) continue;
  view = await res.json() as Record<string, any>;
  if (view.status === "DELIVERED" || view.status === "FAILED") break;
}

if (view?.status === "DELIVERED" && view.delivered?.length === 1) {
  ok("callback dari internet diterima + barang terkirim", `${view.status} → ${view.delivered[0].payload}`);
} else {
  bad("pesanan tidak sampai DELIVERED", JSON.stringify({ status: view?.status, error: view?.deliveryError }));
}

const report = await fetch(`${base}/api/admin/report`, { headers: { "x-admin-key": adminKey, ...UA } });
const reportJson = await report.json() as Record<string, any>;
ok("laporan laba produksi", JSON.stringify(reportJson.report?.ledger));

const noToken = await fetch(`${base}/api/orders/${order.orderCode}`, { headers: UA });
noToken.status === 404 ? ok("tanpa token tetap 404", "produksi") : bad("tanpa token harus 404", String(noToken.status));

console.log(process.exitCode === 1 ? "\nPROBE PRODUKSI GAGAL" : "\nPROBE PRODUKSI LULUS");