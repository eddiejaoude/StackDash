import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "@/lib/adapters/events";
import {
  FAKE_WEBHOOK_HEADERS,
  FAKE_WEBHOOK_SECRET_ENV,
  FAKE_WEBHOOK_TOLERANCE_SECONDS,
  fakeAdapter,
  signFakeWebhook,
} from "@/lib/adapters/fake";
import { postHogAdapter } from "@/lib/adapters/posthog";
import { Secret, type AdapterContext, type ProviderAdapter, type WebhookDescriptor } from "@/lib/adapters/types";
import { MemoryJobStore } from "@/lib/jobs/memory-store";
import type { RecordWebhookDeliveryInput } from "@/lib/jobs/store";
import type { LogFields, Logger } from "@/lib/log/logger";

import { receiveWebhook, WEBHOOK_ENDPOINT_DELIVERIES_PER_MINUTE, WEBHOOK_MAX_BODY_BYTES, type ReceiveDeps } from "./receive";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1000;
const SECRET = "test-only-fake-webhook-secret";
const ENDPOINT_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_BODY = JSON.stringify({
  type: "event",
  account: "fake-acct-1",
  event: { typeId: "fake.deploy.succeeded", occurredAt: "2026-10-20T12:00:00.000Z" },
});

const fakeWebhooks: WebhookDescriptor = (() => {
  if (fakeAdapter.webhooks === undefined) throw new Error("The fake adapter declares no webhook");
  return fakeAdapter.webhooks;
})();

function withWebhooks(webhooks: Partial<WebhookDescriptor>): ProviderAdapter {
  return { ...fakeAdapter, webhooks: { ...fakeWebhooks, ...webhooks } };
}

// The fake provider as if its URL were per connection, for the connection-level route.
const connectionFake = withWebhooks({ registration: { kind: "connection" } });

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const adapterContext: AdapterContext = {
  fetch: () => Promise.reject(new Error("no network in tests")),
  now: () => NOW,
  timeoutMs: 1000,
  logger: silent,
};

type LogLine = { level: "info" | "warn" | "error"; event: string; fields: LogFields | undefined };

function setup(overrides: Partial<ReceiveDeps> = {}) {
  const store = new MemoryJobStore(() => NOW);
  const lines: LogLine[] = [];
  const deps: ReceiveDeps = {
    getAdapter: (id) => (id === "fake" ? fakeAdapter : id === "posthog" ? postHogAdapter : null),
    readEnv: (name) => (name === FAKE_WEBHOOK_SECRET_ENV ? SECRET : undefined),
    loadWebhookEndpoint: async () => null,
    countEndpointDelivery: async () => 1,
    recordWebhookDelivery: (input) => store.recordWebhookDelivery(input),
    adapterContext: () => adapterContext,
    now: () => NOW,
    log: {
      info: (event, fields) => lines.push({ level: "info", event, fields }),
      warn: (event, fields) => lines.push({ level: "warn", event, fields }),
      error: (event, fields) => lines.push({ level: "error", event, fields }),
    },
    // Records the error with the fields, as the real logError writes both: its name, message,
    // stack, and cause (redactError in src/lib/log/redact.ts).
    logError: (event, error, fields) => {
      const written =
        error instanceof Error ? { name: error.name, message: error.message, stack: error.stack, cause: String(error.cause) } : String(error);
      lines.push({ level: "error", event, fields: { ...fields, error: written } });
      return "REF-TEST0000";
    },
    ...overrides,
  };
  const webhookJobs = () => store.jobs.filter((job) => job.kind === "webhook");
  return { store, lines, deps, webhookJobs };
}

type DeliveryOptions = {
  deliveryId?: string;
  timestampSeconds?: number;
  // Null sends no signature header at all.
  signature?: string | null;
  secret?: string;
  // Signs this body while sending another one, as a tampered delivery would.
  signedBody?: string;
  // Signs this delivery id while sending `deliveryId`, as a replay under a new id would.
  signedDeliveryId?: string;
  headers?: Record<string, string>;
};

function delivery(body: string, options: DeliveryOptions = {}): Request {
  const timestampSeconds = options.timestampSeconds ?? NOW_SECONDS;
  const deliveryId = options.deliveryId ?? "delivery-1";
  const headers = new Headers({
    "content-type": "application/json",
    [FAKE_WEBHOOK_HEADERS.delivery]: deliveryId,
    [FAKE_WEBHOOK_HEADERS.timestamp]: String(timestampSeconds),
    ...options.headers,
  });
  const signature =
    options.signature === undefined
      ? signFakeWebhook({
          secret: options.secret ?? SECRET,
          deliveryId: options.signedDeliveryId ?? deliveryId,
          rawBody: options.signedBody ?? body,
          timestampSeconds,
        })
      : options.signature;
  if (signature !== null) headers.set(FAKE_WEBHOOK_HEADERS.signature, signature);
  return new Request("http://localhost/api/webhooks/fake", { method: "POST", headers, body });
}

