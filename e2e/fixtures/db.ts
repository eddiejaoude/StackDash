/*
 * Service-role access to local Supabase for e2e specs that need synthetic data.
 *
 * Isolation rule: a spec that seeds data creates its own workspace with `createTestWorkspace` and
 * only touches rows inside it, so specs can run in parallel and in any order. Never seed into the
 * owner's personal workspace, which other specs read.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "../../src/lib/supabase/database.types";

import { E2E_USERS } from "./auth";

export type Admin = SupabaseClient<Database>;

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

let cached: Admin | undefined;

export function adminClient(): Admin {
  if (cached !== undefined) return cached;
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const env = envSchema.parse(process.env);
  cached = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/** A connection page URL; group 1 is the connection id. */
export const CONNECTION_URL = /\/connections\/([0-9a-f-]{36})(\?|$)/;

/** The cron secret `POST /api/jobs/tick` checks, from the same env `adminClient` loads. */
export function cronSecret(): string {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  return z.string().min(32).parse(process.env.CRON_SECRET);
}

/**
 * The `next_sync_at` every seeded active connection gets: a month out. A connection with none is
 * due now (`enqueue_due_syncs`), so any job tick against the same database (`npm run jobs:tick`,
 * its watcher, or an `instance-wide` spec) would sync the credential-less row mid-test and write
 * sync-failed events and failure counts into the spec's workspace (#408). Only a spec that ticks
 * a seed on purpose leaves it due. A connection the app makes gets it from `makeConnectionsNotDue`
 * in ./connections.ts (#621). A month is past the day after which a tick watcher with simulation on
 * stops making a simulated connection due (`PARKED_SYNC_AFTER_MS` in src/lib/jobs/store.ts, #626).
 */
export function notDueForAMonth(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
}

async function userIdByEmail(admin: Admin, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`Listing users failed: ${error.message}`);
  const user = data.users.find((candidate) => candidate.email === email);
  if (user === undefined) throw new Error(`No e2e user ${email}; global setup creates it.`);
  return user.id;
}

export type TestWorkspace = Readonly<{ id: string; slug: string; name: string; ownerId: string; viewerId: string }>;

/**
 * A fresh workspace owned by the e2e owner, with the e2e viewer as a viewer member. The name is
 * unique per call so specs never collide.
 */
export async function createTestWorkspace(label: string): Promise<TestWorkspace> {
  const admin = adminClient();
  const [ownerId, viewerId] = await Promise.all([
    userIdByEmail(admin, E2E_USERS.owner.email),
    userIdByEmail(admin, E2E_USERS.viewer.email),
  ]);
  const name = `${label} ${randomUUID().slice(0, 8)}`;
  const { data, error } = await admin.rpc("create_workspace", {
    p_user_id: ownerId,
    p_name: name,
    p_is_personal: false,
  });
  if (error) throw new Error(`Creating a test workspace failed (code ${error.code}).`);
  const workspace = z.object({ id: z.string(), slug: z.string() }).parse(data);
  const { error: memberError } = await admin
    .from("workspace_members")
    .insert({ workspace_id: workspace.id, user_id: viewerId, role: "viewer" });
  if (memberError) throw new Error(`Adding the viewer failed (code ${memberError.code}).`);
  return { id: workspace.id, slug: workspace.slug, name, ownerId, viewerId };
}

/** Deletes a test workspace and, by cascade, everything seeded into it. */
export async function deleteTestWorkspace(workspace: TestWorkspace): Promise<void> {
  const { error } = await adminClient().from("workspaces").delete().eq("id", workspace.id);
  if (error) throw new Error(`Deleting test workspace failed (code ${error.code}).`);
}

/** The personal workspace every user gets when their account is created. */
export async function personalWorkspace(userId: string): Promise<Readonly<{ id: string; slug: string }>> {
  const { data, error } = await adminClient()
    .from("workspaces")
    .select("id, slug")
    .eq("created_by", userId)
    .eq("is_personal", true)
    .single();
  if (error) throw new Error(`Finding the personal workspace failed (code ${error.code}).`);
  return data;
}

/**
 * A key made the way src/lib/api/keys.ts makes one (that module is server-only), for rows the
 * service role inserts directly.
 */
export function seededKey(): { key: string; token_hash: string; token_prefix: string } {
  const key = `sd_${randomBytes(32).toString("base64url")}`;
  return { key, token_hash: createHash("sha256").update(key, "utf8").digest("hex"), token_prefix: key.slice(0, "sd_".length + 8) };
}

/** Inserts `count` usage-only keys the owner created, named "Seeded key 1" onward, for limit tests. */
export async function seedApiKeys(workspace: TestWorkspace, count: number): Promise<void> {
  const { error } = await adminClient()
    .from("api_keys")
    .insert(
      Array.from({ length: count }, (_, index) => {
        const { token_hash, token_prefix } = seededKey();
        return {
          workspace_id: workspace.id,
          name: `Seeded key ${index + 1}`,
          token_hash,
          token_prefix,
          scopes: ["usage:read" as const],
          created_by: workspace.ownerId,
        };
      }),
    );
  if (error) throw new Error(`Seeding keys failed (code ${error.code}).`);
}

/** Keys in the workspace that are not revoked: what the limit of 20 counts. */
export async function activeApiKeyCount(workspace: TestWorkspace): Promise<number> {
  const { count, error } = await adminClient()
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace.id)
    .is("revoked_at", null);
  if (error) throw new Error(`Counting keys failed (code ${error.code}).`);
  return count ?? 0;
}
