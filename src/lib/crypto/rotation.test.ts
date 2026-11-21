import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { credentialAad, currentKeyId, decryptSecret, encryptSecret, keyIdFor } from "@/lib/crypto/credentials";
import { encryptedFromRow, encryptedToColumns, fromBytea, toBytea } from "@/lib/data/credentials";
import { destinationSecretAad } from "@/lib/data/notification-destinations";
import { fakeSupabase, type Filter, type IncomingRequest, type Row } from "@/lib/supabase/fake-postgrest";

import { BATCH_SIZE, rotate, sealedTables, summaryLine, type Counts, type SealedTable } from "./rotation";

/*
 * `npm run keys:rotate` (#35, #153, #606) against a fake PostgREST with the real cipher: every row
 * on an old key ends up under the current key with the same plaintext, bound to its own table's
 * AAD, and nothing the rotation cannot prove it owns (a newer concurrent write, a row it cannot
 * decrypt) is overwritten.
 */

// Keys are generated per run so no key material is ever committed.
const OLD_KEY = randomBytes(32).toString("base64");
const NEW_KEY = randomBytes(32).toString("base64");
// A key whose rows exist but that is no longer configured anywhere.
const GONE_KEY = randomBytes(32).toString("base64");

const WORKSPACE_ID = "60600000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "60600000-0000-4000-8000-000000000002";
const SEEDED_AT = "2026-11-01T09:00:00.000Z";

/** The rotation's configuration: the new key current, the old one still readable. */
function configureRotationKeys(): void {
  vi.stubEnv("STACKDASH_ENCRYPTION_KEY", NEW_KEY);
  vi.stubEnv("STACKDASH_ENCRYPTION_KEYS_PREVIOUS", `${keyIdFor(Buffer.from(OLD_KEY, "base64"))}:${OLD_KEY}`);
}

/** Seals `plaintext` as the app did while `key` was current. */
function sealUnder(key: string, plaintext: string, aad: string): Row {
  vi.stubEnv("STACKDASH_ENCRYPTION_KEY", key);
  try {
    return encryptedToColumns(encryptSecret(plaintext, aad));
  } finally {
    configureRotationKeys();
  }
}

