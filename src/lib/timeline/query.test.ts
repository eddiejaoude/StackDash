import { describe, expect, it } from "vitest";

import { eventTypeName } from "@/lib/adapters/registry";
import { EMPTY_SCOPE, type ScopeOptions } from "@/lib/filters/scope";

import {
  activeFilters,
  decodeCursor,
  EVENT_SEVERITIES,
  encodeCursor,
  eventTypeLabel,
  hasActiveFilters,
  isEventTypeId,
  isIsoDate,
  londonDayStart,
  MAX_SEARCH_LENGTH,
  MAX_TYPE_FILTERS,
  occurredRange,
  parseTimelineEventId,
  parseTimelineSearchParams,
  selectedActivityBucket,
  severityBadge,
  timelineHref,
  timelineOccurredRange,
  timelineParams,
  timelineStatus,
  timelineTotal,
  titleSearchPattern,
  type TimelineCursor,
  type TimelineQuery,
} from "./query";

const CURSOR: TimelineCursor = {
  occurredAt: "2026-06-15T23:30:00.123456+00:00",
  id: "70000000-0000-4000-8000-000000000001",
};

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "20000000-0000-4000-8000-000000000002";

describe("parseTimelineEventId", () => {
  it("accepts a shared event id, normalizes case, and uses the first repeated value", () => {
    expect(parseTimelineEventId(` ${CURSOR.id.toUpperCase()} `)).toBe(CURSOR.id);
    expect(parseTimelineEventId([CURSOR.id, PROJECT_ID])).toBe(CURSOR.id);
  });

  it.each([undefined, "", [], "not-an-event", `${CURSOR.id},id.eq.${PROJECT_ID}`, ["invalid", CURSOR.id]])(
    "ignores a missing or malformed selection: %j", (value) => {
      expect(parseTimelineEventId(value)).toBeNull();
    },
  );
});

describe("encodeCursor and decodeCursor", () => {
  it("round trips a cursor with microseconds intact", () => {
    const token = encodeCursor(CURSOR);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(token)).toEqual(CURSOR);
  });

  it("round trips a cursor with a Z offset and no fraction", () => {
    const cursor = { occurredAt: "2026-01-01T00:00:00Z", id: CURSOR.id };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["an empty token", ""],
    ["characters outside base64url", "abc+/="],
    ["padding", `${encodeCursor(CURSOR)}=`],
    ["a token over 200 characters", "A".repeat(201)],
    ["bad base64 that does not re-encode to itself", "a"],
    ["a missing id", Buffer.from(CURSOR.occurredAt).toString("base64url")],
    ["a missing timestamp", Buffer.from(`|${CURSOR.id}`).toString("base64url")],
    ["an extra part", Buffer.from(`${CURSOR.occurredAt}|${CURSOR.id}|x`).toString("base64url")],
    ["a tampered id", Buffer.from(`${CURSOR.occurredAt}|not-a-uuid`).toString("base64url")],
    ["a tampered timestamp", Buffer.from(`2026-13-45T99:99:99Z|${CURSOR.id}`).toString("base64url")],
    ["a timestamp without an offset", Buffer.from(`2026-06-15T23:30:00|${CURSOR.id}`).toString("base64url")],
    ["an injected filter", Buffer.from(`2026-06-15T23:30:00Z),id.gt.(x|${CURSOR.id}`).toString("base64url")],
  ])("rejects %s", (_name, token) => {
    expect(decodeCursor(token)).toBeNull();
  });

  it("refuses to encode an invalid cursor", () => {
    expect(() => encodeCursor({ occurredAt: "yesterday", id: CURSOR.id })).toThrow(RangeError);
  });
});

describe("isIsoDate", () => {
  it.each([
    ["a normal date", "2026-06-15", true],
    ["a leap day", "2028-02-29", true],
    ["a non leap year February 29", "2026-02-29", false],
    ["February 30", "2026-02-30", false],
    ["month 13", "2026-13-01", false],
    ["a datetime", "2026-06-15T00:00", false],
    ["a short year", "26-06-15", false],
    ["an empty string", "", false],
  ])("%s", (_name, value, expected) => {
    expect(isIsoDate(value)).toBe(expected);
  });
});

