/*
 * Support chat's Realtime topics (#680), shared by the browser and the server. The database sends
 * on them from inside each write (support_broadcast in 20261128120300_support_chat_functions.sql);
 * the policies are in 20261128120100_support_chat.sql. Both topics are private: a channel must join
 * with `private: true`, and Realtime admits it only when the select policy does.
 *
 * - `support-user:<user id>`: the user's own topic. The user and every operator may join it. The
 *   user tracks presence there (nobody else can), which is how operators and the server know the
 *   user is online.
 * - `support-operators`: operators only. Operators track presence there, keyed by their user id.
 *
 * Every message is event `activity` with a hint, never content: the listener reads again through
 * the server (a route handler, or a refresh of the page) on receipt and after every reconnect.
 */

export const SUPPORT_OPERATORS_TOPIC = "support-operators";

export const SUPPORT_ACTIVITY_EVENT = "activity";

export function supportUserTopic(userId: string): string {
  return `support-user:${userId}`;
}

/** What happened: a message was written, the thread opened or closed, or someone read it. */
export type SupportActivityKind = "message" | "status" | "read";

export type SupportActivity = Readonly<{
  threadId: string;
  kind: SupportActivityKind;
  /** When the write committed, on the database clock (an ISO timestamp). */
  at: string;
  /** On the operators' topic only, for a read: the operator who read, so other operators can ignore it. */
  operatorId: string | null;
}>;

const KINDS: readonly SupportActivityKind[] = ["message", "status", "read"];

/** The hint a broadcast carries, or null for a payload of any other shape. */
export function supportActivity(payload: unknown): SupportActivity | null {
  if (typeof payload !== "object" || payload === null) return null;
  const threadId: unknown = Reflect.get(payload, "thread_id");
  const kind: unknown = Reflect.get(payload, "kind");
  const at: unknown = Reflect.get(payload, "at");
  const operatorId: unknown = Reflect.get(payload, "operator_id");
  if (typeof threadId !== "string" || typeof at !== "string") return null;
  const knownKind = KINDS.find((candidate) => candidate === kind);
  if (knownKind === undefined) return null;
  return { threadId, kind: knownKind, at, operatorId: typeof operatorId === "string" ? operatorId : null };
}
