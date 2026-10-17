import type { DeliveredItem, Order, StockItem } from "../core/types.ts";

export interface DeliveryRequest {
  order: Order;
  items: StockItem[];
}

export interface DeliveryResult {
  ok: boolean;
  items: DeliveredItem[];
  error?: string;
}

export type DeliveryStrategy = {
  name: string;
  deliver(request: DeliveryRequest): Promise<DeliveryResult>;
};

/**
 * Produk digital: "pengiriman" = menyerahkan isi stok (kode voucher/akun) ke
 * pembeli. Strategi disuntikkan supaya domain bisa diuji tanpa Telegram/email,
 * dan supaya kegagalan kirim bisa disimulasikan.
 */
export function digitalStockDelivery(): DeliveryStrategy {
  return {
    name: "digital-stock",
    async deliver({ items }) {
      if (items.length === 0) return { ok: false, items: [], error: "tidak ada stok untuk dikirim" };
      return {
        ok: true,
        items: items.map((i) => ({ variantId: i.variantId, payload: i.payload })),
      };
    },
  };
}