import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Secret } from "@/lib/adapters/types";
import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { fakeSupabase, type Row } from "@/lib/supabase/fake-postgrest";

import { createWebhookEndpoint, loadWebhookEndpoint } from "./webhook-endpoints";

/*
 * A per-connection webhook secret (#28) sealed by createWebhookEndpoint and read back by
 * loadWebhookEndpoint, the way the route reads it. The write goes through a client that records
 * the row the upsert sends; the read goes through the fake PostgREST over that row, so the
 * ciphertext, its key id, and its associated data make the whole round trip.
 */

vi.mock("@/lib/supabase/admin");

const WORKSPACE_ID = "28100000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "28100000-0000-4000-8000-000000000002";
const CONNECTION_ID = "28100000-0000-4000-8000-000000000003";
const OTHER_CONNECTION_ID = "28100000-0000-4000-8000-000000000004";
const ENDPOINT_ID = "28100000-0000-4000-8000-000000000005";

const CONNECTION: Row = { id: CONNECTION_ID, workspace_id: WORKSPACE_ID, provider: "fake" };

// The row the upsert sends: every column is text (bytea travels as Postgres hex).
const WrittenRowSchema = z.record(z.string(), z.string());

/** A client whose connection lookup answers from `connections` and that records each upserted endpoint row. */
function recordingClient(connections: readonly Row[]) {
  const written: Array<Record<string, string>> = [];
  const db = createClient<Database>("http://postgrest.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/connections")) {
          const filters = [...url.searchParams].filter(([column]) => column !== "select");
          return Response.json(connections.filter((row) => filters.every(([column, filter]) => filter === `eq.${String(row[column])}`)));
        }
        const body: unknown = JSON.parse(String(init?.body));
        written.push(WrittenRowSchema.parse(body));
        return Response.json({ id: ENDPOINT_ID });
      },
    },
  });
  vi.mocked(createAdminClient).mockReturnValue(db);
  return written;
}

function readFrom(rows: readonly Row[]) {
  const { db, requests } = fakeSupabase({ webhook_endpoints: rows });
  vi.mocked(createAdminClient).mockReturnValue(db);
  return requests;
}

/** Seals `secret` for the fake connection and returns the stored row, as the database would hold it. */
async function sealed(secret: string): Promise<Row> {
  const written = recordingClient([CONNECTION]);
  const id = await createWebhookEndpoint({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "fake", secret: new Secret(secret) });
  expect(id).toBe(ENDPOINT_ID);
  expect(written).toHaveLength(1);
  return { ...written[0], id };
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

describe("createWebhookEndpoint and loadWebhookEndpoint (#28)", () => {
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

    await expect(
      createWebhookEndpoint({ workspaceId, connectionId: CONNECTION_ID, provider, secret: new Secret("whsec-test") }),
    ).rejects.toThrow("the connection does not belong to this workspace and provider");
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
