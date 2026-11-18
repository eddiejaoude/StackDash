import { WorkspaceItemScope } from "@/components/app/workspace-item-scope";

// Lets this segment's not-found page name the missing item for a member only (#484).
export default function ConnectionLayout({ children, params }: LayoutProps<"/w/[workspace]/connections/[connectionId]">) {
  return <WorkspaceItemScope params={params}>{children}</WorkspaceItemScope>;
}
