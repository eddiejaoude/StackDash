"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { EmptyState } from "@/components/app/empty-state";
import { LayersIcon, LockIcon } from "@/components/icons";
import { CreateProjectForm } from "@/components/projects/create-project-form";
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog";
import { accountCountLabel, type ProjectDeletionImpact } from "@/components/projects/project-rules";
import { RenameProjectForm } from "@/components/projects/rename-project-form";
import { buttonClass } from "@/components/ui/button";
import { LiveRegion } from "@/components/ui/live-region";

export type ProjectItem = { id: string; name: string } & ProjectDeletionImpact;

/**
 * The projects section: the create form, the list, and one status region that announces every
 * create, rename, and delete. The status region lives here, above the parts that come and go, so
 * a message survives the empty state turning into a list and a deleted row disappearing.
 */
export function ProjectsManager({
  workspaceSlug,
  projects,
  hasMore,
  limit,
  deniedReason,
}: {
  workspaceSlug: string;
  projects: ProjectItem[];
  hasMore: boolean;
  limit: number;
  /** Set when the current role cannot manage projects; replaces every control with the reason. */
  deniedReason?: string | undefined;
}) {
  const canManage = deniedReason === undefined;
  const [status, setStatus] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  // Set when the first project replaces the empty state, whose form had focus.
  const focusListOnRender = useRef(false);

  useEffect(() => {
    if (focusListOnRender.current && projects.length > 0) {
      focusListOnRender.current = false;
      listHeadingRef.current?.focus();
    }
  }, [projects]);

  const statusRegion = (
    // Always mounted so screen readers announce changes to it.
    <LiveRegion tone="status" className="text-sm text-success">
      {status === "" ? null : <p className="mt-6">{status}</p>}
    </LiveRegion>
  );

  function onCreated(name: string) {
    setStatus(`Created project ${name}.`);
    if (projects.length === 0) focusListOnRender.current = true;
  }

  if (projects.length === 0) {
    return (
      <>
        {statusRegion}
        {canManage ? (
          <EmptyState
            icon={<LayersIcon width={20} height={20} />}
            title="Create your first project"
            description="A project groups accounts from different providers, such as a Vercel project and its Supabase database, into one product."
          >
            <div className="mx-auto mt-6 max-w-lg">
              <CreateProjectForm workspaceSlug={workspaceSlug} onCreated={onCreated} autoFocus />
            </div>
          </EmptyState>
        ) : (
          <EmptyState
            icon={<LayersIcon width={20} height={20} />}
            title="No projects yet"
            description="A project groups accounts from different providers, such as a Vercel project and its Supabase database, into one product."
            deniedReason={deniedReason}
          />
        )}
      </>
    );
  }

  return (
    <>
      {statusRegion}
      {canManage ? (
        <section aria-labelledby="create-project-title" className="mt-8 rounded-xl border border-line bg-panel px-6 py-5">
          <h2 id="create-project-title" className="mb-3 text-sm font-semibold">
            Create a project
          </h2>
          <CreateProjectForm workspaceSlug={workspaceSlug} onCreated={onCreated} />
        </section>
      ) : (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted">
          <LockIcon className="shrink-0" />
          <span>{deniedReason}</span>
        </p>
      )}

      <section aria-labelledby="project-list-title" className="mt-6 rounded-xl border border-line bg-panel">
        <h2
          id="project-list-title"
          ref={listHeadingRef}
          tabIndex={-1}
          className="border-b border-line px-6 py-4 text-sm font-semibold"
        >
          All projects
        </h2>
        <ul className="divide-y divide-line">
          {projects.map((project) => (
            <ProjectRow
              key={project.id}
              workspaceSlug={workspaceSlug}
              project={project}
              canManage={canManage}
              renaming={renamingId === project.id}
              onRename={() => setRenamingId(project.id)}
              onRenameClosed={(newName) => {
                setRenamingId(null);
                if (newName !== null) setStatus(`Renamed ${project.name} to ${newName}.`);
              }}
              onDeleted={(name) => {
                setStatus(`Deleted project ${name}. Its accounts are unassigned and keep their history.`);
                // The row and its button are going; the list heading is the nearest stable place.
                // When this was the last project, the empty state's form takes focus instead.
                listHeadingRef.current?.focus();
              }}
            />
          ))}
        </ul>
        {hasMore ? (
          <p className="border-t border-line px-6 py-4 text-sm text-muted">
            Showing the first {limit} projects by name.
          </p>
        ) : null}
      </section>
    </>
  );
}

function ProjectRow({
  workspaceSlug,
  project,
  canManage,
  renaming,
  onRename,
  onRenameClosed,
  onDeleted,
}: {
  workspaceSlug: string;
  project: ProjectItem;
  canManage: boolean;
  renaming: boolean;
  onRename: () => void;
  onRenameClosed: (newName: string | null) => void;
  onDeleted: (name: string) => void;
}) {
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const focusRenameButton = useRef(false);

  // Back to the Rename button once the inline form closes, saved or cancelled.
  useEffect(() => {
    if (!renaming && focusRenameButton.current) {
      focusRenameButton.current = false;
      renameButtonRef.current?.focus();
    }
  }, [renaming]);

  if (renaming) {
    return (
      <li className="px-6 py-4">
        <RenameProjectForm
          workspaceSlug={workspaceSlug}
          project={project}
          onClose={(newName) => {
            focusRenameButton.current = true;
            onRenameClosed(newName);
          }}
        />
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium">{project.name}</p>
        <p className="mt-1 text-sm text-muted">{accountCountLabel(project.accountCount)}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {/* Every role: viewers see what is published, owners and admins publish (#148). */}
        <Link
          href={`/w/${workspaceSlug}/projects/${project.id}/public-metrics`}
          className={buttonClass("secondary", "sm")}
        >
          Public metrics<span className="sr-only"> for {project.name}</span>
        </Link>
        {/* Every role: members see what the project has earned, owners and admins publish it (#413). */}
        <Link href={`/w/${workspaceSlug}/projects/${project.id}/achievements`} className={buttonClass("secondary", "sm")}>
          Achievements<span className="sr-only"> for {project.name}</span>
        </Link>
        {canManage ? (
          <>
            <button
              ref={renameButtonRef}
              type="button"
              onClick={onRename}
              className={buttonClass("secondary", "sm")}
            >
              Rename<span className="sr-only"> {project.name}</span>
            </button>
            <DeleteProjectDialog workspaceSlug={workspaceSlug} project={project} onDeleted={onDeleted} />
          </>
        ) : null}
      </div>
    </li>
  );
}
