import { describe, expect, it } from "vitest";

import {
  isSecretKey,
  MAX_REDACT_ARRAY_LENGTH,
  REDACTED,
  redact,
  redactFields,
  redactString,
} from "@/lib/log/redact";

// Fixtures are assembled at runtime so secret scanners on the repository never
// see a literal credential-shaped string.
const join = (...parts: string[]): string => parts.join("");

const STRIPE_LIVE = join("sk_", "live_", "51HqLyjWDarjtT1zdp7dcAbCdEfGh");
const STRIPE_TEST = join("sk_", "test_", "4eC39HqLyjWDarjtT1zdp7dc");
const STRIPE_RESTRICTED = join("rk_", "live_", "51HqLyjWDarjtT1zdp7dc");
const STRIPE_WEBHOOK = join("whsec_", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw");
const GITHUB_PAT = join("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a");
const GITHUB_OAUTH = join("gho_", "16C7e42F292c6912E7710c838347Ae178B4a");
const GITHUB_USER = join("ghu_", "16C7e42F292c6912E7710c838347Ae178B4a");
const GITHUB_SERVER = join("ghs_", "16C7e42F292c6912E7710c838347Ae178B4a");
const GITHUB_FINE = join("github_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz");
const RESEND_KEY = join("re_", "123456789_AbCdEfGhIjKlMnOpQrSt");
const VERCEL_PREFIXED = join("vcp_", "AbCdEfGhIjKlMnOpQrSt1234");
const VERCEL_LEGACY = join("Xk9", "2LmQpR7tVbN4wZcY8hJd3Fs");
const SUPABASE_PAT = join("sbp_", "0123456789abcdef0123456789abcdef01234567");
const SUPABASE_SECRET = join("sb_secret_", "FakeKeyFor", "RedactTests", "0123");
// A StackDash API key whose secret part has separators every few characters, so only the sd_ rule
// (not the generic blob rule) can catch it.
const STACKDASH_KEY = join("sd_", "ab-cd_ef-gh_ij-kl_mn-op_qr-st_uv-wx_yz-01_2");
const POLAR_ACCESS = join("polar_at_", "AbCdEfGhIjKlMnOpQrSt1234");
const POLAR_ORGANIZATION = join("polar_oat_", "AbCdEfGhIjKlMnOpQrSt1234");
const BASIC_CREDENTIALS = btoa("user:password");
const HEX_BLOB = join("9f86d081884c7d659a2feaa0c55ad015", "a3bf4f1b2b0b822cd15d6c15b0f00a08");
const BASE64_BLOB = join("dGhpcyBpcyBhIHNlY3Jl", "dCBibG9iIHdpdGggMzIrIGNoYXJz");
const JWT = join(
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  ".eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ",
  ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
);
const DISCORD_TOKEN = join("abcDEF", "123_ghi-JKL456");
const SLACK_SECRET = join("XXXX", "YYYY", "zzzz1234");

describe("redactString", () => {
  const masked: readonly { name: string; input: string; secret: string }[] = [
    { name: "Bearer token in a header line", input: `Authorization: Bearer ${GITHUB_OAUTH}`, secret: GITHUB_OAUTH },
    { name: "Bearer token with opaque value", input: "Bearer abc.def-ghi_jkl", secret: "abc.def-ghi_jkl" },
    { name: "Basic credentials", input: `Basic ${BASIC_CREDENTIALS}`, secret: BASIC_CREDENTIALS },
    { name: "bare JWT", input: `session ${JWT} expired`, secret: JWT },
    { name: "JWT inside a URL query string", input: `https://app.example.com/cb?state=${JWT}&next=/`, secret: JWT },
    { name: "sk_live_ inside a URL query string", input: `https://api.example.com/v1?state=${STRIPE_LIVE}&page=2`, secret: STRIPE_LIVE },
    { name: "Stripe test key", input: `using ${STRIPE_TEST}`, secret: STRIPE_TEST },
    { name: "Stripe restricted key", input: `using ${STRIPE_RESTRICTED}`, secret: STRIPE_RESTRICTED },
    { name: "Stripe webhook secret", input: `secret=${STRIPE_WEBHOOK}`, secret: STRIPE_WEBHOOK },
    { name: "GitHub ghp_ token", input: `token ${GITHUB_PAT}`, secret: GITHUB_PAT },
    { name: "GitHub ghu_ token", input: `token ${GITHUB_USER}`, secret: GITHUB_USER },
    { name: "GitHub ghs_ token", input: `token ${GITHUB_SERVER}`, secret: GITHUB_SERVER },
    { name: "GitHub fine-grained token", input: `token ${GITHUB_FINE}`, secret: GITHUB_FINE },
    { name: "Resend re_ key", input: `resend key ${RESEND_KEY} rejected`, secret: RESEND_KEY },
    { name: "Vercel prefixed token", input: `vercel ${VERCEL_PREFIXED}`, secret: VERCEL_PREFIXED },
    { name: "Vercel legacy 24 char token", input: `vercel ${VERCEL_LEGACY}`, secret: VERCEL_LEGACY },
    { name: "Supabase sbp_ token", input: `supabase ${SUPABASE_PAT}`, secret: SUPABASE_PAT },
    { name: "Supabase sb_secret_ key", input: `supabase ${SUPABASE_SECRET}`, secret: SUPABASE_SECRET },
    { name: "StackDash sd_ API key", input: `api key ${STACKDASH_KEY} rejected`, secret: STACKDASH_KEY },
    { name: "StackDash API key at the start of a value", input: STACKDASH_KEY, secret: STACKDASH_KEY },
    { name: "Polar polar_at_ access token", input: `polar ${POLAR_ACCESS} expired`, secret: POLAR_ACCESS },
    { name: "Polar polar_oat_ organization token", input: `token=${POLAR_ORGANIZATION}`, secret: POLAR_ORGANIZATION },
    { name: "hex blob of 64 chars", input: `digest ${HEX_BLOB}`, secret: HEX_BLOB },
    { name: "base64 blob of 48 chars", input: `blob ${BASE64_BLOB}`, secret: BASE64_BLOB },
    { name: "password in connection string", input: "postgres://app:hunter2pass@db.example.com:5432/app", secret: "hunter2pass" },
    { name: "access_token query parameter", input: "https://x.example.com/?access_token=short123&a=1", secret: "short123" },
    { name: "OAuth code query parameter", input: "https://x.example.com/callback?code=abc123&state=s", secret: "abc123" },
    {
      name: "Discord webhook URL token",
      input: `post to https://discord.com/api/webhooks/123456789/${DISCORD_TOKEN} failed`,
      secret: DISCORD_TOKEN,
    },
    {
      name: "Discord webhook URL on a versioned path",
      input: `https://canary.discord.com/api/v10/webhooks/123456789/${DISCORD_TOKEN}`,
      secret: DISCORD_TOKEN,
    },
    {
      name: "Slack incoming webhook URL",
      input: `"https://hooks.slack.com/services/T0001/B0002/${SLACK_SECRET}"`,
      secret: SLACK_SECRET,
    },
  ];

  it.each(masked)("masks $name", ({ input, secret }) => {
    const output = redactString(input);
    expect(output).not.toContain(secret);
    expect(output).toContain(REDACTED);
  });

  const untouched: readonly { name: string; input: string }[] = [
    { name: "empty string", input: "" },
    { name: "plain sentence", input: "Sync finished for 3 projects" },
    { name: "unicode text and emoji", input: "Zürich 東京 café 🚀 naïve résumé" },
    { name: "lowercase UUID", input: "123e4567-e89b-12d3-a456-426614174000" },
    { name: "uppercase UUID", input: "123E4567-E89B-12D3-A456-426614174000" },
    { name: "ISO timestamp", input: "2026-10-31T12:00:00.000Z" },
    { name: "dotted event name", input: "adapter.vercel.sync.failed" },
    { name: "long kebab slug without digits", input: "stackdash-dashboard-production-preview-branch" },
    { name: "URL without credentials", input: "https://api.vercel.com/v9/projects?teamId=team_1&limit=20" },
    { name: "short hex below 32 chars", input: "deadbeefdeadbeefdeadbeef" },
    { name: "word containing re_ mid-word", input: "store_procedure_name_for_reporting" },
    { name: "API key display prefix", input: "key sd_AbCd1234 revoked" },
    { name: "Polar event type and adapter names", input: "polar.order.paid from polar_adapter_sync_runner" },
  ];

  it.each(untouched)("leaves $name untouched", ({ input }) => {
    expect(redactString(input)).toBe(input);
  });
});

describe("isSecretKey", () => {
  const secretKeys = [
    "password",
    "PASSWORD",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "accessToken",
    "refreshToken",
    "Authorization",
    "cookie",
    "Set-Cookie",
    "apiKey",
    "api_key",
    "x-api-key",
    "client_secret",
    "clientSecret",
    "ciphertext",
    "key",
    "credential",
    "credentials",
    "stripeSecretKey",
    "webhookSecret",
  ];
  it.each(secretKeys)("treats %s as secret", (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  const plainKeys = ["name", "status", "provider", "keyId", "monkey", "tokenCount", "code", "referenceId", "constructor"];
  it.each(plainKeys)("treats %s as not secret", (key) => {
    expect(isSecretKey(key)).toBe(false);
  });
});

describe("redact", () => {
  it("redacts a credential inside an Error message and its cause", () => {
    const cause = new Error(`upstream said Authorization: Bearer ${GITHUB_OAUTH}`);
    const error = new Error(`Stripe call failed with ${STRIPE_LIVE}`, { cause });
    Object.assign(error, { status: 401, headers: { authorization: `Bearer ${GITHUB_PAT}` } });

    const output = redact(error);
    const serialized = JSON.stringify(output);

    for (const secret of [GITHUB_OAUTH, STRIPE_LIVE, GITHUB_PAT]) {
      expect(serialized).not.toContain(secret);
    }
    expect(output).toMatchObject({
      name: "Error",
      message: `Stripe call failed with ${REDACTED}`,
      status: 401,
      headers: { authorization: REDACTED },
      cause: { name: "Error", message: `upstream said Authorization: Bearer ${REDACTED}` },
    });
    expect(serialized).toContain('"stack"');
  });

  it("redacts a credential in a non-Error cause", () => {
    const error = new Error("refresh failed", {
      cause: { refresh_token: "refresh-fixture-value", detail: `got ${RESEND_KEY}` },
    });
    const serialized = JSON.stringify(redact(error));
    expect(serialized).not.toContain("refresh-fixture-value");
    expect(serialized).not.toContain(RESEND_KEY);
  });

  it("redacts secret keys in a nested object and array", () => {
    const input = {
      provider: "vercel",
      auth: { accessToken: "a1", refresh_token: "r1", expiresAt: "2026-10-31T00:00:00.000Z" },
      items: [{ apiKey: "k1", name: "first" }, { name: "second", note: `see ${SUPABASE_PAT}` }],
    };
    expect(redact(input)).toEqual({
      provider: "vercel",
      auth: { accessToken: REDACTED, refresh_token: REDACTED, expiresAt: "2026-10-31T00:00:00.000Z" },
      items: [{ apiKey: REDACTED, name: "first" }, { name: "second", note: `see ${REDACTED}` }],
    });
  });

  it("does not mutate its input", () => {
    const input = { password: "p1", nested: { token: "t1" } };
    redact(input);
    expect(input).toEqual({ password: "p1", nested: { token: "t1" } });
  });

  it("marks a cyclic object as circular without throwing", () => {
    type Node = { name: string; self?: Node; children: Node[] };
    const root: Node = { name: "root", children: [] };
    root.self = root;
    root.children.push(root);

    const output = redact(root);
    expect(output).toEqual({ name: "root", self: "[circular]", children: ["[circular]"] });
    expect(() => JSON.stringify(output)).not.toThrow();
  });

  it("renders a shared non-cyclic reference in both places", () => {
    const shared = { id: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });

  it("truncates a very long array at the boundary", () => {
    const input = Array.from({ length: 250 }, (_, index) => index);
    const output = redact(input);
    expect(Array.isArray(output)).toBe(true);
    if (!Array.isArray(output)) return;
    expect(output).toHaveLength(MAX_REDACT_ARRAY_LENGTH + 1);
    expect(output[MAX_REDACT_ARRAY_LENGTH - 1]).toBe(MAX_REDACT_ARRAY_LENGTH - 1);
    expect(output[MAX_REDACT_ARRAY_LENGTH]).toBe("[truncated 150 items]");
  });

  it("keeps an array of exactly the maximum length intact", () => {
    const input = Array.from({ length: MAX_REDACT_ARRAY_LENGTH }, (_, index) => index);
    expect(redact(input)).toEqual(input);
  });

  it("stops at the depth limit", () => {
    let deep: Record<string, unknown> = { leaf: "bottom" };
    for (let level = 0; level < 12; level += 1) deep = { next: deep };
    const serialized = JSON.stringify(redact(deep));
    expect(serialized).toContain("[depth limit]");
    expect(serialized).not.toContain("bottom");
  });

  const scalars: readonly { name: string; input: unknown; expected: unknown }[] = [
    { name: "null", input: null, expected: null },
    { name: "undefined", input: undefined, expected: undefined },
    { name: "zero", input: 0, expected: 0 },
    { name: "NaN", input: Number.NaN, expected: "NaN" },
    { name: "boolean", input: false, expected: false },
    { name: "bigint", input: BigInt(12), expected: "12" },
    { name: "Date", input: new Date(Date.UTC(2026, 9, 31)), expected: "2026-10-31T00:00:00.000Z" },
    { name: "unicode string", input: "Grüße aus München 👋", expected: "Grüße aus München 👋" },
    { name: "function", input: () => "x", expected: "[function]" },
    { name: "Uint8Array", input: new Uint8Array(4), expected: "[binary 4 bytes]" },
  ];

  it.each(scalars)("handles $name", ({ input, expected }) => {
    expect(redact(input)).toEqual(expected);
  });

  it("leaves non-secret fields untouched", () => {
    const input = { workspaceId: "123e4567-e89b-12d3-a456-426614174000", amountMinor: 1999, currency: "USD", ok: true };
    expect(redact(input)).toEqual(input);
  });

  it("redacts secret entries in a Map and Headers", () => {
    const map = new Map<string, unknown>([["token", "t1"], ["name", "n"]]);
    const headers = new Headers({ authorization: `Bearer ${JWT}`, accept: "application/json" });
    expect(redact({ map, headers })).toEqual({
      map: { token: REDACTED, name: "n" },
      headers: { accept: "application/json", authorization: REDACTED },
    });
  });
});

describe("redactFields", () => {
  it("redacts a field bag and keeps cycles to the root safe", () => {
    const fields: Record<string, unknown> = { password: "p1", event: "x" };
    fields.self = fields;
    expect(redactFields(fields)).toEqual({ password: REDACTED, event: "x", self: "[circular]" });
  });
});
