import { readFile } from "node:fs/promises";
import path from "node:path";
import { bootstrap } from "../src/app/bootstrap.ts";
import type { NewStockItem } from "../src/repos/types.ts";

/**
 * Isi stok massal dari file JSON:
 *   [{ "variantId": "v_stream_1m", "payload": "KODE-XXXX", "cost": 19000 }]
 * `cost` boleh dikosongkan: harga `cost` varian dari katalog yang dipakai.
 */
const seedPath = process.argv[2] ?? path.join(process.cwd(), "data", "stock.seed.json");

const raw = await readFile(seedPath, "utf8").catch(() => {
  console.error(`file seed tidak terbaca: ${seedPath}`);
  process.exit(1);
});

const parsed = JSON.parse(raw) as NewStockItem[] | { items: NewStockItem[] };
const items = Array.isArray(parsed) ? parsed : parsed?.items;
if (!Array.isArray(items) || items.length === 0) {
  console.error("seed harus array stok (atau { items: [...] }) dan tidak kosong");
  process.exit(1);
}

const boot = await bootstrap();
try {
  const count = await boot.service.addStock(items.map((item) => ({
    variantId: item.variantId,
    payload: item.payload,
    cost: Number.isInteger(item.cost) && item.cost >= 0 ? item.cost : undefined,
  })));
  console.log(`stok ditambahkan: ${count} item`);
  console.log(`stok tersedia: ${JSON.stringify(await boot.service.stockAvailable())}`);
  console.log(`storage: ${boot.service.storage.backend} (durable=${boot.service.storage.durable})`);
} finally {
  await boot.close();
}
