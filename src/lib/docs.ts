import "server-only";

import fs from "node:fs";
import path from "node:path";
import { cache } from "react";

/**
 * Repository docs published on the website. Every Markdown file under `docs/` becomes a page at
 * `/docs/<folder>/<file>`, read with `fs` at build time (synchronous reads complete during the
 * prerender, so the pages stay fully static), except the files under `docs/internal/`.
 */
const DOCS_DIR = path.join(process.cwd(), "docs");
export const DOCS_ROUTE = "/docs";

// Runbooks for the people who operate the hosted instance. They stay in the repository and are
// never published: no /docs page, no entry in the docs list, no link target.
const INTERNAL_FOLDER = "internal";

// One URL segment per folder or file name. Anything else (`..`, `/`, `\`, `%`, uppercase, an empty
// segment) is refused before a path is ever built from it.
const SEGMENT = /^[a-z0-9-]+$/;

// The top-level pages written for people using StackDash, in reading order. They lead the index.
// Any other top-level page is for people working on StackDash's code and is listed under
// Developers.
const GUIDE_PAGES = ["getting-started", "connect-providers", "api", "mcp", "roadmap"];
const GUIDES_GROUP = "guides";
const DEVELOPERS_GROUP = "developers";
const PROVIDERS_GROUP = "providers";

// Index order and label of each group. A folder under docs/ that is not listed here still
// publishes, after these, labeled from its name.
const GROUPS: readonly { id: string; label: string }[] = [
  { id: GUIDES_GROUP, label: "Using StackDash" },
  { id: PROVIDERS_GROUP, label: "Providers" },
  { id: "operations", label: "Self-hosting and operations" },
  { id: "architecture", label: "Architecture" },
  { id: DEVELOPERS_GROUP, label: "Developers" },
];

/**
 * How far a provider page's claims have been checked, from its `Verification:` lead sentence:
 * against the provider's documentation only, or with a real account.
 */
export type DocVerification = "documentation" | "real-account";

// The words a provider page's lead line uses for each status. Anything else fails the build.
const VERIFICATION_PHRASES: Readonly<Record<string, DocVerification>> = {
  "documentation only": "documentation",
  "tested with a real account": "real-account",
};
const VERIFICATION_SENTENCE = /(?:^|\s)Verification: ([^.]+)\./;

export interface DocPage {
  /** URL segments under /docs, the file path without `.md`. */
  slug: readonly string[];
  href: string;
  /** Folder under docs/; a file at the top level is in "guides" or "developers" (GUIDE_PAGES). */
  group: string;
  /** Plain text of the first heading. */
  title: string;
  /** Plain text of the first prose paragraph, for the index and the page description. */
  description: string;
  /** Provider pages only: how far the page's claims have been checked. */
  verification: DocVerification | null;
  source: string;
}

export interface DocGroup {
  id: string;
  label: string;
  docs: readonly DocPage[];
}

/** True when every segment is lowercase letters, digits, or hyphens: the only shape a doc has. */
export function isDocSlug(slug: readonly string[]): boolean {
  return slug.length > 0 && slug.every((segment) => SEGMENT.test(segment));
}

export function docHref(slug: readonly string[]): string {
  return `${DOCS_ROUTE}/${slug.join("/")}`;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Lines outside fenced code blocks, so a `# comment` in a shell sample is never a heading. */
function proseLines(source: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      // The fence line itself ends any paragraph in progress.
      lines.push("");
      continue;
    }
    lines.push(fence === null ? line : "");
  }
  return lines;
}

