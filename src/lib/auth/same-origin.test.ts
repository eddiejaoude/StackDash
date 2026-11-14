import { describe, expect, it } from "vitest";

import { isSameOrigin } from "./same-origin";

function post(headers: Record<string, string>): Request {
  return new Request("http://localhost:3100/auth/sign-out", { method: "POST", headers });
}

describe("isSameOrigin", () => {
  it("accepts an Origin whose host matches the Host header", () => {
    expect(isSameOrigin(post({ origin: "http://localhost:3100", host: "localhost:3100" }))).toBe(true);
  });

  it("prefers X-Forwarded-Host behind a proxy", () => {
    expect(
      isSameOrigin(post({ origin: "https://stackdash.example", host: "internal:3000", "x-forwarded-host": "stackdash.example" })),
    ).toBe(true);
  });

  it.each([
    ["another site", { origin: "https://evil.example", host: "localhost:3100" }],
    ["a different port", { origin: "http://localhost:3200", host: "localhost:3100" }],
    ["no Origin header", { host: "localhost:3100" }],
    ["an opaque origin", { origin: "null", host: "localhost:3100" }],
  ])("refuses %s", (_, headers) => {
    expect(isSameOrigin(post(headers))).toBe(false);
  });
});
