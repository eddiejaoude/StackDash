import { describe, expect, it } from "vitest";

import { EventEmojiSchema, EventTypeSchema, validateAdapterEvents, type ActivityEvent, type EventType } from "./events";
import { declaredEventTypes } from "./registry";

const eventTypes: EventType[] = [
  {
    id: "vercel.deployment.failed",
    label: "Deployment failed",
    description: "A production or preview deployment did not finish.",
    shownByDefault: true,
    emoji: "💥",
  },
  {
    id: "vercel.deployment.succeeded",
    label: "Deployment succeeded",
    description: "A deployment finished and is serving traffic.",
    shownByDefault: false,
    emoji: "🚀",
  },
];

const failedDeployment: ActivityEvent = {
  typeId: "vercel.deployment.failed",
  occurredAt: new Date("2026-10-31T09:15:00Z"),
  severity: "critical",
  title: "Deployment failed for stackdash",
  body: "The build step exited with code 1.",
  externalAccountId: "team_1",
  dedupeKey: "dpl_123:failed",
  url: "https://vercel.com/team/stackdash/dpl_123",
};

describe("validateAdapterEvents", () => {
  it.each([
    { name: "a declared event with an https url", event: failedDeployment },
    {
      name: "an event with no url and no body",
      event: {
        typeId: "vercel.deployment.succeeded",
        occurredAt: failedDeployment.occurredAt,
        severity: "success",
        title: "Deployment ready",
        externalAccountId: "team_1",
        dedupeKey: "dpl_124:ready",
      },
    },
  ])("accepts $name", ({ event }) => {
    expect(validateAdapterEvents(eventTypes, [event])).toEqual({ ok: true, items: [event] });
  });

  it.each([
    { name: "undeclared typeId", event: { ...failedDeployment, typeId: "vercel.domain.expired" }, path: "typeId" },
    {
      name: "typeId that is not a dotted key",
      event: { ...failedDeployment, typeId: "Deployment Failed" },
      path: "typeId",
    },
    { name: "http url", event: { ...failedDeployment, url: "http://vercel.com/team" }, path: "url" },
    { name: "javascript url", event: { ...failedDeployment, url: "javascript:alert(1)" }, path: "url" },
    { name: "unparseable url", event: { ...failedDeployment, url: "not a url" }, path: "url" },
    { name: "unknown severity", event: { ...failedDeployment, severity: "error" }, path: "severity" },
    { name: "whitespace-only title", event: { ...failedDeployment, title: "   " }, path: "title" },
    { name: "empty dedupeKey", event: { ...failedDeployment, dedupeKey: "" }, path: "dedupeKey" },
    { name: "invalid occurredAt", event: { ...failedDeployment, occurredAt: new Date("nope") }, path: "occurredAt" },
    { name: "personal data field", event: { ...failedDeployment, authorEmail: "someone@example.com" }, path: "" },
  ])("rejects $name", ({ event, path }) => {
    const result = validateAdapterEvents(eventTypes, [event]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining({ index: 0, path }));
  });

  it("rejects every event when the adapter declares no event types", () => {
    const result = validateAdapterEvents([], [failedDeployment]);
    expect(result.ok).toBe(false);
  });
});

describe("EventTypeSchema", () => {
  const declaration = eventTypes[0];

  it("accepts a declaration with no category, as before categories existed", () => {
    expect(EventTypeSchema.safeParse(declaration).success).toBe(true);
  });

  it.each(["signup", "deploy_succeeded", "deploy_failed"] as const)("accepts the %s category", (category) => {
    expect(EventTypeSchema.safeParse({ ...declaration, category }).success).toBe(true);
  });

  it("rejects a category it does not name", () => {
    expect(EventTypeSchema.safeParse({ ...declaration, category: "payment" }).success).toBe(false);
  });

  it.each(["🚀", "⚠️", "↩️", "🗑️"])("accepts the single emoji %s", (emoji) => {
    expect(EventTypeSchema.safeParse({ ...declaration, emoji }).success).toBe(true);
  });

  it("rejects a declaration without an emoji", () => {
    expect(EventTypeSchema.safeParse({ ...declaration, emoji: undefined }).success).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["two emoji", "🚀🚀"],
    ["an emoji with text", "🚀 deployed"],
    ["a word", "rocket"],
    ["a letter", "a"],
    ["a digit", "1"],
    ["a doubled presentation selector", "⚠️\uFE0F"],
    ["a lone presentation selector", "\uFE0F"],
  ])("rejects %s as the emoji (boundary)", (_case, emoji) => {
    expect(EventTypeSchema.safeParse({ ...declaration, emoji }).success).toBe(false);
  });

  it("accepts every registered adapter's declarations", () => {
    for (const eventType of declaredEventTypes) expect(EventTypeSchema.safeParse(eventType).error).toBeUndefined();
  });

  // Every type of every live adapter (and the fake one) shows an emoji on its timeline row.
  it("gives every registered adapter's event type one emoji", () => {
    for (const eventType of declaredEventTypes) {
      expect(EventEmojiSchema.safeParse(eventType.emoji).success, eventType.id).toBe(true);
    }
  });
});
