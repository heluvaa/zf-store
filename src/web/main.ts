import http from "node:http";
import { bootstrap } from "../app/bootstrap.ts";
import { createRequestHandler } from "./server.ts";

const boot = await bootstrap();

const handle = createRequestHandler({
  service: boot.service,
  adminKey: boot.config.adminKey,
  sweepSecret: boot.config.sweepSecret,
  brand: boot.brand,
});

const server = http.createServer((req, res) => {
  void handle(req, res);
});

// Sweep saat boot: order yang sudah dibayar tapi macet di tengah pengiriman harus
// dilanjutkan, bukan menunggu cron.
const sweep = await boot.service.sweep();
if (sweep.expired.length || sweep.redelivered.length || sweep.stillFailing.length) {
  console.log(`[zf-store] sweep awal: ${JSON.stringify(sweep)}`);
}

server.listen(boot.config.port, () => {
  console.log(`[zf-store] ${boot.brand} siap di http://127.0.0.1:${boot.config.port}`);
  console.log(`[zf-store] storage: ${boot.service.storage.backend} (durable=${boot.service.storage.durable})`);
  console.log(`[zf-store] callback: ${boot.config.callbackUrl}`);
  console.log(`[zf-store] gateway: ${boot.config.qrisUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void boot.close().finally(() => process.exit(0));
    });
  });
}