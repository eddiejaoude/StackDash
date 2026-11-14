import { afterEach, describe, expect, it, vi } from "vitest";

import { emailEnv, isLoopbackUrl, onVercel, operatorEnv, superAdminEmails } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
});

const EMAIL_VARIABLES = ["STACKDASH_EMAIL_FROM", "STACKDASH_RESEND_API_KEY", "STACKDASH_RESEND_API_URL"] as const;

function stubEmailEnv(values: Partial<Record<(typeof EMAIL_VARIABLES)[number], string>>): void {
  for (const name of EMAIL_VARIABLES) vi.stubEnv(name, values[name] ?? "");
}

const FROM = "StackDash <alerts@example.com>";

describe("emailEnv", () => {
  it("is off when neither the Resend key nor URL is set, even with a sender", () => {
    stubEmailEnv({ STACKDASH_EMAIL_FROM: FROM });
    expect(emailEnv()).toBeNull();
  });

  it("sends to Resend itself when no URL is set", () => {
    stubEmailEnv({ STACKDASH_EMAIL_FROM: FROM, STACKDASH_RESEND_API_KEY: "test-key" });
    expect(emailEnv()).toEqual({ from: FROM, apiKey: "test-key", apiUrl: "https://api.resend.com" });
  });

  it.each([
    ["the local fake on 127.0.0.1", "http://127.0.0.1:55430", "http://127.0.0.1:55430"],
    ["localhost with a trailing slash", "http://localhost:55430/", "http://localhost:55430"],
    ["IPv6 loopback", "http://[::1]:55430", "http://[::1]:55430"],
    ["another https host", "https://mail-proxy.example.com", "https://mail-proxy.example.com"],
  ])("accepts %s as the URL, as an origin", (_title, url, origin) => {
    stubEmailEnv({ STACKDASH_EMAIL_FROM: FROM, STACKDASH_RESEND_API_KEY: "test-key", STACKDASH_RESEND_API_URL: url });
    expect(emailEnv()?.apiUrl).toBe(origin);
  });

  it.each([
    ["plain http to another computer", "http://mail-proxy.example.com"],
    ["plain http to a private address", "http://10.0.0.5:55430"],
    ["plain http to a name that starts with 127.0.0.1", "http://127.0.0.1.nip.io"],
    ["another scheme", "ftp://127.0.0.1:55430"],
    ["a path", "https://api.resend.com/emails"],
    ["a query", "https://api.resend.com/?region=eu"],
    ["user info", "https://user:hunter2@api.resend.com"],
    ["text that is not a URL", "api.resend.com"],
  ])("refuses %s as the URL, without echoing it", (_title, url) => {
    stubEmailEnv({ STACKDASH_EMAIL_FROM: FROM, STACKDASH_RESEND_API_KEY: "test-key", STACKDASH_RESEND_API_URL: url });
    expect(() => emailEnv()).toThrow(/STACKDASH_RESEND_API_URL is invalid/);
    expect(() => emailEnv()).not.toThrow(url);
  });

  it("refuses a key without a sender", () => {
    stubEmailEnv({ STACKDASH_RESEND_API_KEY: "test-key" });
    expect(() => emailEnv()).toThrow(/STACKDASH_EMAIL_FROM is not set/);
  });

  it("refuses a URL without a key rather than turning email off", () => {
    stubEmailEnv({ STACKDASH_EMAIL_FROM: FROM, STACKDASH_RESEND_API_URL: "http://127.0.0.1:55430" });
    expect(() => emailEnv()).toThrow(/STACKDASH_RESEND_API_KEY is not set/);
  });
});

const OPERATOR_VARIABLES = ["STACKDASH_OPERATOR_NAME", "STACKDASH_OPERATOR_EMAIL", "STACKDASH_GOVERNING_LAW"] as const;

function stubOperatorEnv(values: Partial<Record<(typeof OPERATOR_VARIABLES)[number], string>>): void {
  for (const name of OPERATOR_VARIABLES) vi.stubEnv(name, values[name] ?? "");
}

const OPERATOR = {
  STACKDASH_OPERATOR_NAME: "Example Operator Ltd",
  STACKDASH_OPERATOR_EMAIL: "privacy@example.com",
  STACKDASH_GOVERNING_LAW: "England and Wales",
};

