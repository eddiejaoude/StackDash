// Success marks good news (a signup, a payment, a deploy that went live) so it stands out from
// neutral events. Achievement marks a project milestone (#413) in gold on a tinted fill, so it reads
// as rarer than everyday good news and differs from the outlined warning pill in shape too.
// The word is always printed, so color is never the only signal.
// "Warning" and "Critical" are the app timeline's words for stored event severities; the landing
// page keeps its own vocabulary.
export type Severity = "Success" | "Achievement" | "Alert" | "Failed" | "Summary" | "Event" | "Warning" | "Critical";

const SEVERITY_CLASSES: Record<Severity, string> = {
  Success: "border-success/40 text-success",
  Achievement: "border-gold/50 bg-gold-soft text-gold",
  Alert: "border-warning/40 text-warning",
  Failed: "border-danger/40 text-danger",
  Summary: "border-line text-muted",
  Event: "border-line text-muted",
  Warning: "border-warning/40 text-warning",
  Critical: "border-danger/40 text-danger",
};

/** Event severity as a text pill, so color is never the only carrier of meaning. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] ${SEVERITY_CLASSES[severity]}`}
    >
      {severity}
    </span>
  );
}
