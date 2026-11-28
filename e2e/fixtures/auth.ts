import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { test as base } from "@playwright/test";
import {
  combineChunks,
  createChunks,
  createServerClient,
  stringFromBase64URL,
  stringToBase64URL,
  type CookieOptions,
} from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "../../src/lib/supabase/database.types";

// Synthetic accounts on reserved example.com addresses; e2e/global-setup.ts creates them.
export const E2E_USERS = {
  owner: { email: "e2e-owner@example.com", userName: "e2e-owner" },
  viewer: { email: "e2e-viewer@example.com", userName: "e2e-viewer" },
} as const;

/**
 * A second super admin address, listed in STACKDASH_SUPER_ADMIN_EMAILS by playwright.config.ts and
 * never signed in, so it is never online in the support inbox: support chat email to operators
 * (#680) always reaches it, whatever the e2e owner's open pages say about the owner's presence.
 */
export const E2E_OFFLINE_SUPER_ADMIN = "e2e-offline-admin@example.com";

// Absolute so the paths resolve the same from global setup, the config, and any spec.
const AUTH_DIR = path.join(__dirname, "..", ".auth");

/** Storage states written by e2e/global-setup.ts on every run (git ignored). */
export const STORAGE_STATE = {
  owner: path.join(AUTH_DIR, "owner.json"),
  viewer: path.join(AUTH_DIR, "viewer.json"),
  // A session of its own for tests that sign out, so they never end the shared owner session.
  ownerSignOut: path.join(AUTH_DIR, "owner-sign-out.json"),
} as const;

/** Signed in as the owner of a personal workspace that the viewer also belongs to. */
export const ownerTest = base.extend({ storageState: STORAGE_STATE.owner });

/** Signed in as a viewer member of the owner's workspace. */
export const viewerTest = base.extend({ storageState: STORAGE_STATE.viewer });

/** Signed in as the owner on a disposable session; use for tests that sign out. */
export const signOutTest = base.extend({ storageState: STORAGE_STATE.ownerSignOut });

export { expect } from "@playwright/test";

/*
 * Synthetic users and signed-in cookies, without GitHub (issue #23).
 *
 * Users are created through the Auth admin API with the service role key from `.env.local`, each
 * with a random password generated for one run only and never written to disk. Signing in uses the
 * same @supabase/ssr cookie format the app reads.
 */

const authEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

export function authEnv(): AuthEnv {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const parsed = authEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      "e2e auth setup needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SERVICE_ROLE_KEY in .env.local. Run `supabase start`, then copy them from `supabase status -o env`.",
    );
  }
  return parsed.data;
}

type Admin = SupabaseClient<Database>;

export function authAdminClient(env: AuthEnv): Admin {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const playwrightCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
});

export type PlaywrightCookie = z.infer<typeof playwrightCookieSchema>;

function toSameSite(value: CookieOptions["sameSite"]): PlaywrightCookie["sameSite"] {
  if (value === "strict" || value === true) return "Strict";
  if (value === "none") return "None";
  return "Lax";
}

/** Finds a user by email. Local e2e databases hold a handful of users, so one page is enough. */
export async function findUserId(admin: Admin, email: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`Listing users failed: ${error.message}`);
  return data.users.find((user) => user.email === email)?.id ?? null;
}

/** GitHub profile fields Supabase Auth keeps in `user_metadata`, beside the username. */
export type GitHubMetadata = Readonly<{ full_name?: string; name?: string; avatar_url?: string }>;

/** Creates the user or resets the password of the existing one. Returns the user id. */
export async function ensureUser(
  admin: Admin,
  email: string,
  userName: string,
  password: string,
  metadata: GitHubMetadata = {},
): Promise<string> {
  // The invite comes first: the before-user-created hook refuses emails that are not invited.
  const { error: inviteError } = await admin
    .from("access_invites")
    .upsert({ email, invited_by: "e2e global setup" }, { onConflict: "email", ignoreDuplicates: true });
  if (inviteError) throw new Error(`Inviting ${email} failed (code ${inviteError.code}).`);

  const existingId = await findUserId(admin, email);
  if (existingId !== null) {
    const { error } = await admin.auth.admin.updateUserById(existingId, { password, email_confirm: true });
    if (error) throw new Error(`Resetting the password of ${email} failed: ${error.message}`);
    return existingId;
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { ...metadata, user_name: userName },
  });
  if (error) throw new Error(`Creating ${email} failed: ${error.message}`);
  return data.user.id;
}

