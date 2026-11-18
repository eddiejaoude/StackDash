import { WorkspaceItemScope } from "@/components/app/workspace-item-scope";

// Lets this segment's not-found page name the missing item for a member only (#484).
export default function ProjectLayout({ children, params }: LayoutProps<"/w/[workspace]/projects/[projectId]">) {
  return <WorkspaceItemScope params={params}>{children}</WorkspaceItemScope>;
}
