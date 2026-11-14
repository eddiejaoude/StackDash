"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, type ReactNode } from "react";

import { GuardedButton } from "@/components/guarded-button";
import { buttonClass } from "@/components/ui/button";
import { LiveRegion } from "@/components/ui/live-region";
import { Wordmark } from "@/components/wordmark";

import { unsubscribeFromEmail, type UnsubscribeResult } from "./actions";

export function UnsubscribeCard({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
      <div className="rounded-xl border border-line bg-panel px-6 py-10 sm:px-10">
        <p className="flex">
          <Link href="/" className="inline-flex min-h-6 items-center">
            <Wordmark />
          </Link>
        </p>
        <h1 className="mt-4 mb-4 text-2xl font-semibold tracking-tight">Unsubscribe from alert emails</h1>
        {children}
      </div>
    </main>
  );
}

export function SignInLink() {
  return (
    <p className="mt-6 text-sm">
      <Link href="/sign-in" className="underline underline-offset-4">
        Sign in to StackDash
      </Link>
    </p>
  );
}

export function InvalidLinkNotice() {
  return (
    <>
      <p className="text-sm leading-6">
        This unsubscribe link is incomplete or no longer valid. Open it again from the email, or sign in and change your
        alert emails in the alert settings of your workspace.
      </p>
      <SignInLink />
    </>
  );
}

/** Alert email is off for this member and workspace, whether it just changed or already was. */
export function EmailsOffNotice({ workspaceName, focusOnMount = false }: { workspaceName: string; focusOnMount?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // The button that was pressed is gone, so focus moves to what replaced it.
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <>
      <LiveRegion ref={ref} tone="status" as="p" tabIndex={-1} className="text-sm leading-6">
        Alert emails for <strong className="font-semibold">{workspaceName}</strong> are off. StackDash sends you no more
        alert emails or digests for this workspace.
      </LiveRegion>
      <p className="mt-3 text-sm leading-6 text-muted">
        Alerts still show in StackDash. To get emails again, sign in and choose how often in alert settings.
      </p>
      <SignInLink />
    </>
  );
}

/**
 * The one button that turns alert email off (#152). Opening the page changes nothing, because mail
 * scanners follow links. Works without JavaScript: the form posts to the Server Function and the
 * page renders its result.
 */
export function UnsubscribeForm({
  token,
  workspaceName,
  frequencyLabel,
}: {
  token: string;
  workspaceName: string;
  frequencyLabel: string;
}) {
  const [state, formAction, pending] = useActionState<UnsubscribeResult | null, FormData>(unsubscribeFromEmail, null);
  if (state?.ok === true) return <EmailsOffNotice workspaceName={workspaceName} focusOnMount />;
  if (state?.ok === false && state.reason === "invalid_link") return <InvalidLinkNotice />;
  return (
    <>
      {state?.ok === false && state.reason === "failed" ? (
        <LiveRegion tone="error" className="mb-4 text-sm leading-6 text-danger">
          <p>StackDash could not turn off your alert emails. Try again in a moment.</p>
          <p className="mt-2 text-muted">
            If it keeps happening, share reference <span className="font-mono text-foreground">{state.referenceId}</span>.
          </p>
        </LiveRegion>
      ) : null}
      <p className="text-sm leading-6">
        Your alert emails for <strong className="font-semibold">{workspaceName}</strong> are set to {frequencyLabel}.
        Turning them off stops every alert email and digest for this workspace. Alerts still show in StackDash.
      </p>
      <form action={formAction} className="mt-6">
        <input type="hidden" name="token" value={token} />
        <GuardedButton type="submit" unavailable={pending} className={buttonClass("primary", "lg")}>
          {pending ? "Turning off alert emails" : "Turn off alert emails"}
        </GuardedButton>
      </form>
    </>
  );
}
