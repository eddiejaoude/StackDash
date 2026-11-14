import { formatDateTime, formatUtcDate, type Instant } from "@/lib/format";

import { isPublicMetricId, type PublicMetricId } from "./definitions";
import type { PublishedAchievement, PublishedEngineMetric } from "./published";

/*
 * Share surfaces of a published metric (#149) and a published achievement (#413): the URLs of its
 * badge and card, the text a share carries, and the alt text of each image. Client-safe like
 * `definitions.ts` and `display.ts` (no data access, no adapter or Node module; `display.test.ts`
 * walks the imports), so the share dialog, the routes, and the public project page (#150) build
 * the same URLs and words.
 *
 * Badges and cards are keyed by project id, like the public JSON route of #148: projects have no
 * slug, and the workspace slug is the private app URL, so neither belongs in a README (decision on
 * issue #149).
 */

/** Open Graph and X large image size, which the card always has. */
export const CARD_SIZE = { width: 1200, height: 630 } as const;

/** Days of history the card's trend line covers. */
export const CARD_TREND_DAYS = 30;

export function badgePath(projectId: string, metricId: PublicMetricId): string {
  return `/badge/${projectId}/${metricId}.svg`;
}

export function cardPath(projectId: string, metricId: PublicMetricId): string {
  return `/card/${projectId}/${metricId}.png`;
}

/**
 * The metric id in a route's last segment, `<metric id>.<extension>`, or null for anything else,
 * so `/badge/<project>/github-stars.png` and `/badge/<project>/github-stars` are not badges.
 */
export function metricIdFromFile(file: string, extension: "svg" | "png"): PublicMetricId | null {
  const suffix = `.${extension}`;
  if (!file.endsWith(suffix)) return null;
  const id = file.slice(0, -suffix.length);
  return isPublicMetricId(id) ? id : null;
}

// An achievement's file is `achievement-<achievement id>.<extension>`. No metric id starts with
// "achievement-", so the two never collide. The id rule is the database's
// (project_achievements_achievement_id_format) and AdapterScopedKeySchema's, repeated here
// because this module may not import an adapter.
const ACHIEVEMENT_FILE_PREFIX = "achievement-";
const ACHIEVEMENT_ID = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const ACHIEVEMENT_ID_MAX = 100;

export function achievementBadgePath(projectId: string, achievementId: string): string {
  return `/badge/${projectId}/${ACHIEVEMENT_FILE_PREFIX}${achievementId}.svg`;
}

export function achievementCardPath(projectId: string, achievementId: string): string {
  return `/card/${projectId}/${ACHIEVEMENT_FILE_PREFIX}${achievementId}.png`;
}

/**
 * The achievement id in a route's last segment, `achievement-<achievement id>.<extension>`, or
 * null for anything else, so a metric's file, the other surface's extension, and an id the
 * database could never store are not achievements.
 */
export function achievementIdFromFile(file: string, extension: "svg" | "png"): string | null {
  const suffix = `.${extension}`;
  if (!file.startsWith(ACHIEVEMENT_FILE_PREFIX) || !file.endsWith(suffix)) return null;
  const id = file.slice(ACHIEVEMENT_FILE_PREFIX.length, -suffix.length);
  return id.length <= ACHIEVEMENT_ID_MAX && ACHIEVEMENT_ID.test(id) ? id : null;
}

/** What a share surface needs to know about one published value, already formatted. */
export type ShareableMetric = Readonly<{
  label: string;
  /** "1,204 stars", "at least 1,200 stars", or why there is no number ("Not enough history yet"). */
  text: string;
  available: boolean;
  provenance: "verified" | "estimated";
  simulated: boolean;
  /** Present when `available`. */
  lastSyncedAt: Date | null;
}>;

export function shareableMetric(metric: PublishedEngineMetric): ShareableMetric {
  const { value } = metric;
  return {
    label: metric.label,
    text: value.text,
    available: value.status === "available",
    provenance: metric.provenance,
    simulated: value.status === "available" && value.simulated,
    lastSyncedAt: value.status === "available" ? value.lastSyncedAt : null,
  };
}

/** What every share surface says of data the provider simulator made up (#131), metric or achievement. */
export const SIMULATED_SENTENCE = "Simulated data, not verified";

/**
 * Who stands behind the number, in words. A simulated value (#131) is never called verified,
 * whatever the metric's provenance.
 */
