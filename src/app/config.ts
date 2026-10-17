import path from "node:path";
import { DomainError } from "../core/errors.ts";
import { DEFAULT_MDR_BPS } from "../core/pricing.ts";

export interface Config {
  port: number;
  qrisUrl: string;
  qrisSecret: string;
  publicUrl: string;
  callbackSecret: string;
  sweepSecret: string;
  adminKey: string;
  databaseUrl: string | null;
  mdrBps: number;
  catalogPath: string;
  callbackUrl: string;
}

const MIN_SECRET_LEN = 24;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (key: string): string => {
    const value = (env[key] ?? "").trim();
    if (!value) throw new DomainError("CONFIG_MISSING", `env ${key} belum diisi`);
    return value;
  };
  const publicUrl = need("STORE_PUBLIC_URL").replace(/\/+$/, "");
  const mdrBps = Number((env.STORE_MDR_BPS ?? "").trim() || DEFAULT_MDR_BPS);
  if (!Number.isInteger(mdrBps) || mdrBps < 0 || mdrBps > 2000) {
    throw new DomainError("CONFIG_BAD", `STORE_MDR_BPS tidak masuk akal: ${env.STORE_MDR_BPS}`);
  }
  return {
    port: Number((env.PORT ?? "").trim() || 3100),
    qrisUrl: need("STORE_QRIS_URL").replace(/\/+$/, ""),
    qrisSecret: need("STORE_QRIS_SECRET"),
    publicUrl,
    callbackSecret: need("STORE_CALLBACK_SECRET"),
    sweepSecret: need("STORE_SWEEP_SECRET"),
    adminKey: need("STORE_ADMIN_KEY"),
    databaseUrl: (env.STORE_DATABASE_URL ?? "").trim() || null,
    mdrBps,
    catalogPath: (env.STORE_CATALOG_PATH ?? "").trim() || path.join(process.cwd(), "data", "catalog.json"),
    callbackUrl: `${publicUrl}/api/pay/callback`,
  };
}

/**
 * Kesalahan konfigurasi yang tidak fatal tapi harus terlihat di log saat boot —
 * jangan biarkan toko jalan dengan secret pendek atau URL http tanpa disadari.
 */
export function configWarnings(cfg: Config): string[] {
  const out: string[] = [];
  for (const [label, value] of [["STORE_CALLBACK_SECRET", cfg.callbackSecret], ["STORE_SWEEP_SECRET", cfg.sweepSecret], ["STORE_ADMIN_KEY", cfg.adminKey]] as const) {
    if (value.length < MIN_SECRET_LEN) out.push(`${label} cuma ${value.length} karakter (disarankan >= ${MIN_SECRET_LEN})`);
  }
  if (cfg.publicUrl.startsWith("http://") && !/localhost|127\.0\.0\.1/.test(cfg.publicUrl)) {
    out.push(`STORE_PUBLIC_URL pakai http:// — callback berisi data pembayaran, harus https`);
  }
  if (!cfg.databaseUrl) out.push("STORE_DATABASE_URL kosong: penyimpanan in-memory, order HILANG saat proses mati");
  return out;
}