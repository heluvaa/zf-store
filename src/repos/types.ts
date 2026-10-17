import type { LedgerEntry, Order, OrderStatus, Product, StockItem } from "../core/types.ts";

/** Katalog dibaca dari satu file data, bukan dari kode. */
export interface CatalogRepository {
  listProducts(): Promise<Product[]>;
  getProduct(slug: string): Promise<Product | null>;
  getVariant(variantId: string): Promise<{ product: Product; variant: Product["variants"][number] } | null>;
}

export interface NewStockItem {
  variantId: string;
  payload: string;
  cost: number;
}

export interface StockRepository {
  addBulk(items: NewStockItem[]): Promise<number>;
  listAvailable(variantId: string, limit?: number): Promise<StockItem[]>;
  countAvailable(): Promise<Record<string, number>>;
  /**
   * Ambil `qty` item FIFO untuk satu order secara atomik (compare-and-swap).
   * Gagal = tidak ada yang tertahan (rollback), lalu lempar DomainError INSUFFICIENT_STOCK.
   */
  reserve(variantId: string, qty: number, orderCode: string): Promise<StockItem[]>;
  /** Kembalikan semua item milik order ini ke available (cancel/expire). */
  releaseByOrder(orderCode: string): Promise<number>;
  /** Tandai item milik order ini sebagai delivered. */
  markDeliveredByOrder(orderCode: string): Promise<number>;
  listByOrder(orderCode: string): Promise<StockItem[]>;
}

export interface SequenceRepository {
  /** Nomor urut order per hari (WIB), atomik. */
  nextSequence(day: string): Promise<number>;
}

export interface OrderRepository {
  insert(order: Order): Promise<void>;
  getByCode(code: string): Promise<Order | null>;
  getByInvoiceId(invoiceId: string): Promise<Order | null>;
  /** CAS: hanya berubah kalau status saat ini ada di `expected`. false = tidak ada yang berubah. */
  transition(code: string, expected: OrderStatus[], patch: Partial<Order> & { status: OrderStatus }): Promise<boolean>;
  /**
   * Ambil hak mengirim untuk satu order (eksklusif):
   *  - status PAID → selalu boleh
   *  - status DELIVERING → hanya kalau `deliveryClaimedAt` kosong atau lebih tua dari `staleBefore`
   * true = proses inilah pemiliknya.
   */
  claimForDelivery(code: string, at: string, staleBefore: string): Promise<boolean>;
  update(code: string, patch: Partial<Order>): Promise<void>;
  listByStatuses(statuses: OrderStatus[], limit?: number): Promise<Order[]>;
  listRecent(limit?: number): Promise<Order[]>;
}

export interface LedgerRepository {
  /** Idempoten per (orderCode, kind) supaya callback ganda tidak menghitung laba dua kali. */
  append(entries: LedgerEntry[]): Promise<number>;
  listForOrder(orderCode: string): Promise<LedgerEntry[]>;
  listAll(limit?: number): Promise<LedgerEntry[]>;
}

export interface PaymentRecord {
  gateway: string;
  invoiceId: string;
  orderCode: string;
  amount: number;
  senderName: string | null;
  gatewayEventId: string | null;
  paidAt: string;
  rawPayload: string;
}

export interface PaymentRepository {
  /** true = baru dicatat, false = sudah pernah (callback retry). */
  recordOnce(payment: PaymentRecord): Promise<boolean>;
  get(invoiceId: string): Promise<PaymentRecord | null>;
  list(limit?: number): Promise<PaymentRecord[]>;
}

export interface Repositories {
  catalog: CatalogRepository;
  stock: StockRepository;
  orders: OrderRepository;
  ledger: LedgerRepository;
  payments: PaymentRepository;
  sequence: SequenceRepository;
  /** Nama backend yang benar-benar dipakai, untuk dilaporkan ke admin. */
  backend: string;
  durable: boolean;
}