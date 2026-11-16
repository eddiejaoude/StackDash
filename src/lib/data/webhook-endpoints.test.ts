import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Secret } from "@/lib/adapters/types";
import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { fakeSupabase, type Row } from "@/lib/supabase/fake-postgrest";

import {
  getConnectionWebhook,
  insertWebhookEndpoint,
  listWebhookSources,
  loadWebhookEndpoint,
  WEBHOOK_SOURCES_PER_ENDPOINT,
  WebhookEndpointExistsError,
  WebhookEndpointLimitError,
  type NewWebhookEndpoint,
} from "./webhook-endpoints";

/*
 * A per-connection webhook secret (#28) sealed by insertWebhookEndpoint and read back by
 * loadWebhookEndpoint, the way the route reads it. The write goes through a client that records
 * the row the insert sends; the read goes through the fake PostgREST over that row, so the
 * ciphertext, its key id, and its associated data make the whole round trip. The setup panel's read
 * (#426) goes through the same fake.
 */

vi.mock("@/lib/supabase/admin");

const WORKSPACE_ID = "28100000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "28100000-0000-4000-8000-000000000002";
const CONNECTION_ID = "28100000-0000-4000-8000-000000000003";
const OTHER_CONNECTION_ID = "28100000-0000-4000-8000-000000000004";
const ENDPOINT_ID = "28100000-0000-4000-8000-000000000005";

const CONNECTION: Row = { id: CONNECTION_ID, workspace_id: WORKSPACE_ID, provider: "fake" };

// The row the insert sends: bytea travels as Postgres hex text, the setup columns as they are.
const WrittenRowSchema = z.record(z.string(), z.union([z.string(), z.boolean(), z.null()]));

/**
 * A client whose connection lookup answers from `connections` and that records each inserted
 * endpoint row, or answers the insert with the Postgres error `insertError` names.
 */
function recordingClient(connections: readonly Row[], insertError?: string) {
  const written: Row[] = [];
  const db = createClient<Database>("http://postgrest.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/connections")) {
          const filters = [...url.searchParams].filter(([column]) => column !== "select");
          return Response.json(connections.filter((row) => filters.every(([column, filter]) => filter === `eq.${String(row[column])}`)));
        }
        if (insertError !== undefined) return Response.json({ code: insertError, message: "refused" }, { status: 409 });
        const body: unknown = JSON.parse(String(init?.body));
        written.push(WrittenRowSchema.parse(body));
        return new Response(null, { status: 201 });
      },
    },
  });
  vi.mocked(createAdminClient).mockReturnValue(db);
  return written;
}

function readFrom(rows: readonly Row[], deliveries: readonly Row[] = []) {
  const { db, requests } = fakeSupabase({ webhook_endpoints: rows, webhook_deliveries: deliveries });
  vi.mocked(createAdminClient).mockReturnValue(db);
  return requests;
}

const newEndpoint = (secret: string): NewWebhookEndpoint => ({
  id: ENDPOINT_ID,
  workspaceId: WORKSPACE_ID,
  connectionId: CONNECTION_ID,
  provider: "fake",
  secret: new Secret(secret),
  setup: { mode: "manual", awaitingProviderSecret: false },
});

/** Seals `secret` for the fake connection and returns the stored row, as the database would hold it. */
async function sealed(secret: string): Promise<Row> {
  const written = recordingClient([CONNECTION]);
  await insertWebhookEndpoint(newEndpoint(secret));
  expect(written).toHaveLength(1);
  const [row] = written;
  if (row === undefined) throw new Error("expected one written row");
  return row;
}

