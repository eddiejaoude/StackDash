import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createHeadingSlugger,
  docGroup,
  getDoc,
  groupDocs,
  isDocSlug,
  listDocs,
  parseVerification,
  resolveDocLink,
  type DocLink,
  type DocVerification,
} from "@/lib/docs";

describe("parseVerification", () => {
  it.each<[string, string, DocVerification | null]>([
    ["documentation only", "Provider id: `x`. Verification: documentation only. Docs checked 2026-11-05.", "documentation"],
    ["a real account", "Provider id: `x`. Verification: tested with a real account.", "real-account"],
    ["the sentence at the start of a line", "Verification: documentation only.", "documentation"],
    ["no sentence", "Provider id: `x`. Docs checked 2026-11-05.", null],
    ["an empty page", "", null],
    ["an unknown phrase", "Verification: mostly.", null],
    ["a prototype member as the phrase", "Verification: constructor.", null],
    ["a phrase in another case", "Verification: Documentation only.", null],
    ["a sentence only inside a code fence", "```\nVerification: documentation only.\n```", null],
    ["a sentence only after the lead paragraph", "Provider id: `x`.\n\nVerification: tested with a real account.", null],
    ["a sentence on the lead paragraph's second line", "Provider id: `x`.\nVerification: documentation only.", "documentation"],
  ])("reads %s", (_case, source, expected) => {
    expect(parseVerification(`# Title\n\n${source}\n`)).toBe(expected);
  });

  it("reads the lead paragraph, never a later sentence that disagrees", () => {
    expect(
      parseVerification("# Title\n\nVerification: documentation only.\n\nVerification: tested with a real account.\n"),
    ).toBe("documentation");
  });
});

describe("isDocSlug", () => {
  it.each([
    [["providers", "vercel"]],
    [["operations", "oauth-apps"]],
    [["architecture", "schema"]],
    [["top-level"]],
    [["v2", "page-1"]],
  ])("accepts %j", (slug) => {
    expect(isDocSlug(slug)).toBe(true);
  });

  it.each([
    ["empty slug", []],
    ["empty segment", ["providers", ""]],
    ["parent traversal", ["..", "src"]],
    ["traversal inside a segment", ["providers", "..%2F..%2Fpackage"]],
    ["decoded traversal inside a segment", ["providers", "../../package"]],
    ["absolute path", ["/etc", "passwd"]],
    ["backslash", ["providers\\vercel"]],
    ["uppercase", ["providers", "Vercel"]],
    ["file extension", ["providers", "vercel.md"]],
    ["dot file", [".env"]],
    ["whitespace", ["providers", "ver cel"]],
    ["unicode letter", ["providers", "vércel"]],
  ])("refuses %s", (_case, slug) => {
    expect(isDocSlug(slug)).toBe(false);
  });

  it("getDoc never reads outside docs/ for a traversal slug", () => {
    expect(getDoc(["..", "package"])).toBeNull();
    expect(getDoc(["..", "..", "etc", "passwd"])).toBeNull();
  });

  it("getDoc returns null for a well-formed slug with no file", () => {
    expect(getDoc(["providers", "not-a-provider"])).toBeNull();
  });
});

