/**
 * Marks a connection the provider simulator made, and data from it (#131), so made-up data is never
 * mistaken for real data. Words, not color alone. Callers decide on the server: an existing
 * connection from its own marker (`isSimulatedConnection`), the catalog and connect screen from
 * the adapter this instance uses.
 */
export function SimulatedBadge() {
  return (
    <span
      title="Example data made up on this computer, not read from the provider"
      className="inline-flex shrink-0 items-center rounded-full border border-warning/40 px-2 py-0.5 text-xs font-medium text-warning"
    >
      Simulated
    </span>
  );
}
