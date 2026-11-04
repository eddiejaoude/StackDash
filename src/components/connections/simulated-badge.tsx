/**
 * Marks a provider the local simulator stands in for (#131), so made-up data is never mistaken for
 * real data. Words, not color alone. Callers decide with `isProviderSimulated` on the server.
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
