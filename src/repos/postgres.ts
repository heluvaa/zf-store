import { randomBytes } from "node:crypto";
import pg from "pg";
import { DomainError } from "../core/errors.ts";
import { assertTransition } from "../core/order.ts";
import type { LedgerEntry, Order, OrderStatus, Product, StockItem } from "../core/types.ts";
import type {
  CatalogRepository, LedgerRepository, NewStockItem, OrderRepository, PaymentRecord,
  PaymentRepository, Repositories, SequenceRepository, StockRepository,
} from "./types.ts";

const uid = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

interface StockRow {
  id: string; variant_id: string; payload: string; cost: number;
  status: string; order_code: string | null; created_at: Date | string; updated_at: Date | string;
}

function toStockItem(row: StockRow): StockItem {
  return {
    id: row.id,
    variantId: row.variant_id,
    payload: row.payload,
    cost: Number(row.cost),
    status: row.status as StockItem["status"],
    orderCode: row.order_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface PostgresOptions {
  connectionString: string;
  /** Seed SEKALI saat tabel produk masih kosong (dari data/catalog.json). */
  seedProducts?: Product[];
  max?: number;
}

export interface PostgresRepositories extends Repositories {
  close(): Promise<void>;
  verifySchema(): Promise<void>;
}

function sortProducts(products: Product[]): Product[] {
  return [...products].sort((a, b) => a.sort - b.sort || a.slug.localeCompare(b.slug));
}

/**
 * Katalog di DB: panel admin boleh menulis, isi file katalog lokal cuma modal
 * awal. Seed terjadi sekali (saat tabel kosong) supaya edit admin tidak pernah
 * tertimpa ulang oleh file.
 */
function dbCatalog(pool: pg.Pool): CatalogRepository {
  async function all(): Promise<Product[]> {
    const res = await pool.query<{ payload: Product }>(
      `SELECT payload FROM zf_products ORDER BY sort, slug`,
    );
    return res.rows.map((r) => r.payload);
  }
  return {
    async listProducts() { return sortProducts((await all()).filter((p) => p.active)); },
    async listAllProducts() { return all(); },
    async getProduct(slug) { return (await all()).find((p) => p.slug === slug) ?? null; },
    async getVariant(variantId) {
      for (const product of await all()) {
        const variant = product.variants.find((v) => v.id === variantId);
        if (variant) return { product, variant };
      }
      return null;
    },
    async upsertProduct(product) {
      await pool.query(
        `INSERT INTO zf_products (slug, id, active, sort, payload, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, now())
         ON CONFLICT (slug) DO UPDATE
           SET id = EXCLUDED.id, active = EXCLUDED.active, sort = EXCLUDED.sort,
               payload = EXCLUDED.payload, updated_at = now()`,
        [product.slug, product.id, product.active, product.sort, JSON.stringify(product)],
      );
    },
    async setActive(slug, active) {
      const res = await pool.query<{ payload: Product }>(
        `UPDATE zf_products SET active = $2, payload = payload || jsonb_build_object('active', $2::boolean), updated_at = now()
         WHERE slug = $1 RETURNING payload`,
        [slug, active],
      );
      return res.rows[0]?.payload ?? null;
    },
    async deleteProduct(slug) {
      const res = await pool.query(`DELETE FROM zf_products WHERE slug = $1`, [slug]);
      return (res.rowCount ?? 0) === 1;
    },
  };
}


export async function postgresRepositories(opts: PostgresOptions): Promise<PostgresRepositories> {
  const needsSsl = /supabase|sslmode=require|neon\.tech|render\.com/i.test(opts.connectionString);
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 3,
    connectionTimeoutMillis: 10_000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  const stock: StockRepository = {
    async addBulk(items: NewStockItem[]) {
      if (items.length === 0) return 0;
      const values: string[] = [];
      const params: unknown[] = [];
      items.forEach((item, i) => {
        const base = i * 4;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        params.push(uid("stk"), item.variantId, item.payload, item.cost);
      });
      const res = await pool.query(
        `INSERT INTO zf_stock (id, variant_id, payload, cost) VALUES ${values.join(",")}`,
        params,
      );
      return res.rowCount ?? 0;
    },
    async listAvailable(variantId, limit = 500) {
      const res = await pool.query<StockRow>(
        `SELECT * FROM zf_stock WHERE variant_id = $1 AND status = 'available'
         ORDER BY created_at, id LIMIT $2`,
        [variantId, limit],
      );
      return res.rows.map(toStockItem);
    },
    async listForAdmin({ variantId, status, limit = 200 }) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (variantId) { params.push(variantId); where.push(`variant_id = $${params.length}`); }
      if (status) { params.push(status); where.push(`status = $${params.length}`); }
      params.push(limit);
      const res = await pool.query<StockRow>(
        `SELECT * FROM zf_stock ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return res.rows.map(toStockItem);
    },

    async countAvailable() {
      const res = await pool.query<{ variant_id: string; n: string }>(
        `SELECT variant_id, count(*)::int AS n FROM zf_stock WHERE status = 'available' GROUP BY variant_id`,
      );
      const out: Record<string, number> = {};
      for (const row of res.rows) out[row.variant_id] = Number(row.n);
      return out;
    },
    async reserve(variantId, qty, orderCode) {
      // Satu statement: jumlah yang tersedia dicek di snapshot yang sama dengan UPDATE,
      // jadi tidak mungkin ada reservasi separuh jalan.
      const res = await pool.query<StockRow>(
        `UPDATE zf_stock SET status = 'reserved', order_code = $3, updated_at = now()
         WHERE id IN (
           SELECT id FROM zf_stock WHERE variant_id = $1 AND status = 'available'
           ORDER BY created_at, id LIMIT $2
         )
         AND (SELECT count(*) FROM zf_stock WHERE variant_id = $1 AND status = 'available') >= $2
         RETURNING *`,
        [variantId, qty, orderCode],
      );
      if ((res.rowCount ?? 0) !== qty) {
        throw new DomainError("INSUFFICIENT_STOCK", `stok ${variantId} tidak cukup untuk ${qty}`);
      }
      return res.rows.map(toStockItem);
    },
    async releaseByOrder(orderCode) {
      const res = await pool.query(
        `UPDATE zf_stock SET status = 'available', order_code = NULL, updated_at = now()
         WHERE order_code = $1 AND status = 'reserved'`,
        [orderCode],
      );
      return res.rowCount ?? 0;
    },
    async markDeliveredByOrder(orderCode) {
      const res = await pool.query(
        `UPDATE zf_stock SET status = 'delivered', updated_at = now()
         WHERE order_code = $1 AND status <> 'delivered'`,
        [orderCode],
      );
      return res.rowCount ?? 0;
    },
    async listByOrder(orderCode) {
      const res = await pool.query<StockRow>(
        `SELECT * FROM zf_stock WHERE order_code = $1 ORDER BY created_at, id`,
        [orderCode],
      );
      return res.rows.map(toStockItem);
    },
  };

  const orders: OrderRepository = {
    async insert(order) {
      await pool.query(
        `INSERT INTO zf_orders (code, status, invoice_id, payload, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [order.code, order.status, order.invoiceId, JSON.stringify(order), order.createdAt, order.updatedAt],
      );
    },
    async getByCode(code) {
      const res = await pool.query<{ payload: Order }>(`SELECT payload FROM zf_orders WHERE code = $1`, [code]);
      const row = res.rows[0];
      return row ? row.payload : null;
    },
    async getByInvoiceId(invoiceId) {
      const res = await pool.query<{ payload: Order }>(`SELECT payload FROM zf_orders WHERE invoice_id = $1`, [invoiceId]);
      const row = res.rows[0];
      return row ? row.payload : null;
    },
    async transition(code, expected, patch) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const cur = await client.query<{ status: OrderStatus; payload: Order }>(
          `SELECT status, payload FROM zf_orders WHERE code = $1 FOR UPDATE`,
          [code],
        );
        const row = cur.rows[0];
        if (!row) { await client.query("ROLLBACK"); return false; }
        if (!expected.includes(row.status)) { await client.query("ROLLBACK"); return false; }
        assertTransition(row.status, patch.status, code);
        const next: Order = { ...row.payload, ...patch, status: patch.status, updatedAt: new Date().toISOString() };
        const upd = await client.query(
          `UPDATE zf_orders SET status = $2, invoice_id = $3, payload = $4::jsonb, updated_at = now()
           WHERE code = $1 AND status = ANY($5::text[])`,
          [code, next.status, next.invoiceId, JSON.stringify(next), expected],
        );
        await client.query("COMMIT");
        // CAS: nol baris berubah = gagal, bukan sukses.
        return (upd.rowCount ?? 0) === 1;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async claimForDelivery(code, at, staleBefore) {
      // Satu statement: pengecekan sewa dan penulisan terjadi di snapshot yang sama.
      // Perbandingan waktu pakai string ISO 8601 UTC — formatnya seragam, jadi urutan
      // leksikografis = urutan waktu.
      const res = await pool.query(
        `UPDATE zf_orders
            SET status = 'DELIVERING',
                payload = payload || jsonb_build_object('status', 'DELIVERING',
                                                        'deliveryClaimedAt', $2::text,
                                                        'updatedAt', $2::text),
                updated_at = now()
          WHERE code = $1
            AND (status = 'PAID'
                 OR (status = 'DELIVERING'
                     AND COALESCE(payload->>'deliveryClaimedAt', '1970-01-01T00:00:00.000Z') < $3))
          RETURNING code`,
        [code, at, staleBefore],
      );
      return (res.rowCount ?? 0) === 1;
    },
    async update(code, patch) {
      const cur = await orders.getByCode(code);
      if (!cur) throw new DomainError("ORDER_NOT_FOUND", `order ${code} tidak ada`);
      const next: Order = { ...cur, ...patch, updatedAt: new Date().toISOString() };
      await pool.query(
        `UPDATE zf_orders SET status = $2, invoice_id = $3, payload = $4::jsonb, updated_at = now() WHERE code = $1`,
        [code, next.status, next.invoiceId, JSON.stringify(next)],
      );
    },
    async listByStatuses(statuses, limit = 100) {
      const res = await pool.query<{ payload: Order }>(
        `SELECT payload FROM zf_orders WHERE status = ANY($1::text[]) ORDER BY created_at LIMIT $2`,
        [statuses, limit],
      );
      return res.rows.map((r) => r.payload);
    },
    async listRecent(limit = 20) {
      const res = await pool.query<{ payload: Order }>(
        `SELECT payload FROM zf_orders ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return res.rows.map((r) => r.payload);
    },
  };

  const ledger: LedgerRepository = {
    async append(entries) {
      let added = 0;
      for (const entry of entries) {
        const res = await pool.query(
          `INSERT INTO zf_ledger (order_code, kind, amount, at, note) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (order_code, kind) DO NOTHING`,
          [entry.orderCode, entry.kind, entry.amount, entry.at, entry.note],
        );
        added += res.rowCount ?? 0;
      }
      return added;
    },
    async listForOrder(orderCode) {
      const res = await pool.query<LedgerEntry & { at: Date }>(
        `SELECT order_code AS "orderCode", kind, amount, at, note, order_code || ':' || kind AS id
         FROM zf_ledger WHERE order_code = $1 ORDER BY kind`,
        [orderCode],
      );
      return res.rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
    },
    async listAll(limit = 500) {
      const res = await pool.query<LedgerEntry & { at: Date }>(
        `SELECT order_code AS "orderCode", kind, amount, at, note, order_code || ':' || kind AS id
         FROM zf_ledger ORDER BY at DESC LIMIT $1`,
        [limit],
      );
      return res.rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
    },
  };

  const payments: PaymentRepository = {
    async recordOnce(payment) {
      const res = await pool.query(
        `INSERT INTO zf_payments (gateway, invoice_id, order_code, amount, sender_name, gateway_event_id, paid_at, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (gateway, invoice_id) DO NOTHING`,
        [payment.gateway, payment.invoiceId, payment.orderCode, payment.amount, payment.senderName,
         payment.gatewayEventId, payment.paidAt, payment.rawPayload],
      );
      return (res.rowCount ?? 0) === 1;
    },
    async get(invoiceId) {
      const res = await pool.query<PaymentRecord & { paid_at: Date }>(
        `SELECT gateway, invoice_id AS "invoiceId", order_code AS "orderCode", amount,
                sender_name AS "senderName", gateway_event_id AS "gatewayEventId",
                paid_at, raw_payload AS "rawPayload"
         FROM zf_payments WHERE invoice_id = $1`,
        [invoiceId],
      );
      const row = res.rows[0];
      return row ? { ...row, paidAt: new Date(row.paidAt).toISOString() } : null;
    },
    async list(limit = 100) {
      const res = await pool.query(
        `SELECT gateway, invoice_id AS "invoiceId", order_code AS "orderCode", amount,
                sender_name AS "senderName", gateway_event_id AS "gatewayEventId",
                paid_at AS "paidAt", raw_payload AS "rawPayload"
         FROM zf_payments ORDER BY paid_at DESC LIMIT $1`,
        [limit],
      );
      return res.rows as PaymentRecord[];
    },
  };

  const sequence: SequenceRepository = {
    async nextSequence(day) {
      const res = await pool.query<{ n: number }>(
        `INSERT INTO zf_seq (day, n) VALUES ($1, 1)
         ON CONFLICT (day) DO UPDATE SET n = zf_seq.n + 1
         RETURNING n`,
        [day],
      );
      const row = res.rows[0];
      if (!row) throw new DomainError("SEQ_FAILED", "gagal mengambil nomor urut order");
      return Number(row.n);
    },
  };

  const requiredTables = ["zf_stock", "zf_orders", "zf_ledger", "zf_payments", "zf_seq", "zf_products"];
  const catalog = dbCatalog(pool);

  return {
    catalog,
    stock,
    orders,
    ledger,
    payments,
    sequence,
    backend: "postgres",
    durable: true,
    async verifySchema() {
      const res = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1::text[])`,
        [requiredTables],
      );
      const found = new Set(res.rows.map((r) => r.table_name));
      const missing = requiredTables.filter((t) => !found.has(t));
      if (missing.length > 0) {
        throw new DomainError("SCHEMA_MISSING", `tabel belum ada: ${missing.join(", ")} — jalankan npm run migrate`);
      }
      // Seed katalog sekali saja: tabel kosong + ada file seed. Setelah admin
      // menyentuh katalog, file lokal tidak pernah dipakai lagi.
      if (opts.seedProducts?.length) {
        const count = await pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM zf_products`);
        if (Number(count.rows[0]?.n ?? 0) === 0) {
          for (const product of opts.seedProducts) await catalog.upsertProduct(product);
          console.log(`[zf-store] katalog dised ke DB dari file: ${opts.seedProducts.length} produk`);
        }
      }
    },
    async close() {
      await pool.end();
    },
  };
}