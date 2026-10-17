import { rp } from "../core/money.ts";
import type { Order, Product } from "../core/types.ts";

/**
 * Bentuk yang boleh keluar dari server. `cost` (harga beli) tidak pernah masuk ke
 * sini — satu-satunya cara harga beli bocor adalah lewat view ini.
 */
export function publicProduct(product: Product, stock: Record<string, number>) {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    variants: product.variants.map((v) => ({
      id: v.id,
      name: v.name,
      price: v.price,
      priceText: rp(v.price),
      warranty: v.warranty,
      terms: v.terms,
      tiers: v.tiers ?? [],
      stock: stock[v.id] ?? 0,
    })),
  };
}

export function publicOrder(order: Order) {
  return {
    orderCode: order.code,
    status: order.status,
    buyerName: order.buyer.name,
    lines: order.lines,
    subtotal: order.subtotal,
    subtotalText: rp(order.subtotal),
    chargedAmount: order.chargedAmount,
    chargedAmountText: order.chargedAmount === null ? null : rp(order.chargedAmount),
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    deliveredAt: order.deliveredAt,
    qrisUrl: order.status === "PENDING_PAYMENT" ? order.qrisUrl : null,
    delivered: order.status === "DELIVERED" ? order.delivered : [],
  };
}