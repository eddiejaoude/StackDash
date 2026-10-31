import { LiveEventFeed } from "@/components/live-event-feed";

type CostSource = "Verified cost" | "Estimated cost" | "Allowance" | "Budget";

interface PreviewRow {
  provider: string;
  detail: string;
  source: CostSource;
  measure: { kind: "share"; percentUsed: number } | { kind: "amount"; amountMinor: number };
}

// Illustrative values only, labeled as such in the UI. Not real provider data. Every row is a
// first-release integration (issue #11). The GitHub cost rows come from the organization billing
// usage endpoints the GitHub App in issue #51 reads with "Administration" set to read.
const previewRows: readonly PreviewRow[] = [
  { provider: "Vercel", detail: "$22.80 of a $25 budget", source: "Budget", measure: { kind: "share", percentUsed: 91 } },
  { provider: "Resend", detail: "Monthly emails · resets in 9 days", source: "Allowance", measure: { kind: "share", percentUsed: 75 } },
  { provider: "GitHub Actions", detail: "Included minutes · resets in 21 days", source: "Allowance", measure: { kind: "share", percentUsed: 42 } },
  { provider: "Stripe", detail: "Processing fees this month", source: "Verified cost", measure: { kind: "amount", amountMinor: 1450 } },
  { provider: "GitHub Copilot", detail: "Premium requests beyond the plan", source: "Verified cost", measure: { kind: "amount", amountMinor: 400 } },
  { provider: "GitHub Actions", detail: "Larger runner minutes, not in the allowance", source: "Verified cost", measure: { kind: "amount", amountMinor: 240 } },
  { provider: "Supabase", detail: "Pro plan price, from published pricing", source: "Estimated cost", measure: { kind: "amount", amountMinor: 2500 } },
];

// Verified spend per day so far this month, in cents. Sums to the $43.70 verified total:
// Vercel $22.80 + Stripe fees $14.50 + GitHub Copilot $4.00 + GitHub Actions $2.40.
const dailyVerifiedMinor: readonly number[] = [
  135, 140, 125, 150, 170, 150, 145, 175, 185, 165, 195, 210, 185, 205, 230, 225, 240, 260, 235, 265, 280, 300,
];
const VERIFIED_MINOR = 4370;
const ESTIMATED_MINOR = 2500;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

type CountFormat = "usd" | "percent" | "integer";

interface StatTile {
  term: string;
  value: number;
  format: CountFormat;
  /** Printed after the number, outside the count-up. */
  unit?: string;
  note: string;
}

// Verified and estimated stay in separate tiles: different kinds of number are never summed.
const statTiles: readonly StatTile[] = [
  { term: "Verified", value: VERIFIED_MINOR, format: "usd", note: "From billing APIs" },
  { term: "Estimated", value: ESTIMATED_MINOR, format: "usd", note: "From published pricing" },
  { term: "Near a limit", value: 2, format: "integer", note: "Of 3 allowances and budgets" },
  { term: "Next reset", value: 9, format: "integer", unit: "days", note: "Resend monthly emails" },
];

function formatCount(value: number, format: CountFormat): string {
  if (format === "usd") return usd.format(value / 100);
  if (format === "percent") return percent.format(value / 100);
  return String(value);
}

/**
 * A number that counts up from zero in CSS (see `.count-up` in globals.css). Screen readers get
 * the real value as text; the animated digits are decoration.
 */
function CountUp({ value, format, delayMs }: { value: number; format: CountFormat; delayMs: number }) {
  const text = formatCount(value, format);
  return (
    <>
      <span className="sr-only">{text}</span>
      <span
        aria-hidden="true"
        className="count-up"
        data-format={format}
        data-value={text}
        style={{ "--count-to": value, animationDelay: `${delayMs}ms` }}
      />
    </>
  );
}

function barColor(percentUsed: number): string {
  if (percentUsed >= 90) return "bg-danger";
  if (percentUsed >= 75) return "bg-warning";
  return "bg-success";
}

const SPARK_WIDTH = 320;
const SPARK_HEIGHT = 64;
const SPARK_PAD = 6;

