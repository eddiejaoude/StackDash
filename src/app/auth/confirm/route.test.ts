import { AuthApiError, AuthRetryableFetchError, type AuthError } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEMO_USER_MARKER, demoSignInPath } from "@/lib/demo/sign-in";

import { GET } from "./route";

type Claims = { data: { claims: { sub: string; app_metadata?: Record<string, unknown> } }; error: null } | { data: null; error: AuthError | null };

const auth = vi.hoisted(() => ({
  verifyOtp: vi.fn<(params: { token_hash: string; type: string }) => Promise<{ error: AuthError | null }>>(),
  getClaims: vi.fn<() => Promise<Claims>>(),
  signOut: vi.fn<(options: { scope: string }) => Promise<{ error: AuthError | null }>>(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth }) }));

const ORIGIN = "http://localhost:3000";
// Made up, and built from parts so CI's secret scan (gitleaks) does not read it as a credential.
const TOKEN_HASH = ["pkce_", "0123456789abcdef".repeat(3), "01234567"].join("");
const DASHBOARD = "/w/demoslug/dashboard";
const INVALID = `${ORIGIN}/sign-in?error=link_invalid&next=${encodeURIComponent(DASHBOARD)}`;

function confirm(path: string): Promise<Response> {
  return GET(new NextRequest(new URL(path, ORIGIN)));
}

function demoClaims(appMetadata: Record<string, unknown> = { [DEMO_USER_MARKER]: true }): Claims {
  return { data: { claims: { sub: "7595b9b0-0000-4000-8000-000000000001", app_metadata: appMetadata } }, error: null };
}

let output: string[];

