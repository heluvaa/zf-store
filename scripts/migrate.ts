import { readFile } from "node:fs/promises";
import pg from "pg";
import { DomainError } from "../src/core/errors.ts";

const url = (process.env.STORE_DATABASE_URL ?? "").trim();
if (!url) {
  console.error("STORE_DATABASE_URL belum diisi — tidak ada yang dimigrasi.");
  process.exit(1);
}

const sql = await readFile(new URL("../src/repos/schema.sql", import.meta.url), "utf8");
const needsSsl = /supabase|sslmode=require|neon\.tech|render\.com/i.test(url);
const pool = new pg.Pool({ connectionString: url, max: 1, ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}) });

try {
  await pool.query(sql);
  const res = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'zf_%' ORDER BY table_name`,
  );
  const names = res.rows.map((r) => r.table_name);
  console.log(`migrasi selesai. tabel: ${names.join(", ")}`);
} catch (e) {
  const message = e instanceof DomainError ? e.message : e instanceof Error ? e.message : String(e);
  console.error(`migrasi gagal: ${message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}