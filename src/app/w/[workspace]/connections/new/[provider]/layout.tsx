import { WorkspaceGate } from "@/components/app/workspace-gate";

// Confirms the workspace before this segment's not-found.tsx can catch anything, so a missing or
// inaccessible workspace still gets the workspace's not-found page (#484).
export default function ConnectProviderLayout({ children, params }: LayoutProps<"/w/[workspace]/connections/new/[provider]">) {
  return (
    <WorkspaceGate
      params={params}
      loadingLabel="Loading the connection form"
    >
      {children}
    </WorkspaceGate>
  );
}
