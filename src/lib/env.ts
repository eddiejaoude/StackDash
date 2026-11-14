import { z } from "zod";

// Accessors are functions rather than module-level constants so that importing this module never
// reads the environment: `next build` prerenders static pages without any Supabase variables set.

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
});

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

// Only presence is checked here; the key format (base64 of exactly 32 bytes, `keyId:base64` pairs)
// is validated in `src/lib/crypto/credentials.ts`, which owns the keyring and its error messages.
const encryptionEnvSchema = z.object({
  STACKDASH_ENCRYPTION_KEY: z.string().min(1),
  STACKDASH_ENCRYPTION_KEYS_PREVIOUS: z.string().min(1).optional(),
});

/**
 * True for an http(s) URL whose host is this computer: `localhost`, any 127.x.x.x address, or
 * `[::1]`. The WHATWG parser has already normalized the host (`127.1` is `127.0.0.1`, user info
 * is split off), so a name that only starts with a loopback address is refused.
 */
export function isLoopbackUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Resend's own API origin, where alert email goes unless STACKDASH_RESEND_API_URL names another. */
export const RESEND_API_URL = "https://api.resend.com";

// Alert email (#152) goes through Resend's API (#244). Without STACKDASH_RESEND_API_KEY email is not
// set up on this instance; alerts still reach the app and the channels. STACKDASH_RESEND_API_URL
// points the client at another server that answers like Resend, such as the local fake
// (`npm run email:fake`). Plain http only to this computer, so the key never crosses a network in
// the clear. An origin only: the client appends `/emails` itself. Messages never echo the value.
const emailEnvSchema = z.object({
  STACKDASH_EMAIL_FROM: z.string().trim().min(3),
  STACKDASH_RESEND_API_KEY: z.string().min(1),
  STACKDASH_RESEND_API_URL: z
    .url({ protocol: /^https?$/, error: "use an https URL" })
    // Each check passes text that is not a URL, which the check above already reports.
    .refine((value) => !URL.canParse(value) || new URL(value).protocol === "https:" || isLoopbackUrl(value), {
      error: "use https, or plain http only to this computer (localhost, 127.0.0.1, or [::1])",
    })
    .refine(
      (value) => {
        if (!URL.canParse(value)) return true;
        const url = new URL(value);
        return url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
      },
      { error: "use the scheme, host, and port only, with no path, query, or user name" },
    )
    .transform((value) => new URL(value).origin)
    .default(RESEND_API_URL),
});

// Where the public routes' per IP rate limit (#149) finds the client: on Vercel (`onVercel`), its
// own header. Elsewhere STACKDASH_TRUSTED_PROXY_COUNT is how many proxies in front of the app append
// to x-forwarded-for; one when unset.
const clientIpEnvSchema = z.object({
  STACKDASH_TRUSTED_PROXY_COUNT: z
    .string()
    .regex(/^[1-9]$/, "use a whole number from 1 to 9: the proxies in front of the app that append to x-forwarded-for")
    .optional(),
});

// Who runs this instance (#339): the privacy policy and terms of use name them, and the pages and
// their links exist only when all three are set, so a self-hosted instance never names another
// operator. Not secret. The landing page and the legal pages are prerendered, so they take the
// values `next build` saw: set them before building and deploy again after changing one.
const operatorEnvSchema = z.object({
  STACKDASH_OPERATOR_NAME: z.string().trim().min(1).max(200),
  STACKDASH_OPERATOR_EMAIL: z.email({ error: "use one email address, such as privacy@your-domain" }),
  STACKDASH_GOVERNING_LAW: z.string().trim().min(1).max(200),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type EncryptionEnv = z.infer<typeof encryptionEnvSchema>;
export type EmailEnv = Readonly<{ from: string; apiKey: string; apiUrl: string }>;
export type ClientIpEnv = Readonly<{ header: "x-vercel-forwarded-for" | "x-forwarded-for"; trustedProxies: number }>;
export type OperatorEnv = Readonly<{ name: string; email: string; governingLaw: string }>;

function parseEnv<Schema extends z.ZodType>(
  schema: Schema,
  input: Record<string, string | undefined>,
): z.infer<Schema> {
  // Empty strings come from blank lines in .env files; treat them as missing, not as values.
  const present = Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "",
    ),
  );
  const result = schema.safeParse(present);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = issue.path.map(String).join(".");
    return name in present ? `${name} is invalid: ${issue.message}` : `${name} is not set`;
  });
  throw new Error(
    `Environment configuration error: ${problems.join("; ")}. See .env.example for where each value comes from.`,
    { cause: result.error },
  );
}

/**
 * Public Supabase settings, safe to expose to the browser.
 *
 * Each variable is read with a literal `process.env.NEXT_PUBLIC_*` expression because Next.js only
 * inlines public variables into client bundles when referenced that way.
 */
