import "server-only";

import { FAKE_PROVIDER_ENABLE_ENV } from "@/lib/adapters/fake";
import { isFakeProviderEnabled, liveProviderSetup } from "@/lib/adapters/registry";
import { isProviderSimulationEnabled, SIMULATE_PROVIDERS_ENV } from "@/lib/adapters/simulated";
import type { LiveProviderId } from "@/lib/adapters/types";
import { currentKeyId } from "@/lib/crypto/credentials";
import { clientIpEnv, emailEnv, publicEnv, serverEnv, superAdminEmails } from "@/lib/env";
import { formatList } from "@/lib/format";
import { CRON_SECRET_MIN_LENGTH } from "@/lib/jobs/runner";
import { urlPolicyFromEnv } from "@/lib/notifications/channels";
import { PROVIDER_NAMES } from "@/lib/providers";

/*
 * What this instance is configured for (#250), as the super admin page shows it. Every check asks
 * the code that uses the setting (the env accessors, the registry, the keyring, the cron check)
 * rather than parsing the variable again, so the page cannot disagree with the behavior. Values are
 * never returned, only whether each is set and what that means; error messages from those accessors
 * name the variable and never its value.
 */

/** `ok`: works as intended. `info`: optional and off, or on and expected. `attention`: act on it. */
export type CheckStatus = "ok" | "info" | "attention";

export type ConfigCheck = Readonly<{
  name: string;
  variables: readonly string[];
  status: CheckStatus;
  // Short state shown in the badge: "Set", "Not set", "Invalid", "On".
  summary: string;
  detail: string;
}>;

export type ConfigGroup = Readonly<{ title: string; checks: readonly ConfigCheck[] }>;

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The setting could not be read.";
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function supabaseCheck(): ConfigCheck {
  const variables = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  try {
    publicEnv();
    serverEnv();
    return { name: "Supabase", variables, status: "ok", summary: "Set", detail: "Database, sign-in, and realtime." };
  } catch (error) {
    return { name: "Supabase", variables, status: "attention", summary: "Invalid", detail: messageOf(error) };
  }
}

function siteUrlCheck(): ConfigCheck {
  const base = { name: "Public address", variables: ["NEXT_PUBLIC_SITE_URL"] };
  const value = process.env.NEXT_PUBLIC_SITE_URL;
  if (value === undefined || value.trim() === "") {
    return isProduction()
      ? {
          ...base,
          status: "attention",
          summary: "Not set",
          detail: "Alert emails and channel messages are not sent without it, and links fall back to the address each request used.",
        }
      : { ...base, status: "info", summary: "Not set", detail: "Links point at http://localhost:3000, which is fine locally." };
  }
  return URL.canParse(value.trim())
    ? { ...base, status: "ok", summary: "Set", detail: "Used for links in emails, page metadata, and provider callbacks." }
    : { ...base, status: "attention", summary: "Invalid", detail: "Set the full origin, such as https://stackdash.example.com." };
}

// An invalid list never reaches this check: requireSuperAdmin() fails first and the page shows its
// error boundary instead.
function superAdminCheck(): ConfigCheck {
  const count = superAdminEmails().size;
  return {
    name: "Super admins",
    variables: ["STACKDASH_SUPER_ADMIN_EMAILS"],
    status: "ok",
    summary: `${count} ${count === 1 ? "address" : "addresses"}`,
    detail: "Who can open this page.",
  };
}

function encryptionKeyCheck(): ConfigCheck {
  const base = { name: "Encryption key", variables: ["STACKDASH_ENCRYPTION_KEY"] };
  if (isBlank(process.env.STACKDASH_ENCRYPTION_KEY)) {
    return {
      ...base,
      status: "attention",
      summary: "Not set",
      detail: "Connecting a provider, syncing, and alert channels fail until it is set.",
    };
  }
  try {
    currentKeyId();
    return { ...base, status: "ok", summary: "Set", detail: "Encrypts stored provider credentials and channel secrets." };
  } catch (error) {
    return { ...base, status: "attention", summary: "Invalid", detail: messageOf(error) };
  }
}

function previousKeysCheck(): ConfigCheck {
  const base = { name: "Previous encryption keys", variables: ["STACKDASH_ENCRYPTION_KEYS_PREVIOUS"] };
  return isBlank(process.env.STACKDASH_ENCRYPTION_KEYS_PREVIOUS)
    ? { ...base, status: "info", summary: "Not set", detail: "No key rotation in progress." }
    : {
        ...base,
        status: "attention",
        summary: "Set",
        detail: "A key rotation is in progress. Run npm run keys:rotate, then remove the previous keys.",
      };
}

function cronSecretCheck(): ConfigCheck {
  const base = { name: "Scheduler secret", variables: ["CRON_SECRET"] };
  const secret = process.env.CRON_SECRET;
  if (secret === undefined || secret.trim() === "") {
    return { ...base, status: "attention", summary: "Not set", detail: "The scheduler cannot run background jobs: every tick is refused." };
  }
  if (secret.length < CRON_SECRET_MIN_LENGTH) {
    return {
      ...base,
      status: "attention",
      summary: "Invalid",
      detail: `Shorter than ${CRON_SECRET_MIN_LENGTH} characters, so every tick is refused. Generate one with openssl rand -hex 32.`,
    };
  }
  return { ...base, status: "ok", summary: "Set", detail: "The scheduler can run background jobs." };
}

