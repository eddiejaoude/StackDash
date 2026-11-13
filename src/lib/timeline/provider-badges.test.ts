import { describe, expect, it } from "vitest";

import { providerBadgeQuery, providerBadges, providerBadgeText } from "./provider-badges";
import { encodeCursor, parseTimelineSearchParams } from "./query";

describe("providerBadges", () => {
  it("returns no badges for no connections", () => {
    expect(providerBadges([])).toEqual([]);
  });

  it("sums the connections of one provider into one badge", () => {
    expect(
      providerBadges([
        { provider: "stripe", events: 1000 },
        { provider: "vercel", events: 60 },
        { provider: "stripe", events: 240 },
      ]),
    ).toEqual([
      { provider: "stripe", connections: 2, events: 1240 },
      { provider: "vercel", connections: 1, events: 60 },
    ]);
  });

  it("orders by events, then by provider name on a tie", () => {
    expect(
      providerBadges([
        { provider: "vercel", events: 5 },
        { provider: "github", events: 5 },
        { provider: "stripe", events: 9 },
      ]).map((badge) => badge.provider),
    ).toEqual(["stripe", "github", "vercel"]);
  });
});

describe("providerBadgeText", () => {
  it.each([
    { case: "one event from one connection is singular", events: 1, connections: 1, name: "Show only Stripe: 1 event from 1 connection", short: "1" },
    { case: "plural events and connections", events: 2, connections: 2, name: "Show only Stripe: 2 events from 2 connections", short: "2" },
    { case: "the largest unshortened count", events: 999, connections: 1, name: "Show only Stripe: 999 events from 1 connection", short: "999" },
    { case: "the first shortened count", events: 1000, connections: 1, name: "Show only Stripe: 1,000 events from 1 connection", short: "1K" },
    { case: "one decimal in the badge", events: 1240, connections: 2, name: "Show only Stripe: 1,240 events from 2 connections", short: "1.2K" },
    { case: "rounding up into millions", events: 999_999, connections: 3, name: "Show only Stripe: 999,999 events from 3 connections", short: "1M" },
  ])("$case: the provider and $short on the chip, the exact counts in the name", ({ events, connections, name, short }) => {
    expect(providerBadgeText({ provider: "stripe", connections, events }, false)).toEqual({ name, label: "Stripe", short });
  });

  it.each([
    { provider: "github" as const, label: "GitHub" },
    { provider: "digitalocean" as const, label: "DigitalOcean" },
    { provider: "fake" as const, label: "Example provider" },
  ])("prints the provider's display name on the chip: $label", ({ provider, label }) => {
    expect(providerBadgeText({ provider, connections: 1, events: 0 }, false)).toMatchObject({ label, short: "0" });
  });

  it("names the current view's badge for what it does: back to every provider", () => {
    expect(providerBadgeText({ provider: "stripe", connections: 1, events: 2 }, true).name).toBe(
      "Show every provider. Now showing only Stripe: 2 events from 1 connection",
    );
  });
});

describe("providerBadgeQuery", () => {
  it("filters to only its provider, keeping every other filter", () => {
    const query = parseTimelineSearchParams({ severity: "critical", provider: ["github", "stripe"] });
    const { query: next, current } = providerBadgeQuery(query, "stripe");
    expect(current).toBe(false);
    expect(next.scope.providers).toEqual(["stripe"]);
    expect(next.severities).toEqual(["critical"]);
  });

  it("links back to every provider when its provider is already the whole filter", () => {
    const query = parseTimelineSearchParams({ severity: "critical", provider: "stripe" });
    const { query: next, current } = providerBadgeQuery(query, "stripe");
    expect(current).toBe(true);
    expect(next.scope.providers).toEqual([]);
    expect(next.severities).toEqual(["critical"]);
  });

  it("starts from the newest events, dropping an older page's cursor", () => {
    const cursor = encodeCursor({ occurredAt: "2026-06-15T23:30:00Z", id: "00000000-0000-4000-8000-000000000001" });
    const query = parseTimelineSearchParams({ cursor });
    expect(query.cursor).not.toBeNull();
    expect(providerBadgeQuery(query, "stripe").query.cursor).toBeNull();
  });

  it("is not current under no provider filter", () => {
    expect(providerBadgeQuery(parseTimelineSearchParams({}), "stripe").current).toBe(false);
  });
});
