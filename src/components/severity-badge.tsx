// Success marks good news (a signup, a payment, a deploy that went live) so it stands out from
// neutral events. Achievement marks a project milestone (#413) in gold on a tinted fill, so it reads
// as rarer than everyday good news and differs from the outlined warning pill in shape too.
// The word is always printed, so color is never the only signal.
// "Info", "Warning", and "Critical" are the app timeline's words for stored event severities
// (`severityBadge`, #594); the landing page keeps its own vocabulary, with "Event" for a neutral
// one. Info's fill is the panel color so the pill stays distinct on a hovered row's raised wash.
export type Severity = "Success" | "Achievement" | "Alert" | "Failed" | "Summary" | "Event" | "Info" | "Warning" | "Critical";

const SEVERITY_CLASSES: Record<Severity, string> = {
  Success: "border-success/40 text-success",
  Achievement: "border-gold/50 bg-gold-soft text-gold",
  Alert: "border-warning/40 text-warning",
  Failed: "border-danger/40 text-danger",
  Summary: "border-line text-muted",
  Event: "border-line text-muted",
  Info: "border-line bg-panel text-muted",
  Warning: "border-warning/40 text-warning",
  Critical: "border-danger/40 text-danger",
};

/** Event severity with an optional decorative icon, so color is never the only carrier of meaning. */
export function SeverityBadge({ severity, emoji }: { severity: Severity; emoji?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] ${SEVERITY_CLASSES[severity]}`}
    >
      {emoji === undefined ? null : <span aria-hidden="true" className="text-[11px] leading-none">{emoji}</span>}
      <span>{severity}</span>
    </span>
  );
}
