"use client";

import type { ErrorInfo } from "next/error";

import { digestOf } from "@/components/app/error-panel";
import { buttonClass } from "@/components/ui/button";
import { LiveRegion } from "@/components/ui/live-region";

import { UnsubscribeCard } from "./unsubscribe-form";

/**
 * A failed read on the unsubscribe page. Nothing has changed. The digest is the reference id
 * (digestOf in src/components/app/error-panel.tsx); the raw message is never shown.
 */
export default function UnsubscribeError({ error, retry }: Pick<ErrorInfo, "error" | "retry">) {
  const digest = digestOf(error);
  return (
    <UnsubscribeCard>
      <LiveRegion tone="error" className="text-sm leading-6">
        <p>StackDash could not check your alert emails, so nothing has changed. Try again in a moment.</p>
        {digest === undefined ? null : (
          <p className="mt-2 text-muted">
            If it keeps happening, share reference <span className="font-mono text-foreground">{digest}</span>.
          </p>
        )}
      </LiveRegion>
      <button
        type="button"
        onClick={() => retry()}
        className={`mt-6 ${buttonClass("primary", "lg")}`}
      >
        Try again
      </button>
    </UnsubscribeCard>
  );
}
