import { DomainError } from "./errors.ts";
import type { OrderStatus } from "./types.ts";

/**
 * Status order adalah state machine yang disimpan di DB, bukan antrean di memori.
 * Tabel ini satu-satunya tempat transisi sah didefinisikan; setiap penulisan status
 * wajib lewat assertTransition().
 */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ["PAID", "EXPIRED", "CANCELLED", "FAILED"],
  PAID: ["DELIVERING", "CANCELLED", "FAILED"],
  // DELIVERING -> DELIVERING disengaja: proses yang mati di tengah pengiriman harus
  // bisa dilanjutkan, dan itulah transisi yang justru paling butuh izin.
  // DELIVERING -> PAID = percobaan kirim gagal dan dikembalikan untuk dicoba lagi sweep.
  DELIVERING: ["PAID", "DELIVERING", "DELIVERED", "FAILED"],
  DELIVERED: [],
  EXPIRED: [],
  CANCELLED: [],
  FAILED: [],
};

export const ORDER_TTL_SECONDS = 900;
export const MAX_DELIVERY_ATTEMPTS = 3;

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus, code: string): void {
  if (!canTransition(from, to)) {
    throw new DomainError("BAD_TRANSITION", `status ${from} -> ${to} tidak sah untuk ${code}`);
  }
}