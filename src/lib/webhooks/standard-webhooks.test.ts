import { describe, expect, it } from "vitest";

import { Secret, type WebhookRequest } from "@/lib/adapters/types";

import {
  STANDARD_WEBHOOK_HEADERS,
  STANDARD_WEBHOOK_TOLERANCE_SECONDS,
  standardWebhookKey,
  standardWebhookSignature,
  verifyStandardWebhook,
  type StandardWebhookHeaders,
} from "./standard-webhooks";

/*
 * The shared Standard Webhooks check (#429): what every provider that signs this way gets. Each
 * adapter tests only what is its own (Polar: the two keys one secret stands for).
 */

// Made up, and built from parts so CI's secret scan (gitleaks) does not read it as a credential.
const SECRET = new Secret(["whsec", Buffer.from("synthetic-standard-webhooks-key1").toString("base64")].join("_"));
const OTHER = new Secret(["whsec", Buffer.from("another-synthetic-signing-key-32").toString("base64")].join("_"));
const DELIVERY_ID = "msg_synthetic0000000000000001";
const NOW = new Date("2026-11-16T09:00:00.000Z");
const NOW_SECONDS = String(NOW.getTime() / 1000);
const BODY = '{"type":"order.paid","data":{"id":"order_1"}}';
const SVIX_HEADERS: StandardWebhookHeaders = { delivery: "svix-id", timestamp: "svix-timestamp", signature: "svix-signature" };

function keyOf(secret: Secret): Buffer {
  const key = standardWebhookKey(secret);
  if (key === null) throw new Error("expected a usable key");
  return key;
}

const KEY = keyOf(SECRET);

function sign(secret: Secret, deliveryId: string, timestamp: string, body: string): string {
  return standardWebhookSignature(keyOf(secret), deliveryId, timestamp, new TextEncoder().encode(body));
}

type Delivery = Partial<{
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  signedId: string;
  signedBody: string;
  names: StandardWebhookHeaders;
}>;

// A delivery signed with SECRET. Each option bends one part for a boundary test.
function delivery(options: Delivery = {}): WebhookRequest {
  const names = options.names ?? STANDARD_WEBHOOK_HEADERS;
  const id = options.id === undefined ? DELIVERY_ID : options.id;
  const timestamp = options.timestamp === undefined ? NOW_SECONDS : options.timestamp;
  const headers = new Headers({ "content-type": "application/json" });
  if (id !== null) headers.set(names.delivery, id);
  if (timestamp !== null) headers.set(names.timestamp, timestamp);
  const signature = options.signature === undefined ? sign(SECRET, options.signedId ?? id ?? "", timestamp ?? "", options.signedBody ?? BODY) : options.signature;
  if (signature !== null) headers.set(names.signature, signature);
  return { headers, rawBody: new TextEncoder().encode(BODY) };
}

