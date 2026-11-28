import { MESSAGE_MAX_CHARS, SUBJECT_MAX_CHARS } from "./limits";

/*
 * Message text as support chat (#680) stores it. Plain text, rendered as text with its line breaks,
 * never as HTML. Lengths count code points, as Postgres char_length does, so an emoji counts once
 * here and in support_messages_body_format.
 */

// Control characters other than tab and line feed: Postgres refuses NUL in text, and the rest have
// no business in a message. Carriage returns are folded into line feeds first.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export type BodyCheck =
  | Readonly<{ ok: true; body: string }>
  | Readonly<{ ok: false; reason: "empty" | "too_long" }>;

/** The body to store: line endings normalized, control characters dropped, outer whitespace trimmed. */
export function normalizeBody(raw: string): BodyCheck {
  const body = raw.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
  if (body === "") return { ok: false, reason: "empty" };
  if (codePoints(body) > MESSAGE_MAX_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, body };
}

/**
 * A thread's subject: the first line of its first message with its whitespace collapsed, cut to
 * SUBJECT_MAX_CHARS with an ellipsis. Always one line, because it becomes an email subject header.
 */
export function supportSubject(body: string): string {
  const firstLine = body.split("\n").find((line) => line.trim() !== "") ?? body;
  const line = firstLine.replace(/\s+/g, " ").trim();
  const characters = [...line];
  if (characters.length <= SUBJECT_MAX_CHARS) return line;
  return `${characters.slice(0, SUBJECT_MAX_CHARS).join("").trimEnd()}…`;
}

/** Code points in `text`: a surrogate pair is one, as Postgres char_length counts. */
export function codePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}
