import { randomBytes } from "node:crypto";
import { DomainError } from "../core/errors.ts";
import { assertTransition } from "../core/order.ts";
import type { LedgerEntry, Order, OrderStatus, StockItem } from "../core/types.ts";
import type {
  CatalogRepository, LedgerRepository, NewStockItem, OrderRepository, PaymentRecord,
  PaymentRepository, Repositories, SequenceRepository, StockRepository,
} from "./types.ts";

let counter = 0;
const uid = (prefix: string) => `${prefix}_${(++counter).toString(36)}${randomBytes(4).toString("hex")}`;
const iso = (at: Date | string) => (typeof at === "string" ? at : at.toISOString());

function fifo(a: StockItem, b: StockItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

export interface MemoryOptions {
  products?: CatalogRepository;
  now?: () => Date;
  seedStock?: NewStockItem[];
}

/**
 * Implementasi in-memory: untuk test dan dev tanpa DB. Bukan penyimpanan nyata —
 * semua hilang saat proses mati, dan pemanggilnya wajib tahu itu (`durable: false`).
 */
export async function memoryRepositories(catalog: CatalogRepository, opts: MemoryOptions = {}): Promise<Repositories> {
  const now = opts.now ?? (() => new Date());
  const stock = new Map<string, StockItem>();
  const orders = new Map<string, Order>();
  const invoiceIndex = new Map<string, string>();
  const ledger = new Map<string, LedgerEntry>();
  const payments = new Map<string, PaymentRecord>();
  const sequences = new Map<string, number>();

  const stockRepo: StockRepository = {
    async addBulk(items) {
      const at = iso(now());
      for (const item of items) {
        const id = uid("stk");
        stock.set(id, {
          id, variantId: item.variantId, payload: item.payload, cost: item.cost,
          status: "available", orderCode: null, createdAt: at, updatedAt: at,
        });
      }
      return items.length;
    },
    async listAvailable(variantId, limit = 500) {
      return [...stock.values()]
        .filter((i) => i.variantId === variantId && i.status === "available")
        .sort(fifo)
        .slice(0, limit);
    },
    async countAvailable() {
      const out: Record<string, number> = {};
      for (const item of stock.values()) {
        if (item.status !== "available") continue;
        out[item.variantId] = (out[item.variantId] ?? 0) + 1;
      }
      return out;
    },
    async reserve(variantId, qty, orderCode) {
      const picked: StockItem[] = [];
      const pool = [...stock.values()].filter((i) => i.variantId === variantId && i.status === "available").sort(fifo);
      for (const candidate of pool) {
        if (picked.length >= qty) break;
        const current = stock.get(candidate.id);
        // CAS: kalau sudah tidak available sejak dibaca, lewati — bukan ambil paksa.
        if (!current || current.status !== "available") continue;
        const next: StockItem = { ...current, status: "reserved", orderCode, updatedAt: iso(now()) };
        stock.set(next.id, next);
        picked.push(next);
      }
      if (picked.length !== qty) {
        // gagal = tidak boleh ada yang tertahan
        for (const p of picked) {
          const current = stock.get(p.id);
          if (current) stock.set(p.id, { ...current, status: "available", orderCode: null, updatedAt: iso(now()) });
        }
        throw new DomainError("INSUFFICIENT_STOCK", `stok ${variantId} tidak cukup untuk ${qty}`);
      }
      return picked;
    },
    async releaseByOrder(orderCode) {
      let released = 0;
      for (const [id, item] of stock) {
        if (item.orderCode === orderCode && item.status === "reserved") {
          stock.set(id, { ...item, status: "available", orderCode: null, updatedAt: iso(now()) });
          released++;
        }
      }
      return released;
    },
    async markDeliveredByOrder(orderCode) {
      let marked = 0;
      for (const [id, item] of stock) {
        if (item.orderCode === orderCode && item.status !== "delivered") {
          stock.set(id, { ...item, status: "delivered", updatedAt: iso(now()) });
          marked++;
        }
      }
      return marked;
    },
    async listByOrder(orderCode) {
      return [...stock.values()].filter((i) => i.orderCode === orderCode).sort(fifo);
    },
  };

  const orderRepo: OrderRepository = {
    async insert(order) {
      if (orders.has(order.code)) throw new DomainError("DUPLICATE_ORDER", `order ${order.code} sudah ada`);
      orders.set(order.code, order);
      if (order.invoiceId) invoiceIndex.set(order.invoiceId, order.code);
    },
    async getByCode(code) { return orders.get(code) ?? null; },
    async getByInvoiceId(invoiceId) {
      const code = invoiceIndex.get(invoiceId);
      return code ? orders.get(code) ?? null : null;
    },
    async transition(code, expected, patch) {
      const current = orders.get(code);
      if (!current) return false;
      if (!expected.includes(current.status)) return false;
      assertTransition(current.status, patch.status, code);
      orders.set(code, { ...current, ...patch, updatedAt: iso(now()) });
      if (patch.invoiceId) invoiceIndex.set(patch.invoiceId, code);
      return true;
    },
    async update(code, patch) {
      const current = orders.get(code);
      if (!current) throw new DomainError("ORDER_NOT_FOUND", `order ${code} tidak ada`);
      orders.set(code, { ...current, ...patch, updatedAt: iso(now()) });
    },
    async claimForDelivery(code, at, staleBefore) {
      const current = orders.get(code);
      if (!current) return false;
      const free = current.status === "PAID"
        || (current.status === "DELIVERING" && (!current.deliveryClaimedAt || current.deliveryClaimedAt < staleBefore));
      if (!free) return false;
      assertTransition(current.status, "DELIVERING", code);
      orders.set(code, { ...current, status: "DELIVERING", deliveryClaimedAt: at, updatedAt: iso(now()) });
      return true;
    },
    async listByStatuses(statuses, limit = 100) {
      return [...orders.values()]
        .filter((o) => statuses.includes(o.status))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .slice(0, limit);
    },
    async listRecent(limit = 20) {
      return [...orders.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
    },
  };

  const ledgerRepo: LedgerRepository = {
    async append(entries) {
      let added = 0;
      for (const entry of entries) {
        const key = `${entry.orderCode}:${entry.kind}`;
        if (ledger.has(key)) continue; // idempoten
        ledger.set(key, entry);
        added++;
      }
      return added;
    },
    async listForOrder(orderCode) {
      return [...ledger.values()].filter((e) => e.orderCode === orderCode);
    },
    async listAll(limit = 500) {
      return [...ledger.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
    },
  };

  const paymentRepo: PaymentRepository = {
    async recordOnce(payment) {
      const key = `${payment.gateway}:${payment.invoiceId}`;
      if (payments.has(key)) return false;
      payments.set(key, payment);
      return true;
    },
    async get(invoiceId) { return payments.get(`qris:${invoiceId}`) ?? null; },
    async list(limit = 100) { return [...payments.values()].slice(0, limit); },
  };

  const sequenceRepo: SequenceRepository = {
    async nextSequence(day) {
      const next = (sequences.get(day) ?? 0) + 1;
      sequences.set(day, next);
      return next;
    },
  };

  const repos: Repositories = {
    catalog,
    stock: stockRepo,
    orders: orderRepo,
    ledger: ledgerRepo,
    payments: paymentRepo,
    sequence: sequenceRepo,
    backend: "memory",
    durable: false,
  };

  if (opts.seedStock?.length) await stockRepo.addBulk(opts.seedStock);
  return repos;
}