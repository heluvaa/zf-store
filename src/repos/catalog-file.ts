import { readFile } from "node:fs/promises";
import { DomainError } from "../core/errors.ts";
import type { Product } from "../core/types.ts";
import type { CatalogRepository } from "./types.ts";

export interface CatalogFile {
  meta?: { brand?: string; demo?: boolean; note?: string };
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

/**
 * Katalog dibaca dari satu file data supaya pemilik toko mengubah barang/harga
 * tanpa menyentuh kode. Dibaca ulang tiap panggilan (file kecil) supaya edit
 * langsung terpakai tanpa restart.
 */
export function fileCatalog(path: string): CatalogRepository {
  let cache: { at: number; file: CatalogFile } | null = null;
  const ttlMs = 2000;

  async function load(): Promise<CatalogFile> {
    if (cache && Date.now() - cache.at < ttlMs) return cache.file;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new DomainError("CATALOG_MISSING", `katalog tidak terbaca: ${path}`);
    }
    const file = validate(JSON.parse(raw), path);
    cache = { at: Date.now(), file };
    return file;
  }

  return {
    async listProducts() {
      const file = await load();
      return file.products.filter((p) => p.active).sort((a, b) => a.sort - b.sort);
    },
    async getProduct(slug) {
      const file = await load();
      return file.products.find((p) => p.slug === slug) ?? null;
    },
    async getVariant(variantId) {
      const file = await load();
      for (const product of file.products) {
        const variant = product.variants.find((v) => v.id === variantId);
        if (variant) return { product, variant };
      }
      return null;
    },
  };
}

export async function readCatalogMeta(path: string): Promise<{ brand?: string; demo?: boolean; note?: string }> {
  try {
    const file = validate(JSON.parse(await readFile(path, "utf8")), path);
    return file.meta ?? {};
  } catch {
    return {};
  }
}

export function staticCatalog(products: Product[]): CatalogRepository {
  return {
    async listProducts() { return products.filter((p) => p.active).sort((a, b) => a.sort - b.sort); },
    async getProduct(slug) { return products.find((p) => p.slug === slug) ?? null; },
    async getVariant(variantId) {
      for (const product of products) {
        const variant = product.variants.find((v) => v.id === variantId);
        if (variant) return { product, variant };
      }
      return null;
    },
  };
}