describe("operatorEnv", () => {
  it("is off when none of the three is set", () => {
    stubOperatorEnv({});
    expect(operatorEnv()).toBeNull();
  });

  it("reads all three, trimming the outer spaces of the name and the law", () => {
    stubOperatorEnv({ ...OPERATOR, STACKDASH_OPERATOR_NAME: "  Example Operator Ltd ", STACKDASH_GOVERNING_LAW: " England and Wales" });
    expect(operatorEnv()).toEqual({ name: "Example Operator Ltd", email: "privacy@example.com", governingLaw: "England and Wales" });
  });

  it.each(OPERATOR_VARIABLES.map((name) => [name]))("refuses a configuration without %s", (missing) => {
    stubOperatorEnv({ ...OPERATOR, [missing]: "" });
    expect(() => operatorEnv()).toThrow(`${missing} is not set`);
  });

  it.each([
    ["a name of spaces only", { STACKDASH_OPERATOR_NAME: "   " }, "STACKDASH_OPERATOR_NAME is invalid"],
    ["a name longer than 200 characters", { STACKDASH_OPERATOR_NAME: "a".repeat(201) }, "STACKDASH_OPERATOR_NAME is invalid"],
    ["text that is not an email address", { STACKDASH_OPERATOR_EMAIL: "privacy at example.com" }, "STACKDASH_OPERATOR_EMAIL is invalid"],
    ["two email addresses", { STACKDASH_OPERATOR_EMAIL: "a@example.com, b@example.com" }, "STACKDASH_OPERATOR_EMAIL is invalid"],
    ["a governing law of spaces only", { STACKDASH_GOVERNING_LAW: " " }, "STACKDASH_GOVERNING_LAW is invalid"],
  ])("refuses %s", (_title, override, message) => {
    stubOperatorEnv({ ...OPERATOR, ...override });
    expect(() => operatorEnv()).toThrow(message);
  });
});

describe("onVercel", () => {
  it("is true for Vercel's own value, exactly 1", () => {
    vi.stubEnv("VERCEL", "1");
    expect(onVercel()).toBe(true);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["0", "0"],
    ["true", "true"],
  ])("is false when VERCEL is %s", (_title, value) => {
    vi.stubEnv("VERCEL", value);
    expect(onVercel()).toBe(false);
  });
});

describe("isLoopbackUrl", () => {
  it.each([
    ["the agent stack", "http://127.0.0.1:56421"],
    ["the default local stack", "http://127.0.0.1:54321"],
    ["localhost", "http://localhost:54321"],
    ["localhost in capitals", "http://LOCALHOST:54321"],
    ["another 127 address", "http://127.0.0.2:54321"],
    ["a short 127 address", "http://127.1:54321"],
    ["IPv6 loopback", "http://[::1]:54321"],
    ["https", "https://127.0.0.1:54321"],
  ])("accepts %s", (_title, url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    ["a hosted project", "https://abcdefghijklmnop.supabase.co"],
    ["a name that starts with localhost", "http://localhost.example.com"],
    ["a name that starts with 127.0.0.1", "http://127.0.0.1.nip.io"],
    ["user info naming localhost", "http://localhost@db.example.com"],
    ["user info naming 127.0.0.1", "http://127.0.0.1:54321@db.example.com"],
    ["128.0.0.1", "http://128.0.0.1"],
    ["IPv6 that is not loopback", "http://[::2]:54321"],
    ["a non-http scheme", "postgresql://127.0.0.1:54322/postgres"],
    ["text that is not a URL", "127.0.0.1:54321"],
    ["an empty string", ""],
  ])("refuses %s", (_title, url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});

describe("superAdminEmails", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["only separators and spaces", " , ,"],
  ])("names nobody when %s", (_title, value) => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", value);
    expect(superAdminEmails().size).toBe(0);
  });

  it("reads a comma separated list, trimmed and lowercased, without duplicates", () => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", " Ops@Example.com,second@example.com ,ops@example.com,");
    expect([...superAdminEmails()]).toEqual(["ops@example.com", "second@example.com"]);
  });

  it("refuses an entry that is not an email address, naming its position but never the entry", () => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", "ops@example.com,not-an-address");
    expect(() => superAdminEmails()).toThrow("entry 2 is not an email address");
    expect(() => superAdminEmails()).not.toThrow("not-an-address");
  });
});
