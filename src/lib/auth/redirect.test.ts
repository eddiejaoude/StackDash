import { describe, expect, it } from "vitest";

import { DEFAULT_NEXT_PATH, isAppPath, nextPathWithFragment, safeNextPath, signInErrorUrl } from "./redirect";

describe("safeNextPath", () => {
  it.each([
    ["/app", "/app"],
    ["/app/", "/app/"],
    ["/w/k3j9x2m4pq/dashboard", "/w/k3j9x2m4pq/dashboard"],
    ["/w/k3j9x2m4pq/timeline?cursor=abc&limit=50", "/w/k3j9x2m4pq/timeline?cursor=abc&limit=50"],
    ["/w/k3j9x2m4pq/alerts#rule-1", "/w/k3j9x2m4pq/alerts#rule-1"],
    ["/w/k3j9x2m4pq/connections/../settings", "/w/k3j9x2m4pq/settings"],
    ["/app?next=https://evil.example", "/app?next=https://evil.example"],
  ])("keeps the app path %j", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    ["not a string", 42],
    ["undefined", undefined],
    ["null", null],
    ["an array", ["/app"]],
    ["empty", ""],
    ["the landing page", "/"],
    ["a non-app path", "/sign-in"],
    ["a lookalike prefix", "/application"],
    ["a bare workspace prefix", "/w"],
    ["a relative path without a slash", "w/abc"],
    ["protocol relative", "//evil.example/w/abc"],
    ["protocol relative with a backslash", "/\\evil.example"],
    ["a backslash later on", "/w/abc\\..\\..\\evil"],
    ["an absolute https URL", "https://evil.example/w/abc"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a data URL", "data:text/html,<script>alert(1)</script>"],
    ["a tab that browsers strip", "/\t/evil.example"],
    ["a newline", "/w/abc\n/evil"],
    ["an encoded leading double slash", "/%2F%2Fevil.example"],
    ["an encoded backslash", "/%5Cevil.example"],
    ["an encoded tab", "/%09/evil.example"],
    ["dot segments escaping the app", "/w/../../evil"],
    ["encoded dot segments escaping the app", "/w/%2e%2e/evil"],
    ["a malformed escape", "/w/%E0%A4%A"],
    ["overlong", `/w/${"a".repeat(510)}`],
  ])("falls back to /app for %s", (_label, input) => {
    expect(safeNextPath(input)).toBe(DEFAULT_NEXT_PATH);
  });

  it("accepts a path at exactly the length limit", () => {
    const input = `/w/${"a".repeat(509)}`;
    expect(input).toHaveLength(512);
    expect(safeNextPath(input)).toBe(input);
  });
});

