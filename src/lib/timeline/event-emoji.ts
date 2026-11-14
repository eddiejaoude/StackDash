import "server-only";

import { ALERT_TRIGGERED_TYPE_ID } from "@/lib/alerts/evaluate";
import { ANOMALY_TYPE_ID } from "@/lib/alerts/anomaly";
import { ACHIEVEMENT_EARNED_TYPE_ID } from "@/lib/achievements/events";
import { declaredEventTypes } from "@/lib/adapters/registry";
import { DAILY_SUMMARY_TYPE_ID } from "@/lib/jobs/daily-summary";
import { ALLOWANCE_RESET_TYPE_ID } from "@/lib/jobs/ingest";
import { SYNC_FAILED_TYPE_ID } from "@/lib/jobs/sync-connection";
import { CHANNEL_NEEDS_ATTENTION_TYPE_ID, NOTIFICATION_FAILED_TYPE_ID } from "@/lib/notifications/dispatch";

/*
 * The emoji in the corner of a timeline row's logo: what happened, at a glance. Adapters declare
 * theirs on each event type (`EventType.emoji`); DevMacro's own types are named here, because they
 * have no adapter. Decorative only: the row's title and type say it in words.
 */

const DEVMACRO_EMOJI: ReadonlyMap<string, string> = new Map([
  [ACHIEVEMENT_EARNED_TYPE_ID, "🏆"],
  [ALERT_TRIGGERED_TYPE_ID, "🔔"],
  [ANOMALY_TYPE_ID, "📈"],
  [DAILY_SUMMARY_TYPE_ID, "📋"],
  [ALLOWANCE_RESET_TYPE_ID, "🔄"],
  [SYNC_FAILED_TYPE_ID, "⚠️"],
  [NOTIFICATION_FAILED_TYPE_ID, "📪"],
  [CHANNEL_NEEDS_ATTENTION_TYPE_ID, "⚠️"],
  ["devmacro.metric_published", "📣"],
  ["devmacro.metric_unpublished", "🙈"],
  ["devmacro.metrics_unpublished_all", "🙈"],
  ["devmacro.project_page_enabled", "🌐"],
  ["devmacro.project_page_updated", "📝"],
  ["devmacro.project_page_disabled", "🚫"],
]);

// A type no adapter declares any more, or a DevMacro type added without an entry above.
const FALLBACK_EMOJI = "📌";

const DECLARED_EMOJI: ReadonlyMap<string, string> = new Map(declaredEventTypes.map((type) => [type.id, type.emoji]));

export function eventEmoji(typeId: string): string {
  return DECLARED_EMOJI.get(typeId) ?? DEVMACRO_EMOJI.get(typeId) ?? FALLBACK_EMOJI;
}
