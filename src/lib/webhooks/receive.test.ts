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
import {
  Secret,
  type AdapterContext,
  type ConnectionMode,
  type ProviderAdapter,
  type WebhookConnection,
  type WebhookDescriptor,
  type WebhookOutcome,
  type WebhookSource,
} from "@/lib/adapters/types";
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
const connectionFake = withWebhooks({
  registration: { kind: "connection", setup: { secretSource: "stackdash", manualSteps: ["Add the address."], removalSteps: ["Delete the webhook."] } },
});

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
    loadEndpointConnection: async () => ({ accounts: [] }),
    countEndpointDelivery: async () => 1,
    recordWebhookDelivery: (input) => store.recordWebhookDelivery(input),
    recordWebhookSource: async () => true,
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
        // The fake provider has no simulated twin, so its deliveries are always real (#495).
        simulated: false,
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

  describe("a test mode secret beside the app secret (#481)", () => {
    const TEST_MODE_SECRET = "test-only-fake-test-mode-webhook-secret";
    const TEST_MODE_SECRET_ENV = "FAKE_WEBHOOK_TEST_SECRET";
    const signup: ActivityEvent = { typeId: "fake.signup", occurredAt: NOW, severity: "info", title: "New signup", externalAccountId: "fake-acct-1", dedupeKey: "k" };
    const eventsIn = (mode: ConnectionMode | undefined): WebhookOutcome =>
      mode === undefined ? { kind: "events", externalAccountId: "fake-acct-1", events: [signup] } : { kind: "events", externalAccountId: "fake-acct-1", mode, events: [signup] };
    const uninstallIn = (mode: ConnectionMode | undefined): WebhookOutcome =>
      mode === undefined
        ? { kind: "uninstalled", externalAccountId: "fake-acct-1", occurredAt: NOW }
        : { kind: "uninstalled", externalAccountId: "fake-acct-1", mode, occurredAt: NOW };

    /** The fake provider with a test mode endpoint, its mode recorded per connection, and `outcome` as what it parses. */
    function twoSecrets(outcome: WebhookOutcome, env: Readonly<{ primary?: string; testMode?: string }> = { primary: SECRET, testMode: TEST_MODE_SECRET }) {
      return setup({
        getAdapter: () => ({
          ...withWebhooks({
            registration: { kind: "app", secretEnv: FAKE_WEBHOOK_SECRET_ENV, testModeSecretEnv: TEST_MODE_SECRET_ENV },
            parse: () => outcome,
          }),
          modeOf: () => "live",
        }),
        readEnv: (name) => (name === FAKE_WEBHOOK_SECRET_ENV ? env.primary : name === TEST_MODE_SECRET_ENV ? env.testMode : undefined),
      });
    }

    it.each(["live", "test", undefined] as const)("accepts a delivery the app secret verifies, whatever mode it names (%s)", async (mode) => {
      const { deps, store } = twoSecrets(eventsIn(mode));
      const response = await receive(deps, delivery(EVENT_BODY));
      expect(response.status).toBe(202);
      expect(store.webhookDeliveries.map((row) => row.outcome)).toEqual([eventsIn(mode)]);
    });

    it("accepts a test mode delivery the test mode secret verifies, storing its mode", async () => {
      const { deps, store, webhookJobs } = twoSecrets(eventsIn("test"));
      const response = await receive(deps, delivery(EVENT_BODY, { secret: TEST_MODE_SECRET }));
      expect(response.status).toBe(202);
      expect(webhookJobs()).toHaveLength(1);
      expect(store.webhookDeliveries.map((row) => row.outcome)).toEqual([eventsIn("test")]);
    });

    it("accepts a test mode uninstall the test mode secret verifies", async () => {
      const { deps, store } = twoSecrets(uninstallIn("test"));
      const response = await receive(deps, delivery(EVENT_BODY, { secret: TEST_MODE_SECRET }));
      expect(response.status).toBe(202);
      expect(store.webhookDeliveries.map((row) => row.outcome)).toEqual([uninstallIn("test")]);
    });

    it("accepts an ignored delivery the test mode secret verifies, which reaches no connection", async () => {
      const { deps, store, webhookJobs } = twoSecrets({ kind: "ignored", reason: "unmapped" });
      const response = await receive(deps, delivery(EVENT_BODY, { secret: TEST_MODE_SECRET }));
      expect(response.status).toBe(202);
      expect(webhookJobs()).toHaveLength(0);
      expect(store.webhookDeliveries.map((row) => row.status)).toEqual(["processed"]);
    });

    it.each([
      { name: "the test mode endpoint's copy first", first: TEST_MODE_SECRET, second: SECRET },
      { name: "the live mode endpoint's copy first", first: SECRET, second: TEST_MODE_SECRET },
    ])(
      "answers the second copy of one test mode event, signed with the other secret, as a duplicate and queues one job ($name)",
      async ({ first, second }) => {
        // An account installed in both modes: Stripe sends its test mode event to both endpoints.
        const { deps, webhookJobs } = twoSecrets(eventsIn("test"));
        expect((await receive(deps, delivery(EVENT_BODY, { deliveryId: "delivery-both-modes", secret: first }))).status).toBe(202);
        const repeat = await receive(deps, delivery(EVENT_BODY, { deliveryId: "delivery-both-modes", secret: second }));
        expect(repeat.status).toBe(200);
        expect(await repeat.json()).toEqual({ status: "duplicate" });
        expect(webhookJobs()).toHaveLength(1);
      },
    );

    it.each([
      { name: "events naming live mode", outcome: eventsIn("live"), error: "invalid_events", event: "webhook.invalid_events" },
      { name: "events naming no mode", outcome: eventsIn(undefined), error: "invalid_events", event: "webhook.invalid_events" },
      { name: "an uninstall naming live mode", outcome: uninstallIn("live"), error: "invalid_uninstall", event: "webhook.invalid_uninstall" },
      { name: "an uninstall naming no mode", outcome: uninstallIn(undefined), error: "invalid_uninstall", event: "webhook.invalid_uninstall" },
    ])("answers 422 and stores nothing for $name verified only by the test mode secret (boundary: never live)", async ({ outcome, error, event }) => {
      const { deps, store, webhookJobs, lines } = twoSecrets(outcome);
      const response = await receive(deps, delivery(EVENT_BODY, { secret: TEST_MODE_SECRET }));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error, referenceId: "REF-TEST0000" });
      expect(webhookJobs()).toHaveLength(0);
      expect(store.webhookDeliveries).toEqual([]);
      expect(lines.map((line) => line.event)).toEqual([event]);
      expect(lines[0]?.fields?.issues).toEqual(["mode"]);
    });

    it("accepts a test mode delivery with only the test mode secret set (boundary: no live secret)", async () => {
      const { deps } = twoSecrets(eventsIn("test"), { testMode: TEST_MODE_SECRET });
      expect((await receive(deps, delivery(EVENT_BODY, { secret: TEST_MODE_SECRET }))).status).toBe(202);
    });

    it("refuses with 401 a delivery the app secret would verify while only the test mode secret is set (boundary: no live secret)", async () => {
      const { deps, store } = twoSecrets(eventsIn("live"), { testMode: TEST_MODE_SECRET });
      expect((await receive(deps, delivery(EVENT_BODY))).status).toBe(401);
      expect(store.webhookDeliveries).toEqual([]);
    });

    it("refuses with 401 a delivery neither secret verifies", async () => {
      const { deps, lines } = twoSecrets(eventsIn("test"));
      expect((await receive(deps, delivery(EVENT_BODY, { secret: "some-other-secret" }))).status).toBe(401);
      expect(lines).toEqual([{ level: "warn", event: "webhook.rejected", fields: { provider: "fake", reason: "bad_signature", endpointId: null } }]);
    });

    it("says a delivery signed with the test mode secret but past the tolerance is stale, not a bad signature", async () => {
      const { deps, lines } = twoSecrets(eventsIn("test"));
      const timestampSeconds = NOW_SECONDS - FAKE_WEBHOOK_TOLERANCE_SECONDS - 1;
      expect((await receive(deps, delivery(EVENT_BODY, { secret: TEST_MODE_SECRET, timestampSeconds }))).status).toBe(401);
      expect(lines.map((line) => line.fields?.reason)).toEqual(["stale"]);
    });

    it("answers 503, naming the app secret's variable, when neither secret is set", async () => {
      const { deps, lines } = twoSecrets(eventsIn("test"), {});
      expect((await receive(deps, delivery(EVENT_BODY))).status).toBe(503);
      expect(lines).toEqual([{ level: "error", event: "webhook.secret_missing", fields: { provider: "fake", secretEnv: FAKE_WEBHOOK_SECRET_ENV } }]);
    });
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

    describe("connection and source (#428)", () => {
      const connection: WebhookConnection = { accounts: [{ externalId: "fake-acct-1", displayName: "example-team" }] };
      const source: WebhookSource = { id: "9", name: "group1/app" };

      // The fake provider per connection, recording the connection `parse` was handed and naming a source.
      function sourced(overrides: Partial<ReceiveDeps> = {}) {
        const seen: Array<WebhookConnection | undefined> = [];
        const sources: Array<{ endpointId: string; source: WebhookSource; receivedAt: Date }> = [];
        const recorded: RecordWebhookDeliveryInput[] = [];
        const adapter = withWebhooks({
          registration: connectionFake.webhooks?.registration ?? { kind: "app", secretEnv: FAKE_WEBHOOK_SECRET_ENV },
          parse: (request, ctx, handed) => {
            seen.push(handed);
            const outcome = fakeWebhooks.parse(request, ctx);
            return outcome.kind === "uninstalled" ? outcome : { ...outcome, source };
          },
        });
        const harness = setup({
          getAdapter: () => adapter,
          loadWebhookEndpoint: async () => endpoint,
          loadEndpointConnection: async (loaded) => {
            expect(loaded.id).toBe(ENDPOINT_ID);
            return connection;
          },
          recordWebhookSource: async (input) => {
            sources.push(input);
            return true;
          },
          recordWebhookDelivery: async (input) => {
            recorded.push(input);
            return true;
          },
          ...overrides,
        });
        return { ...harness, seen, sources, recorded };
      }

      it("parses with the accounts the endpoint's connection includes, and records the source it names", async () => {
        const { deps, seen, sources, recorded } = sourced();
        expect((await receive(deps, delivery(EVENT_BODY), "fake", ENDPOINT_ID)).status).toBe(202);
        expect(seen).toEqual([connection]);
        expect(sources).toEqual([{ endpointId: ENDPOINT_ID, source, receivedAt: NOW }]);
        expect(recorded).toHaveLength(1);
      });

      it("parses an app-level delivery with no connection and records no source", async () => {
        const seen: Array<WebhookConnection | undefined> = [];
        const { deps } = setup({
          getAdapter: () =>
            withWebhooks({
              parse: (request, ctx, handed) => {
                seen.push(handed);
                return fakeWebhooks.parse(request, ctx);
              },
            }),
          loadEndpointConnection: () => Promise.reject(new Error("must not be called")),
          recordWebhookSource: () => Promise.reject(new Error("must not be called")),
        });
        expect((await receive(deps, delivery(EVENT_BODY))).status).toBe(202);
        expect(seen).toEqual([undefined]);
      });

      it("still accepts the delivery when the endpoint holds as many sources as it may, with a warning (boundary: limit)", async () => {
        const { deps, lines, recorded } = sourced({ recordWebhookSource: async () => false });
        expect((await receive(deps, delivery(EVENT_BODY), "fake", ENDPOINT_ID)).status).toBe(202);
        expect(recorded).toHaveLength(1);
        expect(lines.filter((line) => line.level === "warn").map((line) => line.event)).toEqual(["webhook.source_limit"]);
      });

      it("still accepts the delivery when recording its source fails, logging the failure (boundary: database fails)", async () => {
        const { deps, lines, recorded } = sourced({ recordWebhookSource: () => Promise.reject(new Error("database unavailable")) });
        expect((await receive(deps, delivery(EVENT_BODY), "fake", ENDPOINT_ID)).status).toBe(202);
        expect(recorded).toHaveLength(1);
        expect(lines.filter((line) => line.level === "error").map((line) => line.event)).toEqual(["webhook.source_record_failed"]);
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

    it("accepts an uninstall naming an installation from an adapter that records installations (#480)", async () => {
      const outcome = { kind: "uninstalled", by: "installation", installationId: "fake-installation-1", occurredAt: NOW } as const;
      const { deps, webhookJobs, store } = setup({
        getAdapter: () => ({ ...withWebhooks({ parse: () => outcome }), installationIdOf: () => "fake-installation-1" }),
      });
      const response = await receive(deps, delivery(EVENT_BODY));
      expect(response.status).toBe(202);
      expect(webhookJobs()).toHaveLength(1);
      expect(store.webhookDeliveries.map((row) => row.outcome)).toEqual([outcome]);
    });

    it.each([
      {
        name: "an installation from an adapter that does not declare installationIdOf",
        outcome: { kind: "uninstalled", by: "installation", installationId: "fake-installation-1", occurredAt: NOW },
        issues: ["by"],
      },
      {
        name: "a blank installation id",
        outcome: { kind: "uninstalled", by: "installation", installationId: " ", occurredAt: NOW },
        issues: ["installationId", "by"],
      },
      { name: "a blank account id", outcome: { kind: "uninstalled", externalAccountId: "", occurredAt: NOW }, issues: ["externalAccountId"] },
      {
        name: "a time that is not one",
        outcome: { kind: "uninstalled", externalAccountId: "fake-acct-1", occurredAt: new Date(Number.NaN) },
        issues: ["occurredAt"],
      },
    ] satisfies { name: string; outcome: WebhookOutcome; issues: string[] }[])(
      "answers 422 and logs issue names only for an uninstall with $name (boundary)",
      async ({ outcome, issues }) => {
        const { deps, webhookJobs, lines } = setup({ getAdapter: () => withWebhooks({ parse: () => outcome }) });
        const response = await receive(deps, delivery(EVENT_BODY));
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ error: "invalid_uninstall", referenceId: "REF-TEST0000" });
        expect(webhookJobs()).toHaveLength(0);
        expect(lines.map((line) => line.event)).toEqual(["webhook.invalid_uninstall"]);
        expect(lines[0]?.fields?.issues).toEqual(issues);
      },
    );

    describe("events naming an installation (#497)", () => {
      const signup: ActivityEvent = { typeId: "fake.signup", occurredAt: NOW, severity: "info", title: "New signup", externalAccountId: "fake-acct-1", dedupeKey: "k" };
      const fromInstallation = (installationId: string): WebhookOutcome => ({ kind: "events", externalAccountId: "fake-acct-1", installationId, events: [signup] });

      it("accepts events naming an installation from an adapter that records installations, storing the installation", async () => {
        const outcome = fromInstallation("fake-installation-1");
        const { deps, webhookJobs, store } = setup({
          getAdapter: () => ({ ...withWebhooks({ parse: () => outcome }), installationIdOf: () => "fake-installation-1" }),
        });
        const response = await receive(deps, delivery(EVENT_BODY));
        expect(response.status).toBe(202);
        expect(webhookJobs()).toHaveLength(1);
        expect(store.webhookDeliveries.map((row) => row.outcome)).toEqual([outcome]);
      });

      it.each([
        { name: "an installation from an adapter that does not declare installationIdOf", installationId: "fake-installation-1", records: false },
        { name: "a blank installation id", installationId: " ", records: true },
        { name: "an empty installation id", installationId: "", records: true },
      ])("answers 422 and logs the issue name only for events with $name (boundary)", async ({ installationId, records }) => {
        const parse = () => fromInstallation(installationId);
        const { deps, webhookJobs, lines, store } = setup({
          getAdapter: () => (records ? { ...withWebhooks({ parse }), installationIdOf: () => "fake-installation-1" } : withWebhooks({ parse })),
        });
        const response = await receive(deps, delivery(EVENT_BODY));
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ error: "invalid_events", referenceId: "REF-TEST0000" });
        expect(webhookJobs()).toHaveLength(0);
        expect(store.webhookDeliveries).toEqual([]);
        expect(lines.map((line) => line.event)).toEqual(["webhook.invalid_events"]);
        expect(lines[0]?.fields?.issues).toEqual(["installationId"]);
      });
    });

    describe("events and uninstalls naming a mode (#481)", () => {
      const signup: ActivityEvent = { typeId: "fake.signup", occurredAt: NOW, severity: "info", title: "New signup", externalAccountId: "fake-acct-1", dedupeKey: "k" };
      // What a parse that copied an unchecked value would return: a mode the type does not allow.
      const drifted: WebhookOutcome = { kind: "events", externalAccountId: "fake-acct-1", mode: "live", events: [] };
      Object.assign(drifted, { mode: "sandbox" });

      it.each([
        { name: "events", outcome: { kind: "events", externalAccountId: "fake-acct-1", mode: "test", events: [signup] } },
        { name: "an uninstall", outcome: { kind: "uninstalled", externalAccountId: "fake-acct-1", mode: "live", occurredAt: NOW } },
      ] satisfies { name: string; outcome: WebhookOutcome }[])("accepts $name naming a mode from an adapter that records modes, storing the mode", async ({ outcome }) => {
        const { deps, store } = setup({ getAdapter: () => ({ ...withWebhooks({ parse: () => outcome }), modeOf: () => "live" }) });
        expect((await receive(deps, delivery(EVENT_BODY))).status).toBe(202);
        expect(store.webhookDeliveries.map((row) => row.outcome)).toEqual([outcome]);
      });

      it.each([
        { name: "events from an adapter that does not declare modeOf", outcome: { kind: "events", externalAccountId: "fake-acct-1", mode: "live", events: [signup] }, records: false, error: "invalid_events" },
        { name: "an uninstall from an adapter that does not declare modeOf", outcome: { kind: "uninstalled", externalAccountId: "fake-acct-1", mode: "test", occurredAt: NOW }, records: false, error: "invalid_uninstall" },
        { name: "events naming a mode that is not one", outcome: drifted, records: true, error: "invalid_events" },
      ] satisfies { name: string; outcome: WebhookOutcome; records: boolean; error: string }[])(
        "answers 422 and logs the issue name only for $name (boundary)",
        async ({ outcome, records, error }) => {
          const parse = () => outcome;
          const { deps, store, lines } = setup({ getAdapter: () => (records ? { ...withWebhooks({ parse }), modeOf: () => "live" } : withWebhooks({ parse })) });
          const response = await receive(deps, delivery(EVENT_BODY));
          expect(response.status).toBe(422);
          expect(await response.json()).toEqual({ error, referenceId: "REF-TEST0000" });
          expect(store.webhookDeliveries).toEqual([]);
          expect(lines[0]?.fields?.issues).toEqual(["mode"]);
        },
      );
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