/** Signs in with a password and returns the auth cookies the app would have set. */
export async function signInCookies(env: AuthEnv, email: string, password: string): Promise<PlaywrightCookie[]> {
  const jar = new Map<string, { value: string; options: CookieOptions }>();
  const supabase = createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return [...jar].map(([name, { value }]) => ({ name, value }));
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          // An empty value is a deletion (for example a stale chunk); drop it from the jar.
          if (value === "") jar.delete(name);
          else jar.set(name, { value, options });
        }
      },
    },
  });

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Signing in ${email} failed: ${error.message}`);
  if (jar.size === 0) throw new Error(`Signing in ${email} set no cookies.`);

  const nowSeconds = Math.floor(Date.now() / 1000);
  return [...jar].map(([name, { value, options }]) => ({
    name,
    value,
    // Playwright's baseURL is http://localhost:<port>, so the cookies belong to that host.
    domain: "localhost",
    path: "/",
    expires: options.maxAge === undefined ? -1 : nowSeconds + options.maxAge,
    httpOnly: options.httpOnly ?? false,
    secure: false,
    sameSite: toSameSite(options.sameSite),
  }));
}

// The parts of a stored Supabase session a test rewrites; the rest passes through unchanged.
const storedSessionSchema = z.looseObject({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(),
});

export type StoredSession = z.infer<typeof storedSessionSchema>;

// The auth cookie @supabase/ssr writes, `sb-<host label>-auth-token`, split into `.0`, `.1`, ...
// when the session is too long for one cookie.
const AUTH_COOKIE = /^sb-[^.]+-auth-token(?:\.\d+)?$/;
// @supabase/ssr's default cookie encoding prefixes the base64url session with this.
const BASE64_PREFIX = "base64-";

/**
 * The cookies of a signed-in storage state with the Supabase session rewritten by `edit`, in the
 * cookie format the app reads. Reads the state file and never writes it, so the session it came
 * from stays valid for every other test.
 */
export async function editedSessionCookies(
  stateFile: string,
  edit: (session: StoredSession) => StoredSession,
): Promise<PlaywrightCookie[]> {
  const { cookies } = z
    .object({ cookies: z.array(playwrightCookieSchema) })
    .parse(JSON.parse(readFileSync(stateFile, "utf8")));
  const first = cookies.find((cookie) => AUTH_COOKIE.test(cookie.name));
  if (first === undefined) throw new Error(`${stateFile} holds no Supabase auth cookie.`);
  const key = first.name.replace(/\.\d+$/, "");

  const stored = await combineChunks(key, (name) => cookies.find((cookie) => cookie.name === name)?.value);
  if (stored === null || stored === undefined || !stored.startsWith(BASE64_PREFIX)) {
    throw new Error(`${stateFile} holds an auth cookie in an unexpected format.`);
  }
  const session = storedSessionSchema.parse(JSON.parse(stringFromBase64URL(stored.slice(BASE64_PREFIX.length))));

  const chunks = createChunks(key, `${BASE64_PREFIX}${stringToBase64URL(JSON.stringify(edit(session)))}`);
  return [
    ...cookies.filter((cookie) => !AUTH_COOKIE.test(cookie.name)),
    ...chunks.map(({ name, value }) => ({ ...first, name, value })),
  ];
}

export type SyntheticUser = Readonly<{
  id: string;
  email: string;
  userName: string;
  // Pass as `storageState: { cookies, origins: [] }` to a new browser context.
  cookies: PlaywrightCookie[];
}>;

/**
 * A brand new invited user with its own personal workspace, signed in, for tests that must not
 * touch the shared e2e users (account deletion). `metadata` stands in for the profile a GitHub
 * sign-in would write. Remove it with `removeSyntheticUser`.
 */
export async function createSyntheticUser(label: string, metadata: GitHubMetadata = {}): Promise<SyntheticUser> {
  const env = authEnv();
  const admin = authAdminClient(env);
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-${label}-${suffix}@example.com`;
  const userName = `e2e-${label}-${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const id = await ensureUser(admin, email, userName, password, metadata);
  return { id, email, userName, cookies: await signInCookies(env, email, password) };
}

/**
 * A Supabase client signed in as a synthetic user through its cookies, for tests that act as that
 * user outside the app, such as a Realtime subscription the app would never make.
 */
export function syntheticUserClient(user: SyntheticUser): SupabaseClient<Database> {
  const env = authEnv();
  const jar = new Map(user.cookies.map(({ name, value }) => [name, value]));
  return createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return [...jar].map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet) {
        // A refresh rewrites the session cookies; an empty value is a deletion.
        for (const { name, value } of cookiesToSet) {
          if (value === "") jar.delete(name);
          else jar.set(name, value);
        }
      },
    },
  });
}

/** Deletes a synthetic user if it still exists, and its invite. Never call with the shared users. */
export async function removeSyntheticUser(user: SyntheticUser): Promise<void> {
  if (Object.values(E2E_USERS).some(({ email }) => email === user.email)) {
    throw new Error("Refusing to delete a shared e2e user.");
  }
  const admin = authAdminClient(authEnv());
  if ((await findUserId(admin, user.email)) !== null) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(`Deleting ${user.email} failed: ${error.message}`);
  }
  const { error } = await admin.from("access_invites").delete().eq("email", user.email);
  if (error) throw new Error(`Removing the invite for ${user.email} failed (code ${error.code}).`);
}