describe("resolveDocLink", () => {
  const docHrefs = new Set(["/docs/operations/deploy", "/docs/operations/jobs", "/docs/providers/github"]);
  const from = ["operations", "oauth-apps"];

  it.each<[string, string, DocLink]>([
    ["sibling doc", "jobs.md", { kind: "doc", href: "/docs/operations/jobs" }],
    ["sibling doc with a fragment", "deploy.md#environment-variables", { kind: "doc", href: "/docs/operations/deploy#environment-variables" }],
    ["doc in another folder with a fragment", "../providers/github.md#permissions", { kind: "doc", href: "/docs/providers/github#permissions" }],
    ["doc from the repository root", "/docs/operations/jobs.md", { kind: "doc", href: "/docs/operations/jobs" }],
    ["fragment on the same page", "#hosted-and-self-hosted", { kind: "fragment", href: "#hosted-and-self-hosted" }],
  ])("links a %s", (_case, href, expected) => {
    expect(resolveDocLink(from, href, docHrefs)).toEqual(expected);
  });

  it.each<[string, string, string]>([
    ["source file", "../../src/lib/docs.ts", "src/lib/docs.ts"],
    ["migration folder", "../../supabase/migrations/", "supabase/migrations"],
    ["dot file at the root", "/.env.example", ".env.example"],
    ["Markdown file outside docs/", "../../README.md#license", "README.md"],
    ["doc that does not exist", "missing.md", "docs/operations/missing.md"],
    ["doc folder", "../providers/", "docs/providers"],
  ])("shows a repository %s as a path, not a link", (_case, href, repoPath) => {
    expect(resolveDocLink(from, href, docHrefs)).toEqual({ kind: "repo", path: repoPath });
  });

  it.each<[string, DocLink]>([
    ["https://vercel.com/docs", { kind: "external", href: "https://vercel.com/docs" }],
    ["HTTP://example.com", { kind: "external", href: "HTTP://example.com" }],
    ["//example.com/a", { kind: "external", href: "https://example.com/a" }],
    ["mailto:security@example.com", { kind: "email", href: "mailto:security@example.com" }],
    ["javascript:alert(1)", { kind: "unsupported" }],
    ["", { kind: "unsupported" }],
    ["   ", { kind: "unsupported" }],
  ])("classifies %j", (href, expected) => {
    expect(resolveDocLink(from, href, docHrefs)).toEqual(expected);
  });
});

describe("createHeadingSlugger", () => {
  it("matches the GitHub anchors the docs link to", () => {
    const slug = createHeadingSlugger();
    expect(slug("Register the pg_cron job")).toBe("register-the-pg_cron-job");
    expect(slug("GitHub OAuth app for sign-in")).toBe("github-oauth-app-for-sign-in");
    expect(slug("What stays Eddie's")).toBe("what-stays-eddies");
    expect(slug("4. Invite testers")).toBe("4-invite-testers");
  });

  it("suffixes repeated headings in order", () => {
    const slug = createHeadingSlugger();
    expect(["Permissions", "Permissions", "Permissions", "Permissions-1"].map(slug)).toEqual([
      "permissions",
      "permissions-1",
      "permissions-2",
      "permissions-1-1",
    ]);
  });

  it("starts each document fresh", () => {
    expect(createHeadingSlugger()("Summary")).toBe("summary");
    expect(createHeadingSlugger()("Summary")).toBe("summary");
  });
});

