import { configWarnings, loadConfig, type Config } from "./config.ts";
import { StoreService } from "./service.ts";
import { digitalStockDelivery } from "../deliver/digital.ts";
import { httpQrisGateway } from "../gateways/qris.ts";
import { fileCatalog, readCatalogMeta } from "../repos/catalog-file.ts";
import { memoryRepositories } from "../repos/memory.ts";
import { postgresRepositories } from "../repos/postgres.ts";
import type { Repositories } from "../repos/types.ts";

export interface Bootstrapped {
  service: StoreService;
  config: Config;
  brand: string;
  demoCatalog: boolean;
  warnings: string[];
  close(): Promise<void>;
}

/**
 * Satu tempat yang tahu cara merakit service, dipakai server lokal dan adapter
 * Vercel. Penyimpanan dipilih dari env: ada STORE_DATABASE_URL = Postgres,
 * tidak ada = in-memory (dan itu dilaporkan terang-terangan, bukan diam-diam).
 */
export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<Bootstrapped> {
  const config = loadConfig(env);
  const catalog = fileCatalog(config.catalogPath);
  const meta = await readCatalogMeta(config.catalogPath);
  const warnings = configWarnings(config);

  let repos: Repositories;
  let close = async (): Promise<void> => {};

  if (config.databaseUrl) {
    const pg = await postgresRepositories({ connectionString: config.databaseUrl, catalog });
    await pg.verifySchema();
    repos = pg;
    close = () => pg.close();
  } else {
    repos = await memoryRepositories(catalog);
    console.warn("[zf-store] STORE_DATABASE_URL kosong — pakai penyimpanan in-memory. Order akan hilang saat proses mati.");
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

  return {
    service,
    config,
    brand: meta.brand ?? "ZF Store",
    demoCatalog: meta.demo === true,
    warnings,
    close,
  };
}