import { describe, expect, it } from "vitest";

import { withoutQueryOrFragment } from "./web-analytics";

const ORIGIN = "https://stackdash.example";

describe("withoutQueryOrFragment", () => {
  it("sends a page address with no query or fragment unchanged, workspace handle included", () => {
    expect(withoutQueryOrFragment({ type: "pageview", url: `${ORIGIN}/w/acme/timeline` })).toEqual({
      type: "pageview",
      url: `${ORIGIN}/w/acme/timeline`,
    });
  });

  it.each([
    ["the unsubscribe token", `${ORIGIN}/unsubscribe?token=c2VjcmV0`, `${ORIGIN}/unsubscribe`],
    ["the OAuth code and state", `${ORIGIN}/auth/callback?code=abc123&state=xyz789`, `${ORIGIN}/auth/callback`],
    ["a fragment", `${ORIGIN}/docs/mcp#tools`, `${ORIGIN}/docs/mcp`],
    ["a query and a fragment together", `${ORIGIN}/sign-in?next=%2Fw%2Facme#top`, `${ORIGIN}/sign-in`],
    ["an empty query and an empty fragment", `${ORIGIN}/privacy?#`, `${ORIGIN}/privacy`],
    ["a query on the home page", `${ORIGIN}/?ref=newsletter`, `${ORIGIN}/`],
  ])("drops %s", (_name, url, sent) => {
    expect(withoutQueryOrFragment({ type: "pageview", url })).toEqual({ type: "pageview", url: sent });
  });

  it("keeps a custom event a custom event", () => {
    expect(withoutQueryOrFragment({ type: "event", url: `${ORIGIN}/unsubscribe?token=c2VjcmV0` })).toEqual({
      type: "event",
      url: `${ORIGIN}/unsubscribe`,
    });
  });

  it.each([
    ["a fragment that holds a ?", `${ORIGIN}/docs/mcp#tools?x=1`, `${ORIGIN}/docs/mcp`],
    ["a relative address", "/unsubscribe?token=c2VjcmV0", "/unsubscribe"],
  ])("cuts at the first ? or # for %s", (_name, url, sent) => {
    expect(withoutQueryOrFragment({ type: "pageview", url })).toEqual({ type: "pageview", url: sent });
  });
});
