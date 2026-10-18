import { DomainError } from "./errors.ts";
import { assertRupiah } from "./money.ts";
import type { Product, Tier, Variant } from "./types.ts";

/**
 * Parser produk dari input manusia (form admin panel). Semua angka dibersihkan
 * dari pemisah ribuan dulu, baru divalidasi integer rupiah. Output sudah siap
 * disimpan apa adanya — validasi terjadi SEKALI di sini, bukan di tiap pembaca.
 */

const MAX_LEN = { id: 64, slug: 64, name: 120, description: 2000, warranty: 500, terms: 1000 };

function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string") {
    if (!required) return "";
    throw new DomainError("BAD_PRODUCT", `${label} wajib diisi`);
  }
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
  if (required && cleaned.length === 0) throw new DomainError("BAD_PRODUCT", `${label} wajib diisi`);
  if (cleaned.length > max) throw new DomainError("BAD_PRODUCT", `${label} maksimal ${max} karakter`);
  return cleaned;
}

/** "25.000", "Rp 25.000", "25000" → 25000. String lain → error dengan nama field. */
export function parseRupiahInput(value: unknown, label: string): number {
  if (typeof value === "number") {
    assertRupiah(value, label);
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const raw = value.trim().replace(/^rp\.?\s*/i, "").replace(/[.\s]/g, "").replace(/,/g, ".");
    if (raw === "") throw new DomainError("BAD_PRODUCT", `${label} wajib diisi`);
    if (!/^\d+$/.test(raw)) throw new DomainError("BAD_PRODUCT", `${label} harus angka rupiah: "${value}"`);
    const n = Number(raw);
    assertRupiah(n, label);
    return n;
  }
  throw new DomainError("BAD_PRODUCT", `${label} wajib diisi`);
}

function parseTier(value: unknown, i: number): Tier {
  const t = (value ?? {}) as Record<string, unknown>;
  const minQty = Number(t.minQty);
  if (!Number.isInteger(minQty) || minQty < 2 || minQty > 1000) {
    throw new DomainError("BAD_PRODUCT", `tier #${i + 1}: minimal qty harus 2..1000`);
  }
  const unitPrice = parseRupiahInput(t.unitPrice, `tier #${i + 1} harga`);
  if (unitPrice <= 0) throw new DomainError("BAD_PRODUCT", `tier #${i + 1}: harga harus di atas 0`);
  return { minQty, unitPrice };
}

export function parseVariant(value: unknown): Variant {
  const v = (value ?? {}) as Record<string, unknown>;
  const id = text(v.id, "id varian", MAX_LEN.id).replace(/\s+/g, "_");
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new DomainError("BAD_PRODUCT", `id varian tidak sah: "${id}"`);
  const price = parseRupiahInput(v.price, `harga ${id}`);
  if (price <= 0) throw new DomainError("BAD_PRODUCT", `harga ${id} harus di atas 0`);
  const cost = parseRupiahInput(v.cost ?? 0, `modal ${id}`);
  const out: Variant = {
    id,
    name: text(v.name, `nama varian ${id}`, MAX_LEN.name),
    price,
    cost,
    warranty: text(v.warranty, `garansi ${id}`, MAX_LEN.warranty, false),
    terms: text(v.terms, `S&K ${id}`, MAX_LEN.terms, false),
  };
  if (Array.isArray(v.tiers) && v.tiers.length > 0) {
    out.tiers = v.tiers.map(parseTier).sort((a, b) => a.minQty - b.minQty);
  }
  return out;
}

export function parseProduct(value: unknown): Product {
  const p = (value ?? {}) as Record<string, unknown>;
  const name = text(p.name, "nama produk", MAX_LEN.name);
  const slug = (text(p.slug, "", MAX_LEN.slug, false) || name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")).replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new DomainError("BAD_PRODUCT", `slug tidak sah: "${slug}"`);
  const id = (text(p.id, "", MAX_LEN.id, false) || `p_${slug.replace(/-/g, "_").slice(0, 40)}`);
  if (Array.isArray(p.variants) === false || p.variants.length === 0) {
    throw new DomainError("BAD_PRODUCT", `produk ${slug}: butuh minimal 1 varian`);
  }
  if (p.variants.length > 20) throw new DomainError("BAD_PRODUCT", `produk ${slug}: maksimal 20 varian`);
  const variants = p.variants.map(parseVariant);
  const seen = new Set<string>();
  for (const v of variants) {
    if (seen.has(v.id)) throw new DomainError("BAD_PRODUCT", `varian ganda: ${v.id}`);
    seen.add(v.id);
    if (v.cost >= v.price) {
      throw new DomainError("BAD_PRODUCT", `varian ${v.id}: modal (Rp ${v.cost}) harus di bawah harga jual (Rp ${v.price})`);
    }
  }
  return {
    id,
    slug,
    name,
    description: text(p.description, `deskripsi ${slug}`, MAX_LEN.description, false),
    active: p.active === undefined ? true : Boolean(p.active),
    sort: Number.isInteger(Number(p.sort)) ? Number(p.sort) : 0,
    variants,
  };
}
