import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError } from "../core/errors.ts";
import { rp } from "../core/money.ts";
import type { StoreService } from "../app/service.ts";
import { publicOrder, publicProduct } from "./views.ts";

export interface HandlerDeps {
  service: StoreService;
  adminKey: string;
  sweepSecret: string;
  brand: string;
  demoCatalog: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;
const ORDER_RATE_LIMIT = 10;          // pesanan per menit per IP
const ORDER_RATE_WINDOW_MS = 60_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new DomainError("BODY_TOO_LARGE", "body terlalu besar");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("bukan objek");
    return parsed as Record<string, unknown>;
  } catch {
    throw new DomainError("BAD_JSON", "body bukan JSON objek");
  }
}

function errorStatus(code: string): number {
  switch (code) {
    case "BAD_JSON":
    case "BAD_BUYER":
    case "BAD_QTY":
    case "EMPTY_ORDER":
    case "TOO_MANY_LINES":
    case "AMOUNT_RANGE":
    case "BAD_CALLBACK":
    case "BODY_TOO_LARGE":
    case "BAD_AMOUNT":
      return 400;
    case "VARIANT_NOT_FOUND":
    case "ORDER_NOT_FOUND":
      return 404;
    case "INSUFFICIENT_STOCK":
    case "PRODUCT_INACTIVE":
    case "DUPLICATE_ORDER":
    case "BAD_TRANSITION":
      return 409;
    case "GATEWAY_HTTP":
    case "GATEWAY_BAD_RESPONSE":
      return 502;
    default:
      return 500;
  }
}

