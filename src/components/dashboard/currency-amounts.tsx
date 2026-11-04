import type { CurrencyAmounts, MoneyValue } from "@/lib/dashboard/aggregate";
import { formatMoney } from "@/lib/format";

import { Freshness, ProvenanceBadge, ProvenanceDetail, Unavailable } from "./value-meta";

/**
 * One money value with its provenance, source, and freshness. The headline variant prints the
 * amount large and skips the source list, because the totals at the top of the dashboard sum
 * several connections and the provider cards below already name each one.
 */
export function MoneyValueBlock({ value, now, headline = false }: { value: MoneyValue; now: Date; headline?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2">
        <span className={`font-mono font-semibold tabular-nums ${headline ? "text-2xl" : "text-lg"}`}>
          {formatMoney(value.amountMinor, value.currency)}
        </span>
        <ProvenanceBadge provenance={value.provenance} />
      </p>
      {headline ? null : <ProvenanceDetail provenance={value.provenance} sources={value.sources} />}
      <Freshness retrievedAt={value.retrievedAt} stale={value.stale} now={now} />
    </div>
  );
}

/**
 * One currency's verified and estimated amounts, side by side and labeled, never added together.
 * A missing verified amount reads "Unavailable"; an estimate is only listed when there is one.
 */
export function CurrencyAmountsList({
  amounts,
  now,
  verifiedLabel,
  estimatedLabel,
  headline = false,
}: {
  amounts: CurrencyAmounts;
  now: Date;
  verifiedLabel: string;
  estimatedLabel: string;
  /** Large amounts without the source list; see `MoneyValueBlock`. */
  headline?: boolean;
}) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      <div>
        <dt className="text-xs font-medium text-muted">{verifiedLabel}</dt>
        <dd className="mt-1">
          {amounts.verified === null ? (
            <Unavailable />
          ) : (
            <MoneyValueBlock value={amounts.verified} now={now} headline={headline} />
          )}
        </dd>
      </div>
      {amounts.estimated === null ? null : (
        <div>
          <dt className="text-xs font-medium text-muted">{estimatedLabel}</dt>
          <dd className="mt-1">
            <MoneyValueBlock value={amounts.estimated} now={now} headline={headline} />
          </dd>
        </div>
      )}
    </dl>
  );
}
