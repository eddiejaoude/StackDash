import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import {
  counted,
  DAILY_ACTIVE_USERS_METRIC_KEY,
  ENTITLEMENT_ALLOWANCES,
  eventTypes,
  PRICING_PAGE_LIMITS,
  PRICING_SOURCE,
  supabaseAdapter,
} from "@/lib/adapters/supabase";

import {
  between,
  countOf,
  DAY_MS,
  HOUR_MS,
  instantInSlot,
  SLOT_MS,
  SLOTS_PER_HOUR,
  simulatedEndpoint,
  utcDayStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated Supabase organization on the Pro plan with two projects. Signups trickle in every few
 * seconds (about 3,600 a day on the main project), a daily auth summary for the day before lands
 * at UTC midnight, and now and then a service is unhealthy for a few minutes. Plan limits use the
 * real adapter's allowance keys, and daily active users its metric key.
 */

type SupabaseTypeId = (typeof eventTypes)[number]["id"];

const PLAN = "pro";
// Signup chances are per 10 second slot.
const PROJECTS = [
  { suffix: "a", name: "Example app", signupChances: [0.3, 0.12] },
  { suffix: "b", name: "Example app staging", signupChances: [0.01] },
] as const;
const SERVICES = ["auth", "db", "rest", "storage", "realtime"] as const;
const ENTITLEMENTS_ENDPOINT = "GET /v1/organizations/{slug}/entitlements";

// Simulated Pro plan values for the entitlement keys the real adapter reads.
const ENTITLEMENT_VALUES: Readonly<Record<string, Readonly<{ value: number; unit: string }>>> = {
  "security.audit_logs_days": { value: 7, unit: "days" },
  "log.retention_days": { value: 7, unit: "days" },
  "function.max_count": { value: 500, unit: "functions" },
  "realtime.max_concurrent_users": { value: 500, unit: "users" },
  "storage.max_file_size": { value: 500, unit: "GB" },
};

function project(accountId: string): (typeof PROJECTS)[number] {
  return PROJECTS.find((candidate) => accountId.endsWith(candidate.suffix)) ?? PROJECTS[0];
}

function signupsInSlot(accountId: string, slot: number): number {
  return countOf(project(accountId).signupChances, accountId, "signups", slot);
}

/**
 * An unhealthy spell of 3 to 9 minutes in the hour starting at `hourMs`, or null when the hour is
 * calm. It starts at least 10 minutes before the hour ends, so it always ends within the same hour.
 */
function incident(accountId: string, hourMs: number): { startSlot: number; endSlot: number; service: string } | null {
  if (between(0, 99, accountId, "incident", hourMs) >= 6) return null;
  const startSlot = hourMs / SLOT_MS + between(0, SLOTS_PER_HOUR - 61, accountId, "incident-start", hourMs);
  return {
    startSlot,
    endSlot: startSlot + between(18, 54, accountId, "incident-length", hourMs),
    service: SERVICES[between(0, SERVICES.length - 1, accountId, "incident-service", hourMs)] ?? "auth",
  };
}

function dailyActiveUsers(accountId: string, dayStartMs: number): number {
  return between(2000, 6000, accountId, "active-users", dayStartMs);
}

function dailySummary(accountId: string, dayStartMs: number): ActivityEvent {
  const firstSlot = dayStartMs / SLOT_MS;
  let signups = 0;
  for (let slot = firstSlot; slot < firstSlot + DAY_MS / SLOT_MS; slot += 1) {
    signups += signupsInSlot(accountId, slot);
  }
  const logins = signups + 2 * dailyActiveUsers(accountId, dayStartMs);
  const logouts = Math.floor(logins / 4);
  const deletedUsers = between(0, 3, accountId, "deleted", dayStartMs);
  const date = new Date(dayStartMs).toISOString().slice(0, 10);
  return {
    typeId: "supabase.auth.daily_summary",
    occurredAt: new Date(dayStartMs),
    severity: "info",
    title: `${counted(logins, "login", "logins")}, ${counted(dailyActiveUsers(accountId, dayStartMs), "active user", "active users")}`,
    body: `${counted(signups, "new signup", "new signups")}, ${counted(logouts, "logout", "logouts")}, ${counted(deletedUsers, "deleted user", "deleted users")}.`,
    externalAccountId: accountId,
    dedupeKey: `supabase.auth.daily_summary:${accountId}:${date}`,
  };
}

function healthEvent(
  accountId: string,
  typeId: Extract<SupabaseTypeId, `supabase.project.${string}`>,
  slot: number,
  service: string,
): ActivityEvent {
  const { name } = project(accountId);
  const unhealthy = typeId === "supabase.project.unhealthy";
  return {
    typeId,
    occurredAt: instantInSlot(slot, accountId, typeId),
    severity: unhealthy ? "critical" : "success",
    title: unhealthy ? `${name} is unhealthy` : `${name} is healthy again`,
    ...(unhealthy ? { body: `Unhealthy services: ${service}.` } : {}),
    externalAccountId: accountId,
    dedupeKey: `${typeId}:${accountId}:${slot}`,
  };
}

function eventsInSlot(accountId: string, slot: number): ActivityEvent[] {
  const startMs = slot * SLOT_MS;
  const events: ActivityEvent[] = [];
  if (startMs % DAY_MS === 0) events.push(dailySummary(accountId, startMs - DAY_MS));

  const candidate = incident(accountId, Math.floor(startMs / HOUR_MS) * HOUR_MS);
  if (candidate !== null) {
    if (candidate.startSlot === slot) events.push(healthEvent(accountId, "supabase.project.unhealthy", slot, candidate.service));
    if (candidate.endSlot === slot) events.push(healthEvent(accountId, "supabase.project.healthy", slot, candidate.service));
  }

  const signups = signupsInSlot(accountId, slot);
  for (let index = 0; index < signups; index += 1) {
    events.push({
      typeId: "supabase.auth.signup",
      occurredAt: instantInSlot(slot, accountId, "signup", index),
      severity: "success",
      title: "New signup",
      externalAccountId: accountId,
      dedupeKey: `supabase.auth.signup:${accountId}:${slot}:${index}`,
    });
  }
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

function metrics(accountId: string, at: Date): AdapterMetric[] {
  const base = { externalAccountId: accountId, retrievedAt: at, timeframe: { type: "point", at } } as const;
  const result: AdapterMetric[] = [];
  for (const [feature, spec] of Object.entries(ENTITLEMENT_ALLOWANCES)) {
    const entitlement = ENTITLEMENT_VALUES[feature];
    if (entitlement === undefined) continue;
    result.push({
      ...base,
      kind: "included_allowance",
      metricKey: spec.metricKey,
      label: spec.label,
      value: entitlement.value,
      unit: entitlement.unit,
      provenance: { source: "provider_api", endpoint: simulatedEndpoint("supabase", ENTITLEMENTS_ENDPOINT) },
    });
  }
  for (const limit of PRICING_PAGE_LIMITS[PLAN] ?? []) {
    result.push({
      ...base,
      kind: "included_allowance",
      metricKey: limit.metricKey,
      label: limit.label,
      value: limit.value,
      unit: limit.unit,
      provenance: { source: "derived", pricingSource: PRICING_SOURCE },
    });
  }
  const yesterday = utcDayStart(at.getTime()) - DAY_MS;
  result.push({
    ...base,
    kind: "usage",
    metricKey: DAILY_ACTIVE_USERS_METRIC_KEY,
    label: "Daily active users",
    value: dailyActiveUsers(accountId, yesterday),
    unit: "users",
    timeframe: { type: "period", start: new Date(yesterday), end: new Date(yesterday + DAY_MS) },
    provenance: { source: "provider_api", endpoint: simulatedEndpoint("supabase", "/v1/projects/{ref}/analytics/endpoints/logs") },
  });
  return result;
}

export const supabaseProfile: SimulatedProfile = {
  real: supabaseAdapter,
  accounts: (seed) => PROJECTS.map(({ suffix, name }) => ({ externalId: `sim${seed}${suffix}`, displayName: name, kind: "project" })),
  metrics,
  eventsInSlot,
};
