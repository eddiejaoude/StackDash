import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instanceConfiguration, providerSetup, type ConfigCheck } from "./configuration";

// A valid key: base64 of exactly 32 bytes.
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function check(name: string): ConfigCheck {
  const found = instanceConfiguration()
    .flatMap((group) => group.checks)
    .find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No check named ${name}`);
  return found;
}

// A baseline that every check reads as healthy, whatever the developer's shell exports.
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:55421");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", "ops@example.com");
  vi.stubEnv("STACKDASH_ENCRYPTION_KEY", ENCRYPTION_KEY);
  vi.stubEnv("STACKDASH_ENCRYPTION_KEYS_PREVIOUS", "");
  vi.stubEnv("CRON_SECRET", "c".repeat(64));
  vi.stubEnv("STACKDASH_EMAIL_FROM", "");
  vi.stubEnv("STACKDASH_RESEND_API_KEY", "");
  vi.stubEnv("STACKDASH_RESEND_API_URL", "");
  vi.stubEnv("STACKDASH_TRUSTED_PROXY_COUNT", "");
  vi.stubEnv("STACKDASH_ALLOW_PRIVATE_WEBHOOKS", "");
  vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "");
  vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("scheduler secret", () => {
  it.each([
    ["unset", "", "attention", "Not set"],
    ["one character short of the minimum", "c".repeat(31), "attention", "Invalid"],
    ["exactly the minimum length", "c".repeat(32), "ok", "Set"],
  ])("is %s", (_title, value, status, summary) => {
    vi.stubEnv("CRON_SECRET", value);
    expect(check("Scheduler secret")).toMatchObject({ status, summary });
  });
});

describe("encryption key", () => {
  it.each([
    ["unset", "", "attention", "Not set"],
    ["not 32 bytes of base64", "too-short", "attention", "Invalid"],
    ["valid", ENCRYPTION_KEY, "ok", "Set"],
  ])("is %s", (_title, value, status, summary) => {
    vi.stubEnv("STACKDASH_ENCRYPTION_KEY", value);
    expect(check("Encryption key")).toMatchObject({ status, summary });
  });

  it("asks for attention while previous keys are kept for a rotation", () => {
    vi.stubEnv("STACKDASH_ENCRYPTION_KEYS_PREVIOUS", "deadbeef:" + ENCRYPTION_KEY);
    expect(check("Previous encryption keys")).toMatchObject({ status: "attention", summary: "Set" });
  });
});

describe("alert email", () => {
  it("is optional: off without a Resend key", () => {
    expect(check("Alert email")).toMatchObject({ status: "info", summary: "Not set" });
  });

  it("is invalid with a key but no sender, without repeating the key", () => {
    vi.stubEnv("STACKDASH_RESEND_API_KEY", "re_secret_value");
    const result = check("Alert email");
    expect(result).toMatchObject({ status: "attention", summary: "Invalid" });
    expect(result.detail).toContain("STACKDASH_EMAIL_FROM");
    expect(result.detail).not.toContain("re_secret_value");
  });
});

describe("production only problems", () => {
  it.each([
    ["development", "info"],
    ["production", "attention"],
  ])("a missing public address in %s is %s", (nodeEnv, status) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    expect(check("Public address").status).toBe(status);
  });

  it.each([
    ["development with the flag", "development", "1", "info"],
    ["production without the flag", "production", "", "ok"],
    ["production with the flag", "production", "1", "attention"],
  ])("private network webhooks in %s", (_title, nodeEnv, flag, status) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("STACKDASH_ALLOW_PRIVATE_WEBHOOKS", flag);
    expect(check("Private network webhooks").status).toBe(status);
  });

  it.each([
    ["off", "development", "", "", "ok", "Off"],
    ["on in development", "development", "", "1", "info", "On"],
    ["on in a production build", "production", "", "1", "attention", "On"],
    ["set on a Vercel production deployment, which refuses it", "production", "production", "1", "attention", "Refused"],
  ])("simulated providers %s", (_title, nodeEnv, vercelEnv, flag, status, summary) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("VERCEL_ENV", vercelEnv);
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", flag);
    expect(check("Simulated providers")).toMatchObject({ status, summary });
  });
});

describe("providers", () => {
  it("names the variables a provider is missing, and nothing for one that is set up", () => {
    vi.stubEnv("RESEND_CLIENT_ID", "resend-client");
    vi.stubEnv("RESEND_CLIENT_SECRET", "");
    vi.stubEnv("POLAR_CLIENT_ID", "polar-client");
    vi.stubEnv("POLAR_CLIENT_SECRET", "polar-secret");
    const setup = new Map(providerSetup().map(({ provider, check: result }) => [provider, result]));
    expect(setup.get("resend")).toMatchObject({ status: "info", summary: "Not set", variables: ["RESEND_CLIENT_SECRET"] });
    expect(setup.get("polar")).toMatchObject({ status: "ok", summary: "Set", variables: [] });
  });
});

it("never returns a configured value, only whether it is set", () => {
  const secrets = {
    NEXT_PUBLIC_SITE_URL: "https://site-value.example.com",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
    CRON_SECRET: "cron-value-".repeat(4),
    STACKDASH_EMAIL_FROM: "sender-value@example.com",
    STACKDASH_RESEND_API_KEY: "resend-key-value",
    STACKDASH_SUPER_ADMIN_EMAILS: "admin-value@example.com",
    GITHUB_APP_CLIENT_ID: "github-id-value",
    GITHUB_APP_CLIENT_SECRET: "github-secret-value",
    GITHUB_APP_PRIVATE_KEY: "github-private-key-value",
  };
  for (const [name, value] of Object.entries(secrets)) vi.stubEnv(name, value);
  const output = JSON.stringify([instanceConfiguration(), providerSetup()]);
  for (const value of [...Object.values(secrets), ENCRYPTION_KEY]) expect(output).not.toContain(value);
});
