import { describe, expect, it } from "vitest";
import type { Achievement, AchievementRule } from "./achievements";
import { digitaloceanAdapter } from "./digitalocean";
import { typeIdsOfCategory } from "./events";
import { githubAdapter } from "./github";
import { gitlabAdapter } from "./gitlab";
import { polarAdapter } from "./polar";
import { postHogAdapter } from "./posthog";
import { railwayAdapter } from "./railway";
import { resendAdapter } from "./resend";
import { sentryAdapter } from "./sentry";
import { stripeAdapter } from "./stripe";
import { supabaseAdapter } from "./supabase";
import type { LiveProviderId, ProviderAdapter } from "./types";
import { vercelAdapter } from "./vercel";

/**
 * Each adapter declares its own achievements (#413), so nothing but this test keeps adapters of
 * the same kind on the same ladder: a member should see the same ids, thresholds, and wording
 * whichever deployment host, payment provider, or signup source they use.
 */

const ADAPTERS: Readonly<Record<LiveProviderId, ProviderAdapter>> = {
  vercel: vercelAdapter,
  github: githubAdapter,
  resend: resendAdapter,
  stripe: stripeAdapter,
  supabase: supabaseAdapter,
  digitalocean: digitaloceanAdapter,
  posthog: postHogAdapter,
  polar: polarAdapter,
  sentry: sentryAdapter,
  railway: railwayAdapter,
  gitlab: gitlabAdapter,
};

// The issue's catalog, ids without the adapter prefix.
const DEPLOYMENT_LADDER = [
  "deployments.first",
  "deployments.10",
  "deployments.100",
  "deployments.streak_10",
  "deployments.night_owl",
  "deployments.friday_ship",
  "deployments.busy_day",
  "deployments.weekly_rhythm",
];
const PAYMENT_LADDER = [
  "payments.first",
  "payments.10",
  "payments.100",
  "payments.1000",
  "payments.payday",
  "payments.while_you_slept",
  "subscriptions.first",
  "subscriptions.10",
];
const SIGNUP_LADDER = ["signups.first", "signups.10", "signups.100", "signups.1000", "signups.big_day"];

const CATALOG: Readonly<Record<LiveProviderId, readonly string[]>> = {
  vercel: DEPLOYMENT_LADDER,
  railway: DEPLOYMENT_LADDER,
  digitalocean: [...DEPLOYMENT_LADDER, "droplets.first", "droplets.fleet"],
  gitlab: [
    ...DEPLOYMENT_LADDER,
    "pipelines.100",
    "pipelines.green_streak",
    "merge_requests.first",
    "merge_requests.100",
    "merge_requests.marathon",
    "releases.first",
    "releases.10",
  ],
  github: [
    "stars.10",
    "stars.100",
    "stars.1000",
    "stars.10000",
    "stars.777",
    "stars.1024",
    "stars.hot_day",
    "stars.steady_glow",
    "stars.weekend",
    "forks.first",
    "forks.10",
    "forks.100",
    "forks.party",
  ],
  stripe: [...PAYMENT_LADDER, "customers.first", "customers.100"],
  polar: PAYMENT_LADDER,
  supabase: [...SIGNUP_LADDER, "signups.rush_hour", "signups.night_owls"],
  posthog: SIGNUP_LADDER,
  sentry: [
    "issues.resolved_first",
    "issues.resolved_100",
    "issues.bug_squasher",
    "releases.first",
    "releases.10",
  ],
  resend: ["domains.first", "domains.collector"],
};

const KINDS: readonly { kind: string; ladder: readonly string[]; providers: readonly LiveProviderId[] }[] = [
  { kind: "deployment hosts", ladder: DEPLOYMENT_LADDER, providers: ["vercel", "railway", "digitalocean", "gitlab"] },
  { kind: "payments", ladder: PAYMENT_LADDER, providers: ["stripe", "polar"] },
  { kind: "signups", ladder: SIGNUP_LADDER, providers: ["supabase", "posthog"] },
];

type Ladder = Readonly<{
  // Ids without the adapter prefix.
  ids: readonly string[];
  achievements: readonly Achievement[];
  // The entry for an id, or an error naming the provider and the missing id.
  get: (id: string) => Achievement;
}>;

/** The adapter's entries for `ladder`, keyed by id without the adapter prefix. */
function ladderOf(provider: LiveProviderId, ladder: readonly string[]): Ladder {
  const prefix = `${provider}.`;
  const entries = (ADAPTERS[provider].achievements ?? []).map((achievement) => [achievement.id.slice(prefix.length), achievement] as const);
  const byId = new Map(entries.filter(([id]) => ladder.includes(id)));
  return {
    ids: [...byId.keys()],
    achievements: [...byId.values()],
    get: (id) => {
      const achievement = byId.get(id);
      if (achievement === undefined) throw new Error(`${provider} declares no ${prefix}${id} achievement`);
      return achievement;
    },
  };
}

