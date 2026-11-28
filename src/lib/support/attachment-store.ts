import "server-only";

import { z } from "zod";

import { log, logError } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { ATTACHMENT_MIME_TYPES, SIGNATURE_BYTES, displayFilename, sniffImageType, type AttachmentMime, type AttachmentRefusal } from "./attachments";
import { ATTACHMENT_BUCKET, ATTACHMENT_URL_TTL_SECONDS, STAGED_ATTACHMENTS_PER_UPLOADER } from "./limits";
import type { SupportAttachmentView } from "./views";

/*
 * Support chat attachments on the server (#680): claims, the content check before a send, signed
 * URLs, and the deletes Storage needs (a discarded image, account deletion, the retention sweep).
 * The rules and the bucket are in 20261128120200_support_attachments.sql. Everything here runs with
 * the service role, scoped to the uploader or owner the caller has already authorized.
 */

const STORAGE_TIMEOUT_MS = 10_000;
// Storage deletes this many objects per request at most, so larger batches are split.
const REMOVE_BATCH = 100;

export type ClaimOutcome =
  | Readonly<{ ok: true; attachmentId: string; objectName: string }>
  | Readonly<{ ok: false; refusal: Extract<AttachmentRefusal, "type" | "too_large" | "empty" | "thread" | "staged_cap"> }>;

const stageRow = z.object({
  attachment_id: z.guid().nullable(),
  object_name: z.string().nullable(),
  refusal: z.enum(["mime", "bytes", "thread", "staged_cap"]).nullable(),
});

/**
 * Claims one image for `uploaderId`: a user into their own thread or a new one (`threadId` null),
 * an operator into the thread they answer. The database decides the object name.
 */
export async function claimAttachment(
  input: Readonly<{ uploaderId: string; threadId: string | null; filename: string; mime: AttachmentMime; bytes: number }>,
): Promise<ClaimOutcome> {
  const { data, error } = await createAdminClient()
    .rpc("stage_support_attachment", {
      p_uploader_id: input.uploaderId,
      p_filename: displayFilename(input.filename),
      p_mime: input.mime,
      p_bytes: input.bytes,
      p_max_staged: STAGED_ATTACHMENTS_PER_UPLOADER,
      // Left out for a new conversation: the function then claims into the uploader's own folder.
      ...(input.threadId === null ? {} : { p_thread_id: input.threadId }),
    })
    .single();
  if (error) throw new Error("Claiming a support attachment failed", { cause: error });
  const row = stageRow.parse(data);
  if (row.refusal === "mime") return { ok: false, refusal: "type" };
  if (row.refusal === "bytes") return { ok: false, refusal: input.bytes <= 0 ? "empty" : "too_large" };
  if (row.refusal !== null) return { ok: false, refusal: row.refusal };
  if (row.attachment_id === null || row.object_name === null) throw new Error("Claiming a support attachment returned no row.");
  return { ok: true, attachmentId: row.attachment_id, objectName: row.object_name };
}

/** Deletes objects through the Storage API, in batches. Throws when Storage refuses. */
async function removeObjects(names: readonly string[]): Promise<void> {
  const storage = createAdminClient().storage.from(ATTACHMENT_BUCKET);
  for (let start = 0; start < names.length; start += REMOVE_BATCH) {
    const { error } = await storage.remove(names.slice(start, start + REMOVE_BATCH));
    if (error) throw new Error("Deleting support attachment objects failed", { cause: error });
  }
}

/**
 * Removes one of the uploader's unsent images and its bytes. False when there was nothing to remove
 * (already sent, someone else's, or gone). A row deleted with its object left behind is logged and
 * left to the retention sweep, which deletes objects no row names.
 */
export async function discardAttachment(uploaderId: string, attachmentId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("discard_support_attachment", {
    p_uploader_id: uploaderId,
    p_attachment_id: attachmentId,
  });
  if (error) throw new Error("Discarding a support attachment failed", { cause: error });
  const objectName: unknown = data;
  if (typeof objectName !== "string") return false;
  try {
    await removeObjects([objectName]);
  } catch (cause) {
    logError("support.attachment_object_delete_failed", cause, { attachmentId });
  }
  return true;
}

const stagedRow = z.object({ id: z.guid(), object_name: z.string(), mime: z.enum(ATTACHMENT_MIME_TYPES) });