beforeEach(() => {
  configureRotationKeys();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type TableCase = Readonly<{
  label: "connection_credentials" | "notification_destination_secrets";
  key: "connection_id" | "destination_id";
  aad: (workspaceId: string, id: string) => string;
}>;

const TABLES: readonly TableCase[] = [
  { label: "connection_credentials", key: "connection_id", aad: credentialAad },
  { label: "notification_destination_secrets", key: "destination_id", aad: destinationSecretAad },
];

function rowId(index: number): string {
  return `60610000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function plaintextFor(index: number): string {
  return `secret-value-${index}`;
}

function sealedRow(table: TableCase, index: number, key = OLD_KEY, plaintext = plaintextFor(index)): Row {
  const id = rowId(index);
  return { [table.key]: id, workspace_id: WORKSPACE_ID, ...sealUnder(key, plaintext, table.aad(WORKSPACE_ID, id)), updated_at: SEEDED_AT };
}

function text(row: Row | undefined, column: string): string {
  const value = row?.[column];
  if (typeof value !== "string") throw new Error(`Expected ${column} to be text`);
  return value;
}

/** A stored row's plaintext, opened with its own table's AAD. */
function opened(table: TableCase, row: Row | undefined): string {
  const record = { key_id: text(row, "key_id"), iv: text(row, "iv"), ciphertext: text(row, "ciphertext"), auth_tag: text(row, "auth_tag") };
  return decryptSecret(encryptedFromRow(record), table.aad(text(row, "workspace_id"), text(row, table.key)));
}

function rotation(
  table: TableCase,
  rows: readonly Row[],
  intercept?: (request: IncomingRequest, tables: Record<string, readonly Row[]>) => Response | undefined,
) {
  const patched: string[] = [];
  const fake = fakeSupabase({ [table.label]: rows }, {}, (request) => {
    if (request.method === "PATCH") patched.push(request.filters.find(([column]) => column === table.key)?.[1] ?? "");
    return intercept?.(request, fake.tables);
  });
  const sealed = sealedTables(fake.db, currentKeyId()).find((candidate) => candidate.label === table.label);
  if (sealed === undefined) throw new Error(`No sealed table ${table.label}`);
  return {
    sealed,
    /** The ids each update targeted, as `eq.<id>`, in order. */
    patched,
    stored: () => fake.tables[table.label] ?? [],
    storedRow: (index: number) => (fake.tables[table.label] ?? []).find((row) => row[table.key] === rowId(index)),
    pageReads: () => fake.requests.filter((request) => request.limit === BATCH_SIZE).map((request) => request.filters),
  };
}

function counts(scanned: number, rotated: number, skipped: number, unreadable: number): Counts {
  return { scanned, rotated, skipped, unreadable };
}

describe.each(TABLES)("rotate on $label", (table) => {
  it("re-seals rows on a previous key under the current key, opening with the table's AAD to the same plaintext", async () => {
    const before = [0, 1, 2].map((index) => sealedRow(table, index));
    const run = rotation(table, before);

    const result = await rotate(run.sealed);
    const remaining = await run.sealed.remaining();

    expect(result).toEqual(counts(3, 3, 0, 0));
    expect(remaining).toBe(0);
    expect(summaryLine(run.sealed.label, result, remaining)).toBe(
      `${table.label}: scanned 3, rotated 3, skipped 0 (changed concurrently), unreadable 0, remaining on old keys 0.`,
    );
    for (const index of [0, 1, 2]) {
      const row = run.storedRow(index);
      expect(text(row, "key_id")).toBe(currentKeyId());
      expect(text(row, "iv")).not.toBe(text(before[index], "iv"));
      expect(text(row, "updated_at")).not.toBe(SEEDED_AT);
      expect(opened(table, row)).toBe(plaintextFor(index));
    }
  });

  it("never reads or changes rows already on the current key (boundary: mixed keys)", async () => {
    const current = [0, 2].map((index) => sealedRow(table, index, NEW_KEY));
    const old = sealedRow(table, 1);
    const run = rotation(table, [current[0], old, current[1]].filter((row) => row !== undefined));

    expect(await rotate(run.sealed)).toEqual(counts(1, 1, 0, 0));

    expect(run.pageReads()).toEqual([[["key_id", `neq.${currentKeyId()}`]]]);
    expect(run.patched).toEqual([`eq.${rowId(1)}`]);
    expect(run.storedRow(0)).toEqual(current[0]);
    expect(run.storedRow(2)).toEqual(current[1]);
  });

  it("reads one empty page and changes nothing when the table has no rows (boundary: zero rows)", async () => {
    const run = rotation(table, []);

    expect(await rotate(run.sealed)).toEqual(counts(0, 0, 0, 0));
    expect(await run.sealed.remaining()).toBe(0);
    expect(run.pageReads()).toHaveLength(1);
    expect(run.patched).toEqual([]);
  });

  it.each([
    { total: 99, pages: 1 },
    { total: 100, pages: 2 },
    { total: 101, pages: 2 },
    { total: 250, pages: 3 },
  ])("visits each of $total rows exactly once in $pages keyset page reads (boundary: $total rows against a page of 100)", async ({ total, pages }) => {
    const indexes = Array.from({ length: total }, (_, index) => index);
    // Stored out of key order, so only the requested order makes the cursor correct.
    const run = rotation(table, indexes.map((index) => sealedRow(table, index)).toReversed());

    expect(await rotate(run.sealed)).toEqual(counts(total, total, 0, 0));
    expect(await run.sealed.remaining()).toBe(0);

    const neq: Filter = ["key_id", `neq.${currentKeyId()}`];
    const cursors = Array.from({ length: pages - 1 }, (_, page): Filter[] => [neq, [table.key, `gt.${rowId((page + 1) * BATCH_SIZE - 1)}`]]);
    expect(run.pageReads()).toEqual([[neq], ...cursors]);
    expect(run.patched).toEqual(indexes.map((index) => `eq.${rowId(index)}`));
    expect(run.stored().every((row) => row.key_id === currentKeyId())).toBe(true);
    expect(opened(table, run.storedRow(total - 1))).toBe(plaintextFor(total - 1));
  });

  it("counts a row replaced between its read and its update as skipped and keeps the newer value (boundary: concurrent write)", async () => {
    const newer = sealUnder(NEW_KEY, "newer-secret-value", table.aad(WORKSPACE_ID, rowId(1)));
    const run = rotation(table, [0, 1, 2].map((index) => sealedRow(table, index)), (request, tables) => {
      // The app writes row 1 (a token refresh) after the rotation read it and before its update lands.
      if (request.method === "PATCH" && request.filters.some(([column, filter]) => column === table.key && filter === `eq.${rowId(1)}`)) {
        tables[table.label] = (tables[table.label] ?? []).map((row) => (row[table.key] === rowId(1) ? { ...row, ...newer } : row));
      }
      return undefined;
    });

    expect(await rotate(run.sealed)).toEqual(counts(3, 2, 1, 0));
    expect(await run.sealed.remaining()).toBe(0);
    expect(run.storedRow(1)).toMatchObject(newer);
    expect(opened(table, run.storedRow(1))).toBe("newer-secret-value");
    expect(opened(table, run.storedRow(0))).toBe(plaintextFor(0));
  });

  it.each([
    {
      name: "a key no longer configured",
      unreadable: (good: Row): Row => ({ ...good, ...sealUnder(GONE_KEY, plaintextFor(1), table.aad(WORKSPACE_ID, rowId(1))) }),
    },
    {
      name: "a tampered auth tag",
      unreadable: (good: Row): Row => {
        const tag = fromBytea(text(good, "auth_tag"));
        tag[0] = (tag[0] ?? 0) ^ 0x01;
        return { ...good, auth_tag: toBytea(tag) };
      },
    },
    {
      name: "another workspace's AAD",
      unreadable: (good: Row): Row => ({ ...good, ...sealUnder(OLD_KEY, plaintextFor(1), table.aad(OTHER_WORKSPACE_ID, rowId(1))) }),
    },
  ])("counts a row sealed with $name as unreadable and leaves it untouched (boundary: undecryptable row)", async ({ unreadable }) => {
    const bad = unreadable(sealedRow(table, 1));
    const run = rotation(table, [sealedRow(table, 0), bad]);

    const result = await rotate(run.sealed);
    const remaining = await run.sealed.remaining();

    expect(result).toEqual(counts(2, 1, 0, 1));
    expect(remaining).toBe(1);
    expect(summaryLine(run.sealed.label, result, remaining)).toBe(
      `${table.label}: scanned 2, rotated 1, skipped 0 (changed concurrently), unreadable 1, remaining on old keys 1.`,
    );
    expect(run.storedRow(1)).toEqual(bad);
    expect(run.patched).toEqual([`eq.${rowId(0)}`]);
  });

  it("rethrows a failure that is not a key or authentication failure and leaves the row untouched (boundary: malformed column)", async () => {
    const malformed = { ...sealedRow(table, 0), iv: "not-bytea" };
    const run = rotation(table, [malformed]);

    await expect(rotate(run.sealed)).rejects.toThrow("Expected a bytea value in Postgres hex format.");
    expect(run.storedRow(0)).toEqual(malformed);
  });

  it.each([
    { method: "GET", verb: "Reading", run: (sealed: SealedTable) => rotate(sealed) },
    { method: "PATCH", verb: "Updating", run: (sealed: SealedTable) => rotate(sealed) },
    { method: "HEAD", verb: "Counting", run: (sealed: SealedTable) => sealed.remaining() },
  ])("fails a $method with the table and Postgres code, never the row's value (boundary: database error)", async ({ method, verb, run }) => {
    const secret = "sk_live_must_not_leak";
    const rotationRun = rotation(table, [sealedRow(table, 0, OLD_KEY, secret)], (request) =>
      request.method === method
        ? new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout", details: secret, hint: null }), {
            status: 500,
          })
        : undefined,
    );

    const failure = await run(rotationRun.sealed).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toBe(`${verb} ${table.label} failed (code 57014).`);
    expect(opened(table, rotationRun.storedRow(0))).toBe(secret);
  });
});

describe("rotate across both tables", () => {
  it("binds each table's rows to its own AAD, so a secret sealed under the other table's AAD is unreadable", async () => {
    const id = rowId(0);
    // The same id and workspace in both tables, each sealed under the other table's AAD.
    const crossed = {
      connection_credentials: [{ connection_id: id, workspace_id: WORKSPACE_ID, ...sealUnder(OLD_KEY, "a", destinationSecretAad(WORKSPACE_ID, id)), updated_at: SEEDED_AT }],
      notification_destination_secrets: [{ destination_id: id, workspace_id: WORKSPACE_ID, ...sealUnder(OLD_KEY, "b", credentialAad(WORKSPACE_ID, id)), updated_at: SEEDED_AT }],
    };
    const fake = fakeSupabase(crossed);

    const results: { label: string; counts: Counts }[] = [];
    for (const sealed of sealedTables(fake.db, currentKeyId())) results.push({ label: sealed.label, counts: await rotate(sealed) });

    expect(results).toEqual([
      { label: "connection_credentials", counts: counts(1, 0, 0, 1) },
      { label: "notification_destination_secrets", counts: counts(1, 0, 0, 1) },
    ]);
    expect(fake.tables).toEqual(crossed);
  });
});

describe("summaryLine", () => {
  it.each([
    { remaining: 0, shown: "0" },
    { remaining: null, shown: "unknown" },
  ])("prints remaining $remaining as $shown (boundary: count unavailable)", ({ remaining, shown }) => {
    expect(summaryLine("connection_credentials", counts(4, 2, 1, 1), remaining)).toBe(
      `connection_credentials: scanned 4, rotated 2, skipped 1 (changed concurrently), unreadable 1, remaining on old keys ${shown}.`,
    );
  });
});
