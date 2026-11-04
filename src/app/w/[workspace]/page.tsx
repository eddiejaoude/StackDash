import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/app/page-skeleton";
import { isWorkspaceSlug, workspaceHome } from "@/lib/workspaces/access";

// The workspace root has no content of its own; the timeline is its home. Access is checked
// there, so this only refuses slugs that could never be valid. Params are read inside Suspense,
// like every page in this segment, so the navigation has an instant shell.
export default function WorkspaceIndexPage(props: PageProps<"/w/[workspace]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WorkspaceIndexContent {...props} />
    </Suspense>
  );
}

// Always redirects or 404s, so it never resolves to markup.
async function WorkspaceIndexContent({ params }: PageProps<"/w/[workspace]">): Promise<never> {
  const { workspace } = await params;
  if (!isWorkspaceSlug(workspace)) notFound();
  redirect(workspaceHome(workspace));
}