describe("londonDayStart", () => {
  it.each([
    ["a winter day starts at midnight UTC", "2026-01-15", "2026-01-15T00:00:00.000Z"],
    ["a summer day starts at 23:00 UTC the day before", "2026-06-15", "2026-06-14T23:00:00.000Z"],
    ["the spring clock change day starts at midnight UTC", "2026-03-29", "2026-03-29T00:00:00.000Z"],
    ["the day after spring forward starts at 23:00 UTC", "2026-03-30", "2026-03-29T23:00:00.000Z"],
    ["the autumn clock change day starts at 23:00 UTC", "2026-10-25", "2026-10-24T23:00:00.000Z"],
    ["the day after fall back starts at midnight UTC", "2026-10-26", "2026-10-26T00:00:00.000Z"],
  ])("%s", (_name, date, expected) => {
    expect(londonDayStart(date).toISOString()).toBe(expected);
  });

  it("throws for an invalid date", () => {
    expect(() => londonDayStart("2026-02-30")).toThrow(RangeError);
  });
});

describe("occurredRange", () => {
  it("includes the whole London day at both ends", () => {
    expect(occurredRange("2026-06-15", "2026-06-15")).toEqual({
      from: "2026-06-14T23:00:00.000Z",
      toExclusive: "2026-06-15T23:00:00.000Z",
    });
  });

  it("rolls the exclusive end over a month and year boundary", () => {
    expect(occurredRange(null, "2026-12-31")).toEqual({ from: null, toExclusive: "2027-01-01T00:00:00.000Z" });
  });

  it("leaves both ends open when no dates are given", () => {
    expect(occurredRange(null, null)).toEqual({ from: null, toExclusive: null });
  });
});

describe("parseTimelineSearchParams", () => {
  it("parses every filter from a full URL", () => {
    const token = encodeCursor(CURSOR);
    expect(
      parseTimelineSearchParams({
        type: ["vercel.deployment_failed", "github.release_published"],
        severity: ["critical", "warning"],
        from: "2026-06-01",
        to: "2026-06-15",
        q: "Deploy failed",
        cursor: token,
        provider: "vercel",
        project: ["unassigned", PROJECT_ID],
        account: ACCOUNT_ID,
      }),
    ).toEqual({
      types: ["vercel.deployment_failed", "github.release_published"],
      severities: ["critical", "warning"],
      from: "2026-06-01",
      to: "2026-06-15",
      timeRange: null,
      search: "Deploy failed",
      cursor: CURSOR,
      scope: { providers: ["vercel"], projects: ["unassigned", PROJECT_ID], accounts: [ACCOUNT_ID] },
    });
  });

  it("returns no filters for empty params", () => {
    expect(parseTimelineSearchParams({})).toEqual({
      types: [],
      severities: [],
      from: null,
      to: null,
      timeRange: null,
      search: null,
      cursor: null,
      scope: EMPTY_SCOPE,
    });
  });

  it("drops invalid values instead of failing", () => {
    expect(
      parseTimelineSearchParams({
        type: ["Vercel.Deploy", "vercel.deployment_failed", "no_dot", "x.y),id.gt.(z"],
        severity: ["bogus", "info"],
        from: "2026-02-30",
        to: "",
        q: "   ",
        cursor: "not a cursor",
        provider: ["bogus", "github"],
        project: "not-a-uuid",
        account: "1,2",
      }),
    ).toEqual({
      types: ["vercel.deployment_failed"],
      severities: ["info"],
      from: null,
      to: null,
      timeRange: null,
      search: null,
      cursor: null,
      scope: { providers: ["github"], projects: [], accounts: [] },
    });
  });

  it("accepts a single string where a list is allowed and removes duplicates", () => {
    const query = parseTimelineSearchParams({ type: "fake.usage_warning", severity: ["info", "info"] });
    expect(query.types).toEqual(["fake.usage_warning"]);
    expect(query.severities).toEqual(["info"]);
  });

  it("uses the first value of a repeated single parameter", () => {
    expect(parseTimelineSearchParams({ from: ["2026-06-01", "2026-06-02"] }).from).toBe("2026-06-01");
  });

  it(`keeps at most ${MAX_TYPE_FILTERS} type ids`, () => {
    const types = Array.from({ length: MAX_TYPE_FILTERS + 1 }, (_, index) => `fake.type_${index}`);
    expect(parseTimelineSearchParams({ type: types }).types).toHaveLength(MAX_TYPE_FILTERS);
  });

  it("trims the title search and keeps one of exactly the longest length", () => {
    expect(parseTimelineSearchParams({ q: "  payment  " }).search).toBe("payment");
    const longest = "a".repeat(MAX_SEARCH_LENGTH);
    expect(parseTimelineSearchParams({ q: longest }).search).toBe(longest);
  });

  it("drops a title search one character too long", () => {
    expect(parseTimelineSearchParams({ q: "a".repeat(MAX_SEARCH_LENGTH + 1) }).search).toBeNull();
  });
});