/** The number a rule must reach, whatever its kind. */
function threshold(rule: AchievementRule): number {
  switch (rule.kind) {
    case "event_count":
    case "event_streak":
    case "events_in_window":
      return rule.count;
    case "metric_threshold":
    case "daily_total_threshold":
      return rule.value;
    case "metric_daily_gain":
      return rule.gain;
    case "consecutive_days":
      return rule.days;
    case "event_at_local_time":
      // Earned by one event: the hours and weekdays are compared with the rule's shape.
      return 1;
  }
}

// Keys naming the provider's own type ids and metric key, left out where rules are compared.
const PROVIDER_KEYS: Readonly<Record<string, true>> = { typeIds: true, successTypeIds: true, failureTypeIds: true, metricKey: true };

/** The rule without the provider's own type ids and metric key: what must match across providers. */
function shape(rule: AchievementRule): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rule).filter(([key]) => PROVIDER_KEYS[key] === undefined));
}

/** Wording with the provider's display name taken out, so parallel wording compares equal. */
function generic(provider: LiveProviderId, text: string): string {
  return text.replaceAll(ADAPTERS[provider].displayName, "{Provider}");
}

describe("achievement catalog", () => {
  it.each(Object.keys(CATALOG) as LiveProviderId[])("%s declares exactly the issue's achievements", (provider) => {
    const ids = (ADAPTERS[provider].achievements ?? []).map((achievement) => achievement.id);
    expect(ids.toSorted()).toEqual(CATALOG[provider].map((id) => `${provider}.${id}`).toSorted());
  });
});

describe.each(KINDS)("$kind share one ladder", ({ ladder, providers }) => {
  const [reference, ...others] = providers as [LiveProviderId, ...LiveProviderId[]];

  it.each(others)(`%s matches ${reference}'s ids and thresholds`, (provider) => {
    const mine = ladderOf(provider, ladder);
    const theirs = ladderOf(reference, ladder);
    expect(mine.ids.toSorted()).toEqual([...ladder].toSorted());
    for (const id of ladder) {
      expect(threshold(mine.get(id).rule), id).toBe(threshold(theirs.get(id).rule));
    }
  });

  it.each(others)(`%s matches ${reference}'s titles`, (provider) => {
    const mine = ladderOf(provider, ladder);
    const theirs = ladderOf(reference, ladder);
    for (const id of ladder) {
      expect(generic(provider, mine.get(id).title), id).toBe(generic(reference, theirs.get(id).title));
      expect(generic(provider, mine.get(id).publicTitle), id).toBe(generic(reference, theirs.get(id).publicTitle));
    }
  });
});

// Signups differ in rule kind (PostHog sums daily totals, Supabase counts events), so only the
// deployment and payment ladders share their rule shapes and descriptions.
describe.each(KINDS.filter(({ kind }) => kind !== "signups"))("$kind share rule shapes and wording", ({ ladder, providers }) => {
  const [reference, ...others] = providers as [LiveProviderId, ...LiveProviderId[]];

  it.each(others)(`%s matches ${reference}'s rule kinds, windows, hours, and descriptions`, (provider) => {
    const mine = ladderOf(provider, ladder);
    const theirs = ladderOf(reference, ladder);
    for (const id of ladder) {
      expect(shape(mine.get(id).rule), id).toEqual(shape(theirs.get(id).rule));
      expect(generic(provider, mine.get(id).description), id).toBe(generic(reference, theirs.get(id).description));
    }
  });
});

describe("deployment ladder evidence", () => {
  it.each(["vercel", "railway", "digitalocean", "gitlab"] as const)(
    "%s counts its deploy_succeeded types and breaks streaks on its deploy_failed types",
    (provider) => {
      const succeeded = typeIdsOfCategory(ADAPTERS[provider].eventTypes, ["deploy_succeeded"]);
      const failed = typeIdsOfCategory(ADAPTERS[provider].eventTypes, ["deploy_failed"]);
      for (const achievement of ladderOf(provider, DEPLOYMENT_LADDER).achievements) {
        const { rule } = achievement;
        if (rule.kind === "event_streak") {
          expect(rule.successTypeIds, achievement.id).toEqual(succeeded);
          expect(rule.failureTypeIds, achievement.id).toEqual(failed);
        } else if ("typeIds" in rule) {
          expect(rule.typeIds, achievement.id).toEqual(succeeded);
        } else {
          throw new Error(`${achievement.id} does not read deployment events`);
        }
      }
    },
  );
});
