import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { HANDLE_MAX, HANDLE_MIN, handleSchema, isHandleFormat, normalizeHandle, RESERVED_HANDLES } from "./handles";

function refusal(input: string): string | undefined {
  const result = handleSchema.safeParse(input);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe("handleSchema", () => {
  it.each([
    ["the shortest handle (3 characters)", "a".repeat(HANDLE_MIN), "aaa"],
    ["the longest handle (32 characters)", "a".repeat(HANDLE_MAX), "a".repeat(32)],
    ["single hyphens between words", "acme-labs-2", "acme-labs-2"],
    ["digits only", "123", "123"],
    ["uppercase input, lowercased", "Acme-Labs", "acme-labs"],
    ["surrounding whitespace, trimmed", "  acme-labs\t\n", "acme-labs"],
    ["a 32 character handle inside whitespace", ` ${"a".repeat(HANDLE_MAX)} `, "a".repeat(32)],
  ])("accepts %s", (_case, input, handle) => {
    expect(handleSchema.parse(input)).toBe(handle);
  });

  it.each([
    ["empty input (boundary)", "", "Enter a handle, such as acme-labs."],
    ["whitespace only (boundary)", "   ", "Enter a handle, such as acme-labs."],
    ["2 characters (boundary)", "ab", "Use at least 3 characters."],
    ["33 characters (boundary)", "a".repeat(HANDLE_MAX + 1), "Use 32 characters or fewer."],
    ["a leading hyphen", "-acme", "Use lowercase letters and numbers, with single hyphens between words."],
    ["a trailing hyphen", "acme-", "Use lowercase letters and numbers, with single hyphens between words."],
    ["a double hyphen", "acme--labs", "Use lowercase letters and numbers, with single hyphens between words."],
    ["an inner space", "acme labs", "Use lowercase letters and numbers, with single hyphens between words."],
    ["an underscore", "acme_labs", "Use lowercase letters and numbers, with single hyphens between words."],
    ["a dot", "acme.labs", "Use lowercase letters and numbers, with single hyphens between words."],
    ["an accented letter (unicode)", "café", "Use lowercase letters and numbers, with single hyphens between words."],
    ["a Cyrillic look-alike (unicode)", "\u0430cme", "Use lowercase letters and numbers, with single hyphens between words."],
    ["the Kelvin sign, which toLowerCase turns into k (unicode)", "\u212Aelvin", "Use lowercase letters and numbers, with single hyphens between words."],
    ["an emoji (unicode)", "acme🚀", "Use lowercase letters and numbers, with single hyphens between words."],
    ["a reserved route segment", "docs", "This handle is reserved. Choose another one."],
    ["a reserved name", "stackdash", "This handle is reserved. Choose another one."],
    ["a reserved name in capitals", "WWW", "This handle is reserved. Choose another one."],
    ["a reserved hyphenated route segment", "sign-in", "This handle is reserved. Choose another one."],
  ])("refuses %s", (_case, input, message) => {
    expect(refusal(input)).toBe(message);
  });
});

describe("normalizeHandle", () => {
  it("lowercases ASCII letters and leaves every other character as typed", () => {
    expect(normalizeHandle(" ACME-\u212A ")).toBe("acme-\u212A");
  });
});

describe("isHandleFormat", () => {
  it.each(["aaa", "a".repeat(HANDLE_MAX), "acme-labs"])("accepts %s", (value) => {
    expect(isHandleFormat(value)).toBe(true);
  });

  it.each([
    ["2 characters (boundary)", "ab"],
    ["33 characters (boundary)", "a".repeat(HANDLE_MAX + 1)],
    ["capitals, since addresses are never lowercased", "Acme"],
    ["a double hyphen", "acme--labs"],
  ])("refuses %s", (_case, value) => {
    expect(isHandleFormat(value)).toBe(false);
  });
});

/**
 * The URL segments directly under an app directory. A route group "(x)" adds no segment, so its
 * children are top-level segments too; dynamic segments "[x]", slots "@x", and private folders "_x"
 * add none that a handle could collide with.
 */
function topLevelSegments(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || /^[[@_]/.test(entry.name)) return [];
    if (entry.name.startsWith("(")) return topLevelSegments(path.join(dir, entry.name));
    return [entry.name];
  });
}

describe("topLevelSegments", () => {
  it("lists the segments inside route groups, and none for dynamic, slot, or private folders (boundary)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stackdash-app-"));
    try {
      for (const folder of ["docs", "(marketing)/pricing", "(marketing)/(nested)/blog", "[id]", "@modal", "_lib"]) {
        fs.mkdirSync(path.join(root, folder), { recursive: true });
      }
      fs.writeFileSync(path.join(root, "page.tsx"), "");
      expect(topLevelSegments(root).sort()).toEqual(["blog", "docs", "pricing"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("RESERVED_HANDLES", () => {
  const segments = topLevelSegments(path.join(process.cwd(), "src/app"));

  it("finds the app's top-level route segments, so the check below is not vacuous", () => {
    expect(segments).toEqual(expect.arrayContaining(["api", "docs", "p", "w"]));
  });

  it.each(segments)("reserves the route segment %s", (segment) => {
    expect(RESERVED_HANDLES.has(segment)).toBe(true);
  });

  it("holds only lowercase entries, so the lowercased input is what is compared", () => {
    expect([...RESERVED_HANDLES].filter((word) => word !== word.toLowerCase())).toEqual([]);
  });
});
