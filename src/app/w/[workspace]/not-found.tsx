import { WorkspaceNotFoundPanel } from "@/components/app/not-found-panel";

// A missing workspace and one the user is not a member of get the same page. A missing item inside
// a workspace the user belongs to gets its own page instead (ItemNotFound, #484).
export default function WorkspaceNotFound() {
  return <WorkspaceNotFoundPanel />;
}
