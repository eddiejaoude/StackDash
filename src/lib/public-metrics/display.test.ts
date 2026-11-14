import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { applyRounding, formatMetricValue, livePublicationsText, publicationSummary, publishedDisplay } from "./display";

const SRC = path.join(process.cwd(), "src");

/** Every module `file` loads at run time, following `@/` and relative imports; type imports are erased. */
function runtimeImports(file: string, specifiers = new Set<string>(), visited = new Set<string>()): Set<string> {
  visited.add(file);
  const source = readFileSync(file, "utf8");
  for (const [, specifier] of source.matchAll(/^import\s+(?:(?!type\s)[^;]*?from\s+)?"([^"]+)";/gms)) {
    if (specifier === undefined) continue;
    specifiers.add(specifier);
    const base = specifier.startsWith("@/")
      ? path.join(SRC, specifier.slice(2))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(file), specifier)
        : null;
    const resolved = base === null ? undefined : [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(existsSync);
    if (resolved !== undefined && !visited.has(resolved)) runtimeImports(resolved, specifiers, visited);
  }
  return specifiers;
}

describe("client safety", () => {
  // #149 and #150 import these from client components; a server module here fails their build.
  it.each(["display.ts", "definitions.ts", "share.ts", "badge.ts"])("%s loads no adapter, data access, or Node module", (file) => {
    const imports = [...runtimeImports(path.join(SRC, "lib/public-metrics", file))];
    expect(imports.filter((specifier) => /^node:|^server-only$|^@\/lib\/(adapters|supabase\/(server|admin)|data)\b/.test(specifier))).toEqual([]);
  });

  it("finds a server module when one is imported", () => {
    // The engine's Supabase store is server-only, so the walk must report it.
    expect([...runtimeImports(path.join(SRC, "lib/public-metrics/supabase-store.ts"))]).toContain("server-only");
  });
});

describe("applyRounding", () => {
  it.each([
    ["exact", 1234, 1234],
    ["tens", 1234, 1230],
    ["hundreds", 1299, 1200],
    ["thousands", 1999, 1000],
    // Boundaries: on the step stays, below the first step is zero, zero stays zero.
    ["hundreds", 1200, 1200],
    ["thousands", 999, 0],
    ["tens", 0, 0],
  ] as const)("%s rounds %d down to %d", (rounding, value, expected) => {
    expect(applyRounding(value, rounding)).toBe(expected);
  });
});

describe("formatMetricValue", () => {
  it.each([
    [1204, "stars", false, "1,204 stars"],
    [1, "deployments", false, "1 deployment"],
    [0, "signups", false, "0 signups"],
    [87, "percent", false, "87%"],
    [1200, "stars", true, "at least 1,200 stars"],
    [1, "payments", true, "at least 1 payment"],
  ] as const)("formats %d %s (at least: %s) as %s", (value, unit, atLeast, expected) => {
    expect(formatMetricValue(value, unit, atLeast)).toBe(expected);
  });
});

describe("publishedDisplay", () => {
  it("rounds down and marks a rounded value as at least", () => {
    expect(publishedDisplay(1204, "stars", "hundreds", false)).toEqual({ value: 1200, text: "at least 1,200 stars" });
  });

  it("keeps an exact value exact unless it is a lower bound", () => {
    expect(publishedDisplay(1204, "stars", "exact", false)).toEqual({ value: 1204, text: "1,204 stars" });
    expect(publishedDisplay(1000, "deployments", "exact", true)).toEqual({ value: 1000, text: "at least 1,000 deployments" });
  });
});

describe("publicationSummary", () => {
  it.each([
    ["exact", 0, "Exact, current"],
    ["hundreds", 7, "Rounded down to 100, 7 days late"],
  ] as const)("%s and %d days read %s", (rounding, delay, expected) => {
    expect(publicationSummary(rounding, delay)).toBe(expected);
  });
});

describe("livePublicationsText (#413)", () => {
  it.each([
    [{ metrics: 2, achievements: 1 }, "2 metrics and 1 achievement"],
    [{ metrics: 1, achievements: 0 }, "1 metric"],
    [{ metrics: 0, achievements: 3 }, "3 achievements"],
    [{ metrics: 1_204, achievements: 0 }, "1,204 metrics"],
    [{ metrics: 0, achievements: 0 }, ""],
  ])("%o reads %s", (counts, expected) => {
    expect(livePublicationsText(counts)).toBe(expected);
  });
});