function alertEmailCheck(): ConfigCheck {
  const base = { name: "Alert email", variables: ["STACKDASH_RESEND_API_KEY", "STACKDASH_EMAIL_FROM", "STACKDASH_RESEND_API_URL"] };
  try {
    return emailEnv() === null
      ? { ...base, status: "info", summary: "Not set", detail: "Alerts still show in the app and reach channels, but no email is sent." }
      : { ...base, status: "ok", summary: "Set", detail: "Alert and digest emails are sent through Resend." };
  } catch (error) {
    return { ...base, status: "attention", summary: "Invalid", detail: messageOf(error) };
  }
}

export type ProviderSetup = Readonly<{ provider: LiveProviderId; check: ConfigCheck }>;

/** Whether each live provider's OAuth app is registered here, in catalog order. */
export function providerSetup(): ProviderSetup[] {
  const simulated = isProviderSimulationEnabled();
  return liveProviderSetup().map(({ provider, missing }): ProviderSetup => {
    const name = PROVIDER_NAMES[provider];
    if (missing.length === 0) {
      return {
        provider,
        check: {
          name,
          variables: [],
          status: "ok",
          summary: "Set",
          detail: simulated ? "OAuth app registered. Simulated while simulation is on." : "OAuth app registered.",
        },
      };
    }
    return {
      provider,
      check: {
        name,
        variables: missing,
        status: "info",
        summary: "Not set",
        detail: simulated
          ? `Simulated on this instance. The real app needs ${formatList(missing)}.`
          : `Shown as not set up on this instance. Needs ${formatList(missing)}.`,
      },
    };
  });
}

function trustedProxyCheck(): ConfigCheck {
  const base = { name: "Trusted proxies", variables: ["STACKDASH_TRUSTED_PROXY_COUNT"] };
  try {
    const { header, trustedProxies } = clientIpEnv();
    if (header === "x-vercel-forwarded-for") {
      return { ...base, status: "info", summary: "Not used", detail: "On Vercel the client address comes from Vercel's own header." };
    }
    return isBlank(process.env.STACKDASH_TRUSTED_PROXY_COUNT)
      ? { ...base, status: "info", summary: "Not set", detail: "One proxy in front of the app is assumed for the public rate limit." }
      : { ...base, status: "ok", summary: "Set", detail: `${trustedProxies} ${trustedProxies === 1 ? "proxy" : "proxies"} in front of the app.` };
  } catch (error) {
    return { ...base, status: "attention", summary: "Invalid", detail: messageOf(error) };
  }
}

function privateWebhooksCheck(): ConfigCheck {
  const base = { name: "Private network webhooks", variables: ["STACKDASH_ALLOW_PRIVATE_WEBHOOKS"] };
  if (!urlPolicyFromEnv().allowPrivate) {
    return { ...base, status: "ok", summary: "Off", detail: "Webhook channels post to public https addresses only." };
  }
  return isProduction()
    ? {
        ...base,
        status: "attention",
        summary: "On",
        detail: "Webhook channels may post to plain http and private addresses. Only for a self-hosted instance whose receivers live on its own network.",
      }
    : { ...base, status: "info", summary: "Allowed", detail: "Development builds always allow them." };
}

function simulationCheck(): ConfigCheck {
  const base = { name: "Simulated providers", variables: [SIMULATE_PROVIDERS_ENV] };
  // Read directly, not through isProviderSimulationEnabled(): that is false both when the flag is
  // off and when Vercel production refuses it, and only the second needs attention.
  if (process.env[SIMULATE_PROVIDERS_ENV] !== "1") {
    return { ...base, status: "ok", summary: "Off", detail: "Connections use the real providers." };
  }
  if (!isProviderSimulationEnabled()) {
    return { ...base, status: "attention", summary: "Refused", detail: "Set, but refused on a Vercel production deployment. Remove it." };
  }
  return isProduction()
    ? { ...base, status: "attention", summary: "On", detail: "New connections get made-up data. Never set it in production." }
    : { ...base, status: "info", summary: "On", detail: "New connections get made-up data, for local demos and tests." };
}

function fakeProviderCheck(): ConfigCheck {
  const base = { name: "Example provider", variables: [FAKE_PROVIDER_ENABLE_ENV] };
  if (!isFakeProviderEnabled()) {
    return { ...base, status: "ok", summary: "Off", detail: "Not offered in the catalog." };
  }
  return isProduction()
    ? { ...base, status: "attention", summary: "On", detail: "The test-only example provider is offered to everyone. Never set it in production." }
    : { ...base, status: "info", summary: "On", detail: "The test-only example provider is offered in the catalog." };
}

/** Every instance-wide check except the providers' (`providerSetup`), grouped as the page shows them. */
export function instanceConfiguration(): ConfigGroup[] {
  return [
    { title: "Core", checks: [supabaseCheck(), siteUrlCheck(), superAdminCheck()] },
    { title: "Secrets and background jobs", checks: [encryptionKeyCheck(), previousKeysCheck(), cronSecretCheck()] },
    { title: "Alert email", checks: [alertEmailCheck()] },
    { title: "Network", checks: [trustedProxyCheck(), privateWebhooksCheck()] },
    { title: "Development settings", checks: [simulationCheck(), fakeProviderCheck()] },
  ];
}
