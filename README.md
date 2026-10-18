# ZF Store — backend toko produk digital

Backend toko produk digital (voucher/akun/topup) dengan pembayaran **QRIS Gateway** milik
sendiri (`qris-gateway.nybaee888.workers.dev`). Katalog + stok FIFO + order + ledger +
webhook callback. Node 26 menjalankan TypeScript langsung — **tanpa build step**.

```bash
npm install
npm test        # 58 test, tanpa DB, tanpa jaringan
npm run check   # typecheck strict (tsc --noEmit)
npm run smoke   # uji asap: bikin invoice SUNGGUHAN di gateway + callback bertanda tangan
```

## Isi

| Lapisan | Berkas | Catatan |
| :--- | :--- | :--- |
| Domain (murni) | `src/core/` | uang (integer rupiah), pricing+tier, stok FIFO, state machine order, ledger, kode order. Tanpa DB/jaringan/jam — `now` selalu parameter |
| Repo | `src/repos/` | interface + **memory** (test/dev) + **Postgres/Supabase** (produksi). Katalog dari `data/catalog.json` |
| Gateway | `src/gateways/qris.ts` | klien HTTP ke worker QRIS + verifikasi tanda tangan callback |
| Aplikasi | `src/app/service.ts` | checkout, callback pembayaran, pengiriman, sweep, cancel, laporan |
| HTTP | `src/web/server.ts` | satu handler `(req,res)` — dipakai server lokal dan adapter Vercel (`api/index.ts`) |

## Endpoint

| Path | Method | Auth | Guna |
| :--- | :--- | :--- | :--- |
| `/health` | GET | – | status + backend penyimpanan |
| `/api/catalog` | GET | – | katalog + stok tersedia (harga beli tidak pernah dikirim) |
| `/api/orders` | POST | – | checkout: `{items:[{variantId,qty}], buyer:{name,contact}}` → kode order + token + QR |
| `/api/orders/:code` | GET | `?t=<accessToken>` atau `x-admin-key` | status pesanan; isi stok hanya setelah lunas |
| `/api/pay/callback` | POST | HMAC `X-Callback-Signature` | callback gateway (dipakai worker, bukan browser) |
| `/internal/sweep` | POST/GET | `x-sweep-key` atau `Authorization: Bearer <secret>` | expire order + lanjutkan kirim yang macet (cron) |
| `/api/admin/report` | GET | `x-admin-key` | ledger (omzet/biaya/HPP/laba) + 20 order terakhir |

`POST /api/orders` membalas `201` + `{orderCode, accessToken, quote, pay:{invoiceId, chargedAmount, qrisUrl}}`.
Yang ditampilkan ke pembeli = `chargedAmount` (harga + kode unik dari gateway), bukan `amount`.

## Aturan yang dipegang kode ini

- **Harga dihitung ulang di server** dari `data/catalog.json`. Harga/total dari klien dibuang.
- **Uang integer rupiah**, persen lewat basis point (`applyBps`), format `Rp 22.255.985`.
- **Stok = compare-and-swap.** Reservasi FIFO satu statement; gagal = tidak ada yang tertahan.
  Di Postgres jumlah-tersedia dan UPDATE dicek di snapshot yang sama, jadi tak mungkin separuh jalan.
- **Order = state machine di DB**, transisi tak sah ditolak (`BAD_TRANSITION`). Order yang mati di
  `DELIVERING` bisa dilanjutkan; klaim kirim pakai **sewa** (`deliveryClaimedAt`, 120 detik) supaya
  dua callback bersamaan tidak mengirim dua kali.
- **Idempotensi pembayaran = batasan DB**: `zf_payments` PK `(gateway, invoice_id)`. Callback ganda
  tidak menambah laba dan tidak mengirim barang dua kali.
- **Satu ledger** untuk pendapatan/biaya/HPP/laba. `COGS` diambil dari baris stok yang dikirim,
  bukan dari `cost` varian.
- **Callback diverifikasi atas body mentah** (`sha256=HMAC(secret, "<ts>.<body>")`) + toleransi
  umur 5 menit. Yang bukan invoice toko ini dibalas 200 (`ignored`) supaya gateway berhenti retry;
  yang ditandatangani sah tapi uangnya telat/ kurang dicatat sebagai **anomali**, tidak dikirim otomatis.
- **`cost` tidak pernah keluar dari server** — view publik ada di `src/web/views.ts`.

## Konfigurasi

