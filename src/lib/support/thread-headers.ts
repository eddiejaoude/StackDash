/*
 * RFC 5322 threading headers for support chat email (#680), per recipient. Each email about a
 * conversation answers the last one that same recipient received (In-Reply-To) and lists the ones
 * before it (References), so the conversation stays one thread in each recipient's mail client:
 * the user's, and every operator's, whose copies all carry different Message-IDs. Pure, so the edges
 * are unit tested (BackTalk src/lib/feedback/thread-headers.ts at 274976f^1).
 */

/** How many ids References carries, so a long conversation never grows an unbounded header. */
export const REFERENCE_LIMIT = 20;

// Inside the brackets a msg-id has no whitespace and no bracket (RFC 5322, section 3.6.4).
const NOT_IN_MSG_ID = /[\s<>]/;

/**
 * One id in the `<...>` form the headers need, or null when it cannot be one. Ids come from a
 * provider response, so a missing bracket is repaired, but an id with whitespace inside is dropped
 * rather than sent: a malformed In-Reply-To makes clients ignore the whole chain.
 */
export function normalizeMessageId(raw: string): string | null {
  const trimmed = raw.trim();
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  if (inner === "" || NOT_IN_MSG_ID.test(inner) || !inner.includes("@")) return null;
  return `<${inner}>`;
}

export type ThreadHeaders = Readonly<{
  /** In-Reply-To and References, or nothing for the first email to this recipient. */
  headers: Readonly<Record<string, string>>;
  /** True when this recipient already received email about the conversation. */
  isReply: boolean;
}>;

/**
 * The headers for the next email to one recipient, from the Message-IDs of the email that recipient
 * already received about the conversation, oldest first, at most REFERENCE_LIMIT of them. `root`
 * is the first one they received: when the list is at its limit, the oldest id held is probably not
 * the first, and the root is the id clients identify the conversation by, so it leads References.
 */
export function buildThreadHeaders(previous: readonly string[], root: string | null = null): ThreadHeaders {
  if (previous.length === 0) return { headers: {}, isReply: false };
  const ids = previous.map(normalizeMessageId).filter((id): id is string => id !== null);
  // The recipient has mail about this conversation, so the subject still says "Re:" even when no id
  // survived: subject grouping is then the only chain left.
  const newest = ids.at(-1);
  if (newest === undefined) return { headers: {}, isReply: true };
  const rootId = root === null ? null : normalizeMessageId(root);
  const atLimit = previous.length >= REFERENCE_LIMIT;
  const references = atLimit && rootId !== null && !ids.includes(rootId) ? [rootId, ...ids.slice(1)] : ids;
  return { headers: { "In-Reply-To": newest, References: references.join(" ") }, isReply: true };
}

/** The subject for one recipient: "Re: " in front once they have email about the conversation. */
export function threadSubject(subject: string, isReply: boolean): string {
  const line = subject.replace(/\s+/g, " ").trim();
  return isReply && !/^re:/i.test(line) ? `Re: ${line}` : line;
}
