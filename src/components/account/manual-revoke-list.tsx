export type ManualRevokeItem = Readonly<{
  key: string;
  providerName: string;
  // Why the user has to act, e.g. "does not let apps revoke their own access".
  reason: string;
  steps: string;
  referenceId?: string;
}>;

/** Per provider: why StackDash could not remove its access, and how to remove it by hand. */
export function ManualRevokeList({ items, label }: { items: readonly ManualRevokeItem[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.key} className="rounded-lg border border-line bg-panel-raised px-4 py-3 text-sm leading-6">
          <p className="font-medium">{item.providerName}</p>
          <p className="text-muted">
            {item.reason}
            {item.referenceId === undefined ? null : (
              <>
                {" "}
                Reference <code className="font-mono text-xs text-foreground">{item.referenceId}</code>.
              </>
            )}
          </p>
          <p className="mt-1">{item.steps}</p>
        </li>
      ))}
    </ul>
  );
}