/** The first bytes of a stored object, or null when it is not there. */
async function objectHead(signedUrl: string): Promise<Uint8Array | null> {
  const response = await fetch(signedUrl, {
    headers: { Range: `bytes=0-${SIGNATURE_BYTES - 1}` },
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  if (response.status === 400 || response.status === 404) return null;
  if (!response.ok || response.body === null) throw new Error(`Reading a support attachment answered ${response.status}`);
  // Storage may ignore the range; read only as far as the signature either way.
  const reader = response.body.getReader();
  const head = new Uint8Array(SIGNATURE_BYTES);
  let filled = 0;
  while (filled < SIGNATURE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.length, SIGNATURE_BYTES - filled);
    head.set(value.subarray(0, take), filled);
    filled += take;
  }
  await reader.cancel();
  return head.subarray(0, filled);
}

export type AttachmentCheckOutcome = Readonly<{ ok: true }> | Readonly<{ ok: false; refusal: "upload" | "unreadable" }>;

/**
 * Before a send: every id must be the uploader's own unsent image, staged for this thread or for
 * none, uploaded, and its first bytes the signature of the type it was claimed as. `upload` when one
 * is missing or not theirs; `unreadable` when the bytes are not that image. The send function binds
 * them in its own transaction afterwards and refuses anything that changed in between.
 */
export async function checkStagedAttachments(
  uploaderId: string,
  threadId: string | null,
  attachmentIds: readonly string[],
): Promise<AttachmentCheckOutcome> {
  if (attachmentIds.length === 0) return { ok: true };
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("staged_support_attachments", {
    p_uploader_id: uploaderId,
    p_ids: [...attachmentIds],
    ...(threadId === null ? {} : { p_thread_id: threadId }),
  });
  if (error) throw new Error("Reading staged support attachments failed", { cause: error });
  const rows = z.array(stagedRow).parse(data);
  if (rows.length !== new Set(attachmentIds).size || rows.length !== attachmentIds.length) return { ok: false, refusal: "upload" };

  const signed = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrls(
    rows.map((row) => row.object_name),
    60,
  );
  if (signed.error) throw new Error("Signing staged support attachments failed", { cause: signed.error });
  const heads = await Promise.all(
    rows.map(async (row, index) => {
      const url = signed.data[index]?.signedUrl ?? null;
      return url === null ? null : objectHead(url);
    }),
  );
  for (const [index, head] of heads.entries()) {
    if (head === null) return { ok: false, refusal: "upload" };
    if (sniffImageType(head) !== rows[index]?.mime) {
      log.warn("support.attachment_content_mismatch", { attachmentId: rows[index]?.id ?? null });
      return { ok: false, refusal: "unreadable" };
    }
  }
  return { ok: true };
}

export const attachmentRow = z.object({
  id: z.guid(),
  object_name: z.string(),
  filename: z.string(),
  mime: z.enum(ATTACHMENT_MIME_TYPES),
  bytes: z.number(),
});

export type AttachmentRow = z.infer<typeof attachmentRow>;

/**
 * Views of the attachments of a page of messages, each with a URL signed for this read, in one
 * Storage call. An image Storage cannot sign is still listed, with no URL, and logged.
 */
export async function signAttachments(rows: readonly AttachmentRow[]): Promise<Map<string, SupportAttachmentView>> {
  const views = new Map<string, SupportAttachmentView>();
  if (rows.length === 0) return views;
  const { data, error } = await createAdminClient()
    .storage.from(ATTACHMENT_BUCKET)
    .createSignedUrls(
      rows.map((row) => row.object_name),
      ATTACHMENT_URL_TTL_SECONDS,
    );
  if (error) logError("support.attachment_sign_failed", error, { count: rows.length });
  for (const [index, row] of rows.entries()) {
    const url = data?.[index]?.signedUrl ?? null;
    if (url === null && !error) log.warn("support.attachment_unsigned", { attachmentId: row.id });
    views.set(row.id, { id: row.id, filename: row.filename, mime: row.mime, bytes: row.bytes, url });
  }
  return views;
}

const objectNameRow = z.object({ object_name: z.string() });

/**
 * Deletes every object in the owner's folder: the images of their conversations, whoever attached
 * them, and any they never sent. Account deletion calls it before the account goes, since the
 * cascade that removes the rows cannot reach Storage. Bounded: a folder holds at most what its
 * conversations and the claim cap allow, and a page that comes back empty ends it.
 */
export async function deleteOwnerObjects(ownerId: string): Promise<number> {
  let deleted = 0;
  for (let page = 0; page < 1000; page += 1) {
    const { data, error } = await createAdminClient().rpc("list_owner_support_objects", { p_owner_id: ownerId, p_limit: REMOVE_BATCH });
    if (error) throw new Error("Listing an account's support attachments failed", { cause: error });
    const names = z.array(objectNameRow).parse(data).map((row) => row.object_name);
    if (names.length === 0) return deleted;
    await removeObjects(names);
    deleted += names.length;
  }
  throw new Error("Deleting an account's support attachments did not finish.");
}

const staleRow = z.object({ id: z.guid(), object_name: z.string() });

/**
 * One batch of the retention sweep of unsent images claimed before `before`: their objects first,
 * then their rows, so a run cut short leaves rows the next run finds again. Returns the rows deleted.
 */
export async function purgeStagedAttachments(before: Date, limit: number): Promise<number> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("list_stale_support_attachments", { p_before: before.toISOString(), p_limit: limit });
  if (error) throw new Error("Listing stale support attachments failed", { cause: error });
  const rows = z.array(staleRow).parse(data);
  if (rows.length === 0) return 0;
  await removeObjects(rows.map((row) => row.object_name));
  const deleted = await supabase.rpc("delete_staged_support_attachments", { p_ids: rows.map((row) => row.id) });
  if (deleted.error) throw new Error("Deleting stale support attachments failed", { cause: deleted.error });
  // A batch is complete when it listed `limit` rows, even if some were sent in between and kept.
  return rows.length;
}

/** One batch of the sweep of objects created before `before` that no row names. Returns how many it deleted. */
export async function purgeOrphanedObjects(before: Date, limit: number): Promise<number> {
  const { data, error } = await createAdminClient().rpc("list_orphaned_support_objects", { p_before: before.toISOString(), p_limit: limit });
  if (error) throw new Error("Listing orphaned support objects failed", { cause: error });
  const names = z.array(objectNameRow).parse(data).map((row) => row.object_name);
  if (names.length === 0) return 0;
  await removeObjects(names);
  return names.length;
}
