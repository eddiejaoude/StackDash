export const REDACTED = "[redacted]";
export const MAX_REDACT_DEPTH = 8;
export const MAX_REDACT_ARRAY_LENGTH = 100;

// Keys are compared after lowercasing and dropping "_" and "-", so
// `access_token`, `accessToken` and `Access-Token` all normalize alike.
const SECRET_KEYS_EXACT: Readonly<Record<string, true>> = { key: true, pwd: true };

// Suffix matching catches compound names such as `stripeSecretKey`,
// `x-api-key`, `set-cookie` or `webhookSecret` without listing each one.
const SECRET_KEY_SUFFIXES: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "secretkey",
  "privatekey",
  "ciphertext",
  "credential",
  "credentials",
  "cookie",
  "authorization",
];

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  if (SECRET_KEYS_EXACT[normalized] === true) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

type StringRule = {
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
};

const fullMask = (): string => REDACTED;

// Order matters: specific prefixed formats run first so the generic blob rule
// only sees what is left.
const STRING_RULES: readonly StringRule[] = [
  // Userinfo password in URLs such as postgres://user:pass@host.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi,
    replace: (_match, prefix = "") => `${prefix}${REDACTED}@`,
  },
  // Discord and Slack incoming webhook URLs (#153): the path is the credential, so everything
  // after the fixed prefix goes.
  {
    pattern: /\b(https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/)[^\s"'<>]+/gi,
    replace: (_match, prefix = "") => `${prefix}${REDACTED}`,
  },
  {
    pattern: /\b(https?:\/\/hooks\.slack\.com\/)[^\s"'<>]+/gi,
    replace: (_match, prefix = "") => `${prefix}${REDACTED}`,
  },
  // Credential-bearing query string and form parameters.
  {
    pattern:
      /([?&;](?:access_token|refresh_token|id_token|token|key|api_key|apikey|client_secret|secret|password|code|signature|sig)=)[^&#\s"']+/gi,
    replace: (_match, prefix = "") => `${prefix}${REDACTED}`,
  },
  {
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replace: (_match, scheme = "") => `${scheme} ${REDACTED}`,
  },
  // JWT: base64url JSON header (always starts "eyJ") plus payload and signature.
  {
    pattern: /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    replace: fullMask,
  },
  // Stripe secret, restricted and webhook signing keys.
  {
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|\bwhsec_[A-Za-z0-9]+/g,
    replace: fullMask,
  },
  // GitHub personal, OAuth, user-to-server, server-to-server and refresh tokens.
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}/g,
    replace: fullMask,
  },
  // Resend API keys.
  {
    pattern: /\bre_[A-Za-z0-9_]{16,}/g,
    replace: fullMask,
  },
  // Vercel prefixed tokens (vcp_, vci_, vca_, vcr_, vck_).
  {
    pattern: /\bvc[a-z]_[A-Za-z0-9]{16,}/g,
    replace: fullMask,
  },
  // StackDash API keys (#162): sd_ plus 43 base64url characters. The 8 character display prefix
  // shown in settings is too short to match and stays readable.
  {
    pattern: /\bsd_[A-Za-z0-9_-]{20,}/g,
    replace: fullMask,
  },
  // Supabase personal access tokens and secret API keys.
  {
    pattern: /\bsbp_[A-Za-z0-9]{16,}|\bsb_secret_[A-Za-z0-9_-]{8,}/g,
    replace: fullMask,
  },
  // Polar access, refresh, organization, and personal tokens and client secrets (polar_at_,
  // polar_rt_, polar_oat_, polar_pat_, polar_cs_).
  {
    pattern: /\bpolar_[a-z]{2,3}_[A-Za-z0-9]{16,}/g,
    replace: fullMask,
  },
  // Long hex blobs (hashes, encryption keys, legacy tokens).
  {
    pattern: /\b[0-9a-fA-F]{32,}\b/g,
    replace: fullMask,
  },
  // Long base64 or base64url blobs, including unprefixed legacy Vercel tokens.
  // Only mixed case plus digits counts so slugs, event names and UUIDs survive.
  {
    pattern: /[A-Za-z0-9+_-]{24,}={0,2}/g,
    replace: (match) => (looksLikeRandomBlob(match) ? REDACTED : match),
  },
];

