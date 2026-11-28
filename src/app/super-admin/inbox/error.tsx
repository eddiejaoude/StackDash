"use client";

import Link from "next/link";
import type { ErrorInfo } from "next/error";

import { digestOf, ErrorPanel } from "@/components/app/error-panel";
import { buttonClass } from "@/components/ui/button";

/** The digest is the reference id (digestOf in error-panel.tsx); the raw message is never shown. */
export default function SupportInboxError({ error, retry }: Pick<ErrorInfo, "error" | "retry">) {
  const referenceId = digestOf(error);
  return (
    <main id="main" className="flex flex-1 flex-col justify-center px-4 py-16">
      <ErrorPanel
        title="The support inbox could not be loaded"
        description="Reading the conversations failed, and nothing was changed or sent. Try again, and if the problem continues, check the server log."
        {...(referenceId === undefined ? {} : { referenceId })}
        actions={
          <>
            <button type="button" onClick={() => retry()} className={buttonClass("primary")}>
              Try again
            </button>
            <Link href="/app" className={buttonClass("secondary")}>
              Open your workspace
            </Link>
          </>
        }
      />
    </main>
  );
}