export function createRequestHandler(deps: HandlerDeps) {
  const orderHits = new Map<string, number[]>();

  function rateLimited(ip: string, nowMs: number): boolean {
    const hits = (orderHits.get(ip) ?? []).filter((t) => nowMs - t < ORDER_RATE_WINDOW_MS);
    hits.push(nowMs);
    orderHits.set(ip, hits);
    return hits.length > ORDER_RATE_LIMIT;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = (req.method ?? "GET").toUpperCase();
    const headers = req.headers;

    try {
      // ── Publik ─────────────────────────────────────────────
      if (path === "/health" && method === "GET") {
        sendJson(res, 200, {
          ok: true,
          service: "zf-store",
          brand: deps.brand,
          demoCatalog: deps.demoCatalog,
          storage: deps.service.storage,
        });
        return;
      }

      if ((path === "/api/catalog" || path === "/catalog") && method === "GET") {
        const { products, stock } = await deps.service.catalog();
        sendJson(res, 200, {
          ok: true,
          brand: deps.brand,
          demo: deps.demoCatalog,
          products: products.map((p) => publicProduct(p, stock)),
        });
        return;
      }

      if (path === "/api/orders" && method === "POST") {
        const ip = String(headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() || "unknown";
        const raw = await readRawBody(req);
        const body = parseJson(raw);
        // Batas laju diperiksa setelah body lolos parse: request cacat tidak boleh
        // menghabiskan kuota orang lain.
        if (rateLimited(ip, Date.now())) {
          sendJson(res, 429, { ok: false, error: "terlalu banyak pesanan, coba lagi sebentar" });
          return;
        }
        const result = await deps.service.createOrder({
          items: (body.items as { variantId: string; qty: number }[]) ?? [],
          buyer: (body.buyer as { name?: unknown; contact?: unknown }) ?? {},
        });
        sendJson(res, 201, {
          ok: true,
          orderCode: result.orderCode,
          accessToken: result.accessToken,
          status: result.status,
          quote: {
            lines: result.quote.lines,
            subtotal: result.quote.subtotal,
            subtotalText: rp(result.quote.subtotal),
            total: result.quote.total,
            totalText: rp(result.quote.total),
          },
          pay: {
            invoiceId: result.pay.invoiceId,
            chargedAmount: result.pay.chargedAmount,
            chargedAmountText: rp(result.pay.chargedAmount),
            qrisUrl: result.pay.qrisUrl,
            expiresAt: result.pay.expiresAt,
          },
        });
        return;
      }

      if (path.startsWith("/api/orders/") && method === "GET") {
        const code = decodeURIComponent(path.slice("/api/orders/".length));
        const tokenHeader = String(headers["x-order-token"] ?? "");
        const token = url.searchParams.get("t") ?? (tokenHeader.length > 0 ? tokenHeader : null);
        const adminKey = String(headers["x-admin-key"] ?? "");
        const view = adminKey && adminKey === deps.adminKey
          ? await deps.service.getOrderForAdmin(code)
          : await deps.service.getPublicOrder(code, token);
        if (!view) {
          // 404 juga untuk token salah: jangan pernah memberi tahu bahwa kode order itu ada.
          sendJson(res, 404, { ok: false, error: "pesanan tidak ditemukan" });
          return;
        }
        sendJson(res, 200, { ok: true, ...view });
        return;
      }

      // ── Callback gateway (tanda tangan wajib) ──────────────
      if (path === "/api/pay/callback" && method === "POST") {
        const raw = await readRawBody(req);
        const outcome = await deps.service.handlePaymentCallback({
          rawBody: raw,
          timestamp: String(headers["x-callback-timestamp"] ?? "") || null,
          signature: String(headers["x-callback-signature"] ?? "") || null,
        });
        switch (outcome.kind) {
          case "bad_signature":
            sendJson(res, 401, { ok: false, error: "bad signature", reason: outcome.reason });
            return;
          case "bad_payload":
            sendJson(res, 400, { ok: false, error: "bad payload", reason: outcome.reason });
            return;
          case "unknown_invoice":
            // Ditandatangani sah dan dipahami, cuma bukan invoice toko ini.
            // Balas 200 supaya gateway berhenti mencoba ulang.
            sendJson(res, 200, { ok: true, ignored: "unknown_invoice", invoiceId: outcome.invoiceId });
            return;
          case "anomaly":
            sendJson(res, 200, { ok: true, anomaly: outcome.reason, order: outcome.orderCode });
            return;
          case "duplicate":
            sendJson(res, 200, { ok: true, duplicate: true, order: outcome.orderCode, status: outcome.status });
            return;
          case "processed":
            sendJson(res, 200, { ok: true, order: outcome.orderCode, status: outcome.status, delivered: outcome.delivered });
            return;
        }
      }

      // ── Internal ───────────────────────────────────────────
      const sweepKey = String(headers["x-sweep-key"] ?? "");
      const bearer = String(headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
      const sweepOk = deps.sweepSecret.length > 0 && (sweepKey === deps.sweepSecret || bearer === deps.sweepSecret);
      if (path === "/internal/sweep" && (method === "POST" || method === "GET")) {
        if (!sweepOk) {
          sendJson(res, 401, { ok: false, error: "bad sweep key" });
          return;
        }
        const report = await deps.service.sweep();
        sendJson(res, 200, { ok: true, ...report });
        return;
      }

      if (path === "/api/admin/report" && method === "GET") {
        if (!deps.adminKey || String(headers["x-admin-key"] ?? "") !== deps.adminKey) {
          sendJson(res, 401, { ok: false, error: "bad admin key" });
          return;
        }
        const [report, recent] = await Promise.all([deps.service.report(), deps.service.recentOrders(20)]);
        sendJson(res, 200, {
          ok: true,
          report,
          recentOrders: recent.map((o) => ({
            ...publicOrder(o),
            buyerContact: o.buyer.contact,
            deliveryError: o.deliveryError,
            deliveryAttempts: o.deliveryAttempts,
          })),
        });
        return;
      }

      if (path.startsWith("/api/admin/orders/") && path.endsWith("/cancel") && method === "POST") {
        if (!deps.adminKey || String(headers["x-admin-key"] ?? "") !== deps.adminKey) {
          sendJson(res, 401, { ok: false, error: "bad admin key" });
          return;
        }
        const code = decodeURIComponent(path.slice("/api/admin/orders/".length, -"/cancel".length));
        const result = await deps.service.cancelOrder(code);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      sendJson(res, 404, { ok: false, error: "rute tidak dikenal", path });
    } catch (e) {
      if (e instanceof DomainError) {
        sendJson(res, errorStatus(e.code), { ok: false, error: e.code, message: e.message });
        return;
      }
      console.error("unhandled error", e);
      sendJson(res, 500, { ok: false, error: "internal error" });
    }
  };
}