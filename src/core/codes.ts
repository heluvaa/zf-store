import { randomBytes } from "node:crypto";

const WIB_OFFSET_MS = 7 * 3600_000;

/** YYYYMMDD menurut WIB (bukan UTC) — kode order harus konsisten dengan tanggal yang dilihat pembeli. */
export function dayKey(at: Date): string {
  return new Date(at.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");
}

export function orderCode(day: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new Error("seq order harus >= 1");
  return `ZF-${day}-${String(seq).padStart(3, "0")}`;
}

/**
 * Token akses pembeli. Kode order (ZF-YYYYMMDD-NNN) bisa ditebak, jadi
 * membuka order tanpa token ini tidak boleh membocorkan isi pesanan.
 */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}