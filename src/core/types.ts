import type { Rupiah } from "./money.ts";

export type OrderStatus =
  | "PENDING_PAYMENT"
  | "PAID"
  | "DELIVERING"
  | "DELIVERED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export interface Tier {
  minQty: number;
  unitPrice: Rupiah;
}

export interface Variant {
  id: string;
  name: string;
  price: Rupiah;
  cost: Rupiah;
  /** S&K per varian: ini yang jadi payung, bukan disclaimer global. */
  warranty: string;
  terms: string;
  tiers?: Tier[];
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  description: string;
  active: boolean;
  sort: number;
  variants: Variant[];
}

export type StockStatus = "available" | "reserved" | "delivered";

export interface StockItem {
  id: string;
  variantId: string;
  /** Isi yang diserahkan ke pembeli saat lunas (kode voucher, akun, dsb). */
  payload: string;
  cost: Rupiah;
  status: StockStatus;
  orderCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderLine {
  variantId: string;
  variantName: string;
  productName: string;
  qty: number;
  unitPrice: Rupiah;
  lineTotal: Rupiah;
}

export interface Buyer {
  name: string;
  contact: string;
}

export interface DeliveredItem {
  variantId: string;
  payload: string;
}

export interface Order {
  code: string;
  status: OrderStatus;
  lines: OrderLine[];
  subtotal: Rupiah;
  /** Yang dibayar pembeli ke gateway (harga + kode unik dari gateway). */
  chargedAmount: Rupiah | null;
  /** Nilai yang benar-benar masuk ke rekening (dari gateway, bukan hitungan toko). */
  paidAmount: Rupiah | null;
  buyer: Buyer;
  /** Rahasia pembeli: kode order saja tidak cukup untuk membuka pesanan. */
  accessToken: string;
  invoiceId: string | null;
  qrisUrl: string | null;
  expiresAt: string | null;
  reservedStockIds: string[];
  delivered: DeliveredItem[];
  deliveryAttempts: number;
  deliveryError: string | null;
  /**
   * Waktu (ISO) saat sebuah proses MENGKLAIM pengiriman. Dipakai sebagai sewa:
   * order DELIVERING hanya boleh dilanjutkan proses lain kalau klaimnya sudah basi,
   * sehingga satu order tidak dikirim dua kali oleh dua callback bersamaan.
   */
  deliveryClaimedAt: string | null;
  paidAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LedgerKind = "SALE" | "GATEWAY_FEE" | "COGS";

export interface LedgerEntry {
  id: string;
  orderCode: string;
  kind: LedgerKind;
  /** Bertanda: pemasukan positif, biaya negatif. */
  amount: Rupiah;
  at: string;
  note: string | null;
}