import "server-only";

import { ImageResponse } from "next/og";
import type { ReactNode } from "react";

import { formatDateTime } from "@/lib/format";
import { site } from "@/lib/site";

import type { PublishedAchievement, PublishedMetricCard } from "./published";
import { achievementEarnedText, CARD_SIZE, CARD_TREND_DAYS, provenanceSentence, shareableMetric } from "./share";
import { isYearComplete, yearFigures, yearPeriod, yearProvenance, yearSummaryLabel, type YearSlide, type YearSummary } from "./yearly";

/*
 * The 1200 by 630 PNG cards (#149 milestone cards, #151 yearly card, #262 year in review slides, #338 site preview image), rendered with Next.js'
 * `ImageResponse` (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/
 * image-response.md): JSX laid out by Satori with flexbox only, no external image service, and the
 * renderer's bundled font, so no font file ships with the route. Colors are the site's tokens
 * (src/app/globals.css); text is at least 4.5:1 against the background.
 */

const COLORS = {
  background: "#0a0a0a",
  panel: "#16161a",
  line: "#2a2a30",
  foreground: "#ededed",
  muted: "#a1a1aa",
  accent: "#ff5d3b",
  success: "#3ecf8e",
  warning: "#f5a623",
} as const;

const PADDING_PX = 64;
const TREND_WIDTH_PX = CARD_SIZE.width - 2 * PADDING_PX;
const TREND_HEIGHT_PX = 150;
const TREND_STROKE_PX = 5;

/**
 * An SVG path through the points that have a value, scaled into `width` by `height`. A missing
 * point breaks the line instead of drawing a slope across a gap; a flat series sits mid-height.
 * Null when fewer than two points have a value, since one point is not a trend.
 */
export function trendPath(values: readonly (number | null)[], width: number, height: number): string | null {
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2 || values.length < 2) return null;
  const min = Math.min(...known);
  const max = Math.max(...known);
  const inset = TREND_STROKE_PX;
  const usable = height - 2 * inset;
  const x = (index: number) => Math.round(((index / (values.length - 1)) * width) * 10) / 10;
  const y = (value: number) =>
    Math.round((max === min ? height / 2 : inset + usable - ((value - min) / (max - min)) * usable) * 10) / 10;
  let path = "";
  let drawing = false;
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false;
      return;
    }
    path += `${drawing ? "L" : "M"}${x(index)} ${y(value)} `;
    drawing = true;
  });
  return path.trim();
}