/** Smoothed line through the daily values, plus the closed area under it. */
function sparkPaths(values: readonly number[]): { line: string; area: string; end: { x: number; y: number } } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = values.map((value, index) => ({
    x: (index / (values.length - 1)) * SPARK_WIDTH,
    y: SPARK_HEIGHT - SPARK_PAD - ((value - min) / (max - min)) * (SPARK_HEIGHT - SPARK_PAD * 2),
  }));
  const first = points[0];
  const end = points[points.length - 1];
  if (first === undefined || end === undefined) throw new Error("A sparkline needs at least one value");
  // Each segment curves through its point toward the midpoint of the next: smooth, never overshoots.
  let line = `M ${first.x} ${first.y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index];
    const next = points[index + 1];
    if (point === undefined || next === undefined) continue;
    line += ` Q ${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.y + next.y) / 2}`;
  }
  line += ` L ${end.x} ${end.y}`;
  return { line, area: `${line} L ${end.x} ${SPARK_HEIGHT} L 0 ${SPARK_HEIGHT} Z`, end };
}

const spark = sparkPaths(dailyVerifiedMinor);
const todayMinor = dailyVerifiedMinor[dailyVerifiedMinor.length - 1] ?? 0;

// Entrance timing, in step with the window's tilt-in (globals.css `.window-in`, 0.25s + 1.3s).
// Totals count first, rows follow, each bar fills as its row lands, and the budget alert
// (`.alert-in`, 2.1s) drops in as the 91% bar finishes filling.
const STATS_DELAY_MS = 500;
const ROW_START_MS = 600;
const ROW_STAGGER_MS = 70;
const BAR_AFTER_ROW_MS = 150;

/** Window header strip: the month's headline numbers, counting up. */
function MonthSummary() {
  return (
    <div className="border-b border-line p-5 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">This month</p>
        <p className="font-mono text-xs text-muted">5 providers · synced 4 min ago</p>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {statTiles.map((stat) => (
          <div key={stat.term} className="rounded-lg border border-line bg-panel-raised px-3.5 py-3">
            <dt className="font-mono text-[10px] uppercase tracking-wide text-muted">{stat.term}</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight">
              <CountUp value={stat.value} format={stat.format} delayMs={STATS_DELAY_MS} />
              {stat.unit ? <span className="ml-1.5 text-sm font-normal text-muted">{stat.unit}</span> : null}
            </dd>
            <dd className="mt-0.5 text-xs text-muted">{stat.note}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Left column: the spending trend, the budget alert, and every provider's number. */
function MonthDetail() {
  return (
    <div className="p-5 sm:p-6">
      <div className="rounded-lg border border-line bg-panel-raised px-3 pb-1 pt-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-mono text-[10px] uppercase tracking-wide text-muted">Verified spend per day</p>
          <p className="font-mono text-xs text-muted">
            Today <span className="text-foreground">{usd.format(todayMinor / 100)}</span>
          </p>
        </div>
        <svg viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} className="mt-1 block h-auto w-full overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id="hero-spark-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path className="spark-area" d={spark.area} fill="url(#hero-spark-fill)" />
          <path
            className="spark-line"
            d={spark.line}
            pathLength={1}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle className="spark-ping" cx={spark.end.x} cy={spark.end.y} r={4} fill="var(--accent)" />
          <circle className="spark-dot" cx={spark.end.x} cy={spark.end.y} r={4} fill="var(--accent)" stroke="var(--panel-raised)" strokeWidth={2} />
        </svg>
      </div>

      <p className="alert-in mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-5 text-warning">
        <span aria-hidden="true">▲</span>
        Vercel passed 90% of your $25 monthly budget.
      </p>

      <ul className="mt-1 divide-y divide-line">
        {previewRows.map((row, index) => {
          const rowDelayMs = ROW_START_MS + index * ROW_STAGGER_MS;
          const valueDelayMs = rowDelayMs + BAR_AFTER_ROW_MS;
          return (
            <li key={`${row.provider} ${row.source}`} className="rise-in py-2" style={{ animationDelay: `${rowDelayMs}ms` }}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm">{row.provider}</span>
                <span className="font-mono text-sm">
                  {row.measure.kind === "share" ? (
                    <CountUp value={row.measure.percentUsed} format="percent" delayMs={valueDelayMs} />
                  ) : (
                    <CountUp value={row.measure.amountMinor} format="usd" delayMs={valueDelayMs} />
                  )}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-3 text-xs text-muted">
                <span>{row.detail}</span>
                <span className="shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide">
                  {row.source}
                </span>
              </div>
              {row.measure.kind === "share" ? (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
                  <div
                    className={`bar-fill h-full rounded-full ${barColor(row.measure.percentUsed)}`}
                    style={{ width: `${row.measure.percentUsed}%`, animationDelay: `${valueDelayMs}ms` }}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The hero's product picture: one window with this month's spending and allowances beside the
 * live events feed. Everything moves in CSS except the feed, which is the only client code.
 */
export function HeroPreview() {
  return (
    <div className="window-stage">
      <figure className="window-in overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]">
        <div className="flex items-center gap-3 border-b border-line bg-panel-raised px-4 py-2.5">
          <span className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-line-strong" />
            <span className="size-2.5 rounded-full bg-line-strong" />
            <span className="size-2.5 rounded-full bg-line-strong" />
          </span>
          <p className="flex-1 text-center font-mono text-xs text-muted">Acme workspace · DevMacro</p>
          <span className="w-[42px]" aria-hidden="true" />
        </div>

        <MonthSummary />

        <div className="grid lg:grid-cols-[1.1fr_1fr]">
          <MonthDetail />
          <div className="border-t border-line lg:border-l lg:border-t-0">
            <LiveEventFeed />
          </div>
        </div>

        <figcaption className="border-t border-line px-5 py-3 text-xs text-muted">
          Example data. Every figure is labeled as verified, estimated, an allowance, or your own budget, and the
          events are simulated in your browser.
        </figcaption>
      </figure>
    </div>
  );
}
