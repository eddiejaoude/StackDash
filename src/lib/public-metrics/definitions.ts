import type { LiveProviderId, ProviderId } from "@/lib/adapters/types";
import { PROVIDER_NAMES } from "@/lib/providers";
import { Constants, type Database } from "@/lib/supabase/database.types";

/*
 * The public metric engine's definition list (#148): every number a workspace may publish, with
 * its formula in words, its provenance, the stored data it is computed from, and the history it
 * needs. Badges, cards, public project pages, the weekly email, and the leaderboard all read
 * these, so a metric is defined once.
 *
 * The ids are the database enum `public_metric_id` (20261105023129_published_metrics.sql), so
 * `published_metrics` can only ever hold an id defined here. Spend, budgets, and alert thresholds
 * have no id and can never be published. Values come only from stored snapshots and events, never
 * from a provider call, and never include money, account names, or repository names.
 *
 * Client-safe: it imports no adapter code, data access, or Node module (adapter types only), so
 * client components can use these definitions and `display.ts`. Metric keys are therefore
 * literals; `definitions.test.ts` proves each one against what the adapters store.
 */

export type PublicMetricId = Database["public"]["Enums"]["public_metric_id"];
export type PublishedMetricRounding = Database["public"]["Enums"]["published_metric_rounding"];

export const PUBLIC_METRIC_IDS = Constants.public.Enums.public_metric_id;
export const PUBLISHED_METRIC_ROUNDINGS = Constants.public.Enums.published_metric_rounding;
/** Days a published value may lag behind (#150: "publish values 7 days late"). */
export const PUBLISHED_METRIC_DELAYS = [0, 7] as const;
export type PublishedMetricDelay = (typeof PUBLISHED_METRIC_DELAYS)[number];

/**
 * Verified: counted from what the provider reported. Estimated: calculated by StackDash. A
 * self-reported value is typed by a person, exists only on the project page, and is never an
 * engine metric, so it has no definition here.
 */
export type MetricProvenance = "verified" | "estimated";
export type PublishedProvenance = MetricProvenance | "self_reported";

export const PROVENANCE_LABELS: Record<PublishedProvenance, string> = {
  verified: "Verified",
  estimated: "Estimated",
  self_reported: "Self-reported",
};

export type MetricUnit =
  | "stars"
  | "deployments"
  | "signups"
  | "emails"
  | "percent"
  | "minutes"
  | "customers"
  | "payments";

/** Singular and plural nouns; percent has none and formats as "87%". */
export const UNIT_NOUNS: Record<Exclude<MetricUnit, "percent">, readonly [string, string]> = {
  stars: ["star", "stars"],
  deployments: ["deployment", "deployments"],
  signups: ["signup", "signups"],
  emails: ["email", "emails"],
  minutes: ["minute", "minutes"],
  customers: ["customer", "customers"],
  payments: ["payment", "payments"],
};

/**
 * Where a value comes from. Snapshot sources read quantity rows of `usage_snapshots` (never money
 * kinds); event sources read `activity_events`. The window, where one applies, is the
 * definition's `windowDays`, unless a private request such as the yearly card passes its own start
 * (`MetricRequest.from` in engine.ts).
 *
 * - `snapshot_total`: the sum, over the project's accounts, of each account's newest reading that
 *   is still current (inside its billing period or before its reset time) and fresh.
 * - `snapshot_change`: newest reading minus the reading at the start of the window, summed over the
 *   accounts that have both; never below zero.
 * - `snapshot_percent`: summed numerator readings over summed denominator readings, current and
 *   fresh, as a whole percent rounded down.
 * - `event_count`: events of the types in the window, one per stored event (the event dedupe key
 *   already makes it one per deployment, signup, customer, or payment).
 * - `event_streak`: successes since the newest failure, counting back from the newest event.
 */