export function publicEnv(): PublicEnv {
  return parseEnv(publicEnvSchema, {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

/**
 * Secret server settings. Callers must be server-only modules (see `src/lib/supabase/admin.ts`);
 * the browser guard is a second line of defense in case one is imported into client code.
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() was called in the browser. Secret variables are server only.");
  }
  return parseEnv(serverEnvSchema, {
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
}

/**
 * Credential encryption keys. Separate from `serverEnv()` so that code which only needs the
 * service role (most of the server) does not fail when the encryption key is absent; only the
 * credential paths require it.
 */
export function encryptionEnv(): EncryptionEnv {
  if (typeof window !== "undefined") {
    throw new Error("encryptionEnv() was called in the browser. Secret variables are server only.");
  }
  return parseEnv(encryptionEnvSchema, {
    STACKDASH_ENCRYPTION_KEY: process.env.STACKDASH_ENCRYPTION_KEY,
    STACKDASH_ENCRYPTION_KEYS_PREVIOUS: process.env.STACKDASH_ENCRYPTION_KEYS_PREVIOUS,
  });
}

/**
 * The alert email settings, or null when neither STACKDASH_RESEND_API_KEY nor STACKDASH_RESEND_API_URL
 * is set. A key without STACKDASH_EMAIL_FROM, or a URL without a key, is a configuration error
 * rather than a silent "off".
 */
export function emailEnv(): EmailEnv | null {
  if (typeof window !== "undefined") {
    throw new Error("emailEnv() was called in the browser. Secret variables are server only.");
  }
  const input = {
    STACKDASH_EMAIL_FROM: process.env.STACKDASH_EMAIL_FROM,
    STACKDASH_RESEND_API_KEY: process.env.STACKDASH_RESEND_API_KEY,
    STACKDASH_RESEND_API_URL: process.env.STACKDASH_RESEND_API_URL,
  };
  if (!input.STACKDASH_RESEND_API_KEY && !input.STACKDASH_RESEND_API_URL) return null;
  const env = parseEnv(emailEnvSchema, input);
  return { from: env.STACKDASH_EMAIL_FROM, apiKey: env.STACKDASH_RESEND_API_KEY, apiUrl: env.STACKDASH_RESEND_API_URL };
}

/**
 * Whether this deployment runs on Vercel. VERCEL=1 is Vercel's system environment variable, set at
 * both build and run time (https://vercel.com/docs/environment-variables/system-environment-variables),
 * so a prerendered page reads it as reliably as a request does.
 */
export function onVercel(): boolean {
  return process.env.VERCEL === "1";
}

/**
 * Which request header holds the client IP and how many proxies appended to it. On Vercel,
 * `x-vercel-forwarded-for`, which Vercel sets to the client it saw and a proxy in front of Vercel
 * cannot overwrite (https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for).
 * Self-hosted, `x-forwarded-for` with STACKDASH_TRUSTED_PROXY_COUNT proxies appending to it.
 */
export function clientIpEnv(): ClientIpEnv {
  const env = parseEnv(clientIpEnvSchema, { STACKDASH_TRUSTED_PROXY_COUNT: process.env.STACKDASH_TRUSTED_PROXY_COUNT });
  if (onVercel()) return { header: "x-vercel-forwarded-for", trustedProxies: 1 };
  return { header: "x-forwarded-for", trustedProxies: Number(env.STACKDASH_TRUSTED_PROXY_COUNT ?? "1") };
}

const SUPER_ADMIN_EMAIL = z.email();

/**
 * The super admins of this instance (#250): STACKDASH_SUPER_ADMIN_EMAILS, comma separated, lowercased.
 * Empty when unset, so nobody is one by default. An entry that is not an email address is a
 * configuration error rather than skipped, so a typo fails loudly instead of quietly locking the
 * operator out. Messages name the entry's position, never the address.
 */
export function superAdminEmails(): ReadonlySet<string> {
  const raw = process.env.STACKDASH_SUPER_ADMIN_EMAILS;
  const emails = new Set<string>();
  if (raw === undefined) return emails;
  const entries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  for (const [index, entry] of entries.entries()) {
    if (!SUPER_ADMIN_EMAIL.safeParse(entry).success) {
      throw new Error(
        `Environment configuration error: STACKDASH_SUPER_ADMIN_EMAILS is invalid: entry ${index + 1} is not an email address. See .env.example for the format.`,
      );
    }
    emails.add(entry.toLowerCase());
  }
  return emails;
}

/**
 * The operator the privacy policy and terms of use name, or null when none of the three variables
 * is set: then /privacy and /terms answer 404 and nothing links to them. Setting only some of them
 * is a configuration error rather than a silent "off", so a half-configured instance fails loudly
 * instead of publishing a policy with no one to contact.
 */
export function operatorEnv(): OperatorEnv | null {
  const input = {
    STACKDASH_OPERATOR_NAME: process.env.STACKDASH_OPERATOR_NAME,
    STACKDASH_OPERATOR_EMAIL: process.env.STACKDASH_OPERATOR_EMAIL,
    STACKDASH_GOVERNING_LAW: process.env.STACKDASH_GOVERNING_LAW,
  };
  if (!input.STACKDASH_OPERATOR_NAME && !input.STACKDASH_OPERATOR_EMAIL && !input.STACKDASH_GOVERNING_LAW) return null;
  const env = parseEnv(operatorEnvSchema, input);
  return { name: env.STACKDASH_OPERATOR_NAME, email: env.STACKDASH_OPERATOR_EMAIL, governingLaw: env.STACKDASH_GOVERNING_LAW };
}
