"use client";

import { useParams } from "next/navigation";

import { NotFoundPanel } from "@/components/app/not-found-panel";
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

/**
 * Not-found page for an item inside a workspace the user is a member of (#484). Naming the missing
 * item reveals nothing new there: the segment's layout has already confirmed membership through
 * WorkspaceGate, and a missing or inaccessible workspace never reaches this page. A not-found page
 * gets no props, so the workspace comes from the URL (Next.js docs, not-found.js, "Data Fetching").
 */
export function ItemNotFound({ item }: { item: MissingItem }) {
  const { workspace } = useParams<{ workspace: string }>();
  const { title, description, section, label } = ITEMS[item];
  return (
    <NotFoundPanel
      title={title}
      description={description}
      action={{ href: workspacePath(workspace, section), label }}
    />
  );
}