export type MetricSource =
  | Readonly<{ type: "snapshot_total"; metricKey: string }>
  | Readonly<{ type: "snapshot_change"; metricKey: string }>
  | Readonly<{ type: "snapshot_percent"; numeratorKey: string; denominatorKey: string }>
  | Readonly<{ type: "event_count"; typeIds: readonly string[] }>
  | Readonly<{ type: "event_streak"; successTypeId: string; failureTypeId: string }>;

export type PublicMetricDefinition = Readonly<{
  id: PublicMetricId;
  /** Sentence case, no account or repository names: it is shown publicly as is. */
  label: string;
  unit: MetricUnit;
  /** How the value is computed, in words, for the formulas page and the share surfaces. */
  formula: string;
  provenance: MetricProvenance;
  /**
   * The providers whose included accounts the value counts, never empty (`definitions.test.ts`).
   * Most metrics read one; the deployment counts read every provider in `DEPLOYMENT_OUTCOMES`.
   */
  providers: readonly LiveProviderId[];
  source: MetricSource;
  /**
   * The counting window in days for change and count sources, which is also the minimum history
   * the value needs: a 30 day count from 3 days of data would understate it, so it is reported as
   * not enough history instead. 0 for current values and streaks.
   */
  windowDays: number;
}>;

// `starMetricNames.total` in src/lib/adapters/github/repositories.ts.
const STARS_TOTAL = "github.stars.total";
// `billingMetricNames.usage("Actions", "Minutes")` in src/lib/adapters/github/billing.ts.
const ACTIONS_MINUTES = "github.usage.actions.minutes";
const VERCEL_SUCCEEDED = "vercel.deployment.succeeded";
const VERCEL_FAILED = "vercel.deployment.failed";
const SUPABASE_SIGNUP = "supabase.auth.signup";
const RESEND_MONTHLY_USED = "resend.emails.monthly.used";
const RESEND_MONTHLY_LIMIT = "resend.emails.monthly.limit";
const STRIPE_CUSTOMER_CREATED = "stripe.customer.created";
const STRIPE_CHARGE_SUCCEEDED = "stripe.charge.succeeded";

/**
 * Every provider that reports a deployment's outcome, with the event types its adapter declares as
 * `deploy_succeeded` and `deploy_failed` (`definitions.test.ts` proves the match), in provider name
 * order. A Railway deployment that crashed or was removed later is not an outcome (`markers.ts`),
 * and a GitLab pipeline may deploy nothing, so neither is here. "Deployments shipped" and the
 * deployment counts read every success here (decision on #262); the year in review's longest run
 * reads one pair per provider.
 */
export const DEPLOYMENT_OUTCOMES = [
  { provider: "digitalocean", successTypeId: "digitalocean.deployment.succeeded", failureTypeId: "digitalocean.deployment.failed" },
  { provider: "gitlab", successTypeId: "gitlab.deployment.succeeded", failureTypeId: "gitlab.deployment.failed" },
  { provider: "railway", successTypeId: "railway.deployment.deployed", failureTypeId: "railway.deployment.failed" },
  { provider: "vercel", successTypeId: VERCEL_SUCCEEDED, failureTypeId: VERCEL_FAILED },
] as const satisfies readonly Readonly<{ provider: LiveProviderId; successTypeId: string; failureTypeId: string }>[];

const DEPLOYMENT_PROVIDERS = DEPLOYMENT_OUTCOMES.map((outcome) => outcome.provider);
const DEPLOYMENT_SUCCEEDED = DEPLOYMENT_OUTCOMES.map((outcome) => outcome.successTypeId);

// Until #155 stores the deployment environment, deployments of every environment count, and the
// labels and formulas say so rather than claiming production. The formula is published on the
// formulas page word for word, so it carries no issue number.
const ALL_ENVIRONMENTS =
  "Counts deployments to every environment (production and preview) until StackDash records the environment of each deployment.";
// The providers by the names every other surface uses (`PROVIDER_NAMES`), as the run slide does.
const DEPLOYMENT_SOURCES = new Intl.ListFormat("en-US", { type: "conjunction" }).format(
  DEPLOYMENT_PROVIDERS.map((provider) => PROVIDER_NAMES[provider]),
);