describe("activity time selection", () => {
  const start = "2026-10-25T01:00:00.000Z";
  const until = "2026-10-25T02:00:00.000Z";

  it("round trips exact bounds alongside other filters and pagination", () => {
    const query = parseTimelineSearchParams({ start, until, q: "deploy", severity: "critical" });
    expect(query.timeRange).toEqual({ from: start, toExclusive: until });
    expect(hasActiveFilters(query)).toBe(true);
    const params = new URL(timelineHref("/timeline", query, CURSOR), "https://example.com").searchParams;
    expect(parseTimelineSearchParams(Object.fromEntries(params))).toEqual({ ...query, cursor: CURSOR });
  });

  it("normalizes offsets across the repeated London hour without losing the instant", () => {
    expect(parseTimelineSearchParams({
      start: "2026-10-25T01:00:00+01:00", until: "2026-10-25T01:00:00Z",
    }).timeRange).toEqual({ from: "2026-10-25T00:00:00.000Z", toExclusive: start });
  });

  it.each([
    { start }, { until }, { start, until: start }, { start: until, until: start },
    { start: "0000-01-01T00:00:00Z", until },
    { start, until: "9999-12-31T23:59:59-01:00" },
    { start: "2026-02-30T00:00:00Z", until },
    { start: "2026-10-25T00:00:00", until },
    { start: "2026-10-25T00:00:00.000001Z", until },
    { start: "now", until },
    { start: "2026-10-25T00:00:00Z),id.gt.(x", until },
  ])("ignores an invalid or incomplete pair: %j", (params) => {
    expect(parseTimelineSearchParams(params).timeRange).toBeNull();
  });

  it("intersects calendar days with a wider bucket rather than broadening them", () => {
    const query = parseTimelineSearchParams({
      from: "2026-10-25", to: "2026-10-25",
      start: "2026-10-24T00:00:00Z", until: "2026-10-27T00:00:00Z",
    });
    expect(timelineOccurredRange(query)).toEqual({
      from: "2026-10-24T23:00:00.000Z", toExclusive: "2026-10-26T00:00:00.000Z",
    });
    expect(timelineOccurredRange({ ...query, from: null, to: null })).toEqual(query.timeRange);
  });

  it("keeps a disjoint intersection empty and honors narrower buckets", () => {
    const query = parseTimelineSearchParams({ from: "2026-10-26", start, until });
    expect(timelineOccurredRange(query)).toEqual({ from: "2026-10-26T00:00:00.000Z", toExclusive: until });
    expect(timelineOccurredRange({ ...query, from: "2026-10-25", to: "2026-10-25" })).toEqual(query.timeRange);
    expect(timelineOccurredRange({ ...query, timeRange: null })).toEqual(occurredRange(query.from, query.to));
  });
});

describe("titleSearchPattern", () => {
  it("leaves plain text, unicode, and spaces as they are", () => {
    expect(titleSearchPattern("Paiement réussi 5")).toBe("Paiement réussi 5");
  });

  it("escapes every regular expression metacharacter so it matches literally", () => {
    expect(titleSearchPattern("a.b*c+d?e^f$g|h(i)j[k]l{m}n\\o")).toBe(
      "a\\.b\\*c\\+d\\?e\\^f\\$g\\|h\\(i\\)j\\[k\\]l\\{m\\}n\\\\o",
    );
  });
});

describe("isEventTypeId", () => {
  it("accepts a 100 character id and rejects 101", () => {
    const at100 = `fake.${"a".repeat(95)}`;
    expect(isEventTypeId(at100)).toBe(true);
    expect(isEventTypeId(`${at100}a`)).toBe(false);
  });
});