export function provenanceSentence(metric: Pick<ShareableMetric, "provenance" | "simulated">): string {
  if (metric.simulated) return SIMULATED_SENTENCE;
  return metric.provenance === "verified" ? "Verified by StackDash" : "Estimated by StackDash";
}

/** "GitHub stars: 1,204 stars. Verified by StackDash, last synced 2026-11-05 12:00 GMT." */
export function metricSentence(metric: ShareableMetric): string {
  if (!metric.available || metric.lastSyncedAt === null) return `${metric.label}: ${metric.text}.`;
  return `${metric.label}: ${metric.text}. ${provenanceSentence(metric)}, last synced ${formatDateTime(metric.lastSyncedAt)}.`;
}

/** Alt text for the card image, for the share dialog and the public project page's preview. */
export function cardAltText(metric: ShareableMetric, projectName: string | null): string {
  const trend = metric.available ? ` With its trend over the last ${CARD_TREND_DAYS} days.` : "";
  const card = projectName === null ? "StackDash card." : `StackDash card for ${projectName}.`;
  return `${card} ${metricSentence(metric)}${trend}`;
}

/** Alt text for the badge image, also the badge's own `<title>`. */
export function badgeAltText(metric: ShareableMetric): string {
  return metricSentence(metric);
}

/** Markdown for a README: the badge, linking to the project page or to how the metric is counted. */
export function badgeMarkdown(input: Readonly<{ badgeUrl: string; linkUrl: string; label: string }>): string {
  // Brackets would end the alt text early; the label comes from definitions.ts, but stay safe.
  const alt = input.label.replace(/[[\]]/g, "");
  return `[![${alt}](${input.badgeUrl})](${input.linkUrl})`;
}

/** The prefilled post for "Share to X": the value in words, naming the project when its page is public. */
export function shareText(metric: ShareableMetric, projectName: string | null): string {
  const subject = projectName === null ? metric.label : `${metric.label} for ${projectName}`;
  if (!metric.available) return `${subject} on StackDash.`;
  return `${subject}: ${metric.text}. ${provenanceSentence(metric)}.`;
}

/**
 * X's post web intent (https://docs.x.com/x-for-websites/post-button/guides/web-intent): opens a
 * prefilled post the person still edits and sends themselves. Nothing is posted automatically.
 */
export function shareToXUrl(text: string, url?: string): string {
  const intent = new URL("https://x.com/intent/tweet");
  intent.searchParams.set("text", text);
  if (url !== undefined) intent.searchParams.set("url", url);
  return intent.href;
}

/**
 * LinkedIn's share page for `url`, the address its Share plugin opens
 * (https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/plugins/share-plugin).
 * A plain link, so no LinkedIn script loads; the person writes and sends the post themselves.
 */
export function shareToLinkedInUrl(url: string): string {
  const share = new URL("https://www.linkedin.com/sharing/share-offsite/");
  share.searchParams.set("url", url);
  return share.href;
}

/**
 * The project's public page as share surfaces see it (#255). Present only while the page answers,
 * so no link ever leads to a page that is off; the project name is public only through that page.
 */
export type ShareProjectPage = Readonly<{ path: string; projectName: string }>;

export type ShareLinks = Readonly<{
  badgeMarkdown: string;
  cardUrl: string;
  /** What a post links to: the project page while it is public, else the card itself. */
  link: string;
  xIntentUrl: string;
  linkedInUrl: string;
}>;

/** Every absolute link the share dialog of a published metric offers, on the public `origin`. */
export function metricShareLinks(
  input: Readonly<{
    origin: string;
    projectId: string;
    metricId: PublicMetricId;
    formulaPath: string;
    metric: ShareableMetric;
    projectPage: ShareProjectPage | null;
  }>,
): ShareLinks {
  const { origin, projectId, metricId, metric, projectPage } = input;
  const badgeUrl = new URL(badgePath(projectId, metricId), origin).href;
  const cardUrl = new URL(cardPath(projectId, metricId), origin).href;
  const pageUrl = projectPage === null ? null : new URL(projectPage.path, origin).href;
  const link = pageUrl ?? cardUrl;
  return {
    badgeMarkdown: badgeMarkdown({ badgeUrl, linkUrl: pageUrl ?? new URL(input.formulaPath, origin).href, label: metric.label }),
    cardUrl,
    link,
    xIntentUrl: shareToXUrl(shareText(metric, projectPage?.projectName ?? null), link),
    linkedInUrl: shareToLinkedInUrl(link),
  };
}

