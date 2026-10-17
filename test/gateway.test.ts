import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { DomainError } from "../src/core/errors.ts";
import { httpQrisGateway, parseGatewayCallback, verifyGatewayCallback } from "../src/gateways/qris.ts";
import { signedCallback, CALLBACK_SECRET } from "./helpers.ts";

test("tanda tangan callback yang sah diterima", () => {
  const signed = signedCallback({ invoiceId: "inv_1", amount: 25_001 });
  const result = verifyGatewayCallback({
    rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature, secret: CALLBACK_SECRET,
  });
  assert.equal(result.ok, true, result.reason);
});

test("body yang diubah setelah ditandatangani ditolak", () => {
  const signed = signedCallback({ invoiceId: "inv_1", amount: 25_001 });
  const tampered = signed.rawBody.replace("25001", "99999");
  const result = verifyGatewayCallback({
    rawBody: tampered, timestamp: signed.timestamp, signature: signed.signature, secret: CALLBACK_SECRET,
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /tidak cocok/);
});

test("secret salah, header kurang, dan pesan basi ditolak", () => {
  const signed = signedCallback({ invoiceId: "inv_1", amount: 25_001 });
  assert.equal(verifyGatewayCallback({ rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature, secret: "secret-lain-yang-panjang" }).ok, false);
  assert.equal(verifyGatewayCallback({ rawBody: signed.rawBody, timestamp: null, signature: signed.signature, secret: CALLBACK_SECRET }).ok, false);
  assert.equal(verifyGatewayCallback({ rawBody: signed.rawBody, timestamp: signed.timestamp, signature: null, secret: CALLBACK_SECRET }).ok, false);
  assert.equal(verifyGatewayCallback({ rawBody: signed.rawBody, timestamp: signed.timestamp, signature: signed.signature, secret: "" }).ok, false);

  const old = new Date(Date.now() - 3600_000);
  const stale = signedCallback({ invoiceId: "inv_1", amount: 25_001 }, CALLBACK_SECRET, old);
  const result = verifyGatewayCallback({
    rawBody: stale.rawBody, timestamp: stale.timestamp, signature: stale.signature, secret: CALLBACK_SECRET,
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /toleransi/);
});

test("payload callback dipetakan apa adanya, body rusak ditolak", () => {
  const event = parseGatewayCallback(JSON.stringify({
    invoice_id: "inv_9", amount: 25_001, base_amount: 25_000, reference: "ZF-20261018-001",
    status: "paid", sender_name: "BUDI", event_id: "e1", paid_at: "2026-10-18T03:10:00.000Z",
  }));
  assert.equal(event.invoiceId, "inv_9");
  assert.equal(event.amount, 25_001);
  assert.equal(event.baseAmount, 25_000);
  assert.equal(event.reference, "ZF-20261018-001");
  assert.throws(() => parseGatewayCallback("bukan json"), /JSON/);
  assert.throws(() => parseGatewayCallback("{}"), /invoice_id/);
});

test("klien HTTP bicara dengan gateway sungguhan lewat HTTP", async () => {
  const seen: { path: string; method: string; secret: string | undefined; body: unknown }[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({
        path: req.url ?? "", method: req.method ?? "",
        secret: req.headers["x-webhook-secret"] as string | undefined,
        body: raw ? JSON.parse(raw) : null,
      });
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/invoice" && req.method === "POST") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          invoice_id: "inv_live", amount: 25_000, charged_amount: 25_013, reference: "ZF-1",
          status: "pending", expires_at: "2026-10-18T03:15:00.000Z",
          qris_payload: "000201010212", qris_url: "https://gw/qris?invoice_id=inv_live&t=a",
        }));
        return;
      }
      if (url.pathname === "/invoice" && req.method === "GET") {
        const id = url.searchParams.get("id");
        const reference = url.searchParams.get("reference");
        if (id === "inv_hilang") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invoice not found" }));
          return;
        }
        if (id !== "inv_live" && reference !== "ZF-1") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "boom" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true, invoice_id: "inv_live", status: "paid", stored_status: "paid",
          base_amount: 25_000, charged_amount: 25_013, reference: "ZF-1",
          paid_at: "2026-10-18T03:05:00.000Z", expires_at: "2026-10-18T03:15:00.000Z",
        }));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const gateway = httpQrisGateway({ baseUrl: `http://127.0.0.1:${port}`, secret: "rahasia-uji" });

    const invoice = await gateway.createInvoice({
      amount: 25_000, reference: "ZF-1", callbackUrl: "https://toko.test/api/pay/callback",
      callbackSecret: "cs", expiresIn: 900,
    });
    assert.equal(invoice.invoiceId, "inv_live");
    assert.equal(invoice.chargedAmount, 25_013);
    assert.equal(invoice.amount, 25_000);
    assert.equal(invoice.expiresAt, "2026-10-18T03:15:00.000Z");

    const post = seen.find((s) => s.method === "POST");
    assert.equal(post?.secret, "rahasia-uji", "secret harus dikirim sebagai X-Webhook-Secret");
    assert.deepEqual(post?.body, {
      amount: 25_000, reference: "ZF-1", callback_url: "https://toko.test/api/pay/callback",
      callback_secret: "cs", expires_in: 900,
    });

    const status = await gateway.getStatus({ invoiceId: "inv_live" });
    assert.equal(status?.status, "paid");
    assert.equal(status?.chargedAmount, 25_013);
    const get = seen.find((s) => s.method === "GET");
    assert.match(String(get?.path), /\?id=inv_live$/);

    assert.equal(await gateway.getStatus({ invoiceId: "inv_hilang" }), null, "404 dari gateway = null, bukan error");

    await assert.rejects(
      () => gateway.getStatus({ reference: "ZF-404" }).then(() => {
        // server balas 500 untuk query ini
      }),
      (e: unknown) => e instanceof DomainError && e.code === "GATEWAY_HTTP",
    );
    assert.equal(seen.filter((s) => s.method === "GET").length, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});