/** Inline Markdown to plain text: link text kept, code and emphasis markers dropped. */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Lead sentences that only carry tracking details for the repository (provider id, verification
// status, the date the research was checked). They say nothing about the page, so the description
// skips them.
const TRACKING_SENTENCE = /^(?:Provider id|Verification|Docs checked)\b[\s\S]*?\.(?:\s+|$)/;

// Lines that start a block other than a paragraph: heading, list, table, quote, HTML, rule.
const NON_PARAGRAPH = /^\s*(?:#|[-*+]\s|\d+[.)]\s|\||>|<|-{3,}|\*{3,}|_{3,})/;

function parseTitle(lines: readonly string[]): string | null {
  for (const line of lines) {
    const match = /^ {0,3}#\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (match?.[1]) return toPlainText(match[1]);
  }
  return null;
}

/** Prose paragraphs in order, each joined into one line. Headings, lists, tables, and quotes end one. */
function paragraphs(lines: readonly string[]): string[] {
  let paragraph: string[] = [];
  const found: string[] = [];
  for (const line of [...lines, ""]) {
    if (line.trim() === "" || NON_PARAGRAPH.test(line)) {
      if (paragraph.length > 0) found.push(paragraph.join(" "));
      paragraph = [];
      continue;
    }
    paragraph.push(line.trim());
  }
  return found;
}

function parseDescription(lines: readonly string[]): string {
  for (const candidate of paragraphs(lines)) {
    let text = candidate;
    for (let match = TRACKING_SENTENCE.exec(text); match; match = TRACKING_SENTENCE.exec(text)) {
      text = text.slice(match[0].length);
    }
    const plain = toPlainText(text);
    if (plain !== "") return plain;
  }
  return "";
}

/**
 * The status a provider page states in a `Verification: <phrase>.` sentence of its lead paragraph
 * (the first prose paragraph outside code), or null when the lead paragraph states none or a
 * phrase that is not one of `VERIFICATION_PHRASES`. A sentence further down never counts, so a
 * note in the body cannot change the badge.
 */
export function parseVerification(source: string): DocVerification | null {
  const lead = paragraphs(proseLines(source))[0];
  const phrase = lead === undefined ? undefined : VERIFICATION_SENTENCE.exec(lead)?.[1];
  if (phrase === undefined) return null;
  // `hasOwn`, so a phrase such as "constructor" never resolves to an Object prototype member.
  return Object.hasOwn(VERIFICATION_PHRASES, phrase) ? (VERIFICATION_PHRASES[phrase] ?? null) : null;
}

function requireVerification(relativeFile: string, source: string): DocVerification {
  const verification = parseVerification(source);
  if (verification !== null) return verification;
  const phrases = Object.keys(VERIFICATION_PHRASES).map((phrase) => `"Verification: ${phrase}."`);
  throw new Error(`docs/${relativeFile}: add one of ${phrases.join(" or ")} to the lead line`);
}

/**
 * The index group of the doc at this slug: its folder, or for a top-level page "guides" when
 * GUIDE_PAGES lists it and "developers" otherwise.
 */
export function docGroup(slug: readonly string[]): string {
  const [first = ""] = slug;
  if (slug.length > 1) return first;
  return GUIDE_PAGES.includes(first) ? GUIDES_GROUP : DEVELOPERS_GROUP;
}

function readDoc(relativeFile: string): DocPage {
  const slug = relativeFile.slice(0, -".md".length).split(path.sep);
  if (!isDocSlug(slug)) {
    throw new Error(
      `docs/${relativeFile}: rename it to lowercase letters, digits, and hyphens so it has a /docs URL`,
    );
  }
  const source = fs.readFileSync(path.join(DOCS_DIR, relativeFile), "utf8");
  const lines = proseLines(source);
  const title = parseTitle(lines);
  if (title === null) throw new Error(`docs/${relativeFile}: add a "# Title" heading, the page title comes from it`);

  const group = docGroup(slug);
  return {
    slug,
    href: docHref(slug),
    group,
    title,
    description: parseDescription(lines),
    verification: group === PROVIDERS_GROUP ? requireVerification(relativeFile, source) : null,
    source,
  };
}

function groupRank(group: string): number {
  const index = GROUPS.findIndex((known) => known.id === group);
  return index === -1 ? GROUPS.length : index;
}

/** Reading order inside a group: the guides as GUIDE_PAGES lists them, every other page by title. */
function guideRank(doc: DocPage): number {
  return doc.group === GUIDES_GROUP ? GUIDE_PAGES.indexOf(doc.slug[0] ?? "") : 0;
}

/** Every published doc, ordered by group (GROUPS first) and then by reading order or title. */
export const listDocs = cache((): readonly DocPage[] => {
  const files = fs
    .readdirSync(DOCS_DIR, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md") && file.split(path.sep)[0] !== INTERNAL_FOLDER);

  return files
    .map(readDoc)
    .sort(
      (a, b) =>
        groupRank(a.group) - groupRank(b.group) ||
        a.group.localeCompare(b.group) ||
        guideRank(a) - guideRank(b) ||
        a.title.localeCompare(b.title),
    );
});

/** The doc at this slug, or null for a slug of the wrong shape or one with no file behind it. */
export function getDoc(slug: readonly string[]): DocPage | null {
  if (!isDocSlug(slug)) return null;
  const href = docHref(slug);
  return listDocs().find((doc) => doc.href === href) ?? null;
}

function groupLabel(group: string): string {
  const known = GROUPS.find(({ id }) => id === group);
  if (known !== undefined) return known.label;
  const words = group.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function groupDocs(docs: readonly DocPage[]): DocGroup[] {
  const groups = new Map<string, DocPage[]>();
  for (const doc of docs) groups.set(doc.group, [...(groups.get(doc.group) ?? []), doc]);
  return [...groups].map(([id, members]) => ({ id, label: groupLabel(id), docs: members }));
}

/**
 * Heading ids that match GitHub's, so `file.md#section` links written for the repository land on
 * the same heading here: lowercase, punctuation dropped (hyphens and underscores kept), each space
 * a hyphen, and a repeated heading suffixed `-1`, `-2`. One slugger per document.
 */
export function createHeadingSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
      .replace(/ /g, "-");
    let slug = base;
    while (seen.has(slug)) {
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      slug = `${base}-${count}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

export type DocLink =
  /** Another published doc: `/docs/...`, with the fragment kept. */
  | { kind: "doc"; href: string }
  /** A heading on the same page. */
  | { kind: "fragment"; href: string }
  /** An http(s) URL off the site. */
  | { kind: "external"; href: string }
  | { kind: "email"; href: string }
  /** A file in the repository. The repository is private, so it renders as text, not a link. */
  | { kind: "repo"; path: string }
  /** Any other scheme, or nothing at all: rendered as plain text. */
  | { kind: "unsupported" };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Resolves a link written in `docs/<fromSlug>.md` the way GitHub would, relative to that file, then
 * maps it onto the website: a published doc becomes its /docs route, any other repository path is
 * reported as a path to show as text.
 */
export function resolveDocLink(fromSlug: readonly string[], href: string, docHrefs: ReadonlySet<string>): DocLink {
  const target = href.trim();
  if (target === "") return { kind: "unsupported" };
  if (target.startsWith("#")) return { kind: "fragment", href: target };
  if (target.startsWith("//")) return { kind: "external", href: `https:${target}` };

  const scheme = SCHEME.exec(target)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") return { kind: "external", href: target };
  if (scheme === "mailto") return { kind: "email", href: target };
  if (scheme !== undefined) return { kind: "unsupported" };

  const hashIndex = target.indexOf("#");
  const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
  const pathPart = (hashIndex === -1 ? target : target.slice(0, hashIndex)).split("?")[0] ?? "";

  // A leading slash is the repository root on GitHub; anything else is relative to this file.
  const repoPath = pathPart.startsWith("/")
    ? path.posix.normalize(pathPart.slice(1))
    : path.posix.join("docs", ...fromSlug.slice(0, -1), pathPart);
  const cleanPath = repoPath.replace(/\/+$/, "");

  const docMatch = /^docs\/(.+)\.md$/.exec(cleanPath);
  if (docMatch?.[1]) {
    const slug = docMatch[1].split("/");
    const route = docHref(slug);
    if (isDocSlug(slug) && docHrefs.has(route)) return { kind: "doc", href: `${route}${fragment}` };
  }
  return { kind: "repo", path: cleanPath };
}