beforeEach(() => {
  vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:55421");
  vi.stubEnv("VERCEL_ENV", "");
  auth.verifyOtp.mockResolvedValue({ error: null });
  auth.getClaims.mockResolvedValue(demoClaims());
  auth.signOut.mockResolvedValue({ error: null });
  output = [];
  const capture = (chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  auth.verifyOtp.mockReset();
  auth.getClaims.mockReset();
  auth.signOut.mockReset();
});

describe("GET /auth/confirm with a valid demo link", () => {
  it("verifies the token hash once and continues to the dashboard", async () => {
    const response = await confirm(demoSignInPath(TOKEN_HASH, DASHBOARD));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}${DASHBOARD}`);
    expect(auth.verifyOtp).toHaveBeenCalledExactlyOnceWith({ token_hash: TOKEN_HASH, type: "email" });
    expect(auth.getClaims).toHaveBeenCalledOnce();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("never writes the token to the logs, on success or on a rejected link", async () => {
    await confirm(demoSignInPath(TOKEN_HASH, DASHBOARD));
    auth.verifyOtp.mockResolvedValue({ error: new AuthApiError("Email link is invalid or has expired", 403, "otp_expired") });
    await confirm(demoSignInPath(TOKEN_HASH, DASHBOARD));
    auth.verifyOtp.mockResolvedValue({ error: new AuthRetryableFetchError("fetch failed", 0) });
    await confirm(demoSignInPath(TOKEN_HASH, DASHBOARD));

    expect(output.length).toBeGreaterThan(0);
    expect(output.join("")).not.toContain(TOKEN_HASH);
  });
});

describe("GET /auth/confirm refusals", () => {
  it.each([
    ["simulation off", { STACKDASH_SIMULATE_PROVIDERS: "0" }],
    ["simulation unset", { STACKDASH_SIMULATE_PROVIDERS: "" }],
    ["a Vercel production deployment", { VERCEL_ENV: "production" }],
    ["a hosted Supabase project", { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co" }],
    ["no Supabase URL", { NEXT_PUBLIC_SUPABASE_URL: "" }],
  ])("answers %s exactly as an invalid link, without spending the token", async (_title, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const response = await confirm(demoSignInPath(TOKEN_HASH, DASHBOARD));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(INVALID);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it.each([
    ["used (Supabase answers otp_expired)", new AuthApiError("Email link is invalid or has expired", 403, "otp_expired")],
    ["expired", new AuthApiError("Email link is invalid or has expired", 403, "otp_expired")],
    ["unknown to Supabase (malformed)", new AuthApiError("Invalid token hash", 400, "validation_failed")],
  ])("answers a %s token as an invalid link", async (_title, error) => {
    auth.verifyOtp.mockResolvedValue({ error });

    const response = await confirm(demoSignInPath(TOKEN_HASH, DASHBOARD));

    expect(response.headers.get("location")).toBe(INVALID);
    expect(auth.getClaims).not.toHaveBeenCalled();
  });

  it("refuses the second use of the same link after the first signed in", async () => {
    const path = demoSignInPath(TOKEN_HASH, DASHBOARD);
    auth.verifyOtp
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: new AuthApiError("Email link is invalid or has expired", 403, "otp_expired") });

    expect((await confirm(path)).headers.get("location")).toBe(`${ORIGIN}${DASHBOARD}`);
    expect((await confirm(path)).headers.get("location")).toBe(INVALID);
  });

  it.each([
    ["no token hash", `/auth/confirm?type=email&next=${encodeURIComponent(DASHBOARD)}`],
    ["an empty token hash", `/auth/confirm?token_hash=&type=email&next=${encodeURIComponent(DASHBOARD)}`],
    ["no type", `/auth/confirm?token_hash=${TOKEN_HASH}&next=${encodeURIComponent(DASHBOARD)}`],
    ["a recovery type", `/auth/confirm?token_hash=${TOKEN_HASH}&type=recovery&next=${encodeURIComponent(DASHBOARD)}`],
    ["a signup type", `/auth/confirm?token_hash=${TOKEN_HASH}&type=signup&next=${encodeURIComponent(DASHBOARD)}`],
  ])("answers %s as an invalid link without calling Supabase", async (_title, path) => {
    const response = await confirm(path);

    expect(response.headers.get("location")).toBe(INVALID);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it.each([
    ["no marker", {}],
    ["a marker that is not true", { [DEMO_USER_MARKER]: "true" }],
  ])("ends the session and answers as an invalid link when the token signs in an account with %s", async (_title, appMetadata) => {
    auth.getClaims.mockResolvedValue(demoClaims(appMetadata));

    const response = await confirm(demoSignInPath(TOKEN_HASH, DASHBOARD));

    expect(response.headers.get("location")).toBe(INVALID);
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });
});

describe("GET /auth/confirm failures that are not the link's fault", () => {
  it("says the sign-in did not finish, with a reference, when Supabase Auth cannot be reached", async () => {
    auth.verifyOtp.mockResolvedValue({ error: new AuthRetryableFetchError("fetch failed", 0) });

    const location = new URL((await confirm(demoSignInPath(TOKEN_HASH, DASHBOARD))).headers.get("location") ?? "");

    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("error")).toBe("link_failed");
    expect(location.searchParams.get("ref")).toMatch(/\S/);
    expect(location.searchParams.get("next")).toBe(DASHBOARD);
  });

  it("says the sign-in did not finish when the new session cannot be verified, and ends it", async () => {
    auth.getClaims.mockResolvedValue({ data: null, error: new AuthApiError("invalid JWT", 401, "bad_jwt") });

    const location = new URL((await confirm(demoSignInPath(TOKEN_HASH, DASHBOARD))).headers.get("location") ?? "");

    expect(location.searchParams.get("error")).toBe("link_failed");
    expect(auth.signOut).toHaveBeenCalledOnce();
  });
});

describe("GET /auth/confirm next", () => {
  it.each([
    ["another site", "https://evil.example/w/x/dashboard"],
    ["a protocol-relative address", "//evil.example"],
    ["a public page", "/docs"],
    ["a backslash trick", "/\\evil.example"],
  ])("goes to /app instead of %s", async (_title, next) => {
    const response = await confirm(demoSignInPath(TOKEN_HASH, next));

    expect(response.headers.get("location")).toBe(`${ORIGIN}/app`);
  });

  it("keeps /app as next on an invalid link with an unsafe next", async () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "0");

    const response = await confirm(demoSignInPath(TOKEN_HASH, "https://evil.example"));

    expect(response.headers.get("location")).toBe(`${ORIGIN}/sign-in?error=link_invalid&next=%2Fapp`);
  });
});
