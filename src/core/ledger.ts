import { applyBps, type Rupiah } from "./money.ts";
import type { LedgerEntry, LedgerKind } from "./types.ts";

export interface PaidOrderFacts {
  orderCode: string;
  /** Uang yang benar-benar masuk dari gateway (sudah termasuk kode unik). */
  paidAmount: Rupiah;
  /** Harga barang yang disepakati (tanpa kode unik). */
  saleAmount: Rupiah;
  /** Harga pokok barang yang dikirim, dari baris stok yang direservasi. */
  cogs: Rupiah;
  mdrBps: number;
  at: string;
}

/**
 * Satu ledger adalah satu-satunya sumber pendapatan, biaya, HPP, dan laba.
 * Jangan hitung ulang di tempat lain — angka akan berbeda.
 *
 * Catatan: kode unik gateway (Rp1..Rp200) ikut tercatat di SALE karena itu uang
 * yang benar-benar diterima; `saleAmount` disimpan sebagai nota harga barangnya.
 */
export function entriesForPaidOrder(facts: PaidOrderFacts): LedgerEntry[] {
  const fee = applyBps(facts.paidAmount, facts.mdrBps);
  const make = (kind: LedgerKind, amount: Rupiah, note: string): LedgerEntry => ({
    id: `${facts.orderCode}:${kind}`,
    orderCode: facts.orderCode,
    kind,
    amount,
    at: facts.at,
    note,
  });
  return [
    make("SALE", facts.paidAmount, `harga ${facts.saleAmount}`),
    make("GATEWAY_FEE", -fee, `MDR ${facts.mdrBps} bps`),
    make("COGS", -facts.cogs, "harga pokok stok terkirim"),
  ];
}

export interface LedgerSummary {
  revenue: Rupiah;
  fee: Rupiah;
  cogs: Rupiah;
  profit: Rupiah;
  entries: number;
  orders: number;
}

export function summarize(entries: LedgerEntry[]): LedgerSummary {
  let revenue = 0;
  let fee = 0;
  let cogs = 0;
  const orders = new Set<string>();
  for (const e of entries) {
    orders.add(e.orderCode);
    if (e.kind === "SALE") revenue += e.amount;
    if (e.kind === "GATEWAY_FEE") fee += -e.amount;
    if (e.kind === "COGS") cogs += -e.amount;
  }
  return { revenue, fee, cogs, profit: revenue - fee - cogs, entries: entries.length, orders: orders.size };
}