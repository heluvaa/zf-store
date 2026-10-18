import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../core/errors.ts";
import type { Product } from "../core/types.ts";
import type { CatalogRepository } from "./types.ts";

export interface CatalogFile {
  meta?: { brand?: string; note?: string };
  products: Product[];
}

function validate(data: unknown, path: string): CatalogFile {
  const file = data as CatalogFile;
  if (!file || !Array.isArray(file.products)) throw new DomainError("BAD_CATALOG", `katalog ${path} tidak punya array products`);
  for (const p of file.products) {
    if (!p.slug || !p.name) throw new DomainError("BAD_CATALOG", `produk tanpa slug/name di ${path}`);
    if (!Array.isArray(p.variants) || p.variants.length === 0) throw new DomainError("BAD_CATALOG", `produk ${p.slug} tanpa varian`);
    for (const v of p.variants) {
      if (!v.id || !Number.isInteger(v.price) || v.price <= 0) throw new DomainError("BAD_CATALOG", `varian ${v.id || "?"} tanpa harga integer`);
      if (!Number.isInteger(v.cost) || v.cost < 0) throw new DomainError("BAD_CATALOG", `varian ${v.id} tanpa cost valid`);
    }
  }
  return file;
}

function sortProducts(products: Product[]): Product[] {
  return [...products].sort((a, b) => a.sort - b.sort || a.slug.localeCompare(b.slug));
}

/**
 * Katalog yang BISA ditulis, disimpan di satu file JSON. Pemilik toko mengubah
 * barang/harga lewat panel admin tanpa menyentuh kode dan tanpa restart (dibaca
 * ulang tiap panggilan, file kecil). Tulis atomik: temp + rename, supaya proses
 * yang mati di tengah tulis tidak merusak katalog.
 */
export function fileCatalog(filePath: string): CatalogRepository {
  let cache: { at: number; file: CatalogFile } | null = null;
  const ttlMs = 2000;

  async function load(): Promise<CatalogFile> {
    if (cache && Date.now() - cache.at < ttlMs) return cache.file;
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      throw new DomainError("CATALOG_MISSING", `katalog tidak terbaca: ${filePath}`);
    }
    const file = validate(JSON.parse(raw), filePath);
    cache = { at: Date.now(), file };
    return file;
  }

  async function persist(products: Product[]): Promise<void> {
    const current = await load().catch(() => ({ meta: undefined, products: [] }) as CatalogFile);
    const next: CatalogFile = { meta: current.meta, products };
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await rename(tmp, filePath);
    cache = { at: Date.now(), file: next };
  }

  return {
    async listProducts() {
      return sortProducts((await load()).products.filter((p) => p.active));
    },
    async listAllProducts() {
      return sortProducts((await load()).products);
    },
    async getProduct(slug) {
      return (await load()).products.find((p) => p.slug === slug) ?? null;
    },
    async getVariant(variantId) {
      for (const product of (await load()).products) {
        const variant = product.variants.find((v) => v.id === variantId);
        if (variant) return { product, variant };
      }
      return null;
    },
    async upsertProduct(product) {
      const products = (await load()).products.slice();
      const idx = products.findIndex((p) => p.slug === product.slug);
      if (idx === -1) products.push(product);
      else products[idx] = product;
      await persist(products);
    },
    async setActive(slug, active) {
      const products = (await load()).products.slice();
      const idx = products.findIndex((p) => p.slug === slug);
      const current = idx === -1 ? undefined : products[idx];
      if (!current) return null;
      const updated: Product = { ...current, active };
      products[idx] = updated;
      await persist(products);
      return updated;
    },
    async deleteProduct(slug) {
      const products = (await load()).products;
      const kept = products.filter((p) => p.slug !== slug);
      if (kept.length === products.length) return false;
      await persist(kept);
      return true;
    },
  };
}

export async function readCatalogMeta(filePath: string): Promise<{ brand?: string; note?: string }> {
  try {
    const file = validate(JSON.parse(await readFile(filePath, "utf8")), filePath);
    return file.meta ?? {};
  } catch {
    return {};
  }
}

/**
 * Katalog statis untuk test/dev: bisa ditulis, tapi tulisan hilang saat proses
 * mati (persis seperti penyimpanan memory lainnya).
 */
export function staticCatalog(products: Product[]): CatalogRepository {
  // Salinan dalam: pemanggil tetap pegang array aslinya, dan tiap test rig
  // tidak boleh saling mengotori lewat referensi objek yang sama.
  let items = products.map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v })) }));
  const find = (slug: string) => items.find((p) => p.slug === slug) ?? null;
  return {
    async listProducts() { return sortProducts(items.filter((p) => p.active)); },
    async listAllProducts() { return sortProducts(items); },
    async getProduct(slug) { return find(slug); },
    async getVariant(variantId) {
      for (const product of items) {
        const variant = product.variants.find((v) => v.id === variantId);
        if (variant) return { product, variant };
      }
      return null;
    },
    async upsertProduct(product) {
      const idx = items.findIndex((p) => p.slug === product.slug);
      if (idx === -1) items.push(product);
      else items[idx] = product;
    },
    async setActive(slug, active) {
      const p = find(slug);
      if (!p) return null;
      p.active = active;
      return p;
    },
    async deleteProduct(slug) {
      const before = items.length;
      items = items.filter((p) => p.slug !== slug);
      return items.length !== before;
    },
  };
}

/** Baca produk dari file katalog (untuk seed katalog DB saat boot pertama). */
export async function readCatalogProducts(filePath: string): Promise<Product[] | null> {
  try {
    return validate(JSON.parse(await readFile(filePath, "utf8")), filePath).products;
  } catch {
    return null;
  }
}
