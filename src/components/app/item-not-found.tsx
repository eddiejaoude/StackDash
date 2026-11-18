"use client";

import { useParams } from "next/navigation";
import { createContext, use, type ReactNode } from "react";

import { NotFoundPanel, WorkspaceNotFoundPanel } from "@/components/app/not-found-panel";
import { workspacePath, type WorkspaceSection } from "@/lib/workspaces/paths";

const ITEMS = {
  connection: {
    title: "We could not find that connection",
    description:
      "It may have been deleted, or the link may be mistyped. Every connection in this workspace is listed on the connections page.",
    section: "connections",
    label: "Open all connections",
  },
  // The connect page's not-found also answers a reconnect link whose connection is gone or belongs
  // to another provider, so the copy names both.
  provider: {
    title: "We could not find that provider",
    description:
      "The link may be mistyped, or it may lead to a provider or connection this workspace cannot connect. Choose a provider from the list on the connections page.",
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
} as const satisfies Record<string, { title: string; description: string; section: WorkspaceSection; label: string }>;

export type MissingItem = keyof typeof ITEMS;

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
 */
export function ItemNotFound({ item }: { item: MissingItem }) {
  const { workspace } = useParams<{ workspace: string }>();
  const membership = use(MembershipContext);
  // Without the layout's answer, confirm nothing.
  const isMember = membership === null ? false : use(membership);
  if (!isMember) return <WorkspaceNotFoundPanel />;

  const { title, description, section, label } = ITEMS[item];
  return (
    <NotFoundPanel
      title={title}
      description={description}
      action={{ href: workspacePath(workspace, section), label }}
    />
  );
}
