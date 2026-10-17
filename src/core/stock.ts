import { DomainError } from "./errors.ts";
import type { StockItem } from "./types.ts";

/**
 * Urutan FIFO ditentukan di domain (barang tertua keluar dulu), sementara
 * atomisitas-nya tugas repo: satu item hanya boleh dipegang satu order.
 */
export function planFifo(available: StockItem[], variantId: string, qty: number): StockItem[] {
  if (!Number.isInteger(qty) || qty < 1) throw new DomainError("BAD_QTY", "qty minimal 1");
  const pool = available
    .filter((i) => i.variantId === variantId && i.status === "available")
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  if (pool.length < qty) {
    throw new DomainError(
      "INSUFFICIENT_STOCK",
      `stok ${variantId} tersedia ${pool.length}, diminta ${qty}`,
    );
  }
  return pool.slice(0, qty);
}

export function totalCost(items: StockItem[]): number {
  return items.reduce((sum, i) => sum + i.cost, 0);
}