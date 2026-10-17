import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition, canTransition, isTerminal, TRANSITIONS } from "../src/core/order.ts";
import type { OrderStatus } from "../src/core/types.ts";

test("transisi sah sesuai state machine", () => {
  assert.ok(canTransition("PENDING_PAYMENT", "PAID"));
  assert.ok(canTransition("PAID", "DELIVERING"));
  assert.ok(canTransition("DELIVERING", "DELIVERED"));
  assert.ok(canTransition("PENDING_PAYMENT", "EXPIRED"));
  assert.ok(canTransition("PENDING_PAYMENT", "CANCELLED"));
});

test("transisi terlarang ditolak", () => {
  assert.equal(canTransition("EXPIRED", "PAID"), false);
  assert.equal(canTransition("DELIVERED", "PENDING_PAYMENT"), false);
  assert.equal(canTransition("CANCELLED", "PAID"), false);
  assert.throws(() => assertTransition("EXPIRED", "PAID", "ZF-1"), /tidak sah/);
});

test("order yang mati di tengah pengiriman harus bisa dilanjutkan", () => {
  // DELIVERING -> DELIVERING dan DELIVERING -> PAID keduanya wajib sah, kalau tidak
  // justru order yang butuh dikirim ulang yang ditolak.
  assert.ok(canTransition("DELIVERING", "DELIVERING"));
  assert.ok(canTransition("DELIVERING", "PAID"));
  assert.ok(canTransition("PAID", "FAILED"));
});

test("status terminal tidak punya jalan keluar", () => {
  const terminal: OrderStatus[] = ["DELIVERED", "EXPIRED", "CANCELLED", "FAILED"];
  for (const status of terminal) {
    assert.ok(isTerminal(status), `${status} harus terminal`);
    assert.deepEqual(TRANSITIONS[status], []);
  }
  assert.equal(isTerminal("PAID"), false);
  assert.equal(isTerminal("DELIVERING"), false);
});