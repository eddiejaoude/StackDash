import type { ReactNode } from "react";

import { WorkspaceMembershipProvider } from "@/components/app/item-not-found";
import { isWorkspaceMember } from "@/lib/workspaces/access";

/**
 * Layout of an item segment inside a workspace (#484): gives the segment's not-found page whether
 * the user belongs to the workspace, so it names the missing item only for a member. The answer is
 * a promise the layout never awaits, so the layout never blocks the page's instant shell, and it
 * never throws `notFound()` itself: the page's own checks decide what is missing, as before.
 */
export function WorkspaceItemScope({ params, children }: { params: Promise<{ workspace: string }>; children: ReactNode }) {
  return (
    <WorkspaceMembershipProvider isMember={params.then(({ workspace }) => isWorkspaceMember(workspace))}>
      {children}
    </WorkspaceMembershipProvider>
  );
}
