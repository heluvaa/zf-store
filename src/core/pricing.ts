import { DomainError } from "./errors.ts";
import { applyBps, assertRupiah, type Rupiah } from "./money.ts";
import type { OrderLine, Tier, Variant } from "./types.ts";

/**
 * PLACEHOLDER: MDR QRIS merchant. Angka ini HARUS diganti dari kontrak/akun
 * merchant sendiri sebelum dipakai menghitung untung. Selama masih true, laporan
 * laba toko belum bisa dipercaya sebagai angka nyata.
 */
export const GATEWAY_RATES_ARE_PLACEHOLDER = true;
export const DEFAULT_MDR_BPS = 70; // 0,7%

export function unitPriceFor(variant: Variant, qty: number): Rupiah {
  if (!Number.isInteger(qty) || qty < 1) throw new DomainError("BAD_QTY", "qty minimal 1");
  const tiers: Tier[] = [...(variant.tiers ?? [])].sort((a, b) => a.minQty - b.minQty);
  let price = variant.price;
  for (const t of tiers) {
    if (qty >= t.minQty) price = t.unitPrice;
  }
  assertRupiah(price, `harga ${variant.id}`);
  return price;
}

export interface Quote {
  lines: OrderLine[];
  subtotal: Rupiah;
  /** Yang dibayar pembeli. Gateway akan menambahkan kode unik di atas ini. */
  total: Rupiah;
  merchantFeeBps: number;
  /** Perkiraan biaya merchant (MDR) — dipotong dari pencairan, bukan ditagih ke pembeli. */
  merchantFeeEstimate: Rupiah;
  merchantNetEstimate: Rupiah;
}

export interface QuoteInput {
  productName: string;
  variant: Variant;
  qty: number;
}

/**
 * Harga SELALU dihitung ulang di server dari katalog. Harga/total yang dikirim
 * klien tidak pernah dipakai — itu cuma masukan yang dibuang.
 */
export function buildQuote(items: QuoteInput[], mdrBps: number = DEFAULT_MDR_BPS): Quote {
  if (items.length === 0) throw new DomainError("EMPTY_ORDER", "order tanpa item");
  const lines: OrderLine[] = [];
  let subtotal = 0;
  for (const item of items) {
    const unitPrice = unitPriceFor(item.variant, item.qty);
    const lineTotal = unitPrice * item.qty;
    assertRupiah(lineTotal, "total baris");
    lines.push({
      variantId: item.variant.id,
      variantName: item.variant.name,
      productName: item.productName,
      qty: item.qty,
      unitPrice,
      lineTotal,
    });
    subtotal += lineTotal;
  }
  const fee = applyBps(subtotal, mdrBps);
  return {
    lines,
    subtotal,
    total: subtotal,
    merchantFeeBps: mdrBps,
    merchantFeeEstimate: fee,
    merchantNetEstimate: subtotal - fee,
  };
}