Salin `.env.example` → `.env`. Wajib: `STORE_QRIS_URL`, `STORE_QRIS_SECRET` (= `QRIS_HOOK_SECRET`
di worker), `STORE_PUBLIC_URL`, `STORE_CALLBACK_SECRET`, `STORE_SWEEP_SECRET`, `STORE_ADMIN_KEY`.
`STORE_DATABASE_URL` kosong = penyimpanan **in-memory** dan itu dilaporkan di `/health` + log
(`durable:false`) — bukan diam-diam.

## Penyimpanan: pilih mengikuti tempat deploy

Satu proses (Termux/VPS) → file/SQLite cukup. Vercel (banyak instans) → **Postgres**.
Yang ada sekarang: `memory` (test & dev) dan `postgres` (produksi, Supabase).

```bash
# sekali saja, dan hanya kalau sudah disetujui:
npm run migrate                  # menerapkan src/repos/schema.sql ke STORE_DATABASE_URL
```

Tabel: `zf_stock`, `zf_orders` (payload JSONB + kolom status/invoice_id), `zf_ledger`,
`zf_payments`, `zf_seq`. Repo Postgres memverifikasi tabelnya ada saat boot dan gagal cepat
dengan pesan `SCHEMA_MISSING` kalau belum dimigrasi.

### Alamat Supabase dari Termux

Host langsung (`db.<ref>.supabase.co`) hanya punya alamat **IPv6**, dan Termux/Android di
HP ini tidak punya rute IPv6 — koneksinya gagal `ENOTFOUND`. Pakai **pooler** (IPv4):

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

- `<region>` ditentukan oleh project, bukan tebakan — kalau salah, error-nya
  `tenant/user postgres.<ref> not found`. Project ini: **ap-south-1**.
- Port **6543** = transaction mode (cocok untuk serverless/banyak instans),
  port 5432 = session mode. Keduanya menerima `BEGIN/COMMIT` eksplisit.

## Deploy ke Vercel

1. Import repo ini di Vercel (framework: **Other**). `vercel.json` sudah menangani:
   - `rewrites` semua path → `api/index.ts`
   - `functions.includeFiles: "data/**"` supaya `data/catalog.json` ikut ke serverless
   - `crons: /internal/sweep` harian (Hobby dibatasi 1×/hari)
2. Set env vars: `STORE_QRIS_URL`, `STORE_QRIS_SECRET`, `STORE_PUBLIC_URL` (= URL produksi),
   `STORE_CALLBACK_SECRET`, `STORE_SWEEP_SECRET` (juga dipakai sebagai `CRON_SECRET`),
   `STORE_ADMIN_KEY`, `STORE_DATABASE_URL`.
3. Migrasi DB (lihat di atas) sebelum trafik pertama.
4. Isi stok: `npm run seed` (lihat `data/stock.seed.json`) atau endpoint admin (belum ada UI).
5. **Bukan andalan cron:** Hobby hanya mengizinkan jadwal harian. Karena itu `api/index.ts`
   menjalankan sweep *lazy* (maks sekali per menit, ditunggu — bukan kerja latar yang bisa
   dibekukan serverless) dan cron jadi jaring pengaman.

## Yang wajib diisi pemilik toko sebelum jualan

1. `data/catalog.json` — masih **contoh** (`meta.demo: true`). Ganti nama, harga, `cost`, S&K.
   `cost` = harga beli; dipakai menghitung laba, tidak pernah dikirim ke pembeli.
2. **MDR QRIS di `src/core/pricing.ts` masih placeholder** (`GATEWAY_RATES_ARE_PLACEHOLDER = true`,
   0,7%). Ganti dengan angka dari akun merchant sendiri, lalu ubah flag-nya — ada test yang gagal
   kalau flag dinyatakan nyata tapi angkanya masih 70 bps.
3. Secret acak (≥24 karakter) untuk callback/sweep/admin. Jangan pakai contoh.
4. `STORE_DATABASE_URL` — tanpa itu order hilang saat proses mati.
5. Storefront (Next.js) belum ada; lihat `docs/integrasi-toko.md` di repo gateway untuk kontraknya.

## Batas yang perlu diketahui

- KV/DB di gateway **eventually consistent** (baca bisa tertinggal ~60 detik). Karena itu callback
  adalah jalur utama, `GET /invoice` di gateway hanya untuk rekonsiliasi.
- Batas laju pesanan 10/menit per IP (in-memory, per instans) — cukup menahan skrip iseng, bukan DDoS.
- Belum ada: voucher, saldo/top-up, panel admin ber-UI, notifikasi ke pembeli (WhatsApp/Telegram),
  laporan CSV. Semua itu lapisan di atas service yang sudah ada.