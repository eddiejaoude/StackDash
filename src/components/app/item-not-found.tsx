"use client";

import { useParams, useSearchParams } from "next/navigation";
import { createContext, use, type ReactNode } from "react";

import { NotFoundPanel, WorkspaceNotFoundPanel } from "@/components/app/not-found-panel";
import { workspacePath, yearInReviewPath, type WorkspaceSection } from "@/lib/workspaces/paths";

type ItemCopy = { title: string; description: string; label: string };

// Items each listed on a section of the workspace: the link opens that list.
const LISTED_ITEMS = {
  connection: {
    title: "We could not find that connection",
    description:
      "It may have been deleted, or the link may be mistyped. Every connection in this workspace is listed on the connections page.",
    section: "connections",
    label: "Open all connections",
  },
  // The connect page (connections/new/[provider]/page.tsx) also answers here for the fake provider
  // while it is switched off and for an automatic webhook choice the provider cannot use. A
  // reconnect address, one that carries `connection`, gets the connection's copy instead
  // (ItemNotFound), whichever check failed: its connection is gone or belongs to another provider,
  // but also an unknown provider, the switched-off fake provider, and the webhook case, which only
  // the server can tell apart. Only a hand-edited address should reach those; the connection page's
  // Reconnect link for a fake connection while the fake provider is off is a bug of its own.
  provider: {
    title: "We could not find that provider",
    description:
      "The link may be mistyped, or it may lead to a provider this workspace cannot connect. Choose a provider from the list on the connections page.",
    section: "connections",
    label: "Choose a provider",
  },
  project: {
    title: "We could not find that project",
    description:
      "It may have been deleted, or the link may be mistyped. Every project in this workspace is listed on the projects page.",
    section: "projects",
    label: "Open all projects",
  },
} as const satisfies Record<string, ItemCopy & { section: WorkspaceSection }>;

// A year in review that has not started, or a malformed year (year/[year]/page.tsx, #559). It has
// no list to link to, so the link opens the newest year in review instead.
const YEAR = {
  title: "We could not find that year",
  description: "The link may be mistyped, or the year may not have started yet. A year in review opens on 1 January of its year.",
  label: "Open the latest year in review",
} as const satisfies ItemCopy;

export type MissingItem = keyof typeof LISTED_ITEMS | "year";

// The year's link needs the newest year by the server's clock (year/[year]/not-found.tsx), the
// clock that decides what the year page shows; every other item links to a fixed section.
type ItemNotFoundProps = { item: Exclude<MissingItem, "year"> } | { item: "year"; latestYear: Promise<number> };

// Whether the user belongs to the workspace in the URL, resolved on the server (WorkspaceItemScope).
const MembershipContext = createContext<Promise<boolean> | null>(null);

export function WorkspaceMembershipProvider({ isMember, children }: { isMember: Promise<boolean>; children: ReactNode }) {
  return <MembershipContext value={isMember}>{children}</MembershipContext>;
}

/**
 * Not-found page of an item segment inside a workspace (#484). A segment's not-found.tsx catches
 * every `notFound()` from its page, `requireWorkspace`'s for a missing or inaccessible workspace
 * included, so it names the item only for a member: inside a workspace the user belongs to, that
 * reveals nothing new. Anyone else gets the workspace's page, which answers both cases alike.
 * A not-found page gets no props, so the workspace comes from the URL (Next.js docs, not-found.js,
 * "Data Fetching") and membership from the segment's layout.
 *
 * Membership is as of the layout's last render, not of the request that threw `notFound()`: the
 * client keeps a layout across navigations below it (Next.js docs, layout.js, "Caveats"), so a
 * user removed from the workspace while one of its pages is open can still get the item's copy.
 * That reveals nothing, because `requireWorkspace` throws before any item is read. So the answer
 * decides wording only and must never gate data.
 */
export function ItemNotFound(props: ItemNotFoundProps) {
  const { workspace } = useParams<{ workspace: string }>();
  const searchParams = useSearchParams();
  const membership = use(MembershipContext);
  // Without the layout's answer, confirm nothing.
  const isMember = membership === null ? false : use(membership);
  if (!isMember) return <WorkspaceNotFoundPanel />;

  if (props.item === "year") {
    const { title, description, label } = YEAR;
    return (
      <NotFoundPanel
        title={title}
        description={description}
        action={{ href: yearInReviewPath(workspace, use(props.latestYear)), label }}
      />
    );
  }

  // A reconnect link names a connection (connections/new/[provider]/page.tsx); when that is what is
  // missing, the provider in the address is the part that is fine.
  const missing = props.item === "provider" && searchParams.has("connection") ? "connection" : props.item;
  const { title, description, section, label } = LISTED_ITEMS[missing];
  return (
    <NotFoundPanel
      title={title}
      description={description}
      action={{ href: workspacePath(workspace, section), label }}
    />
  );
}