/** Keyed by id so the type checker proves every enum value has exactly one definition. */
const DEFINITIONS = {
  "github-stars": {
    id: "github-stars",
    label: "GitHub stars",
    unit: "stars",
    formula:
      "Stars across the repositories the project's GitHub accounts can see, from the newest hourly star count. Repository names are never shown.",
    provenance: "verified",
    providers: ["github"],
    source: { type: "snapshot_total", metricKey: STARS_TOTAL },
    windowDays: 0,
  },
  "github-stars-gained-7d": {
    id: "github-stars-gained-7d",
    label: "GitHub stars gained in 7 days",
    unit: "stars",
    formula:
      "The newest star count minus the star count at the end of the day 7 days ago, per GitHub account, added up. Unstars count against it, and it never goes below zero.",
    provenance: "verified",
    providers: ["github"],
    source: { type: "snapshot_change", metricKey: STARS_TOTAL },
    windowDays: 7,
  },
  "github-stars-gained-30d": {
    id: "github-stars-gained-30d",
    label: "GitHub stars gained in 30 days",
    unit: "stars",
    formula:
      "The newest star count minus the star count at the end of the day 30 days ago, per GitHub account, added up. Unstars count against it, and it never goes below zero.",
    provenance: "verified",
    providers: ["github"],
    source: { type: "snapshot_change", metricKey: STARS_TOTAL },
    windowDays: 30,
  },
  "vercel-deployments-7d": {
    id: "vercel-deployments-7d",
    label: "Deployments in 7 days",
    unit: "deployments",
    formula: `Deployments that finished successfully on the project's ${DEPLOYMENT_SOURCES} accounts in the last 7 days, one per deployment. ${ALL_ENVIRONMENTS}`,
    provenance: "verified",
    providers: DEPLOYMENT_PROVIDERS,
    source: { type: "event_count", typeIds: DEPLOYMENT_SUCCEEDED },
    windowDays: 7,
  },
  "vercel-deployments-30d": {
    id: "vercel-deployments-30d",
    label: "Deployments in 30 days",
    unit: "deployments",
    formula: `Deployments that finished successfully on the project's ${DEPLOYMENT_SOURCES} accounts in the last 30 days, one per deployment. ${ALL_ENVIRONMENTS}`,
    provenance: "verified",
    providers: DEPLOYMENT_PROVIDERS,
    source: { type: "event_count", typeIds: DEPLOYMENT_SUCCEEDED },
    windowDays: 30,
  },
  "vercel-deployment-streak": {
    id: "vercel-deployment-streak",
    label: "Successful deployments in a row",
    unit: "deployments",
    formula: `Vercel deployments that succeeded since the newest failed one, counted in deployments, not days. ${ALL_ENVIRONMENTS}`,
    provenance: "verified",
    providers: ["vercel"],
    source: { type: "event_streak", successTypeId: VERCEL_SUCCEEDED, failureTypeId: VERCEL_FAILED },
    windowDays: 0,
  },
  "supabase-signups-7d": {
    id: "supabase-signups-7d",
    label: "Signups in 7 days",
    unit: "signups",
    formula: "New users in the project's Supabase projects in the last 7 days, from Supabase's auth logs, one per signup.",
    provenance: "verified",
    providers: ["supabase"],
    source: { type: "event_count", typeIds: [SUPABASE_SIGNUP] },
    windowDays: 7,
  },
  "supabase-signups-30d": {
    id: "supabase-signups-30d",
    label: "Signups in 30 days",
    unit: "signups",
    formula: "New users in the project's Supabase projects in the last 30 days, from Supabase's auth logs, one per signup.",
    provenance: "verified",
    providers: ["supabase"],
    source: { type: "event_count", typeIds: [SUPABASE_SIGNUP] },
    windowDays: 30,
  },
  "resend-emails-month": {
    id: "resend-emails-month",
    label: "Emails this month",
    unit: "emails",
    formula:
      "Emails counted against the Resend monthly quota in the current quota month, as Resend reports it (sent and received), added up across the project's Resend teams.",
    provenance: "verified",
    providers: ["resend"],
    source: { type: "snapshot_total", metricKey: RESEND_MONTHLY_USED },
    windowDays: 0,
  },
  "resend-quota-percent-month": {
    id: "resend-quota-percent-month",
    label: "Resend monthly quota used",
    unit: "percent",
    formula:
      "Emails counted against the Resend monthly quota divided by the monthly quota, in the current quota month, rounded down to a whole percent. Teams with no quota limit are left out.",
    provenance: "verified",
    providers: ["resend"],
    source: { type: "snapshot_percent", numeratorKey: RESEND_MONTHLY_USED, denominatorKey: RESEND_MONTHLY_LIMIT },
    windowDays: 0,
  },
  "github-actions-minutes-month": {
    id: "github-actions-minutes-month",
    label: "GitHub Actions minutes this month",
    unit: "minutes",
    formula:
      "GitHub Actions minutes used this billing month, as GitHub's billing usage report states them. Only accounts on GitHub's enhanced billing platform report it.",
    provenance: "verified",
    providers: ["github"],
    source: { type: "snapshot_total", metricKey: ACTIONS_MINUTES },
    windowDays: 0,
  },
  "stripe-customers-30d": {
    id: "stripe-customers-30d",
    label: "New customers in 30 days",
    unit: "customers",
    formula: "Customers created on the project's Stripe accounts in the last 30 days, as a count. Never an amount.",
    provenance: "verified",
    providers: ["stripe"],
    source: { type: "event_count", typeIds: [STRIPE_CUSTOMER_CREATED] },
    windowDays: 30,
  },
  "stripe-payments-30d": {
    id: "stripe-payments-30d",
    label: "Successful payments in 30 days",
    unit: "payments",
    formula: "Payments that succeeded on the project's Stripe accounts in the last 30 days, as a count. Never an amount.",
    provenance: "verified",
    providers: ["stripe"],
    source: { type: "event_count", typeIds: [STRIPE_CHARGE_SUCCEEDED] },
    windowDays: 30,
  },
} as const satisfies { readonly [Id in PublicMetricId]: PublicMetricDefinition & { readonly id: Id } };

