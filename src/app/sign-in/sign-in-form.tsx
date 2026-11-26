"use client";

import { useSyncExternalStore } from "react";
import { useFormStatus } from "react-dom";

import { GuardedButton } from "@/components/guarded-button";
import { GitHubIcon } from "@/components/icons";
import { buttonClass } from "@/components/ui/button";
import { LiveRegion } from "@/components/ui/live-region";
import { SIGN_IN_FRAGMENT_FIELD } from "@/lib/auth/redirect";

// The page's fragment, as an external store. The server has none, so the first render (and
// hydration) matches it, and the browser's value follows straight after.
function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const currentHash = () => window.location.hash;
const serverHash = () => "";

function ContinueButton() {
  // Leaving for GitHub takes a moment; say so, and stop a second click from starting a second flow.
  const { pending } = useFormStatus();
  return (
    <>
      <GuardedButton
        type="submit"
        unavailable={pending}
        aria-describedby="sign-in-status"
        className={`${buttonClass("primary", "lg")} w-full gap-2.5 aria-disabled:cursor-wait`}
      >
        <GitHubIcon />
        Continue with GitHub
      </GuardedButton>
      <LiveRegion tone="status" as="p" id="sign-in-status" className="mt-3 min-h-5 text-center text-xs text-muted">
        {pending ? "Opening GitHub sign-in" : ""}
      </LiveRegion>
    </>
  );
}

/**
 * The one sign-in action. `action` is a Server Function with the return path already bound.
 *
 * The link the reader opened may name a section, such as `#alert-emails` in an alert email. Its
 * fragment never reaches the server, so the proxy's `next` lacks it, but the browser keeps it on
 * `/sign-in`; the form sends it along for `action` to add to the return path (#358).
 */
export function SignInForm({ action }: { action: (formData: FormData) => Promise<void> }) {
  const hash = useSyncExternalStore(subscribeToHash, currentHash, serverHash);
  return (
    <form action={action}>
      <input type="hidden" name={SIGN_IN_FRAGMENT_FIELD} value={hash} />
      <ContinueButton />
    </form>
  );
}
