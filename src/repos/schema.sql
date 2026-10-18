-- Skema ZF Store (Postgres / Supabase).
-- Idempoten: aman dijalankan berulang. Dijalankan lewat `npm run migrate`,
-- bukan otomatis saat boot — perubahan skema produksi harus disetujui dulu.

CREATE TABLE IF NOT EXISTS zf_stock (
  id          TEXT PRIMARY KEY,
  variant_id  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  cost        INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'available',
  order_code  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zf_stock_fifo ON zf_stock (variant_id, status, created_at, id);

CREATE TABLE IF NOT EXISTS zf_orders (
  code        TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  invoice_id  TEXT,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS zf_orders_invoice ON zf_orders (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS zf_orders_status ON zf_orders (status, created_at);

-- Kode order (ZF-YYYYMMDD-NNN) bisa ditebak. Token akses pembeli harus unik juga.
CREATE UNIQUE INDEX IF NOT EXISTS zf_orders_token ON zf_orders ((payload->>'accessToken'));

CREATE TABLE IF NOT EXISTS zf_ledger (
  order_code  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  at          TIMESTAMPTZ NOT NULL,
  note        TEXT,
  PRIMARY KEY (order_code, kind)
);
CREATE INDEX IF NOT EXISTS zf_ledger_at ON zf_ledger (at DESC);

CREATE TABLE IF NOT EXISTS zf_payments (
  gateway          TEXT NOT NULL,
  invoice_id       TEXT NOT NULL,
  order_code       TEXT NOT NULL,
  amount           INTEGER NOT NULL,
  sender_name      TEXT,
  gateway_event_id TEXT,
  paid_at          TIMESTAMPTZ NOT NULL,
  raw_payload      TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (gateway, invoice_id)
);

CREATE TABLE IF NOT EXISTS zf_seq (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL
);

-- Katalog hidup di DB supaya panel admin bisa menulis tanpa menyentuh file.
-- data/catalog.json hanya seed awal (sekali, saat tabel masih kosong).
CREATE TABLE IF NOT EXISTS zf_products (
  slug       TEXT PRIMARY KEY,
  id         TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  sort       INTEGER NOT NULL DEFAULT 0,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zf_products_list ON zf_products (sort, slug);
