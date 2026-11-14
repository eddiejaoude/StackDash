import type { SVGProps } from "react";

import { GaugeIcon, ShieldIcon } from "@/components/icons";
import {
  freshnessLabel,
  type ConnectionStatus,
  type Provenance,
  type ValueSource,
} from "@/lib/dashboard/aggregate";
import { spendProjectionText, type ProjectionText, type SpendProjection } from "@/lib/dashboard/projection";
import { formatDateTime } from "@/lib/format";
import { providerName } from "@/lib/providers";

import { InfoTooltip } from "./info-tooltip";

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  pending: "Pending",
  active: "Active",
  needs_attention: "Needs attention",
  revoked: "Revoked",
  failed: "Failed",
};

export function connectionStatusLabel(status: ConnectionStatus): string {
  return STATUS_LABELS[status];
}

function EstimateIcon(props: SVGProps<SVGSVGElement>) {
  // A dashed circle around a tilde: "approximately", drawn so it differs from the verified shield
  // in shape, not only in color.
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
      <path d="M7.5 12.5c1.5-2 3-2 4.5 0s3 2 4.5 0" />
    </svg>
  );
}

/** A clock: data that has not been refreshed. Always beside the word that says so. */
export function StaleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/**
 * "Verified" or "Estimated" as words, each with its own icon and border style (solid or dashed),
 * so the difference never rests on color.
 */
export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  if (provenance.status === "verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-success/50 px-2 py-0.5 text-xs font-medium text-success">
        <ShieldIcon width={14} height={14} />
        Verified
      </span>
    );
  }
  return <EstimateBadge label="Estimated" />;
}

/** The dashed "approximately" badge, for an estimated value or a projection. */
function EstimateBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-warning/60 px-2 py-0.5 text-xs font-medium text-warning">
      <EstimateIcon />
      {label}
    </span>
  );
}

/**
 * A projection to the end of a period (#167): the figure, labeled "Estimate by StackDash" in words
 * with the estimate icon. How it was calculated sits behind an info button beside the badge (#269),
 * as the button's accessible description, so it is one keystroke or tap away rather than a
 * paragraph under every projection. `estimate` is false when nothing was projected or the figure is
 * an observed reading: then the text is the reason, which is the whole note, so it stays in view.
 * `flag` is a short status in words, such as "Projected to cross", shown as a badge with its own
 * icon.
 */
export function ProjectionNote({ text, estimate, flag }: { text: ProjectionText; estimate: boolean; flag?: string }) {
  return (
    <div className="mt-3 rounded-lg border border-dashed border-line-strong p-3">
      {/* Relative: the method's tooltip spans this row, so it stays inside the card however the row wraps. */}
      <p className="relative flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
        {flag === undefined ? null : (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning px-2 py-0.5 text-xs font-semibold text-warning">
            <GaugeIcon width={14} height={14} />
            {flag}
          </span>
        )}
        <span>{text.headline}</span>
        {estimate ? (
          <>
            <EstimateBadge label="Estimate by StackDash" />
            <InfoTooltip label="How this projection is worked out" text={text.explanation} placement="container" />
          </>
        ) : null}
      </p>
      {estimate ? null : <p className="mt-1 text-xs leading-5 text-muted">{text.explanation}</p>}
    </div>
  );
}

/**
 * The spend projection for one currency, or nothing when there is no current spend in it.
 * `partsNote` says where the amounts of a total are shown one by one (see `spendProjectionText`).
 */
export function SpendProjectionNote({ projection, partsNote }: { projection: SpendProjection | undefined; partsNote?: string }) {
  if (projection === undefined) return null;
  return <ProjectionNote text={spendProjectionText(projection, partsNote)} estimate={projection.projection.status === "projected"} />;
}

/** Where a value came from: the provider for verified values, the price list for estimates. */
export function ProvenanceDetail({ provenance, sources }: { provenance: Provenance; sources: readonly ValueSource[] }) {
  const from = sources.map((source) => `${source.connectionName} (${providerName(source.provider)})`).join(", ");
  if (provenance.status === "verified") {
    return <p className="text-xs leading-5 text-muted">From the provider: {from}</p>;
  }
  const pricing = provenance.pricingSources.length > 0 ? provenance.pricingSources.join(", ") : "calculated by StackDash";
  return (
    <p className="text-xs leading-5 text-muted">
      Estimated from {from}. Pricing source: {pricing}
    </p>
  );
}

/** "Updated 5 minutes ago", or a stale warning with an icon and the word "Stale". */
export function Freshness({ retrievedAt, stale, now }: { retrievedAt: string; stale: boolean; now: Date }) {
  const label = freshnessLabel(retrievedAt, stale, now);
  return (
    <p className={`flex items-center gap-1 text-xs leading-5 ${stale ? "font-medium text-warning" : "text-muted"}`}>
      {stale ? <StaleIcon className="shrink-0" /> : null}
      <time dateTime={retrievedAt} title={formatDateTime(retrievedAt)}>
        {label}
      </time>
    </p>
  );
}

/** A value that is missing. Never shown as 0. */
export function Unavailable() {
  return <span className="text-muted">Unavailable</span>;
}
