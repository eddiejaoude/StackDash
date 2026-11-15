import { NextResponse, type NextRequest } from "next/server";

import { unsubscribeMember } from "@/lib/data/notification-preferences";
import { readBoundedRequestBody } from "@/lib/http/bounded-body";
import { logError } from "@/lib/log/logger";
import { UNSUBSCRIBE_PAGE_PATH } from "@/lib/notifications/links";
import { readUnsubscribeToken } from "@/lib/notifications/unsubscribe";

/*
 * RFC 8058 one-click unsubscribe (#152): the URI in every alert email's `List-Unsubscribe` header.
 * https://www.rfc-editor.org/rfc/rfc8058 section 3.1 and 3.2 (checked 2026-11-05): the mail client
 * POSTs `List-Unsubscribe=One-Click` (form encoded or multipart) to the URI, without cookies and
 * without user interaction, and the URI alone identifies the recipient. So the signed token in the
 * query string is the whole authorization, and there is no Origin check: the POST comes from the
 * mailbox provider's servers, not from a StackDash page. The only thing a token can do is turn alert
 * email off for the one member and workspace it names, which is safe to repeat.
 *
 * The answer is never a redirect (section 3.2 forbids following one), and the body is plain text a
 * person may read if their client shows it.
 */

const HEADERS = { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" };

// The body is one short form field. Anything bigger is not a one-click request. Not exported:
// a route file may only export handlers and route segment config.
const MAX_BODY_BYTES = 4096;

function text(status: number, body: string): NextResponse {
  return new NextResponse(body, { status, headers: HEADERS });
}

async function isOneClickBody(request: Request, body: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
  } catch {
    // Not form encoded or multipart, or malformed: not a one-click request.
    return false;
  }
  return form.get("List-Unsubscribe") === "One-Click";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const target = readUnsubscribeToken(request.nextUrl.searchParams.get("token"));
  if (target === null) {
    return text(400, "This unsubscribe link is not valid. Use the unsubscribe link in the email instead.");
  }
  const body = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (body === null) return text(413, "This request is too large to be a one-click unsubscribe.");
  if (!(await isOneClickBody(request, body))) {
    return text(400, "A one-click unsubscribe sends List-Unsubscribe=One-Click. Use the unsubscribe link in the email instead.");
  }

  try {
    await unsubscribeMember(target);
  } catch (error) {
    const referenceId = logError("notifications.one_click_unsubscribe_failed", error, { workspaceId: target.workspaceId });
    return text(
      500,
      `StackDash could not unsubscribe you. Try again, or use the unsubscribe link in the email. Reference ${referenceId}.`,
    );
  }
  // "not_member" is a success too: someone who left the workspace gets no alert email from it.
  return text(200, "You are unsubscribed from alert emails for this workspace.");
}

/**
 * A client without one-click support may open the header's URI in a browser. Opening a link must
 * not unsubscribe anyone, so this sends the browser to the page with the button, keeping the token.
 */
export function GET(request: NextRequest): NextResponse {
  const page = new URL(UNSUBSCRIBE_PAGE_PATH, request.nextUrl.origin);
  const token = request.nextUrl.searchParams.get("token");
  if (token !== null && readUnsubscribeToken(token) !== null) page.searchParams.set("token", token);
  return NextResponse.redirect(page, { status: 303, headers: { "Cache-Control": "no-store" } });
}