describe("eventTypeLabel", () => {
  it.each([
    ["vercel.deployment_failed", "Deployment failed"],
    ["devmacro.daily_summary", "Daily summary"],
    ["devmacro.anomaly_detected", "Unusual spend or usage"],
    ["github.release.published", "Release published"],
  ])("labels %s", (typeId, expected) => {
    expect(eventTypeLabel(typeId)).toBe(expected);
  });
});

describe("severityBadge", () => {
  it("maps every severity to a badge word", () => {
    expect(EVENT_SEVERITIES.map(severityBadge)).toEqual([
      "Event",
      "Success",
      "Warning",
      "Critical",
    ]);
  });
});

describe("timelineHref and hasActiveFilters", () => {
  const empty = parseTimelineSearchParams({});

  it("returns the bare path with no filters", () => {
    expect(timelineHref("/w/abc/timeline", empty, null)).toBe("/w/abc/timeline");
    expect(hasActiveFilters(empty)).toBe(false);
  });

  it("keeps filters and adds the cursor for the next page", () => {
    const query = { ...empty, severities: ["critical" as const], from: "2026-06-15" };
    const href = timelineHref("/w/abc/timeline", query, CURSOR);
    const params = new URL(href, "https://example.com").searchParams;
    expect(params.getAll("severity")).toEqual(["critical"]);
    expect(params.get("from")).toBe("2026-06-15");
    expect(decodeCursor(params.get("cursor") ?? "")).toEqual(CURSOR);
    expect(hasActiveFilters(query)).toBe(true);
  });

  it("does not count a cursor alone as a filter", () => {
    expect(hasActiveFilters({ ...empty, cursor: CURSOR })).toBe(false);
  });

  it("carries the title search into the link and counts it as a filter", () => {
    const query = { ...empty, search: "deploy & ship" };
    const params = new URL(timelineHref("/w/abc/timeline", query, CURSOR), "https://example.com").searchParams;
    expect(params.get("q")).toBe("deploy & ship");
    expect(decodeCursor(params.get("cursor") ?? "")).toEqual(CURSOR);
    expect(hasActiveFilters(query)).toBe(true);
  });

  it("carries the scope filter into the link and counts it as a filter", () => {
    const query = { ...empty, scope: { providers: ["vercel" as const], projects: [PROJECT_ID], accounts: [ACCOUNT_ID] } };
    const params = new URL(timelineHref("/w/abc/timeline", query, null), "https://example.com").searchParams;
    expect(params.getAll("provider")).toEqual(["vercel"]);
    expect(params.getAll("project")).toEqual([PROJECT_ID]);
    expect(params.getAll("account")).toEqual([ACCOUNT_ID]);
    expect(hasActiveFilters(query)).toBe(true);
  });
});

describe("timelineParams", () => {
  it("writes the same filters as the link, so hidden inputs and links agree", () => {
    const query = parseTimelineSearchParams({
      type: "vercel.deployment_ready",
      severity: ["critical", "warning"],
      q: "deploy",
      provider: "vercel",
      start: "2026-06-15T04:00:00.000Z",
      until: "2026-06-15T09:00:00.000Z",
    });
    expect(`/t?${timelineParams(query, CURSOR).toString()}`).toBe(timelineHref("/t", query, CURSOR));
  });

  it("leaves the search out when the search form writes every other filter", () => {
    const query = parseTimelineSearchParams({ q: "deploy", severity: "critical" });
    expect([...timelineParams({ ...query, search: null }, null)]).toEqual([["severity", "critical"]]);
  });
});

const SCOPE_OPTIONS: ScopeOptions = {
  providers: [
    { value: "github", label: "GitHub" },
    { value: "vercel", label: "Vercel" },
  ],
  projects: [
    { value: PROJECT_ID, label: "Checkout" },
    { value: "unassigned", label: "Unassigned" },
  ],
  accounts: [{ value: ACCOUNT_ID, label: "Acme team (Vercel production)" }],
};

