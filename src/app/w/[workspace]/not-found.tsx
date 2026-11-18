import { WorkspaceNotFoundPanel } from "@/components/app/not-found-panel";

// A missing workspace and one the user is not a member of get the same page. Inside a workspace the
// user belongs to, a missing connection, provider on the connect page, or project (#484), and a year
// in review that has not started (#559), gets its own page instead (ItemNotFound). Every other
// missing item still lands here.
export default function WorkspaceNotFound() {
  return <WorkspaceNotFoundPanel />;
}
