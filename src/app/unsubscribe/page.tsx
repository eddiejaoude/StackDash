import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { EMAIL_FREQUENCY_CHOICES } from "@/components/alerts/labels";
import { LiveRegion } from "@/components/ui/live-region";
import { unsubscribeStatus } from "@/lib/data/notification-preferences";
import { readUnsubscribeToken } from "@/lib/notifications/unsubscribe";

import { EmailsOffNotice, InvalidLinkNotice, UnsubscribeCard, UnsubscribeForm } from "./unsubscribe-form";

export const metadata: Metadata = { title: "Unsubscribe from alert emails", robots: { index: false } };

// The enforced CSP nonce (src/proxy.ts) needs this page's HTML rendered per request, so the page
// awaits `connection()` before anything renders and allows an empty static shell (#125).
export const instant = false;

/*
 * The unsubscribe link in every alert email and digest (#152). It works signed out: the signed
 * token in the link names the member and the workspace. Opening the page changes nothing; the
 * button does (unsubscribe-form.tsx). Mail clients that support RFC 8058 one-click unsubscribe
 * post to /api/notifications/unsubscribe instead. A failed read reaches error.tsx.
 */

// Query values can repeat; take the first and drop anything malformed.
const searchParamsSchema = z.object({
  token: z.preprocess((value) => (Array.isArray(value) ? value[0] : value), z.string().optional().catch(undefined)),
});

const FREQUENCY_LABEL = Object.fromEntries(EMAIL_FREQUENCY_CHOICES.map((choice) => [choice.value, choice.label.toLowerCase()]));

async function UnsubscribeDetails({ searchParams }: { searchParams: PageProps<"/unsubscribe">["searchParams"] }) {
  const { token } = searchParamsSchema.parse(await searchParams);
  const target = readUnsubscribeToken(token);
  if (target === null || token === undefined) return <InvalidLinkNotice />;

  const status = await unsubscribeStatus(target);
  if (status.kind === "not_member") {
    return (
      <p className="text-sm leading-6">
        You are no longer a member of this workspace, so StackDash sends you no alert emails for it. Nothing needs doing.
      </p>
    );
  }
  if (status.frequency === "off") return <EmailsOffNotice workspaceName={status.workspaceName} />;
  return (
    <UnsubscribeForm
      token={token}
      workspaceName={status.workspaceName}
      frequencyLabel={FREQUENCY_LABEL[status.frequency] ?? status.frequency}
    />
  );
}

export default async function UnsubscribePage({ searchParams }: PageProps<"/unsubscribe">) {
  await connection();
  return (
    <UnsubscribeCard>
      <Suspense
        fallback={
          <LiveRegion tone="status" as="p" className="text-sm text-muted">
            Checking your unsubscribe link
          </LiveRegion>
        }
      >
        <UnsubscribeDetails searchParams={searchParams} />
      </Suspense>
    </UnsubscribeCard>
  );
}
