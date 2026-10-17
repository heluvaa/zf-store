import { dayKey, orderCode, randomToken } from "../core/codes.ts";
import { DomainError } from "../core/errors.ts";
import { entriesForPaidOrder, summarize, type LedgerSummary } from "../core/ledger.ts";
import { MAX_PAYMENT, MIN_PAYMENT, rp, assertRupiah } from "../core/money.ts";
import { MAX_DELIVERY_ATTEMPTS, ORDER_TTL_SECONDS } from "../core/order.ts";
import { buildQuote, type Quote } from "../core/pricing.ts";
import { totalCost } from "../core/stock.ts";
import type { Buyer, LedgerEntry, Order, OrderStatus, Product, StockItem } from "../core/types.ts";
import type { DeliveryStrategy } from "../deliver/digital.ts";
import { parseGatewayCallback, verifyGatewayCallback, type QrisGateway } from "../gateways/qris.ts";
import type { Repositories } from "../repos/types.ts";

export interface ServiceConfig {
  callbackUrl: string;
  callbackSecret: string;
  mdrBps: number;
  orderTtlSeconds?: number;
  maxDeliveryAttempts?: number;
  /** Umur klaim pengiriman sebelum dianggap basi dan boleh dilanjutkan proses lain. */
  deliveryLeaseMs?: number;
}

/**
 * Sewa klaim pengiriman. Cukup lama untuk menutup satu percobaan kirim yang lambat,
 * cukup pendek supaya order yang prosesnya mati cepat dilanjutkan.
 */
export const DELIVERY_LEASE_MS = 120_000;

export interface ServiceDeps {
  repos: Repositories;
  gateway: QrisGateway;
  delivery: DeliveryStrategy;
  config: ServiceConfig;
  now?: () => Date;
  newToken?: () => string;
}

export interface CreateOrderRequest {
  items: { variantId: string; qty: number }[];
  buyer: { name?: unknown; contact?: unknown };
}

export interface CreateOrderResult {
  orderCode: string;
  accessToken: string;
  status: OrderStatus;
  quote: Quote;
  pay: { invoiceId: string; chargedAmount: number; qrisUrl: string; expiresAt: string | null };
}

export interface PublicOrderView {
  orderCode: string;
  status: OrderStatus;
  buyerName: string;
  lines: Order["lines"];
  subtotal: number;
  chargedAmount: number | null;
  expiresAt: string | null;
  paidAt: string | null;
  deliveredAt: string | null;
  qrisUrl: string | null;
  delivered: Order["delivered"];
  deliveryError: string | null;
  note: string;
}

export type CallbackOutcome =
  | { kind: "bad_signature"; reason: string }
  | { kind: "bad_payload"; reason: string }
  | { kind: "unknown_invoice"; invoiceId: string }
  | { kind: "duplicate"; orderCode: string; status: OrderStatus }
  | { kind: "anomaly"; orderCode: string; reason: string }
  | { kind: "processed"; orderCode: string; status: OrderStatus; delivered: boolean };

export interface SweepReport {
  expired: string[];
  redelivered: string[];
  stillFailing: string[];
  checked: number;
}

export interface DeliveryOutcome {
  delivered: boolean;
  status: OrderStatus;
  error?: string;
}

const STATUS_NOTE: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "Menunggu pembayaran. QR hanya berlaku sampai waktu kedaluwarsa.",
  PAID: "Pembayaran diterima, pengiriman sedang diproses.",
  DELIVERING: "Pembayaran diterima, pengiriman sedang diproses.",
  DELIVERED: "Selesai. Simpan kode di bawah.",
  EXPIRED: "QR kedaluwarsa tanpa pembayaran. Buat pesanan baru kalau masih mau beli.",
  CANCELLED: "Pesanan dibatalkan, stok dikembalikan.",
  FAILED: "Pembayaran masuk tapi pengiriman otomatis gagal. Hubungi penjual — uangmu tidak hilang.",
};

function clean(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") throw new DomainError("BAD_BUYER", `${label} wajib diisi`);
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (trimmed.length < min) throw new DomainError("BAD_BUYER", `${label} minimal ${min} karakter`);
  if (trimmed.length > max) throw new DomainError("BAD_BUYER", `${label} maksimal ${max} karakter`);
  return trimmed;
}

