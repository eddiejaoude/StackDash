// Success marks good news (a signup, a payment, a deploy that went live) so it stands out from
// neutral events. The word is always printed, so color is never the only signal.
export type Severity = "Success" | "Alert" | "Failed" | "Summary" | "Event";

const SEVERITY_CLASSES: Record<Severity, string> = {
  Success: "border-success/40 text-success",
  Alert: "border-warning/40 text-warning",
  Failed: "border-danger/40 text-danger",
  Summary: "border-line text-muted",
  Event: "border-line text-muted",
};

/** Event severity as a text pill, so color is never the only carrier of meaning. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${SEVERITY_CLASSES[severity]}`}
    >
      {severity}
    </span>
  );
}