function Frame({ tag, children, footer }: { tag: ReactNode; children: ReactNode; footer: readonly [string, string] }) {
  return (
    <div
      style={{
        // In pixels: with height 100% the frame took its content's height, leaving a white band under short cards.
        width: CARD_SIZE.width,
        height: CARD_SIZE.height,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: PADDING_PX,
        backgroundColor: COLORS.background,
        color: COLORS.foreground,
        fontSize: 28,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", fontSize: 36, color: COLORS.accent, letterSpacing: -1 }}>DevMacro</div>
        {tag}
      </div>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>{children}</div>
      <div style={{ display: "flex", justifyContent: "space-between", color: COLORS.muted, fontSize: 24 }}>
        <div style={{ display: "flex" }}>{footer[0]}</div>
        <div style={{ display: "flex" }}>{footer[1]}</div>
      </div>
    </div>
  );
}

function Tag({ text, color }: { text: string; color: string }) {
  return (
    <div
      style={{
        display: "flex",
        padding: "8px 20px",
        borderRadius: 999,
        border: `2px solid ${color}`,
        color,
        fontSize: 24,
      }}
    >
      {text}
    </div>
  );
}

function Trend({ values }: { values: readonly (number | null)[] }) {
  const path = trendPath(values, TREND_WIDTH_PX, TREND_HEIGHT_PX);
  if (path === null) {
    return <div style={{ display: "flex", height: TREND_HEIGHT_PX, alignItems: "center", color: COLORS.muted }}>No trend to show yet</div>;
  }
  return (
    <svg width={TREND_WIDTH_PX} height={TREND_HEIGHT_PX} viewBox={`0 0 ${TREND_WIDTH_PX} ${TREND_HEIGHT_PX}`}>
      <path d={path} fill="none" stroke={COLORS.accent} strokeWidth={TREND_STROKE_PX} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The milestone card of one published metric: the project's name while its page is public (#255),
 * then label, value, provenance, trend, last sync. `projectName` is null otherwise, since the page
 * is the only place the name is public.
 */
export function MetricCard({ card, projectName }: { card: PublishedMetricCard; projectName: string | null }) {
  const { metric, trend } = card;
  const share = shareableMetric(metric);
  const tag = share.simulated ? (
    <Tag text={provenanceSentence(share)} color={COLORS.warning} />
  ) : share.available ? (
    <Tag text={provenanceSentence(share)} color={COLORS.success} />
  ) : (
    <Tag text="No current value" color={COLORS.muted} />
  );
  const window = metric.delayDays === 0 ? `Trend over the last ${CARD_TREND_DAYS} days` : `As of ${formatDateTime(metric.asOf)}, ${metric.delayDays} days late`;
  const synced = share.lastSyncedAt === null ? "Not synced recently" : `Last synced ${formatDateTime(share.lastSyncedAt)}`;
  return (
    <Frame tag={tag} footer={[window, synced]}>
      {projectName === null ? null : <div style={{ ...line(44), letterSpacing: -1, marginBottom: 4 }}>{projectName}</div>}
      <div style={{ display: "flex", fontSize: 40, color: COLORS.muted }}>{metric.label}</div>
      <div style={{ display: "flex", fontSize: share.available ? 104 : 72, marginTop: 8, marginBottom: 24, letterSpacing: -2 }}>{share.text}</div>
      <Trend values={trend.map((point) => point.value)} />
    </Frame>
  );
}

/** A card with no metric behind it: not published, refused, or failed. Says which, nothing more. */
export function NoticeCard({ title, body }: { title: string; body: string }) {
  return (
    <Frame tag={<Tag text="No value shown" color={COLORS.muted} />} footer={["Public metrics, counted from stored data", ""]}>
      <div style={{ display: "flex", fontSize: 88, letterSpacing: -2 }}>{title}</div>
      <div style={{ display: "flex", fontSize: 36, marginTop: 24, color: COLORS.muted }}>{body}</div>
    </Frame>
  );
}

/**
 * The card of one published achievement (#413): the project's name while its page is public, the
 * provider, the public title (never the private one), and when it was earned, in the same words as
 * the project page. The title is at most 80 characters (ACHIEVEMENT_TITLE_MAX), which wraps to at
 * most three lines at this size.
 */
export function AchievementCard({ achievement, projectName }: { achievement: PublishedAchievement; projectName: string | null }) {
  return (
    <Frame tag={<Tag text="Achievement earned" color={COLORS.success} />} footer={["Earned from stored provider data", ""]}>
      {projectName === null ? null : <div style={{ ...line(44), letterSpacing: -1, marginBottom: 4 }}>{projectName}</div>}
      <div style={{ display: "flex", fontSize: 36, color: COLORS.muted }}>{`${achievement.providerName} achievement`}</div>
      <div style={{ display: "flex", fontSize: 64, lineHeight: 1.15, marginTop: 12, letterSpacing: -1 }}>{achievement.publicTitle}</div>
      <div style={{ display: "flex", fontSize: 32, marginTop: 24, color: COLORS.muted }}>{achievementEarnedText(achievement)}</div>
    </Frame>
  );
}

/** The site-wide link preview (#338): what DevMacro does and who it is for, for the landing page and the docs. */
export function SiteCard() {
  return (
    <Frame tag={<Tag text="Open source" color={COLORS.accent} />} footer={[site.tagline, site.githubUrl.replace(/^https:\/\//, "")]}>
      <div style={{ display: "flex", fontSize: 68, lineHeight: 1.1, letterSpacing: -2 }}>{site.headline}</div>
      <div style={{ display: "flex", fontSize: 32, lineHeight: 1.3, marginTop: 28, color: COLORS.muted }}>{`For ${site.audience}.`}</div>
    </Frame>
  );
}

// The yearly card's grid, sized so two rows of figures always fit the 1200 by 630 card (#267):
// every line is one line high and ends in an ellipsis rather than wrap past its box. The page lists
// every figure in full beneath the card, and the alt text says them all.
const FIGURE_GAP_PX = 16;
const FIGURE_HEIGHT_PX = 152;
const FIGURE_PADDING_PX = 20;
const VALUE_LINE_PX = 58;
/** A count fits at full size; a reason such as "Not connected" is words and drops to a size that fits. */
const COUNT_CHARS_MAX = 12;

/** One line of card text that ends in an ellipsis instead of wrapping. */
function line(fontSize: number, color: string = COLORS.foreground) {
  return { display: "flex", fontSize, lineHeight: 1.2, color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
}

/** The private yearly summary card (#151): a whole past year, or the current year to date. */
export function YearCard({ summary }: { summary: YearSummary }) {
  const tag = isYearComplete(summary.year, summary.asOf) ? `${summary.year} in review` : "Year to date";
  return (
    <Frame
      tag={<Tag text={tag} color={summary.simulated ? COLORS.warning : COLORS.accent} />}
      footer={[yearPeriod(summary), yearProvenance(summary)]}
    >
      <div style={{ ...line(52), letterSpacing: -1, marginBottom: 24 }}>{`Your stack in ${yearSummaryLabel(summary)}`}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: FIGURE_GAP_PX }}>
        {yearFigures(summary).map((stat) => (
          <div
            key={stat.label}
            style={{
              display: "flex",
              flexDirection: "column",
              width: (TREND_WIDTH_PX - FIGURE_GAP_PX) / 2,
              height: FIGURE_HEIGHT_PX,
              padding: `16px ${FIGURE_PADDING_PX}px`,
              borderRadius: 16,
              backgroundColor: COLORS.panel,
              border: `2px solid ${COLORS.line}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", height: VALUE_LINE_PX }}>
              <div style={{ ...line(stat.value.length > COUNT_CHARS_MAX ? 28 : 52), letterSpacing: -1 }}>{stat.value}</div>
            </div>
            <div style={line(22, COLORS.muted)}>{stat.since === null ? stat.label : `${stat.label}, since ${stat.since}`}</div>
            {stat.countedUpTo === null ? null : <div style={line(22, COLORS.muted)}>{`counted up to ${stat.countedUpTo}`}</div>}
          </div>
        ))}
      </div>
    </Frame>
  );
}

/**
 * Value sizes by length, so a value stays on one line: a count at full size, a weekday and date or
 * "72 in a row on Vercel" smaller, and the longest run value, "1,234 in a row on DigitalOcean",
 * smaller still, so the provider's name is never cut off.
 */
function slideValueSize(value: string): number {
  if (value.length <= 12) return 104;
  return value.length <= 24 ? 72 : 56;
}

/** One slide of the year in review (#262) other than the totals, whose image is `YearCard`. */
export function YearSlideCard({ summary, slide }: { summary: YearSummary; slide: Exclude<YearSlide, { id: "totals" }> }) {
  const tag = isYearComplete(summary.year, summary.asOf) ? `${summary.year} in review` : "Year to date";
  return (
    <Frame
      tag={<Tag text={tag} color={summary.simulated ? COLORS.warning : COLORS.accent} />}
      footer={[yearPeriod(summary), yearProvenance(summary)]}
    >
      <div style={line(40, COLORS.muted)}>{`${slide.title}, ${yearSummaryLabel(summary)}`}</div>
      <div style={{ ...line(slideValueSize(slide.value)), letterSpacing: -2, marginTop: 8, marginBottom: 24 }}>
        {slide.value}
      </div>
      <div style={{ display: "flex", fontSize: 30, lineHeight: 1.3, color: COLORS.muted }}>{slide.detail}</div>
    </Frame>
  );
}

/** Renders a card element as the 1200 by 630 PNG every card is. */
export function cardImageResponse(element: ReactNode, init: Readonly<{ status?: number; headers: Record<string, string> }>): ImageResponse {
  return new ImageResponse(<>{element}</>, { ...CARD_SIZE, status: init.status ?? 200, headers: init.headers });
}
