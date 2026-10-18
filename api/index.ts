import type { IncomingMessage, ServerResponse } from "node:http";
import { bootstrap, type Bootstrapped } from "../src/app/bootstrap.ts";
import { createRequestHandler } from "../src/web/server.ts";

/**
 * Adapter Vercel: satu fungsi menangani semua rute (lihat vercel.json).
 * Instans serverless hidup-pendek, jadi:
 *  - bootstrap di-cache per instans (pool DB tidak dibuat ulang tiap request)
 *  - sweep dijalankan "lazy" paling sering sekali per menit, dan DITUNGGU —
 *    kerja latar di serverless bisa dibekukan begitu respons dikirim.
 *  - cron Vercel (Hobby: sekali sehari) jadi jaring pengaman, bukan penggerak utama.
 */
let booted: Promise<Bootstrapped> | null = null;
let lastSweepMs = 0;
const SWEEP_INTERVAL_MS = 60_000;

async function boot(): Promise<Bootstrapped> {
  booted ??= bootstrap();
  return booted;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ready = await boot();
  const handle = createRequestHandler({
    service: ready.service,
    adminKey: ready.config.adminKey,
    sweepSecret: ready.config.sweepSecret,
    brand: ready.brand,
  });

  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const isSweepRoute = path.replace(/\/+$/, "") === "/internal/sweep";
  if (!isSweepRoute) {
    const now = Date.now();
    if (now - lastSweepMs > SWEEP_INTERVAL_MS) {
      lastSweepMs = now;
      try {
        await ready.service.sweep();
      } catch (e) {
        console.error("lazy sweep gagal", e);
      }
    }
  }

  return handle(req, res);
}