export class StoreService {
  private repos: Repositories;
  private gateway: QrisGateway;
  private delivery: DeliveryStrategy;
  private config: Required<ServiceConfig>;
  private now: () => Date;
  private newToken: () => string;

  constructor(deps: ServiceDeps) {
    this.repos = deps.repos;
    this.gateway = deps.gateway;
    this.delivery = deps.delivery;
    this.config = {
      callbackUrl: deps.config.callbackUrl,
      callbackSecret: deps.config.callbackSecret,
      mdrBps: deps.config.mdrBps,
      orderTtlSeconds: deps.config.orderTtlSeconds ?? ORDER_TTL_SECONDS,
      maxDeliveryAttempts: deps.config.maxDeliveryAttempts ?? MAX_DELIVERY_ATTEMPTS,
      deliveryLeaseMs: deps.config.deliveryLeaseMs ?? DELIVERY_LEASE_MS,
    };
    this.now = deps.now ?? (() => new Date());
    this.newToken = deps.newToken ?? (() => randomToken());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  get storage(): { backend: string; durable: boolean } {
    return { backend: this.repos.backend, durable: this.repos.durable };
  }

  async catalog(): Promise<{ products: Product[]; stock: Record<string, number> }> {
    const products = await this.repos.catalog.listProducts();
    const stock = await this.repos.stock.countAvailable();
    return { products, stock };
  }

  /** Isi stok massal (dipakai script seed / panel admin). */
  async addStock(items: { variantId: string; payload: string; cost: number }[]): Promise<number> {
    if (items.length === 0) throw new DomainError("BAD_STOCK", "tidak ada item stok");
    const cleaned = items.map((item) => {
      const variantId = String(item.variantId ?? "").trim();
      const payload = String(item.payload ?? "").trim();
      if (!variantId) throw new DomainError("BAD_STOCK", "item stok tanpa variantId");
      if (!payload) throw new DomainError("BAD_STOCK", `item stok ${variantId} tanpa payload`);
      assertRupiah(item.cost, `cost ${variantId}`);
      return { variantId, payload, cost: item.cost };
    });
    return this.repos.stock.addBulk(cleaned);
  }

  async stockAvailable(): Promise<Record<string, number>> {
    return this.repos.stock.countAvailable();
  }

  /**
   * Checkout. Harga dihitung ulang dari katalog; `items` dari klien hanya memilih
   * varian + qty. Kalau ada langkah yang gagal, stok yang sudah ditahan dilepas —
   * order gagal tidak boleh menyisakan stok terkunci.
   */
  async createOrder(request: CreateOrderRequest): Promise<CreateOrderResult> {
    const buyer: Buyer = {
      name: clean(request.buyer?.name, "nama", 2, 60),
      contact: clean(request.buyer?.contact, "kontak", 5, 80),
    };
    if (!Array.isArray(request.items) || request.items.length === 0) {
      throw new DomainError("EMPTY_ORDER", "pesanan tanpa item");
    }
    if (request.items.length > 10) throw new DomainError("TOO_MANY_LINES", "maksimal 10 baris per pesanan");

    const quoteInputs: { productName: string; variant: Product["variants"][number]; qty: number }[] = [];
    for (const raw of request.items) {
      const qty = Number(raw?.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
        throw new DomainError("BAD_QTY", `qty ${String(raw?.qty)} tidak sah`);
      }
      const found = await this.repos.catalog.getVariant(String(raw?.variantId ?? ""));
      if (!found) throw new DomainError("VARIANT_NOT_FOUND", `varian ${String(raw?.variantId)} tidak ada`);
      if (!found.product.active) throw new DomainError("PRODUCT_INACTIVE", `produk ${found.product.slug} sedang tidak dijual`);
      quoteInputs.push({ productName: found.product.name, variant: found.variant, qty });
    }
    const quote = buildQuote(quoteInputs, this.config.mdrBps);
    if (quote.total < MIN_PAYMENT || quote.total > MAX_PAYMENT) {
      throw new DomainError("AMOUNT_RANGE", `total ${rp(quote.total)} di luar batas gateway (${rp(MIN_PAYMENT)}..${rp(MAX_PAYMENT)})`);
    }

    const day = dayKey(this.now());
    const seq = await this.repos.sequence.nextSequence(day);
    const code = orderCode(day, seq);

    const reserved: StockItem[] = [];
    try {
      for (const line of quote.lines) {
        const taken = await this.repos.stock.reserve(line.variantId, line.qty, code);
        reserved.push(...taken);
      }
    } catch (e) {
      await this.repos.stock.releaseByOrder(code).catch(() => 0);
      throw e;
    }

    let invoice;
    try {
      invoice = await this.gateway.createInvoice({
        amount: quote.total,
        reference: code,
        callbackUrl: this.config.callbackUrl,
        callbackSecret: this.config.callbackSecret,
        expiresIn: this.config.orderTtlSeconds,
      });
    } catch (e) {
      await this.repos.stock.releaseByOrder(code).catch(() => 0);
      throw e;
    }

    const at = this.iso();
    const expiresAt = invoice.expiresAt ?? new Date(this.now().getTime() + this.config.orderTtlSeconds * 1000).toISOString();
    const order: Order = {
      code,
      status: "PENDING_PAYMENT",
      lines: quote.lines,
      subtotal: quote.subtotal,
      chargedAmount: invoice.chargedAmount,
      paidAmount: null,
      buyer,
      accessToken: this.newToken(),
      invoiceId: invoice.invoiceId,
      qrisUrl: invoice.qrisUrl,
      expiresAt,
      reservedStockIds: reserved.map((item) => item.id),
      delivered: [],
      deliveryAttempts: 0,
      deliveryError: null,
      deliveryClaimedAt: null,
      paidAt: null,
      deliveredAt: null,
      createdAt: at,
      updatedAt: at,
    };

    try {
      await this.repos.orders.insert(order);
    } catch (e) {
      await this.repos.stock.releaseByOrder(code).catch(() => 0);
      throw e;
    }

    return {
      orderCode: order.code,
      accessToken: order.accessToken,
      status: order.status,
      quote,
      pay: {
        invoiceId: invoice.invoiceId,
        chargedAmount: invoice.chargedAmount,
        qrisUrl: invoice.qrisUrl,
        expiresAt: order.expiresAt,
      },
    };
  }

  async getPublicOrder(code: string, token: string | null): Promise<PublicOrderView | null> {
    const order = await this.repos.orders.getByCode(code);
    if (!order) return null;
    if (!token || token !== order.accessToken) return null;
    return this.view(order);
  }

  async getOrderForAdmin(code: string): Promise<PublicOrderView | null> {
    const order = await this.repos.orders.getByCode(code);
    return order ? { ...this.view(order), deliveryError: order.deliveryError } : null;
  }

  private view(order: Order): PublicOrderView {
    return {
      orderCode: order.code,
      status: order.status,
      buyerName: order.buyer.name,
      lines: order.lines,
      subtotal: order.subtotal,
      chargedAmount: order.chargedAmount,
      expiresAt: order.expiresAt,
      paidAt: order.paidAt,
      deliveredAt: order.deliveredAt,
      qrisUrl: order.status === "PENDING_PAYMENT" ? order.qrisUrl : null,
      delivered: order.status === "DELIVERED" ? order.delivered : [],
      deliveryError: order.status === "FAILED" ? order.deliveryError : null,
      note: STATUS_NOTE[order.status],
    };
  }

  /**
   * Callback pembayaran dari gateway. Idempoten: satu pembayaran = satu pengiriman,
   * walau callback datang berkali-kali (gateway retry sampai 5x).
   */
  async handlePaymentCallback(input: {
    rawBody: string;
    timestamp: string | null;
    signature: string | null;
  }): Promise<CallbackOutcome> {
    const verify = verifyGatewayCallback({
      rawBody: input.rawBody,
      timestamp: input.timestamp,
      signature: input.signature,
      secret: this.config.callbackSecret,
      nowMs: this.now().getTime(),
    });
    if (!verify.ok) return { kind: "bad_signature", reason: verify.reason ?? "tidak sah" };

    let event;
    try {
      event = parseGatewayCallback(input.rawBody);
    } catch (e) {
      const reason = e instanceof DomainError ? e.message : "body tidak terbaca";
      return { kind: "bad_payload", reason };
    }

    const byInvoice = await this.repos.orders.getByInvoiceId(event.invoiceId);
    const order = byInvoice ?? (event.reference ? await this.repos.orders.getByCode(event.reference) : null);
    if (!order) return { kind: "unknown_invoice", invoiceId: event.invoiceId };

    const paidAt = event.paidAt ?? this.iso();
    const firstTime = await this.repos.payments.recordOnce({
      gateway: "qris",
      invoiceId: event.invoiceId,
      orderCode: order.code,
      amount: event.amount,
      senderName: event.senderName,
      gatewayEventId: event.eventId,
      paidAt,
      rawPayload: input.rawBody,
    });

    const fresh = (await this.repos.orders.getByCode(order.code)) ?? order;

    if (fresh.status === "DELIVERED") {
      return { kind: "duplicate", orderCode: fresh.code, status: fresh.status };
    }
    // Uang masuk untuk order yang sudah mati: jangan kirim otomatis, jangan juga
    // membuat gateway retry selamanya. Dicatat sebagai anomali untuk manusia.
    if (fresh.status === "EXPIRED" || fresh.status === "CANCELLED") {
      return { kind: "anomaly", orderCode: fresh.code, reason: "late_payment" };
    }
    if (fresh.status === "FAILED") {
      return { kind: "anomaly", orderCode: fresh.code, reason: "delivery_failed" };
    }

    const expected = fresh.chargedAmount ?? fresh.subtotal;
    if (event.amount < expected) {
      return { kind: "anomaly", orderCode: fresh.code, reason: `underpaid:${event.amount}<${expected}` };
    }

    let current = fresh;
    if (current.status === "PENDING_PAYMENT") {
      const moved = await this.repos.orders.transition(current.code, ["PENDING_PAYMENT"], {
        status: "PAID",
        paidAt,
        paidAmount: event.amount,
      });
      current = (await this.repos.orders.getByCode(current.code)) ?? current;
      if (moved) await this.writeLedger(current, event.amount);
    }

    if (current.status === "PAID" || current.status === "DELIVERING") {
      const outcome = await this.deliverOrder(current.code);
      return {
        kind: firstTime ? "processed" : "duplicate",
        orderCode: current.code,
        status: outcome.status,
        delivered: outcome.delivered,
      };
    }

    return { kind: "processed", orderCode: current.code, status: current.status, delivered: current.status === "DELIVERED" };
  }

  private async writeLedger(order: Order, paidAmount: number): Promise<void> {
    const items = await this.repos.stock.listByOrder(order.code);
    const entries: LedgerEntry[] = entriesForPaidOrder({
      orderCode: order.code,
      paidAmount,
      saleAmount: order.subtotal,
      cogs: totalCost(items),
      mdrBps: this.config.mdrBps,
      at: this.iso(),
    });
    await this.repos.ledger.append(entries);
  }

  /**
   * Kirim pesanan. Aman dipanggil berkali-kali: CAS `PAID|DELIVERING -> DELIVERING`
   * yang menentukan siapa yang benar-benar mengirim, jadi dua callback bersamaan
   * tidak mengirim dua kali.
   */
  async deliverOrder(code: string): Promise<DeliveryOutcome> {
    const order = await this.repos.orders.getByCode(code);
    if (!order) throw new DomainError("ORDER_NOT_FOUND", `order ${code} tidak ada`);
    if (order.status === "DELIVERED") return { delivered: true, status: "DELIVERED" };
    if (order.status !== "PAID" && order.status !== "DELIVERING") {
      return { delivered: false, status: order.status, error: `status ${order.status} tidak bisa dikirim` };
    }

    // Klaim eksklusif bersewa: dua callback bersamaan tidak boleh mengirim dua kali,
    // sementara order DELIVERING yang prosesnya mati tetap bisa dilanjutkan.
    const claimedAt = this.iso();
    const staleBefore = new Date(this.now().getTime() - this.config.deliveryLeaseMs).toISOString();
    const claimed = await this.repos.orders.claimForDelivery(code, claimedAt, staleBefore);
    if (!claimed) {
      const raced = await this.repos.orders.getByCode(code);
      return { delivered: raced?.status === "DELIVERED", status: raced?.status ?? order.status, error: "diklaim proses lain" };
    }

    const items = await this.repos.stock.listByOrder(code);
    const attempts = order.deliveryAttempts + 1;
    let result;
    try {
      result = await this.delivery.deliver({ order: { ...order, status: "DELIVERING" }, items });
    } catch (e) {
      result = { ok: false, items: [], error: e instanceof Error ? e.message : String(e) };
    }

    if (result.ok && result.items.length > 0) {
      await this.repos.stock.markDeliveredByOrder(code);
      await this.repos.orders.transition(code, ["DELIVERING"], {
        status: "DELIVERED",
        delivered: result.items,
        deliveredAt: this.iso(),
        deliveryAttempts: attempts,
        deliveryError: null,
      });
      return { delivered: true, status: "DELIVERED" };
    }

    const exhausted = attempts >= this.config.maxDeliveryAttempts;
    const error = result.error ?? "pengiriman tidak menghasilkan item";
    await this.repos.orders.transition(code, ["DELIVERING"], exhausted
      ? { status: "FAILED", deliveryAttempts: attempts, deliveryError: error }
      : { status: "PAID", deliveryAttempts: attempts, deliveryError: error });
    return { delivered: false, status: exhausted ? "FAILED" : "PAID", error };
  }

  async cancelOrder(code: string, reason = "dibatalkan penjual"): Promise<{ cancelled: boolean; status: OrderStatus }> {
    const order = await this.repos.orders.getByCode(code);
    if (!order) throw new DomainError("ORDER_NOT_FOUND", `order ${code} tidak ada`);
    const ok = await this.repos.orders.transition(code, ["PENDING_PAYMENT"], {
      status: "CANCELLED",
      deliveryError: reason,
    });
    if (ok) await this.repos.stock.releaseByOrder(code);
    const fresh = await this.repos.orders.getByCode(code);
    return { cancelled: ok, status: fresh?.status ?? order.status };
  }

  /**
   * Sweep: order yang lewat masa berlaku dilepas (stok kembali), dan pengiriman
   * yang macet (PAID/DELIVERING) dilanjutkan. Wajib dipanggil saat boot juga —
   * kalau tidak, order yang sudah dibayar bisa berhenti selamanya di tengah jalan.
   */
  async sweep(): Promise<SweepReport> {
    const nowMs = this.now().getTime();
    const expiredCodes: string[] = [];
    const pending = await this.repos.orders.listByStatuses(["PENDING_PAYMENT"], 200);
    for (const order of pending) {
      const expires = order.expiresAt ? Date.parse(order.expiresAt) : Number.NaN;
      if (!Number.isFinite(expires) || expires > nowMs) continue;
      const ok = await this.repos.orders.transition(order.code, ["PENDING_PAYMENT"], { status: "EXPIRED" });
      if (!ok) continue;
      await this.repos.stock.releaseByOrder(order.code);
      expiredCodes.push(order.code);
    }

    const stuck = await this.repos.orders.listByStatuses(["PAID", "DELIVERING"], 100);
    const redelivered: string[] = [];
    const stillFailing: string[] = [];
    for (const order of stuck) {
      const outcome = await this.deliverOrder(order.code);
      if (outcome.delivered) redelivered.push(order.code);
      else if (outcome.status === "FAILED") stillFailing.push(order.code);
      else stillFailing.push(order.code);
    }

    return {
      expired: expiredCodes,
      redelivered,
      stillFailing,
      checked: pending.length + stuck.length,
    };
  }

  async report(): Promise<{
    ledger: LedgerSummary;
    storage: { backend: string; durable: boolean };
    pendingOrders: number;
    failedOrders: number;
    stock: Record<string, number>;
  }> {
    const entries = await this.repos.ledger.listAll(1000);
    const [pending, failed, stock] = await Promise.all([
      this.repos.orders.listByStatuses(["PENDING_PAYMENT"], 500),
      this.repos.orders.listByStatuses(["FAILED"], 500),
      this.repos.stock.countAvailable(),
    ]);
    return {
      ledger: summarize(entries),
      storage: this.storage,
      pendingOrders: pending.length,
      failedOrders: failed.length,
      stock,
    };
  }

  async recentOrders(limit = 20): Promise<Order[]> {
    return this.repos.orders.listRecent(limit);
  }
}