describe("nextPathWithFragment", () => {
  it("adds the fragment the browser kept to the path", () => {
    expect(nextPathWithFragment("/w/k3j9x2m4pq/alerts/settings", "#alert-emails")).toBe("/w/k3j9x2m4pq/alerts/settings#alert-emails");
    expect(nextPathWithFragment("/w/k3j9x2m4pq/alerts?alertsAfter=abc", "#alert-emails")).toBe(
      "/w/k3j9x2m4pq/alerts?alertsAfter=abc#alert-emails",
    );
  });

  it.each([
    ["an empty fragment", ""],
    ["a bare #", "#"],
    ["no fragment field", null],
    ["a file in the fragment field", new File([], "fragment")],
    ["a fragment without its #", "alert-emails"],
  ])("keeps the path as it is for %s", (_label, fragment) => {
    expect(nextPathWithFragment("/w/k3j9x2m4pq/alerts/settings", fragment)).toBe("/w/k3j9x2m4pq/alerts/settings");
  });

  it("keeps a fragment the path already has", () => {
    expect(nextPathWithFragment("/w/k3j9x2m4pq/alerts/settings#alert-channels", "#alert-emails")).toBe(
      "/w/k3j9x2m4pq/alerts/settings#alert-channels",
    );
  });

  it("resolves dot segments in the path before the fragment", () => {
    expect(nextPathWithFragment("/w/k3j9x2m4pq/alerts/../alerts/settings", "#alert-emails")).toBe(
      "/w/k3j9x2m4pq/alerts/settings#alert-emails",
    );
  });

  it.each([
    ["a path outside the app", "/sign-in"],
    ["an absolute URL", "https://evil.example/w/abc"],
    ["protocol relative", "//evil.example/w/abc"],
    ["no path", undefined],
    ["an empty path", ""],
  ])("falls back to /app for %s, whatever the fragment", (_label, next) => {
    expect(nextPathWithFragment(next, "#alert-emails")).toBe(DEFAULT_NEXT_PATH);
  });

  it.each([
    ["one letter", "#a"],
    ["digits, underscores and hyphens after the first letter", "#Alert_emails-2"],
    ["dots, as an achievement id has", "#vercel.deployments.10"],
  ])("keeps a section fragment of %s", (_label, fragment) => {
    expect(nextPathWithFragment("/w/k3j9x2m4pq/alerts/settings", fragment)).toBe(`/w/k3j9x2m4pq/alerts/settings${fragment}`);
  });

  it.each([
    ["the error Supabase Auth leaves after a failed sign-in", "#error=access_denied&error_code=provider_denied&error_description=The+user+denied&sb="],
    ["a leading digit", "#1-alert-emails"],
    ["a space", "#alert emails"],
    ["a slash", "#//evil.example"],
    ["an encoded backslash", "#%5Cevil.example"],
    ["a tab", "#\tevil"],
    ["a malformed escape", "#%E0%A4%A"],
  ])("drops a fragment with %s and keeps the path", (_label, fragment) => {
    expect(nextPathWithFragment("/w/k3j9x2m4pq/alerts/settings", fragment)).toBe("/w/k3j9x2m4pq/alerts/settings");
  });

  it("keeps a path and fragment at exactly the length limit", () => {
    const path = `/w/${"a".repeat(498)}`;
    const fragment = "#alert-emai";
    expect(path.length + fragment.length).toBe(512);
    expect(nextPathWithFragment(path, fragment)).toBe(`${path}${fragment}`);
  });

  it("drops a fragment that takes the path over the length limit, and keeps the path", () => {
    const path = `/w/${"a".repeat(498)}`;
    const fragment = "#alert-email";
    expect(path.length + fragment.length).toBe(513);
    expect(nextPathWithFragment(path, fragment)).toBe(path);
  });

  it("falls back to /app for a path over the length limit on its own", () => {
    expect(nextPathWithFragment(`/w/${"a".repeat(510)}`, "#alert-emails")).toBe(DEFAULT_NEXT_PATH);
  });
});

describe("isAppPath", () => {
  it.each([
    ["/app", true],
    ["/app/settings", true],
    ["/account", true],
    ["/account/messages", true],
    ["/account/messages/x", false],
    ["/account/Messages", false],
    ["/account/deleted", false],
    ["/accounts", false],
    ["/", false],
    ["/apple", false],
    ["/sign-in", false],
    ["/auth/callback", false],
  ])("%j -> %j", (pathname, expected) => {
    expect(isAppPath(pathname)).toBe(expected);
  });
});

describe("signInErrorUrl", () => {
  it("points at /sign-in on the request's origin with the code, the reference, and next", () => {
    const url = signInErrorUrl("http://localhost:3000/auth/confirm?token_hash=abc", "link_failed", "/w/k3j9x2m4pq/dashboard", "REF-1234");
    expect(url.toString()).toBe("http://localhost:3000/sign-in?error=link_failed&ref=REF-1234&next=%2Fw%2Fk3j9x2m4pq%2Fdashboard");
  });

  it("leaves out ref when there is no reference, and carries nothing else from the request", () => {
    const url = signInErrorUrl("http://localhost:3000/auth/callback?code=secret&next=%2Fapp", "cancelled", DEFAULT_NEXT_PATH);
    expect(url.toString()).toBe("http://localhost:3000/sign-in?error=cancelled&next=%2Fapp");
  });
});
