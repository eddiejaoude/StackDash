import { formatPercent } from "@/lib/format";

import type { PublishedAchievement, PublishedEngineMetric } from "./published";
import { achievementBadgeAltText, achievementEarnedText, badgeAltText, shareableMetric } from "./share";

/*
 * The SVG badge of a published metric (#149) or a published achievement (#413), in the two-part
 * shields style a README expects: the metric's label and its value and provenance, or the
 * provider's name and the achievement's public title. Pure, so it is tested without a server, and
 * the route only adds headers.
 *
 * The SVG is safe to embed anywhere: text only, every string XML-escaped, no script, no link, no
 * external reference, and `role="img"` with a `<title>` so assistive tech reads one sentence.
 */

export type BadgeTone = "verified" | "estimated" | "simulated" | "neutral" | "achievement";

export type BadgeContent = Readonly<{ label: string; message: string; tone: BadgeTone; title: string }>;

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

// Fills chosen for at least 4.5:1 contrast with the white text, so the badge reads on any README
// background. Never color alone: the message says verified, estimated, or simulated in words, and
// an achievement's says its title, followed by "(simulated)" when simulator data earned it.
const LABEL_FILL = "#3f3f46";
const TONE_FILLS: Record<BadgeTone, string> = {
  verified: "#15803d",
  estimated: "#1d4ed8",
  simulated: "#a16207",
  neutral: "#52525b",
  achievement: "#6d28d9",
};

const UNPUBLISHED: BadgeContent = {
  label: "StackDash",
  message: "Unpublished",
  tone: "neutral",
  title: "This metric is not published on StackDash.",
};

export const RATE_LIMITED_BADGE: BadgeContent = {
  label: "StackDash",
  message: "Try again in a minute",
  tone: "neutral",
  title: "Too many requests from this address. Try again in a minute.",
};

export const UNAVAILABLE_BADGE: BadgeContent = {
  label: "StackDash",
  message: "Temporarily unavailable",
  tone: "neutral",
  title: "StackDash could not read this badge. Try again in a moment.",
};

/** What the badge of `metric` says; null is a metric that is not published (or never existed). */
export function badgeContent(metric: PublishedEngineMetric | null): BadgeContent {
  if (metric === null) return UNPUBLISHED;
  const title = badgeAltText(shareableMetric(metric));
  const { value } = metric;
  if (value.status === "unavailable") {
    return { label: metric.label, message: value.text, tone: "neutral", title };
  }
  const number = metric.unit === "percent" ? formatPercent(value.value) : NUMBER_FORMAT.format(value.value);
  // "1,200+" is the badge's short form of "at least 1,200 stars"; the title says it in full.
  const shown = value.atLeast ? `${number}+` : number;
  const tone: BadgeTone = value.simulated ? "simulated" : metric.provenance;
  return { label: metric.label, message: `${shown} ${tone}`, tone, title };
}

/**
 * What the badge of a published achievement says: a trophy and the provider's name, then the public
 * title, never the private one. One earned from the provider simulator's data (#131) takes the
 * simulated fill and says "(simulated)" after its title, as a simulated metric's badge does. Null
 * (unknown, not earned, not published, or a malformed id) is the same neutral Unpublished badge a
 * metric gets, titled for an achievement.
 */
export function achievementBadgeContent(achievement: PublishedAchievement | null): BadgeContent {
  if (achievement === null) return { ...UNPUBLISHED, title: "This achievement is not published on StackDash." };
  return {
    label: `🏆 ${achievement.providerName}`,
    message: achievement.simulated ? `${achievement.publicTitle} (simulated)` : achievement.publicTitle,
    tone: achievement.simulated ? "simulated" : "achievement",
    title: `${achievementBadgeAltText(achievement)} ${achievementEarnedText(achievement)}.`,
  };
}

// Approximate advance widths of Verdana at 11px, the shields font. `textLength` below fits the
// text to these widths exactly, so a renderer with a different fallback font never overflows.
const NARROW = new Set("ijl'|!.,:;");
const SEMI_NARROW = new Set("frt()[] -/");
const WIDE = new Set("mwMW%");
const CHAR_WIDTHS_PX = { narrow: 3.4, semiNarrow: 4.3, lower: 6.3, upper: 7.5, digit: 7, wide: 10, plus: 9.2, emoji: 14 } as const;
const EMOJI = /\p{Extended_Pictographic}/u;
const VARIATION_SELECTOR = "\uFE0F";

/** Approximate rendered width of `text` in the badge font, in pixels. */
export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === VARIATION_SELECTOR) continue;
    if (EMOJI.test(char)) width += CHAR_WIDTHS_PX.emoji;
    else if (NARROW.has(char)) width += CHAR_WIDTHS_PX.narrow;
    else if (SEMI_NARROW.has(char)) width += CHAR_WIDTHS_PX.semiNarrow;
    else if (WIDE.has(char)) width += CHAR_WIDTHS_PX.wide;
    else if (char === "+") width += CHAR_WIDTHS_PX.plus;
    else if (/[0-9]/.test(char)) width += CHAR_WIDTHS_PX.digit;
    else if (/[A-Z]/.test(char)) width += CHAR_WIDTHS_PX.upper;
    else width += CHAR_WIDTHS_PX.lower;
  }
  return Math.round(width * 10) / 10;
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

const HEIGHT_PX = 20;
const PADDING_PX = 6;

/** The badge as a complete SVG document. */
export function renderBadgeSvg(content: BadgeContent): string {
  const labelText = textWidth(content.label);
  const messageText = textWidth(content.message);
  const labelWidth = Math.ceil(labelText + 2 * PADDING_PX);
  const messageWidth = Math.ceil(messageText + 2 * PADDING_PX);
  const width = labelWidth + messageWidth;
  const title = escapeXml(content.title);
  const label = escapeXml(content.label);
  const message = escapeXml(content.message);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT_PX}" viewBox="0 0 ${width} ${HEIGHT_PX}" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    `<clipPath id="r"><rect width="${width}" height="${HEIGHT_PX}" rx="3"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${labelWidth}" height="${HEIGHT_PX}" fill="${LABEL_FILL}"/>`,
    `<rect x="${labelWidth}" width="${messageWidth}" height="${HEIGHT_PX}" fill="${TONE_FILLS[content.tone]}"/>`,
    `</g>`,
    `<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`,
    `<text x="${labelWidth / 2}" y="14" textLength="${labelText}" lengthAdjust="spacingAndGlyphs">${label}</text>`,
    `<text x="${labelWidth + messageWidth / 2}" y="14" textLength="${messageText}" lengthAdjust="spacingAndGlyphs">${message}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
