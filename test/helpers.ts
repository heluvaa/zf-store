import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { StoreService } from "../src/app/service.ts";
import { digitalStockDelivery, type DeliveryStrategy } from "../src/deliver/digital.ts";
import type { CreateInvoiceInput, GatewayInvoice, GatewayStatus, QrisGateway } from "../src/gateways/qris.ts";
import { staticCatalog } from "../src/repos/catalog-file.ts";
import { memoryRepositories } from "../src/repos/memory.ts";
import type { CatalogRepository, NewStockItem, Repositories } from "../src/repos/types.ts";
import type { Product } from "../src/core/types.ts";
import { createRequestHandler } from "../src/web/server.ts";

export const CATALOG: Product[] = [
  {
    id: "p1", slug: "voucher-a", name: "Voucher A", description: "Contoh", active: true, sort: 1,
    variants: [
      { id: "v1", name: "1 Bulan", price: 25_000, cost: 19_000, warranty: "G1", terms: "T1" },
      { id: "v1b", name: "3 Bulan", price: 65_000, cost: 51_000, warranty: "G1", terms: "T1", tiers: [{ minQty: 3, unitPrice: 60_000 }] },
    ],
  },
  {
    id: "p2", slug: "mati", name: "Produk Mati", description: "Tidak dijual", active: false, sort: 2,
    variants: [{ id: "v2", name: "1x", price: 5_000, cost: 3_000, warranty: "G", terms: "T" }],
  },
];

export const ADMIN_KEY = "admin-key-uji-123456789012345678";
export const SWEEP_KEY = "sweep-key-uji-123456789012345678";
export const CALLBACK_SECRET = "callback-secret-uji-1234567890";

export interface Clock {
  now(): Date;
  advance(ms: number): void;
  set(iso: string): void;
}

export function clock(startIso = "2026-10-18T03:00:00.000Z"): Clock {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => { current += ms; },
    set: (iso: string) => { current = new Date(iso).getTime(); },
  };
}

export interface FakeGatewayInvoice extends CreateInvoiceInput {
  invoiceId: string;
  chargedAmount: number;
  status: string;
  expiresAt: string;
}

export interface FakeGateway extends QrisGateway {
  invoices: Map<string, FakeGatewayInvoice>;
  createCalls: number;
  failNextCreate: boolean;
}

export function fakeGateway(clock: Clock): FakeGateway {
  const invoices = new Map<string, FakeGatewayInvoice>();
  let counter = 0;
  const gateway: FakeGateway = {
    baseUrl: "https://fake-gateway.test",
    invoices,
    createCalls: 0,
    failNextCreate: false,
    async createInvoice(input) {
      gateway.createCalls++;
      if (gateway.failNextCreate) {
        gateway.failNextCreate = false;
        const { DomainError } = await import("../src/core/errors.ts");
        throw new DomainError("GATEWAY_HTTP", "gateway sedang mati (uji)");
      }
      counter++;
      const chargedAmount = input.amount + 1 + (counter % 3);
      const invoiceId = `inv_test_${counter}`;
      const expiresAt = new Date(clock.now().getTime() + input.expiresIn * 1000).toISOString();
      invoices.set(invoiceId, { ...input, invoiceId, chargedAmount, status: "pending", expiresAt });
      return {
        invoiceId, amount: input.amount, chargedAmount, qrisPayload: "00020101021226",
        qrisUrl: `https://fake-gateway.test/qris?invoice_id=${invoiceId}&t=uji`,
        status: "pending", expiresAt,
      } satisfies GatewayInvoice;
    },
    async getStatus(query) {
      const found = query.invoiceId
        ? [...invoices.values()].find((i) => i.invoiceId === query.invoiceId)
        : [...invoices.values()].find((i) => i.reference === query.reference);
      if (!found) return null;
      return {
        invoiceId: found.invoiceId, status: found.status, storedStatus: found.status,
        chargedAmount: found.chargedAmount, baseAmount: found.amount,
        reference: found.reference, paidAt: null, expiresAt: found.expiresAt,
      } satisfies GatewayStatus;
    },
  };
  return gateway;
}

export interface SignInput {
  invoiceId: string;
  amount: number;
  baseAmount?: number;
  reference?: string | null;
  status?: string;
  senderName?: string | null;
  eventId?: string | null;
  paidAt?: string | null;
}

export function signedCallback(input: SignInput, secret = CALLBACK_SECRET, at: Date = new Date()): {
  rawBody: string; timestamp: string; signature: string;
} {
  const payload = {
    invoice_id: input.invoiceId,
    amount: input.amount,
    base_amount: input.baseAmount ?? input.amount,
    reference: input.reference ?? null,
    status: input.status ?? "paid",
    sender_name: input.senderName ?? "BUDI",
    event_id: input.eventId ?? "evt-1",
    paid_at: input.paidAt ?? at.toISOString(),
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return { rawBody, timestamp, signature };
}

export function signingDeliveries(opts: { failTimes?: number; emptyResult?: boolean } = {}): DeliveryStrategy & { calls: number } {
  const base = digitalStockDelivery();
  const strategy = {
    name: "uji",
    calls: 0,
    async deliver(request: Parameters<DeliveryStrategy["deliver"]>[0]) {
      strategy.calls++;
      if (opts.emptyResult) return { ok: false, items: [], error: "kosong (uji)" };
      if (opts.failTimes && strategy.calls <= opts.failTimes) return { ok: false, items: [], error: "gagal kirim (uji)" };
      return base.deliver(request);
    },
  };
  return strategy;
}

export interface Rig {
  service: StoreService;
  repos: Repositories;
  gateway: FakeGateway;
  clock: Clock;
  delivery: ReturnType<typeof signingDeliveries>;
}

export async function makeRig(opts: {
  seed?: NewStockItem[];
  failTimes?: number;
  emptyResult?: boolean;
  catalog?: CatalogRepository;
  maxDeliveryAttempts?: number;
} = {}): Promise<Rig> {
  const time = clock();
  const catalog = opts.catalog ?? staticCatalog(CATALOG);
  const repos = await memoryRepositories(catalog, { now: time.now, seedStock: opts.seed });
  const gateway = fakeGateway(time);
  const delivery = signingDeliveries({ failTimes: opts.failTimes, emptyResult: opts.emptyResult });
  const service = new StoreService({
    repos, gateway, delivery,
    config: {
      callbackUrl: "https://toko.test/api/pay/callback",
      callbackSecret: CALLBACK_SECRET,
      mdrBps: 70,
      orderTtlSeconds: 900,
      maxDeliveryAttempts: opts.maxDeliveryAttempts ?? 3,
    },
    now: time.now,
    newToken: () => "token-uji-tetap",
  });
  return { service, repos, gateway, clock: time, delivery };
}

export function seedFor(variantId: string, count: number, cost = 19_000): NewStockItem[] {
  return Array.from({ length: count }, (_, i) => ({ variantId, payload: `KODE-${variantId}-${i + 1}`, cost }));
}

export async function startServer(service: StoreService, opts: { brand?: string } = {}): Promise<{
  url: string; close(): Promise<void>;
}> {
  const handle = createRequestHandler({
    service,
    adminKey: ADMIN_KEY,
    sweepSecret: SWEEP_KEY,
    brand: opts.brand ?? "ZF Store",
  });
  const server = http.createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function readJson(res: Response): Promise<Record<string, any>> {
  return JSON.parse(await res.text()) as Record<string, any>;
}