import { useId } from "react";

import { SimulatedBadge } from "@/components/connections/simulated-badge";
import type { Allowance, ProviderSummary, QuantityValue } from "@/lib/dashboard/aggregate";
import { formatDateTime, formatPercent, formatPeriod, formatQuantity } from "@/lib/format";
import { providerName } from "@/lib/providers";

import { CurrencyAmountsList, MoneyValueBlock } from "./currency-amounts";
import { connectionStatusLabel, Freshness, ProvenanceBadge, ProviderMark, Unavailable } from "./value-meta";

function QuantityCell({ label, value }: { label: string; value: QuantityValue | null }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-center gap-2">
        {value === null ? (
          <Unavailable />
        ) : (
          <>
            <span className="font-mono font-semibold tabular-nums">{formatQuantity(value.value, value.unit)}</span>
            <ProvenanceBadge provenance={value.provenance} />
          </>
        )}
      </dd>
    </div>
  );
}

function AllowanceCard({ allowance, now }: { allowance: Allowance; now: Date }) {
  const titleId = useId();
  const parts = [allowance.included, allowance.used, allowance.remaining].filter((value) => value !== null);
  // The oldest part decides "Updated", and one stale part marks the card stale.
  const oldest = parts.reduce<QuantityValue | null>(
    (current, value) => (current === null || Date.parse(value.retrievedAt) < Date.parse(current.retrievedAt) ? value : current),
    null,
  );
  const stale = parts.some((value) => value.stale);
  const percent = allowance.percentUsed;
  return (
    <li>
      <article aria-labelledby={titleId} className="rounded-lg border border-line bg-panel-raised p-4">
        <h5 id={titleId} className="text-sm font-semibold">
          {allowance.label}
        </h5>
        <p className="text-xs text-muted">{allowance.accountName}</p>
        {/* Two columns once provider cards sit two to a row, so quantities and their badges fit. */}
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
          <QuantityCell label="Included" value={allowance.included} />
          <QuantityCell label="Used" value={allowance.used} />
          <QuantityCell label="Remaining" value={allowance.remaining} />
          <div>
            <dt className="text-xs font-medium text-muted">Percent used</dt>
            <dd className="mt-1 font-mono font-semibold tabular-nums">
              {percent === null ? <Unavailable /> : formatPercent(percent)}
            </dd>
          </div>
        </dl>
        {percent === null ? null : (
          // The number above is the accessible value; the bar only repeats it visually.
          <div aria-hidden="true" className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className={`h-full rounded-full ${percent >= 100 ? "bg-danger" : percent >= 80 ? "bg-warning" : "bg-accent"}`}
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </div>
        )}
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-1">
            <dt className="text-muted">Billing period:</dt>
            <dd>{allowance.period === null ? <Unavailable /> : formatPeriod(allowance.period)}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted">Resets:</dt>
            <dd>
              {allowance.resetsAt === null ? (
                <Unavailable />
              ) : (
                <time dateTime={allowance.resetsAt}>{formatDateTime(allowance.resetsAt)}</time>
              )}
            </dd>
          </div>
        </dl>
        {oldest === null ? null : (
          <div className="mt-2">
            <Freshness retrievedAt={oldest.retrievedAt} stale={stale} now={now} />
          </div>
        )}
      </article>
    </li>
  );
}

/** One connection: its spend, revenue, credit balance, billing period, and allowances. */
export function ProviderCard({ summary, now }: { summary: ProviderSummary; now: Date }) {
  const titleId = useId();
  const name = providerName(summary.provider);
  return (
    <li>
      <article aria-labelledby={titleId} className="h-full rounded-xl border border-line bg-panel p-4">
        <header className="flex flex-wrap items-start gap-3">
          <ProviderMark provider={summary.provider} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={titleId} className="font-semibold">
                {summary.name}
              </h3>
              {summary.simulated ? <SimulatedBadge /> : null}
            </div>
            <p className="text-xs text-muted">
              {name}. Status: {connectionStatusLabel(summary.status)}
            </p>
          </div>
          <div className="text-right">
            {summary.lastSyncedAt === null ? (
              <p className="text-xs text-muted">Not synced yet</p>
            ) : (
              <Freshness retrievedAt={summary.lastSyncedAt} stale={summary.stale} now={now} />
            )}
          </div>
        </header>

        <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-1">
            <dt className="text-muted">Billing period:</dt>
            <dd>{summary.billingPeriod === null ? <Unavailable /> : formatPeriod(summary.billingPeriod)}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted">Next reset:</dt>
            <dd>
              {summary.resetsAt === null ? (
                <Unavailable />
              ) : (
                <time dateTime={summary.resetsAt}>{formatDateTime(summary.resetsAt)}</time>
              )}
            </dd>
          </div>
        </dl>

        <h4 className="mt-5 text-sm font-semibold">Spend this billing period</h4>
        {summary.spend.length === 0 ? (
          <p className="mt-1 text-sm">
            <Unavailable />
          </p>
        ) : (
          <ul className="mt-2 space-y-4">
            {summary.spend.map((amounts) => (
              <li key={amounts.currency}>
                <p className="mb-1 font-mono text-xs font-medium text-muted">{amounts.currency}</p>
                <CurrencyAmountsList
                  amounts={amounts}
                  now={now}
                  verifiedLabel="Verified spend"
                  estimatedLabel="Estimated spend"
                />
              </li>
            ))}
          </ul>
        )}

        <h4 className="mt-5 text-sm font-semibold">Credit balance</h4>
        {summary.credits.length === 0 ? (
          <p className="mt-1 text-sm">
            <Unavailable />
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {summary.credits.map((credit) => (
              <li key={`${credit.currency}-${credit.provenance.status}`}>
                <MoneyValueBlock value={credit} now={now} />
              </li>
            ))}
          </ul>
        )}

        {summary.revenue.length === 0 ? null : (
          <>
            <h4 className="mt-5 text-sm font-semibold">Revenue this billing period</h4>
            <ul className="mt-2 space-y-4">
              {summary.revenue.map((amounts) => (
                <li key={amounts.currency}>
                  <p className="mb-1 font-mono text-xs font-medium text-muted">{amounts.currency}</p>
                  <CurrencyAmountsList
                    amounts={amounts}
                    now={now}
                    verifiedLabel="Verified revenue"
                    estimatedLabel="Estimated revenue"
                  />
                </li>
              ))}
            </ul>
          </>
        )}

        {summary.allowances.length === 0 ? null : (
          <>
            <h4 className="mt-5 text-sm font-semibold">Allowances</h4>
            <ul className="mt-2 space-y-3">
              {summary.allowances.map((allowance) => (
                <AllowanceCard key={allowance.key} allowance={allowance} now={now} />
              ))}
            </ul>
          </>
        )}
      </article>
    </li>
  );
}