beforeEach(() => {
  // A key generated per run, so no key material is committed.
  vi.stubEnv("STACKDASH_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("STACKDASH_ENCRYPTION_KEYS_PREVIOUS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("insertWebhookEndpoint and loadWebhookEndpoint (#28)", () => {
  it("seals the secret so the endpoint loads it back with its workspace, connection, and provider", async () => {
    const secret = randomBytes(24).toString("hex");
    const row = await sealed(secret);
    // Neither the secret nor its bytes (bytea travels as hex) are stored in the clear.
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(Buffer.from(secret).toString("hex"));
    readFrom([row]);

    const endpoint = await loadWebhookEndpoint(ENDPOINT_ID);

    expect(endpoint).toEqual({ id: ENDPOINT_ID, provider: "fake", workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, secret: expect.any(Secret) });
    expect(endpoint?.secret.reveal()).toBe(secret);
  });

  it.each([
    { name: "another workspace", workspaceId: OTHER_WORKSPACE_ID, provider: "fake" },
    { name: "another provider", workspaceId: WORKSPACE_ID, provider: "github" },
  ] as const)("refuses to attach a secret to a connection of $name (boundary: wrong owner)", async ({ workspaceId, provider }) => {
    const written = recordingClient([CONNECTION]);

    await expect(insertWebhookEndpoint({ ...newEndpoint("whsec-test"), workspaceId, provider })).rejects.toThrow(
      "the connection does not belong to this workspace and provider",
    );
    expect(written).toEqual([]);
  });

  it.each([
    { name: "empty", id: "" },
    { name: "not a uuid", id: "not-a-uuid" },
    { name: "a path", id: "../28100000-0000-4000-8000-000000000005" },
    { name: "one character too long", id: `${ENDPOINT_ID}0` },
  ])("loads nothing for an id that is $name, without a query (boundary: malformed id)", async ({ id }) => {
    const requests = readFrom([]);

    expect(await loadWebhookEndpoint(id)).toBeNull();
    expect(requests).toEqual([]);
  });

  it("loads nothing for an endpoint that does not exist (boundary: unknown id)", async () => {
    readFrom([]);

    expect(await loadWebhookEndpoint(ENDPOINT_ID)).toBeNull();
  });

  it.each([
    { name: "moved to another connection's row", change: (row: Row): Row => ({ ...row, connection_id: OTHER_CONNECTION_ID }) },
    { name: "moved to another workspace's row", change: (row: Row): Row => ({ ...row, workspace_id: OTHER_WORKSPACE_ID }) },
  ])("refuses a sealed secret $name and logs it without the secret (boundary: associated data)", async ({ change }) => {
    const secret = randomBytes(24).toString("hex");
    readFrom([change(await sealed(secret))]);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(await loadWebhookEndpoint(ENDPOINT_ID)).toBeNull();
    expect(warn).toHaveBeenCalledExactlyOnceWith("webhook_endpoint.secret_unreadable", { endpointId: ENDPOINT_ID, keyId: expect.any(String) });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });

  it("loads nothing once the key that sealed the secret is no longer configured (boundary: key rotated away)", async () => {
    readFrom([await sealed("whsec-test")]);
    vi.stubEnv("STACKDASH_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(await loadWebhookEndpoint(ENDPOINT_ID)).toBeNull();
  });
});

describe("webhook setup (#426)", () => {
  it.each([
    { name: "manual, awaiting the provider's secret", setup: { mode: "manual", awaitingProviderSecret: true } as const, providerWebhookId: null, awaiting: true },
    { name: "automatic", setup: { mode: "automatic", providerWebhookId: "hook_1" } as const, providerWebhookId: "hook_1", awaiting: false },
  ])("stores how the endpoint was set up: $name", async ({ setup, providerWebhookId, awaiting }) => {
    const written = recordingClient([CONNECTION]);
    await insertWebhookEndpoint({ ...newEndpoint("whsec-test"), setup });
    expect(written[0]).toMatchObject({ id: ENDPOINT_ID, setup_mode: setup.mode, provider_webhook_id: providerWebhookId, awaiting_provider_secret: awaiting });
  });

  it.each([
    { name: "the workspace is at its limit", code: "54000", error: WebhookEndpointLimitError },
    { name: "the connection already has one (a second setup raced the first)", code: "23505", error: WebhookEndpointExistsError },
  ])("refuses a new endpoint when $name (boundary)", async ({ code, error }) => {
    recordingClient([CONNECTION], code);
    await expect(insertWebhookEndpoint(newEndpoint("whsec-test"))).rejects.toBeInstanceOf(error);
  });

  it("reads the setup and the newest delivery of the connection's own endpoint", async () => {
    const row = await sealed("whsec-test");
    readFrom(
      [row],
      [
        { id: "d1", endpoint_id: ENDPOINT_ID, received_at: "2026-11-16T09:00:00.000Z" },
        { id: "d2", endpoint_id: ENDPOINT_ID, received_at: "2026-11-16T10:00:00.000Z" },
        { id: "d3", endpoint_id: "28100000-0000-4000-8000-000000000009", received_at: "2026-11-16T11:00:00.000Z" },
      ],
    );

    const webhook = await getConnectionWebhook(WORKSPACE_ID, CONNECTION_ID);

    expect(webhook).toEqual({
      id: ENDPOINT_ID,
      setupMode: "manual",
      perSource: false,
      awaitingProviderSecret: false,
      lastDeliveryAt: new Date("2026-11-16T10:00:00.000Z"),
    });
  });

  it("reads no last delivery when none arrived (boundary: empty), and no webhook for a connection without one", async () => {
    readFrom([await sealed("whsec-test")]);
    expect((await getConnectionWebhook(WORKSPACE_ID, CONNECTION_ID))?.lastDeliveryAt).toBeNull();
    expect(await getConnectionWebhook(WORKSPACE_ID, OTHER_CONNECTION_ID)).toBeNull();
    expect(await getConnectionWebhook(OTHER_WORKSPACE_ID, CONNECTION_ID)).toBeNull();
  });
});

describe("webhook sources (#428)", () => {
  it("lists the endpoint's own sources by name, with the webhook StackDash created and the last delivery", async () => {
    const source = (id: string, endpointId: string, name: string, providerWebhookId: string | null, lastDeliveryAt: string | null): Row => ({
      endpoint_id: endpointId,
      source_id: id,
      source_name: name,
      provider_webhook_id: providerWebhookId,
      last_delivery_at: lastDeliveryAt,
    });
    const { db, requests } = fakeSupabase({
      webhook_sources: [
        source("10", ENDPOINT_ID, "group1/web", null, "2026-11-16T10:00:00.000Z"),
        source("9", ENDPOINT_ID, "group1/api", "17", null),
        source("11", "28100000-0000-4000-8000-000000000009", "other/app", "18", null),
      ],
    });
    vi.mocked(createAdminClient).mockReturnValue(db);

    expect(await listWebhookSources(ENDPOINT_ID)).toEqual([
      { sourceId: "9", name: "group1/api", providerWebhookId: "17", lastDeliveryAt: null },
      { sourceId: "10", name: "group1/web", providerWebhookId: null, lastDeliveryAt: new Date("2026-11-16T10:00:00.000Z") },
    ]);
    // Bounded by what the table may hold for one endpoint.
    expect(requests.map((request) => request.limit)).toEqual([WEBHOOK_SOURCES_PER_ENDPOINT]);
  });

  it("lists none for an endpoint without sources (boundary: empty)", async () => {
    const { db } = fakeSupabase({ webhook_sources: [] });
    vi.mocked(createAdminClient).mockReturnValue(db);
    expect(await listWebhookSources(ENDPOINT_ID)).toEqual([]);
  });
});
