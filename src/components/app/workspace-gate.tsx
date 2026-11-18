import { Suspense, type ReactNode } from "react";

import { PageSkeleton } from "@/components/app/page-skeleton";
import { requireWorkspace } from "@/lib/workspaces/access";

/**
 * Confirms the workspace in the URL before an item segment renders (#484). An item segment's own
 * not-found.tsx catches every `notFound()` below its layout, `requireWorkspace`'s included, so
 * without this check a missing or inaccessible workspace would get the item's page and its copy.
 * Thrown here, in the layout, the `notFound()` passes that boundary and reaches the workspace's
 * not-found page, which answers both cases alike. `requireWorkspace` is request-cached, so the
 * page's own call with the same role reads nothing again.
 *
 * It streams behind the page's skeleton, so a navigation into the segment keeps its instant shell.
 */
export function WorkspaceGate({
  params,
  loadingLabel,
  children,
}: {
  params: Promise<{ workspace: string }>;
  loadingLabel: string;
  children: ReactNode;
}) {
  return (
    <Suspense fallback={<PageSkeleton label={loadingLabel} />}>
      <Gate params={params}>{children}</Gate>
    </Suspense>
  );
}

async function Gate({ params, children }: { params: Promise<{ workspace: string }>; children: ReactNode }) {
  const { workspace } = await params;
  await requireWorkspace(workspace, "viewer");
  return children;
}
