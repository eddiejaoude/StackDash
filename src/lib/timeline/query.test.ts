import { describe, expect, it } from "vitest";

import { EMPTY_SCOPE } from "@/lib/filters/scope";

import {
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
  severityBadge,
  timelineHref,
  titleSearchPattern,
  type TimelineCursor,
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
  const empty = { types: [], severities: [], from: null, to: null, search: null, cursor: null, scope: EMPTY_SCOPE };

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
