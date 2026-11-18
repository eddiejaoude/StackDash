import { NotFoundPanel } from "@/components/app/not-found-panel";

// One response for a workspace that does not exist and one the user is not a member of, so the
// page never confirms which workspace addresses are real. A missing item inside a workspace the
// user belongs to gets its own page instead (ItemNotFound, #484).
export default function WorkspaceNotFound() {
  return (
    <NotFoundPanel
      title="We could not find that workspace"
      description="The link may be mistyped, or you may not be a member of this workspace. Check the address, or ask a workspace owner to invite you. You can open any workspace you already belong to."
      action={{ href: "/app", label: "Open your workspaces" }}
    />
  );
}
