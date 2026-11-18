import { WorkspaceItemScope } from "@/components/app/workspace-item-scope";

// Lets this segment's not-found page name the missing year for a member only (#559). The slide
// images beside the page (`[slide]/route.tsx`) are route handlers, which no layout wraps.
export default function YearLayout({ children, params }: LayoutProps<"/w/[workspace]/year/[year]">) {
  return <WorkspaceItemScope params={params}>{children}</WorkspaceItemScope>;
}
