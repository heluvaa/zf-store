import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "../core/errors.ts";
import type { Rupiah } from "../core/money.ts";

export type FetchLike = typeof fetch;

/** Payload callback gateway (bentuknya milik worker QRIS, bukan milik kita). */
export interface GatewayCallbackEvent {
  invoiceId: string;
  amount: Rupiah;
  baseAmount: Rupiah;
  reference: string | null;
  status: string;
  senderName: string | null;
  eventId: string | null;
  paidAt: string | null;
}

export interface GatewayInvoice {
  invoiceId: string;
  amount: Rupiah;
  chargedAmount: Rupiah;
  qrisPayload: string;
  qrisUrl: string;
  status: string;
  expiresAt: string | null;
}

export interface GatewayStatus {
  invoiceId: string;
  status: string;
  storedStatus: string;
  chargedAmount: Rupiah;
  baseAmount: Rupiah;
  reference: string | null;
  paidAt: string | null;
  expiresAt: string | null;
}

export interface CreateInvoiceInput {
  amount: Rupiah;
  reference: string;
  callbackUrl: string;
  callbackSecret: string;
  expiresIn: number;
}

export interface QrisGateway {
  createInvoice(input: CreateInvoiceInput): Promise<GatewayInvoice>;
  getStatus(query: { invoiceId?: string; reference?: string }): Promise<GatewayStatus | null>;
  readonly baseUrl: string;
}

export interface GatewayConfig {
  baseUrl: string;
  secret: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const asInt = (v: unknown, label: string): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n)) throw new DomainError("GATEWAY_BAD_RESPONSE", `${label} bukan integer dari gateway`);
  return n;
};

const asStr = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Klien HTTP untuk worker QRIS Gateway (POST /invoice, GET /invoice).
 * Sengaja tidak menyimpan apa pun: kontraknya dijaga di sini, sisanya di service.
 */
export function httpQrisGateway(cfg: GatewayConfig): QrisGateway {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const timeout = cfg.timeoutMs ?? 15_000;

  async function call(path: string, init: { method: string; body?: string }) {
    const res = await doFetch(`${base}${path}`, {
      method: init.method,
      headers: { "X-Webhook-Secret": cfg.secret, "Content-Type": "application/json" },
      body: init.body,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* biarkan null */ }
    return { status: res.status, ok: res.ok, body: parsed, text };
  }

  return {
    baseUrl: base,
    async createInvoice(input) {
      if (!Number.isInteger(input.amount) || input.amount < 1) {
        throw new DomainError("BAD_AMOUNT", "amount invoice harus integer rupiah");
      }
      const res = await call("/invoice", {
        method: "POST",
        body: JSON.stringify({
          amount: input.amount,
          reference: input.reference,
          callback_url: input.callbackUrl,
          callback_secret: input.callbackSecret,
          expires_in: input.expiresIn,
        }),
      });
      if (!res.ok) {
        throw new DomainError("GATEWAY_HTTP", `create invoice gagal (${res.status}): ${res.text.slice(0, 200)}`);
      }
      const body = res.body as Record<string, unknown> | null;
      if (!body?.invoice_id) throw new DomainError("GATEWAY_BAD_RESPONSE", "gateway tidak mengembalikan invoice_id");
      return {
        invoiceId: String(body.invoice_id),
        amount: asInt(body.amount, "amount"),
        chargedAmount: asInt(body.charged_amount, "charged_amount"),
        qrisPayload: String(body.qris_payload ?? ""),
        qrisUrl: String(body.qris_url ?? ""),
        status: String(body.status ?? "pending"),
        expiresAt: asStr(body.expires_at),
      };
    },
    async getStatus(query) {
      const params = new URLSearchParams();
      if (query.invoiceId) params.set("id", query.invoiceId);
      else if (query.reference) params.set("reference", query.reference);
      else throw new DomainError("BAD_QUERY", "butuh invoiceId atau reference");
      const res = await call(`/invoice?${params.toString()}`, { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new DomainError("GATEWAY_HTTP", `cek status gagal (${res.status}): ${res.text.slice(0, 200)}`);
      const body = res.body as Record<string, unknown>;
      return {
        invoiceId: String(body.invoice_id),
        status: String(body.status),
        storedStatus: String(body.stored_status ?? body.status),
        chargedAmount: asInt(body.charged_amount, "charged_amount"),
        baseAmount: asInt(body.base_amount, "base_amount"),
        reference: asStr(body.reference),
        paidAt: asStr(body.paid_at),
        expiresAt: asStr(body.expires_at),
      };
    },
  };
}

export function parseGatewayCallback(rawBody: string): GatewayCallbackEvent {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new DomainError("BAD_CALLBACK", "body callback bukan JSON");
  }
  if (!body.invoice_id) throw new DomainError("BAD_CALLBACK", "callback tanpa invoice_id");
  return {
    invoiceId: String(body.invoice_id),
    amount: asInt(body.amount, "amount"),
    baseAmount: asInt(body.base_amount ?? body.amount, "base_amount"),
    reference: asStr(body.reference),
    status: String(body.status ?? ""),
    senderName: asStr(body.sender_name),
    eventId: asStr(body.event_id),
    paidAt: asStr(body.paid_at),
  };
}

export interface VerifyInput {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  nowMs?: number;
  toleranceSeconds?: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Tanda tangan dihitung atas body MENTAH yang benar-benar diterima.
 * Jangan parse lalu stringify ulang — urutan/spasi bisa berubah dan tanda tangan
 * yang sah ikut ditolak.
 */
export function verifyGatewayCallback(input: VerifyInput): VerifyResult {
  if (!input.secret) return { ok: false, reason: "callback_secret belum dikonfigurasi" };
  if (!input.signature) return { ok: false, reason: "header X-Callback-Signature tidak ada" };
  if (!input.timestamp) return { ok: false, reason: "header X-Callback-Timestamp tidak ada" };
  const expected = "sha256=" + createHmac("sha256", input.secret).update(`${input.timestamp}.${input.rawBody}`).digest("hex");
  const a = Buffer.from(input.signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "tanda tangan tidak cocok" };

  const nowMs = input.nowMs ?? Date.now();
  const tolerance = (input.toleranceSeconds ?? 300) * 1000;
  const tsMs = Number(input.timestamp) * 1000;
  if (!Number.isFinite(tsMs)) return { ok: false, reason: "timestamp bukan angka" };
  // Toleransi dua arah: menolak replay lama, dan tidak menolak karena jam server lebih cepat.
  if (Math.abs(nowMs - tsMs) > tolerance) return { ok: false, reason: "timestamp di luar toleransi" };
  return { ok: true };
}