describe("activeFilters", () => {
  const BUCKET_START = "2026-06-15T04:00:00.000Z";
  const BUCKET_END = "2026-06-15T09:00:00.000Z";
  // One of each filter, so every kind of chip appears once.
  const every = parseTimelineSearchParams({
    q: "deploy",
    type: "vercel.deployment_ready",
    severity: "critical",
    from: "2026-06-01",
    to: "2026-06-30",
    start: BUCKET_START,
    until: BUCKET_END,
    provider: "vercel",
    project: PROJECT_ID,
    account: ACCOUNT_ID,
    cursor: encodeCursor(CURSOR),
  });

  it("lists nothing when no filter is active, even on an older page", () => {
    expect(activeFilters({ ...parseTimelineSearchParams({}), cursor: CURSOR }, SCOPE_OPTIONS, eventTypeName)).toEqual([]);
  });

  it("names one chip per filter, in the page's order, named the way the filter form names them", () => {
    expect(activeFilters(every, SCOPE_OPTIONS, eventTypeName).map(({ kind, value, name }) => ({ kind, value, name }))).toEqual([
      { kind: "Search", value: "“deploy”", name: "Remove filter: search “deploy”" },
      { kind: "Event type", value: "Vercel: Deployment ready", name: "Remove filter: event type Vercel: Deployment ready" },
      { kind: "Severity", value: "Critical", name: "Remove filter: severity Critical" },
      { kind: "From date", value: "2026-06-01", name: "Remove filter: from date 2026-06-01" },
      { kind: "To date", value: "2026-06-30", name: "Remove filter: to date 2026-06-30" },
      {
        kind: "Period",
        value: "2026-06-15 05:00 BST to before 2026-06-15 10:00 BST",
        name: "Remove filter: period 2026-06-15 05:00 BST to before 2026-06-15 10:00 BST",
      },
      { kind: "Provider", value: "Vercel", name: "Remove filter: provider Vercel" },
      { kind: "Project", value: "Checkout", name: "Remove filter: project Checkout" },
      { kind: "Account", value: "Acme team (Vercel production)", name: "Remove filter: account Acme team (Vercel production)" },
    ]);
  });

  it("removes only its own filter, keeps the rest, and starts from the newest events", () => {
    const chips = activeFilters(every, SCOPE_OPTIONS, eventTypeName);
    expect(new Set(chips.map((chip) => chip.key)).size).toBe(chips.length);
    for (const chip of chips) {
      expect(chip.query.cursor).toBeNull();
      // Removing the chip and putting its one value back gives the original filters.
      const remaining = activeFilters(chip.query, SCOPE_OPTIONS, eventTypeName).map((other) => other.key);
      expect(remaining).toEqual(chips.map((other) => other.key).filter((key) => key !== chip.key));
    }
    const withoutProvider = chips.find((chip) => chip.key === "provider=vercel")?.query;
    expect(withoutProvider).toEqual({ ...every, cursor: null, scope: { ...every.scope, providers: [] } });
  });

  it("names each of several values in one dimension, and removing one keeps the others", () => {
    const query = parseTimelineSearchParams({
      severity: ["critical", "warning"],
      type: ["vercel.deployment_ready", "github.release_published", "stripe.charge.succeeded"],
      provider: ["github", "vercel"],
      project: [PROJECT_ID, "unassigned"],
    });
    const chips = activeFilters(query, SCOPE_OPTIONS, eventTypeName);
    expect(chips.map((chip) => chip.value)).toEqual([
      "Vercel: Deployment ready",
      "GitHub: Release published",
      // The adapter's declared name, as the filter form prints it (#294), not "Charge succeeded".
      "Stripe: Payment succeeded",
      "Critical",
      "Warning",
      "GitHub",
      "Vercel",
      "Checkout",
      "Unassigned",
    ]);
    const removeWarning = chips.find((chip) => chip.name === "Remove filter: severity Warning")?.query;
    expect(removeWarning?.severities).toEqual(["critical"]);
    const removeGitHub = chips.find((chip) => chip.name === "Remove filter: provider GitHub")?.query;
    expect(removeGitHub?.scope.providers).toEqual(["vercel"]);
    expect(removeGitHub?.scope.projects).toEqual([PROJECT_ID, "unassigned"]);
  });

  it("never prints an internal id for a value missing from the options", () => {
    const query = parseTimelineSearchParams({ provider: "stripe", project: PROJECT_ID, account: ACCOUNT_ID });
    const empty: ScopeOptions = { providers: [], projects: [], accounts: [] };
    expect(activeFilters(query, empty, eventTypeName).map((chip) => chip.value)).toEqual(["Stripe", "Unknown project", "Unknown account"]);
  });

  it("keeps a search of exactly the longest length and unicode whole", () => {
    const search = "é".repeat(MAX_SEARCH_LENGTH);
    const [chip] = activeFilters(parseTimelineSearchParams({ q: search }), SCOPE_OPTIONS, eventTypeName);
    expect(chip?.value).toBe(`“${search}”`);
    expect(chip?.query.search).toBeNull();
  });
});