describe("listDocs", () => {
  const docsDir = path.join(process.cwd(), "docs");
  const allMarkdown = fs
    .readdirSync(docsDir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3).split(path.sep));
  const internalSlugs = allMarkdown.filter((slug) => slug[0] === "internal");
  const markdownFiles = allMarkdown.filter((slug) => slug[0] !== "internal").map((slug) => `/docs/${slug.join("/")}`);

  it("publishes every Markdown file under docs/ outside docs/internal/ exactly once", () => {
    const hrefs = listDocs().map((doc) => doc.href);
    expect(markdownFiles.length).toBeGreaterThan(0);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect([...hrefs].sort()).toEqual([...markdownFiles].sort());
    expect(hrefs).toEqual(
      expect.arrayContaining(["/docs/providers/vercel", "/docs/operations/deploy", "/docs/architecture/schema"]),
    );
  });

  // docs/internal/ holds steps only the hosted instance's operator performs. A page there that
  // became reachable at /docs would publish them.
  it("never publishes a page under docs/internal/", () => {
    expect(internalSlugs.length).toBeGreaterThan(0);
    for (const slug of internalSlugs) {
      expect(getDoc(slug), slug.join("/")).toBeNull();
    }
    expect(listDocs().filter((doc) => doc.slug[0] === "internal")).toEqual([]);
  });

  it("links to a page under docs/internal/ as a repository path, never as a doc", () => {
    const docHrefs = new Set(listDocs().map((doc) => doc.href));
    expect(resolveDocLink(["operations", "deploy"], "../internal/hosted-instance.md", docHrefs)).toEqual({
      kind: "repo",
      path: "docs/internal/hosted-instance.md",
    });
  });

  it("titles each page from its first heading and describes it in plain text", () => {
    const vercel = getDoc(["providers", "vercel"]);
    expect(vercel?.title).toBe("Vercel");
    // The lead line only carries the provider id, verification, and date, so the description skips it.
    expect(vercel?.description).toMatch(/^StackDash reads your Vercel billing charges and deployments/);

    for (const doc of listDocs()) {
      expect(doc.title, doc.href).not.toBe("");
      expect(doc.description, doc.href).not.toBe("");
      expect(doc.description, doc.href).not.toMatch(/[`*]|\]\(/);
      expect(doc.description, doc.href).not.toMatch(/^(Provider id|Verification|Docs checked)/);
    }
  });

  it("describes every provider by what StackDash reads, never by a research verdict", () => {
    const providers = listDocs().filter((doc) => doc.group === "providers");
    expect(providers.length).toBeGreaterThan(0);
    for (const doc of providers) {
      expect(doc.description, doc.href).toMatch(/^StackDash reads /);
      expect(doc.description, doc.href).not.toMatch(/\b(go|no-go|not yet confirmed|nothing on this page)\b/i);
    }
  });

  it("gives every provider page a verification status and no other page one", () => {
    for (const doc of listDocs()) {
      if (doc.group === "providers") expect(["documentation", "real-account"], doc.href).toContain(doc.verification);
      else expect(doc.verification, doc.href).toBeNull();
    }
  });

  // The docs are published on the website, where an issue number in a private repository means
  // nothing to the reader. `#` followed by digits after a letter (`PKCS#1`) or inside a color
  // (`#0080FF`) is not an issue reference.
  it("publishes no issue references", () => {
    const issueReference = /(?<![\w&])#\d+\b|github\.com\/eddiejaoude\/StackDash\/(?:issues|pull)\//;
    for (const doc of listDocs()) {
      const found = doc.source.split("\n").filter((line) => issueReference.test(line));
      expect(found, doc.href).toEqual([]);
    }
  });

  it("leads with getting started and the guides, then providers, operations, and architecture", () => {
    const groups = groupDocs(listDocs());
    expect(groups.slice(0, 4).map((group) => group.label)).toEqual([
      "Using StackDash",
      "Providers",
      "Self-hosting and operations",
      "Architecture",
    ]);
    expect(groups[0]?.docs.map((doc) => doc.href)).toEqual(["/docs/getting-started", "/docs/api", "/docs/mcp"]);
    expect(listDocs()[0]?.href).toBe("/docs/getting-started");
    expect(groups.flatMap((group) => group.docs)).toHaveLength(listDocs().length);
  });

  // GitHub token prefixes, the shapes secret scanners flag. Samples use placeholders such as `<token>`.
  it("holds no GitHub token-shaped string in any file under docs/, published or not", () => {
    const tokenShape = /gh[pousr]_|github_pat_/;
    for (const file of fs.readdirSync(docsDir, { recursive: true, encoding: "utf8" })) {
      const fullPath = path.join(docsDir, file);
      if (!fs.statSync(fullPath).isFile()) continue;
      const found = fs
        .readFileSync(fullPath, "utf8")
        .split("\n")
        .filter((line) => tokenShape.test(line));
      expect(found, file).toEqual([]);
    }
  });
});

describe("docGroup", () => {
  it.each<[string, string[], string]>([
    ["a listed guide", ["getting-started"], "guides"],
    ["the last listed guide", ["mcp"], "guides"],
    ["a top-level page that is not a guide", ["adapters"], "developers"],
    ["a page in a folder", ["providers", "vercel"], "providers"],
    ["a page in a folder named like a guide", ["api", "keys"], "api"],
    ["a page in a nested folder", ["architecture", "notes", "x"], "architecture"],
  ])("puts %s in its group", (_case, slug, expected) => {
    expect(docGroup(slug)).toBe(expected);
  });

  it("labels the known groups and a new folder from its name", () => {
    const vercel = getDoc(["providers", "vercel"]);
    if (vercel === null) throw new Error("docs/providers/vercel.md is missing");
    const pages = ["developers", "release-notes"].map((group) => ({ ...vercel, group }));
    expect(groupDocs(pages).map((group) => group.label)).toEqual(["Developers", "Release notes"]);
  });
});
