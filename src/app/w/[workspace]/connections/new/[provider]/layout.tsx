import { WorkspaceItemScope } from "@/components/app/workspace-item-scope";

// Lets this segment's not-found page name the missing item for a member only (#484).
export default function ConnectProviderLayout({ children, params }: LayoutProps<"/w/[workspace]/connections/new/[provider]">) {
  return <WorkspaceItemScope params={params}>{children}</WorkspaceItemScope>;
}