function looksLikeRandomBlob(candidate: string): boolean {
  if (!/[a-z]/.test(candidate) || !/[A-Z]/.test(candidate) || !/[0-9]/.test(candidate)) {
    return false;
  }
  // Random blobs have long uninterrupted alphanumeric runs; identifiers such as
  // `my-Project-2024-production-Build` are broken up by separators.
  const longestRun = candidate
    .split(/[^A-Za-z0-9]/)
    .reduce((longest, part) => Math.max(longest, part.length), 0);
  return longestRun >= 20;
}

export function redactString(input: string): string {
  let output = input;
  for (const rule of STRING_RULES) {
    output = output.replace(rule.pattern, rule.replace);
  }
  return output;
}

function redactEntries(
  entries: Iterable<readonly [string, unknown]>,
  depth: number,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    output[key] = isSecretKey(key) ? REDACTED : redactValue(entryValue, depth + 1, ancestors);
  }
  return output;
}

function redactError(error: Error, depth: number, ancestors: WeakSet<object>): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: redactString(error.name),
    message: redactString(error.message),
  };
  if (error.stack !== undefined) output.stack = redactString(error.stack);
  if (error.cause !== undefined) output.cause = redactValue(error.cause, depth + 1, ancestors);
  // Provider errors often carry `status` or `code` as own properties; keep them
  // for diagnosis, redacted like any other object field.
  const extra: [string, unknown][] = Object.entries(error);
  for (const [key, entryValue] of extra) {
    if (key in output) continue;
    output[key] = isSecretKey(key) ? REDACTED : redactValue(entryValue, depth + 1, ancestors);
  }
  return output;
}

function redactObject(value: object, depth: number, ancestors: WeakSet<object>): unknown {
  if (value instanceof Error) return redactError(value, depth, ancestors);

  if (Array.isArray(value)) {
    const items: unknown[] = value;
    const kept = items
      .slice(0, MAX_REDACT_ARRAY_LENGTH)
      .map((item) => redactValue(item, depth + 1, ancestors));
    if (items.length > MAX_REDACT_ARRAY_LENGTH) {
      kept.push(`[truncated ${items.length - MAX_REDACT_ARRAY_LENGTH} items]`);
    }
    return kept;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[invalid date]" : value.toISOString();
  }
  if (value instanceof URL) return redactString(value.href);
  if (value instanceof RegExp) return redactString(value.toString());
  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;

  // Header bags carry Authorization and Cookie; keep their entries visible to
  // the key rules instead of dropping or dumping them.
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    return redactEntries(value.entries(), depth, ancestors);
  }
  if (value instanceof Map) {
    const entries: [string, unknown][] = [];
    for (const [mapKey, mapValue] of value) entries.push([String(mapKey), mapValue]);
    return redactEntries(entries, depth, ancestors);
  }
  if (value instanceof Set) {
    const items: unknown[] = Array.from(value);
    return redactObject(items, depth, ancestors);
  }

  const entries: [string, unknown][] = Object.entries(value);
  const output = redactEntries(entries, depth, ancestors);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    const constructorName: unknown = value.constructor?.name;
    if (typeof constructorName === "string" && constructorName !== "") {
      output["[type]"] = constructorName;
    }
  }
  return output;
}

function redactValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  switch (typeof value) {
    case "string":
      return redactString(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
    case "undefined":
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
      return value.toString();
    case "function":
      return "[function]";
    case "object":
      break;
  }
  if (value === null || typeof value !== "object") return null;
  if (depth >= MAX_REDACT_DEPTH) return "[depth limit]";
  if (ancestors.has(value)) return "[circular]";

  ancestors.add(value);
  try {
    return redactObject(value, depth, ancestors);
  } finally {
    // Only ancestors count as cycles; the same object referenced twice in
    // sibling positions is rendered both times.
    ancestors.delete(value);
  }
}

/**
 * Returns a JSON-safe deep copy of `value` with secret-named fields replaced
 * and credential-shaped substrings masked. Never mutates the input.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}

/** Same as `redact` for a field bag, keeping the record type for callers that spread it. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const entries: [string, unknown][] = Object.entries(fields);
  return redactEntries(entries, 0, new WeakSet<object>([fields]));
}
