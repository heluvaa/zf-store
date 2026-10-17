import { DomainError } from "./errors.ts";

/** Uang selalu integer rupiah. Float tidak pernah dipakai untuk uang. */
export type Rupiah = number;

export const MIN_PAYMENT: Rupiah = 100;
export const MAX_PAYMENT: Rupiah = 10_000_000;

export function assertRupiah(value: unknown, label = "nominal"): asserts value is Rupiah {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DomainError("BAD_AMOUNT", `${label} harus integer rupiah`);
  }
  if (value < 0) throw new DomainError("BAD_AMOUNT", `${label} tidak boleh negatif`);
}

export function addRupiah(...values: Rupiah[]): Rupiah {
  let total = 0;
  for (const v of values) {
    assertRupiah(v);
    total += v;
  }
  return total;
}

/**
 * Persen lewat basis point supaya 0,7% dan 12,5% tetap eksak.
 * 0,7% -> 70 bps.
 */
export function applyBps(value: Rupiah, bps: number): Rupiah {
  assertRupiah(value);
  if (!Number.isFinite(bps) || bps < 0) throw new DomainError("BAD_BPS", "bps tidak sah");
  return Math.round((value * bps) / 10000);
}

/** "Rp 22.255.985" — pengelompokan ribuan manual, bukan toLocaleString. */
export function rp(n: Rupiah): string {
  const digits = String(Math.abs(Math.trunc(n)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits.charAt(i);
  }
  return `${n < 0 ? "-" : ""}Rp ${out}`;
}