import { configWarnings, loadConfig, type Config } from "./config.ts";
import { StoreService } from "./service.ts";
import { digitalStockDelivery } from "../deliver/digital.ts";
import { httpQrisGateway } from "../gateways/qris.ts";
import { fileCatalog, readCatalogMeta, readCatalogProducts } from "../repos/catalog-file.ts";
import { memoryRepositories } from "../repos/memory.ts";
import { postgresRepositories } from "../repos/postgres.ts";
import type { Repositories } from "../repos/types.ts";

export interface Bootstrapped {
  service: StoreService;
  config: Config;
  brand: string;
  warnings: string[];
  close(): Promise<void>;
}

/**
 * Satu tempat yang tahu cara merakit service, dipakai server lokal dan adapter
 * Vercel. Penyimpanan dipilih dari env: ada STORE_DATABASE_URL = Postgres
 * (katalog ikut di DB dan bisa diedit panel admin; file katalog hanya seed awal),
 * tidak ada = in-memory + katalog file (dan itu dilaporkan terang-terangan).
 */
export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<Bootstrapped> {
  const config = loadConfig(env);
  const meta = await readCatalogMeta(config.catalogPath);
  const seedProducts = (await readCatalogProducts(config.catalogPath)) ?? [];
  const warnings = configWarnings(config);

  let repos: Repositories;
  let close = async (): Promise<void> => {};

  if (config.databaseUrl) {
    const pg = await postgresRepositories({ connectionString: config.databaseUrl, seedProducts });
    await pg.verifySchema();
    repos = pg;
    close = () => pg.close();
  } else {
    // Lokal tanpa DB: katalog tetap dari file supaya edit admin tersimpan antar-restart.
    repos = await memoryRepositories(fileCatalog(config.catalogPath));
    warnings.push("STORE_DATABASE_URL kosong: order hanya di memori (hilang saat proses mati), katalog persist di file");
  }

  for (const w of warnings) console.warn(`[zf-store] peringatan: ${w}`);

  const gateway = httpQrisGateway({ baseUrl: config.qrisUrl, secret: config.qrisSecret });
  const service = new StoreService({
    repos,
    gateway,
    delivery: digitalStockDelivery(),
    config: {
      callbackUrl: config.callbackUrl,
      callbackSecret: config.callbackSecret,
      mdrBps: config.mdrBps,
    },
  });

  return { service, config, brand: meta.brand ?? "ZF Store", warnings, close };
}