describe("verifyStandardWebhook", () => {
  it("verifies the Standard Webhooks specification's own example", () => {
    // The example in the spec's "Signature scheme" section, built from parts for the secret scan.
    const secret = new Secret(["whsec", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"].join("_"));
    const id = ["msg", "p5jXN8AQM9LWM0D4loKWxJek"].join("_");
    const body = '{"test": 2432232314}';
    const signature = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
    expect(sign(secret, id, "1614265330", body)).toBe(signature);
    const headers = new Headers({ "webhook-id": id, "webhook-timestamp": "1614265330", "webhook-signature": signature });
    const request = { headers, rawBody: new TextEncoder().encode(body) };
    expect(verifyStandardWebhook(request, [keyOf(secret)], STANDARD_WEBHOOK_HEADERS, new Date(1614265330 * 1000))).toEqual({ ok: true, deliveryId: id });
  });

  it("reads the header names it is given (Svix's svix-id, svix-timestamp, svix-signature)", () => {
    expect(verifyStandardWebhook(delivery({ names: SVIX_HEADERS }), [KEY], SVIX_HEADERS, NOW)).toEqual({ ok: true, deliveryId: DELIVERY_ID });
    // The same delivery under the spec's names carries none of Svix's.
    expect(verifyStandardWebhook(delivery(), [KEY], SVIX_HEADERS, NOW)).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("accepts one matching entry among several while a secret rotates, in either order", () => {
    const old = sign(OTHER, DELIVERY_ID, NOW_SECONDS, BODY);
    const current = sign(SECRET, DELIVERY_ID, NOW_SECONDS, BODY);
    for (const signature of [`${old} ${current}`, `${current} ${old}`]) {
      expect(verifyStandardWebhook(delivery({ signature }), [KEY], STANDARD_WEBHOOK_HEADERS, NOW)).toEqual({ ok: true, deliveryId: DELIVERY_ID });
    }
  });

  it("accepts a match under any of the keys it is given", () => {
    expect(verifyStandardWebhook(delivery(), [keyOf(OTHER), KEY], STANDARD_WEBHOOK_HEADERS, NOW)).toEqual({ ok: true, deliveryId: DELIVERY_ID });
  });

  it.each<[string, Delivery, string]>([
    ["unsigned", { signature: null }, "missing_signature"],
    ["without a timestamp", { timestamp: null }, "missing_signature"],
    ["with a blank signature header (boundary: empty)", { signature: " " }, "missing_signature"],
    ["with a changed body", { signedBody: BODY.replace("order_1", "order_2") }, "bad_signature"],
    ["replayed under a new delivery id", { id: "msg_synthetic0000000000000002", signedId: DELIVERY_ID }, "bad_signature"],
    ["with an entry of another version", { signature: sign(SECRET, DELIVERY_ID, NOW_SECONDS, BODY).replace(/^v1,/, "v1a,") }, "bad_signature"],
    ["without a delivery id", { id: null, signedId: DELIVERY_ID }, "malformed"],
    ["with a delivery id longer than 200 characters (boundary)", { id: "m".repeat(201) }, "malformed"],
    ["with a timestamp that is not whole seconds", { timestamp: "1763283600.5" }, "malformed"],
    ["one second past the tolerance (boundary)", { timestamp: String(Number(NOW_SECONDS) - STANDARD_WEBHOOK_TOLERANCE_SECONDS - 1) }, "stale"],
    ["one second past the tolerance in the future (boundary)", { timestamp: String(Number(NOW_SECONDS) + STANDARD_WEBHOOK_TOLERANCE_SECONDS + 1) }, "stale"],
  ])("rejects a delivery %s", (_name, options, reason) => {
    expect(verifyStandardWebhook(delivery(options), [KEY], STANDARD_WEBHOOK_HEADERS, NOW)).toEqual({ ok: false, reason });
  });

  it.each([
    ["in the past", -STANDARD_WEBHOOK_TOLERANCE_SECONDS],
    ["in the future", STANDARD_WEBHOOK_TOLERANCE_SECONDS],
  ])("accepts a delivery exactly at the tolerance %s (boundary)", (_name, offset) => {
    const timestamp = String(Number(NOW_SECONDS) + offset);
    expect(verifyStandardWebhook(delivery({ timestamp }), [KEY], STANDARD_WEBHOOK_HEADERS, NOW)).toEqual({ ok: true, deliveryId: DELIVERY_ID });
  });

  it.each<[string, Buffer[]]>([
    ["no key (boundary: none)", []],
    ["only a key under 16 bytes (boundary)", [Buffer.from("fifteen-bytes!!")]],
  ])("verifies nothing with %s", (_name, keys) => {
    const short = keys[0];
    const signature = short === undefined ? sign(SECRET, DELIVERY_ID, NOW_SECONDS, BODY) : standardWebhookSignature(short, DELIVERY_ID, NOW_SECONDS, new TextEncoder().encode(BODY));
    expect(verifyStandardWebhook(delivery({ signature }), keys, STANDARD_WEBHOOK_HEADERS, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("standardWebhookKey", () => {
  it("decodes the base64 after whsec_, and the same base64 without the prefix", () => {
    const encoded = Buffer.from("synthetic-standard-webhooks-key1").toString("base64");
    expect(standardWebhookKey(new Secret(`whsec_${encoded}`))?.toString()).toBe("synthetic-standard-webhooks-key1");
    expect(standardWebhookKey(new Secret(encoded))?.toString()).toBe("synthetic-standard-webhooks-key1");
  });

  it.each([
    ["15 bytes (boundary: one short)", Buffer.alloc(15, 1), null],
    ["16 bytes (boundary: the minimum)", Buffer.alloc(16, 1), 16],
  ] as const)("refuses or keeps a secret decoding to %s", (_name, bytes, length) => {
    expect(standardWebhookKey(new Secret(`whsec_${bytes.toString("base64")}`))?.length ?? null).toBe(length);
  });
});