describe("selectedActivityBucket and timelineTotal", () => {
  const buckets = [
    { bucket_start: "2026-06-15T04:00:00+00:00", bucket_end: "2026-06-15T09:00:00+00:00", events: 5 },
    { bucket_start: "2026-06-15T09:00:00+00:00", bucket_end: "2026-06-15T14:00:00+00:00", events: 0 },
    { bucket_start: "2026-06-15T14:00:00+00:00", bucket_end: "2026-06-15T19:00:00+00:00", events: 7 },
  ];
  const range = (from: string, toExclusive: string): TimelineQuery["timeRange"] => ({ from, toExclusive });

  it.each([
    { case: "no bars and no period", buckets: [], timeRange: null, total: 0 },
    { case: "every bar with no period", buckets, timeRange: null, total: 12 },
    { case: "the selected bar, matched across offsets", buckets, timeRange: range("2026-06-15T14:00:00.000Z", "2026-06-15T19:00:00.000Z"), total: 7 },
    { case: "an empty selected bar", buckets, timeRange: range("2026-06-15T09:00:00.000Z", "2026-06-15T14:00:00.000Z"), total: 0 },
    { case: "a period that is not one bar", buckets, timeRange: range("2026-06-15T04:00:00.000Z", "2026-06-15T14:00:00.000Z"), total: null },
    { case: "a period one millisecond off a bar", buckets, timeRange: range("2026-06-15T04:00:00.001Z", "2026-06-15T09:00:00.000Z"), total: null },
  ])("$case: $total", ({ buckets: rows, timeRange, total }) => {
    expect(timelineTotal(rows, timeRange)).toBe(total);
  });

  it("finds the bar itself, so the overview can mark it", () => {
    expect(selectedActivityBucket(buckets, range("2026-06-15T04:00:00.000Z", "2026-06-15T09:00:00.000Z"))).toBe(buckets[0]);
    expect(selectedActivityBucket(buckets, null)).toBeUndefined();
  });
});

describe("timelineStatus", () => {
  const plain = { olderPage: false, search: null, scopeDescription: null };
  it.each([
    { case: "no events", count: 0, total: 0, olderPage: false, status: "Showing no events" },
    { case: "no events on an older page", count: 0, total: 60, olderPage: true, status: "Showing no events" },
    { case: "one of one", count: 1, total: 1, olderPage: false, status: "Showing 1 of 1 event" },
    { case: "one of many", count: 1, total: 60, olderPage: false, status: "Showing 1 of 60 events" },
    { case: "a full page of more", count: 50, total: 60, olderPage: false, status: "Showing 50 of 60 events" },
    { case: "every event on one page", count: 50, total: 50, olderPage: false, status: "Showing 50 of 50 events" },
    { case: "an older page", count: 10, total: 60, olderPage: true, status: "Showing 10 older events of 60" },
    { case: "one older event", count: 1, total: 51, olderPage: true, status: "Showing 1 older event of 51" },
    { case: "a grouped total", count: 50, total: 12_345, olderPage: false, status: "Showing 50 of 12,345 events" },
    { case: "a total one below the count", count: 50, total: 49, olderPage: false, status: "Showing 50 events" },
    { case: "a total below an older page's count", count: 10, total: 9, olderPage: true, status: "Showing 10 older events" },
    { case: "no total for a period that is not one bar", count: 3, total: null, olderPage: false, status: "Showing 3 events" },
    { case: "one event and no total", count: 1, total: null, olderPage: false, status: "Showing 1 event" },
  ])("$case: $status", ({ count, total, olderPage, status }) => {
    expect(timelineStatus({ ...plain, count, total, olderPage })).toBe(status);
  });

  it("adds the search and the scope after the counts", () => {
    expect(timelineStatus({ count: 11, total: 11, olderPage: false, search: "event 5", scopeDescription: "provider Vercel" })).toBe(
      "Showing 11 of 11 events with “event 5” in the title for provider Vercel",
    );
    expect(timelineStatus({ count: 0, total: 0, olderPage: false, search: "x", scopeDescription: null })).toBe(
      "Showing no events with “x” in the title",
    );
  });
});
