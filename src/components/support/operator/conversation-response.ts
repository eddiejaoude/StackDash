import { z } from "zod";

import { Constants } from "@/lib/supabase/database.types";
import { ATTACHMENT_MIME_TYPES } from "@/lib/support/attachments";
import type { OperatorThreadView, SupportConversation } from "@/lib/support/views";

/*
 * The body of GET /api/support/inbox/threads/<id> (#680), parsed in the browser before the inbox
 * renders it: a proxy that rewrote the body, or a later change to the route, then shows the
 * inbox's load failure instead of breaking the page. Annotated with the view types the route
 * returns, so the schema and the types cannot drift apart.
 */

const enums = Constants.public.Enums;

const conversationSchema: z.ZodType<SupportConversation<OperatorThreadView>> = z.object({
  thread: z.object({
    id: z.string(),
    subject: z.string(),
    status: z.enum(enums.support_thread_status),
    createdAt: z.string(),
    lastMessageAt: z.string(),
    unread: z.boolean(),
    member: z.object({
      userId: z.string(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    }),
    context: z.object({
      fromPage: z.string().nullable(),
      workspaceName: z.string().nullable(),
      memberRole: z.enum(enums.workspace_role).nullable(),
    }),
  }),
  messages: z.array(
    z.object({
      id: z.string(),
      sender: z.enum(enums.support_sender),
      body: z.string(),
      createdAt: z.string(),
      attachments: z.array(
        z.object({
          id: z.string(),
          filename: z.string(),
          mime: z.enum(ATTACHMENT_MIME_TYPES),
          bytes: z.number(),
          url: z.string().nullable(),
        }),
      ),
    }),
  ),
  olderCursor: z.string().nullable(),
  seenThrough: z.string().nullable(),
});

const responseSchema = z.object({ conversation: conversationSchema });

/** The conversation in a 200 response's body, or null for a body of any other shape. */
export function parseOperatorConversation(body: unknown): SupportConversation<OperatorThreadView> | null {
  const parsed = responseSchema.safeParse(body);
  return parsed.success ? parsed.data.conversation : null;
}

const failureSchema = z.object({ referenceId: z.string() });

/** The log reference in a failed response's body, when it has one. */
export function parseFailureReference(body: unknown): string | undefined {
  const parsed = failureSchema.safeParse(body);
  return parsed.success ? parsed.data.referenceId : undefined;
}