/** What a share surface needs to know about a published achievement: public words only. */
export type ShareableAchievement = Pick<PublishedAchievement, "providerName" | "publicTitle" | "simulated">;

const ACHIEVEMENT_COUNT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * When an achievement was earned, in words: "Earned 2026-11-05 14:05 GMT"; "Earned 2026-11-05" for
 * a daily total, which has a day but no time (stored at 00:00 UTC of that day); and "Recorded at
 * least 1,000 on 2026-11-05 14:05 GMT" when StackDash's first reading was already past the
 * threshold, so it never claims the crossing happened then. The one wording of every surface,
 * public and private (the project's Achievements page passes the stored timestamp string).
 */
export function achievementEarnedText(
  achievement: Pick<PublishedAchievement, "earnedPrecision" | "evidence" | "threshold"> & Readonly<{ earnedAt: Instant }>,
): string {
  const when = achievement.earnedPrecision === "day" ? formatUtcDate(achievement.earnedAt) : formatDateTime(achievement.earnedAt);
  if (achievement.evidence === "at_least" && achievement.threshold !== null) {
    return `Recorded at least ${ACHIEVEMENT_COUNT_FORMAT.format(achievement.threshold)} on ${when}`;
  }
  return `Earned ${when}`;
}

/** " Simulated data, not verified." after an achievement earned from simulator data (#131), else nothing. */
function achievementSimulatedSuffix(achievement: Pick<ShareableAchievement, "simulated">): string {
  return achievement.simulated ? ` ${SIMULATED_SENTENCE}.` : "";
}

/**
 * "Vercel achievement on StackDash: 10 Vercel deployments recorded." The badge's alt text, which
 * adds "Simulated data, not verified." for an achievement earned from simulator data.
 */
export function achievementBadgeAltText(achievement: ShareableAchievement): string {
  return `${achievement.providerName} achievement on StackDash: ${achievement.publicTitle}.${achievementSimulatedSuffix(achievement)}`;
}

/** Alt text for an achievement's card, naming the project only while the card shows it. */
export function achievementCardAltText(achievement: ShareableAchievement, projectName: string | null): string {
  const card = projectName === null ? "StackDash achievement card." : `StackDash achievement card for ${projectName}.`;
  return `${card} ${achievement.providerName} achievement: ${achievement.publicTitle}.${achievementSimulatedSuffix(achievement)}`;
}

/** The prefilled post for "Share to X", naming the project when its page is public. */
export function achievementShareText(achievement: ShareableAchievement, projectName: string | null): string {
  const subject = projectName === null ? "Achievement" : `Achievement for ${projectName}`;
  const source = achievement.simulated
    ? `Earned from simulated ${achievement.providerName} data on StackDash, not verified.`
    : `Earned from ${achievement.providerName} data on StackDash.`;
  return `${subject}: ${achievement.publicTitle}. ${source}`;
}

/**
 * Every absolute link the share dialog of a published achievement offers, on the public `origin`.
 * Like a metric's, except that the badge links to the site when the project page is not public,
 * since an achievement has no formula to link to.
 */
export function achievementShareLinks(
  input: Readonly<{
    origin: string;
    projectId: string;
    achievementId: string;
    achievement: ShareableAchievement;
    projectPage: ShareProjectPage | null;
  }>,
): ShareLinks {
  const { origin, projectId, achievementId, achievement, projectPage } = input;
  const badgeUrl = new URL(achievementBadgePath(projectId, achievementId), origin).href;
  const cardUrl = new URL(achievementCardPath(projectId, achievementId), origin).href;
  const pageUrl = projectPage === null ? null : new URL(projectPage.path, origin).href;
  const link = pageUrl ?? cardUrl;
  return {
    badgeMarkdown: badgeMarkdown({ badgeUrl, linkUrl: pageUrl ?? new URL("/", origin).href, label: achievement.publicTitle }),
    cardUrl,
    link,
    xIntentUrl: shareToXUrl(achievementShareText(achievement, projectPage?.projectName ?? null), link),
    linkedInUrl: shareToLinkedInUrl(link),
  };
}