/** Every definition, in the enum's order (the order screens list them in). */
export const PUBLIC_METRICS: readonly PublicMetricDefinition[] = PUBLIC_METRIC_IDS.map((id) => DEFINITIONS[id]);

export function publicMetricDefinition(id: PublicMetricId): PublicMetricDefinition {
  return DEFINITIONS[id];
}

/** True when the metric counts the accounts of `provider`. */
export function countsProvider(definition: PublicMetricDefinition, provider: ProviderId): boolean {
  const providers: readonly ProviderId[] = definition.providers;
  return providers.includes(provider);
}

export function isPublicMetricId(value: string): value is PublicMetricId {
  return (PUBLIC_METRIC_IDS as readonly string[]).includes(value);
}

/**
 * Roundings that make sense for a unit. A percent is at most 100, so rounding it to hundreds or
 * thousands would only ever show zero.
 */
export function allowedRoundings(unit: MetricUnit): readonly PublishedMetricRounding[] {
  return unit === "percent" ? ["exact", "tens"] : PUBLISHED_METRIC_ROUNDINGS;
}

export const ROUNDING_LABELS: Record<PublishedMetricRounding, string> = {
  exact: "Exact",
  tens: "Rounded down to 10",
  hundreds: "Rounded down to 100",
  thousands: "Rounded down to 1,000",
};

/** Path of the published formulas page, `docs/architecture/public-metrics.md`. */
export const FORMULAS_DOC_PATH = "/docs/architecture/public-metrics";

/** Link to one metric's formula on the formulas page (its heading anchor is the id). */
export function formulaPath(id: PublicMetricId): string {
  return `${FORMULAS_DOC_PATH}#${id}`;
}
