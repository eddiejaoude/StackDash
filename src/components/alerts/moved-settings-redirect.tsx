"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { movedAlertSettingsHref } from "@/lib/workspaces/paths";

/**
 * Sends a link written for the alerts page before its settings moved to their own page (#343) on
 * to alert settings, such as `/alerts#alert-emails` in every alert email sent before the move. The
 * fragment is what says so, and a fragment never reaches the server, so this runs in the browser
 * once the inbox loads. `replace` keeps the inbox out of the history, so Back does not land on it
 * and bounce forward again. The section's FragmentHeading lands on it once it streams in.
 *
 * A signed-out visit gets here after sign-in, which keeps the fragment in its return path (#358).
 */
export function MovedSettingsRedirect({ workspaceSlug }: { workspaceSlug: string }) {
  const router = useRouter();
  useEffect(() => {
    const href = movedAlertSettingsHref(workspaceSlug, window.location.search, window.location.hash);
    if (href !== null) router.replace(href);
  }, [router, workspaceSlug]);
  return null;
}