function receive(deps: ReceiveDeps, request: Request, provider = "fake", endpointId: string | null = null): Promise<Response> {
  return receiveWebhook({ provider, endpointId, request }, deps);
}

describe("receiveWebhook", () => {
  it("accepts a signed delivery with 202, no-store, and queues one webhook job", async () => {
    const { deps, webhookJobs, lines } = setup();
    const response = await receive(deps, delivery(EVENT_BODY));
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(webhookJobs()).toHaveLength(1);
    expect(lines.filter((line) => line.level !== "info")).toEqual([]);
  });

  it("stores the parsed events, not the raw body", async () => {
    const recorded: RecordWebhookDeliveryInput[] = [];
    const { deps } = setup({
      recordWebhookDelivery: async (input) => {
        recorded.push(input);
        return true;
      },
    });
    await receive(deps, delivery(EVENT_BODY, { deliveryId: "delivery-parsed" }));
    expect(recorded).toEqual([
      {
        provider: "fake",
        deliveryId: "delivery-parsed",
        endpointId: null,
        outcome: {
          kind: "events",
          externalAccountId: "fake-acct-1",
          events: [
            expect.objectContaining({
              typeId: "fake.deploy.succeeded",
              dedupeKey: "fake.deploy.succeeded:fake-acct-1:2026-10-20",
              externalAccountId: "fake-acct-1",
            }),
          ],
        },
      },
    ]);
  });

  it("answers a repeated delivery id with 200 duplicate and queues no second job", async () => {
    const { deps, webhookJobs, lines } = setup();
    expect((await receive(deps, delivery(EVENT_BODY, { deliveryId: "delivery-repeat" }))).status).toBe(202);
    const repeat = await receive(deps, delivery(EVENT_BODY, { deliveryId: "delivery-repeat" }));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ status: "duplicate" });
    expect(webhookJobs()).toHaveLength(1);
    expect(lines).toContainEqual({ level: "info", event: "webhook.duplicate", fields: { provider: "fake", deliveryId: "delivery-repeat" } });
  });

  it.each([
    { name: "unsigned", options: { signature: null }, reason: "missing_signature" },
    { name: "signed with the wrong secret", options: { secret: "not-the-secret" }, reason: "bad_signature" },
    {
      name: "stale: one second past the tolerance",
      options: { timestampSeconds: NOW_SECONDS - FAKE_WEBHOOK_TOLERANCE_SECONDS - 1 },
      reason: "stale",
    },
    {
      name: "tampered: body changed after signing",
      options: { signedBody: EVENT_BODY.replace("fake-acct-1", "fake-acct-2") },
      reason: "bad_signature",
    },
    {
      name: "replayed: same body and timestamp under another delivery id",
      options: { deliveryId: "delivery-replayed", signedDeliveryId: "delivery-1" },
      reason: "bad_signature",
    },
  ] satisfies { name: string; options: DeliveryOptions; reason: string }[])(
    "rejects a delivery that is $name with 401 and logs no body or secret",
    async ({ options, reason }) => {
      const { deps, webhookJobs, lines } = setup();
      const request = delivery(EVENT_BODY, options);
      const signature = request.headers.get(FAKE_WEBHOOK_HEADERS.signature);
      const response = await receive(deps, request);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(webhookJobs()).toHaveLength(0);
      expect(lines).toEqual([{ level: "warn", event: "webhook.rejected", fields: { provider: "fake", reason, endpointId: null } }]);
      const logged = JSON.stringify(lines);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain("fake-acct-1");
      if (signature !== null) expect(logged).not.toContain(signature);
    },
  );

  it("accepts a timestamp exactly at the tolerance", async () => {
    const { deps } = setup();
    const response = await receive(deps, delivery(EVENT_BODY, { timestampSeconds: NOW_SECONDS - FAKE_WEBHOOK_TOLERANCE_SECONDS }));
    expect(response.status).toBe(202);
  });

  it.each([
    { name: "an unknown provider", provider: "nope", endpointId: null, deps: {} },
    { name: "a provider without webhooks", provider: "posthog", endpointId: null, deps: {} },
    { name: "the fake provider with its flag off", provider: "fake", endpointId: null, deps: { getAdapter: () => null } },
    { name: "an app-level provider on a connection URL", provider: "fake", endpointId: ENDPOINT_ID, deps: {} },
    {
      name: "a connection-level provider on the app URL",
      provider: "fake",
      endpointId: null,
      deps: { getAdapter: () => connectionFake },
    },
  ] satisfies { name: string; provider: string; endpointId: string | null; deps: Partial<ReceiveDeps> }[])(
    "answers 404 for $name",
    async ({ provider, endpointId, deps: overrides }) => {
      const { deps, webhookJobs } = setup(overrides);
      const response = await receive(deps, delivery(EVENT_BODY), provider, endpointId);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(webhookJobs()).toHaveLength(0);
    },
  );

  describe("body size cap", () => {
    // A body of exactly `length` bytes that the fake provider ignores: valid JSON it does not map.
    function paddedBody(length: number): string {
      const shell = JSON.stringify({ type: "padding", pad: "" });
      return JSON.stringify({ type: "padding", pad: "x".repeat(length - shell.length) });
    }

    it("accepts a body of exactly the cap", async () => {
      const { deps } = setup();
      const body = paddedBody(WEBHOOK_MAX_BODY_BYTES);
      expect(new TextEncoder().encode(body).byteLength).toBe(WEBHOOK_MAX_BODY_BYTES);
      expect((await receive(deps, delivery(body))).status).toBe(202);
    });

    it("refuses a body one byte over the cap with 413, without a Content-Length", async () => {
      const { deps, webhookJobs } = setup();
      const request = delivery(paddedBody(WEBHOOK_MAX_BODY_BYTES + 1));
      expect(request.headers.get("content-length")).toBeNull();
      const response = await receive(deps, request);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "payload_too_large" });
      expect(webhookJobs()).toHaveLength(0);
    });

    it("refuses a declared Content-Length over the cap with 413 before reading", async () => {
      const { deps } = setup();
      const request = delivery(EVENT_BODY, { headers: { "content-length": String(WEBHOOK_MAX_BODY_BYTES + 1) } });
      expect((await receive(deps, request)).status).toBe(413);
    });
  });

  it.each([
    { name: "unset", value: undefined },
    { name: "empty", value: "" },
    { name: "whitespace only", value: "   " },
  ])("answers 503 and logs the variable name when the app secret is $name", async ({ value }) => {
    const { deps, webhookJobs, lines } = setup({ readEnv: () => value });
    const response = await receive(deps, delivery(EVENT_BODY));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
    expect(webhookJobs()).toHaveLength(0);
    expect(lines).toEqual([
      { level: "error", event: "webhook.secret_missing", fields: { provider: "fake", secretEnv: FAKE_WEBHOOK_SECRET_ENV } },
    ]);
  });

  describe("connection-level URL", () => {
    const endpoint = {
      id: ENDPOINT_ID,
      provider: "fake" as const,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      connectionId: "33333333-3333-4333-8333-333333333333",
      secret: new Secret(SECRET),
    };

    it("verifies against the endpoint's own secret and records the endpoint id", async () => {
      const recorded: RecordWebhookDeliveryInput[] = [];
      const { deps } = setup({
        getAdapter: () => connectionFake,
        // The instance secret is not consulted for a per-connection URL.
        readEnv: () => undefined,
        loadWebhookEndpoint: async (id) => (id === ENDPOINT_ID ? endpoint : null),
        recordWebhookDelivery: async (input) => {
          recorded.push(input);
          return true;
        },
      });
      const response = await receive(deps, delivery(EVENT_BODY), "fake", ENDPOINT_ID);
      expect(response.status).toBe(202);
      expect(recorded.map((input) => input.endpointId)).toEqual([ENDPOINT_ID]);
    });

    it.each([
      { name: "the endpoint does not exist", loaded: null },
      { name: "the endpoint belongs to another provider", loaded: { ...endpoint, provider: "vercel" as const } },
    ])("answers 404 when $name", async ({ loaded }) => {
      const { deps, webhookJobs } = setup({ getAdapter: () => connectionFake, loadWebhookEndpoint: async () => loaded });
      const response = await receive(deps, delivery(EVENT_BODY), "fake", ENDPOINT_ID);
      expect(response.status).toBe(404);
      expect(webhookJobs()).toHaveLength(0);
    });

    it("rejects a delivery signed with the instance secret instead of the endpoint's with 401", async () => {
      const { deps } = setup({
        getAdapter: () => connectionFake,
        loadWebhookEndpoint: async () => ({ ...endpoint, secret: new Secret("the-endpoint-secret") }),
      });
      expect((await receive(deps, delivery(EVENT_BODY), "fake", ENDPOINT_ID)).status).toBe(401);
    });

    describe("rate limit", () => {
      function limited(countThisMinute: number) {
        const counted: string[] = [];
        const recorded: RecordWebhookDeliveryInput[] = [];
        const harness = setup({
          getAdapter: () => connectionFake,
          loadWebhookEndpoint: async () => endpoint,
          countEndpointDelivery: async (id) => {
            counted.push(id);
            return countThisMinute;
          },
          recordWebhookDelivery: async (input) => {
            recorded.push(input);
            return true;
          },
        });
        return { ...harness, counted, recorded };
      }

      it("accepts the delivery that reaches the per-minute limit (boundary: at the limit)", async () => {
        const { deps, counted, recorded } = limited(WEBHOOK_ENDPOINT_DELIVERIES_PER_MINUTE);
        expect((await receive(deps, delivery(EVENT_BODY), "fake", ENDPOINT_ID)).status).toBe(202);
        expect(counted).toEqual([ENDPOINT_ID]);
        expect(recorded).toHaveLength(1);
      });

      it("answers 429 with Retry-After and stores nothing one over the limit (boundary: limit + 1)", async () => {
        const { deps, recorded, lines } = limited(WEBHOOK_ENDPOINT_DELIVERIES_PER_MINUTE + 1);
        const response = await receive(deps, delivery(EVENT_BODY), "fake", ENDPOINT_ID);
        expect(response.status).toBe(429);
        expect(await response.json()).toEqual({ error: "rate_limited" });
        expect(response.headers.get("cache-control")).toBe("no-store");
        // NOW is on a minute boundary: the next minute starts a full minute later.
        expect(response.headers.get("retry-after")).toBe("60");
        expect(recorded).toEqual([]);
        expect(lines).toEqual([{ level: "warn", event: "webhook.rate_limited", fields: { provider: "fake", endpointId: ENDPOINT_ID } }]);
      });

      it("does not count a delivery that fails verification", async () => {
        const { deps, counted } = limited(1);
        expect((await receive(deps, delivery(EVENT_BODY, { signature: null }), "fake", ENDPOINT_ID)).status).toBe(401);
        expect(counted).toEqual([]);
      });

      it("never counts the app-level URL, whose secret only the provider holds", async () => {
        const { deps } = setup({ countEndpointDelivery: () => Promise.reject(new Error("must not be called")) });
        expect((await receive(deps, delivery(EVENT_BODY))).status).toBe(202);
      });
    });
  });

  describe("parse output", () => {
    it("answers 400 with a reference when parse throws, logging the error's name and none of its text", async () => {
      const marker = "body-marker-7f3a";
      const body = JSON.stringify({ type: "event", account: "fake-acct-1", note: marker });
      const { deps, webhookJobs, lines } = setup({
        getAdapter: () =>
          withWebhooks({
            parse: () => {
              // As V8's JSON.parse and a thrown ZodError do: the message quotes the input.
              throw new SyntaxError(`Unexpected token in JSON at position 40: "${marker}"`, { cause: new Error(marker) });
            },
          }),
      });
      const response = await receive(deps, delivery(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request", referenceId: "REF-TEST0000" });
      expect(webhookJobs()).toHaveLength(0);
      expect(lines.map((line) => line.event)).toEqual(["webhook.parse_failed"]);
      expect(lines[0]?.fields).toMatchObject({ provider: "fake", deliveryId: "delivery-1", errorName: "SyntaxError" });
      expect(JSON.stringify(lines)).not.toContain(marker);
    });

    it.each([
      {
        name: "an undeclared event type",
        event: { typeId: "fake.unknown", occurredAt: NOW, severity: "info", title: "Unknown", externalAccountId: "fake-acct-1", dedupeKey: "k" },
        issues: ["0.typeId"],
      },
      {
        name: "an event of another account",
        event: { typeId: "fake.signup", occurredAt: NOW, severity: "info", title: "New signup", externalAccountId: "fake-acct-2", dedupeKey: "k" },
        issues: ["0.externalAccountId"],
      },
    ] satisfies { name: string; event: ActivityEvent; issues: string[] }[])("answers 422 and logs issue paths only for $name", async ({ event, issues }) => {
      const { deps, webhookJobs, lines } = setup({
        // An adapter whose parse drifted from its declaration or its account.
        getAdapter: () => withWebhooks({ parse: () => ({ kind: "events", externalAccountId: "fake-acct-1", events: [event] }) }),
      });
      const response = await receive(deps, delivery(EVENT_BODY));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "invalid_events", referenceId: "REF-TEST0000" });
      expect(webhookJobs()).toHaveLength(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.fields?.issues).toEqual(issues);
    });

    it("records a verified delivery the provider does not map as ignored and processed, with 202 and no job", async () => {
      const { deps, webhookJobs, store } = setup();
      const response = await receive(deps, delivery(JSON.stringify({ type: "ping" })));
      expect(response.status).toBe(202);
      expect(webhookJobs()).toHaveLength(0);
      expect(store.webhookDeliveries.map((row) => row.status)).toEqual(["processed"]);
    });
  });

  it("answers 500 with a reference when storing the delivery fails, so the provider retries", async () => {
    const { deps } = setup({
      recordWebhookDelivery: () => Promise.reject(new Error("database unavailable")),
    });
    const response = await receive(deps, delivery(EVENT_BODY));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error", referenceId: "REF-TEST0000" });
  });
});
