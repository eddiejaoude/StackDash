import { WorkspaceNotFoundPanel } from "@/components/app/not-found-panel";

// A missing workspace and one the user is not a member of get the same page. Inside a workspace the
// user belongs to, a missing connection, provider on the connect page, or project gets its own page
// instead (ItemNotFound, #484). Every other missing item still lands here, such as a year in review
// that has not started (year/[year]/page.tsx, until #559).
export default function WorkspaceNotFound() {
  return <WorkspaceNotFoundPanel />;
}
