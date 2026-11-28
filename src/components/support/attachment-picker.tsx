"use client";

import Image from "next/image";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";

import { buttonClass } from "@/components/ui/button";
import { FailureAnnouncement, LiveRegion } from "@/components/ui/live-region";
import { createClient } from "@/lib/supabase/client";
import {
  ATTACHMENT_MIME_TYPES,
  SIGNATURE_BYTES,
  attachmentRefusalMessage,
  checkAttachment,
  displayFilename,
  formatMegabytes,
} from "@/lib/support/attachments";
import { ATTACHMENTS_PER_MESSAGE } from "@/lib/support/limits";
import type { ClaimAttachmentResult, DiscardAttachmentResult } from "@/lib/support/views";

import { filesFrom } from "./composer";

/*
 * Image attachments for a support composer (#680), by file picker, drag and drop, or paste (the
 * composer passes pasted files to `addFiles`). Each file is checked by its first bytes before
 * anything leaves the browser, so SVG, other types, empty files, and files over 10 MB are refused
 * with the reason at once; then the claim action names the object, and the browser uploads it
 * straight to Storage with the user's own session, where the bucket's insert policy admits only the
 * claimed name. The bytes never pass through the app. Removing an image before sending discards
 * its claim and its bytes.
 *
 * For the full messages page and the operators' inbox; the launcher leaves attachments out, so this
 * module stays out of the bundle every app page loads.
 */

type ClaimAction = (previous: ClaimAttachmentResult | null, formData: FormData) => Promise<ClaimAttachmentResult>;
type DiscardAction = (previous: DiscardAttachmentResult | null, formData: FormData) => Promise<DiscardAttachmentResult>;

export type AttachmentItem = Readonly<{
  key: string;
  name: string;
  size: number;
  /** A local preview (blob: URL) of the picked file. */
  previewUrl: string;
  status: "uploading" | "ready" | "failed";
  attachmentId: string | null;
}>;

/** What a composer needs from the picker: the ids to send, whether to wait, and what to do with pasted files. */
export type AttachmentController = Readonly<{
  items: readonly AttachmentItem[];
  /** Ids of the uploaded images, for the send's `attachmentId` fields. */
  readyIds: readonly string[];
  /** True while an image is still uploading; sending waits for it. */
  uploading: boolean;
  /** The latest refusal, one sentence with the reason, or null. */
  error: string | null;
  addFiles: (files: readonly File[]) => void;
  remove: (key: string) => void;
  /** After a successful send: the images went with the message, so the list empties. */
  clear: () => void;
}>;

async function fileHead(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
}

/**
 * The upload state of one composer. `claim` and `discard` are the claim and discard actions of the
 * screen's side (src/app/account/messages/actions.ts or src/app/super-admin/inbox/actions.ts);
 * `threadId` is the conversation, or null while a user starts a new one.
 */
export function useAttachmentUploads({
  claim,
  discard,
  threadId,
}: Readonly<{ claim: ClaimAction; discard: DiscardAction; threadId: string | null }>): AttachmentController {
  const [items, setItems] = useState<readonly AttachmentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const count = useRef(0);

  // Previews are blob URLs, released once their image leaves the list or the composer unmounts.
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const update = useCallback((key: string, patch: Partial<Pick<AttachmentItem, "status" | "attachmentId">>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  const upload = useCallback(
    async (file: File, key: string): Promise<void> => {
      const check = checkAttachment(file, await fileHead(file));
      if (!check.ok) {
        setItems((current) => current.filter((item) => item.key !== key));
        setError(attachmentRefusalMessage(check.refusal, file));
        return;
      }
      const form = new FormData();
      form.set("threadId", threadId ?? "");
      form.set("filename", displayFilename(file.name));
      form.set("mime", check.mime);
      form.set("bytes", String(file.size));
      let claimed: ClaimAttachmentResult;
      try {
        claimed = await claim(null, form);
      } catch (cause) {
        console.error(JSON.stringify({ level: "error", event: "support.claim_request_failed", reason: cause instanceof Error ? cause.message : "unknown" }));
        claimed = { ok: false, message: attachmentRefusalMessage("upload", file) };
      }
      if (!claimed.ok) {
        setItems((current) => current.filter((item) => item.key !== key));
        setError(claimed.message);
        return;
      }
      const { error: uploadError } = await createClient()
        .storage.from(claimed.bucket)
        .upload(claimed.objectName, file, { contentType: check.mime, upsert: false });
      if (uploadError !== null) {
        update(key, { status: "failed", attachmentId: null });
        setError(attachmentRefusalMessage("upload", file));
        const release = new FormData();
        release.set("attachmentId", claimed.attachmentId);
        void discard(null, release);
        return;
      }
      update(key, { status: "ready", attachmentId: claimed.attachmentId });
    },
    [claim, discard, threadId, update],
  );

  const addFiles = useCallback(
    (files: readonly File[]) => {
      setError(null);
      const room = ATTACHMENTS_PER_MESSAGE - items.filter((item) => item.status !== "failed").length;
      if (files.length > room) setError(attachmentRefusalMessage("count"));
      const accepted = files.slice(0, Math.max(0, room)).map((file) => {
        count.current += 1;
        const previewUrl = URL.createObjectURL(file);
        previews.current.add(previewUrl);
        return { file, item: { key: `attachment-${count.current}`, name: displayFilename(file.name), size: file.size, previewUrl, status: "uploading" as const, attachmentId: null } };
      });
      setItems((current) => [...current, ...accepted.map(({ item }) => item)]);
      for (const { file, item } of accepted) void upload(file, item.key);
    },
    [items, upload],
  );

  const remove = useCallback(
    (key: string) => {
      const item = items.find((candidate) => candidate.key === key);
      if (item === undefined) return;
      setItems((current) => current.filter((candidate) => candidate.key !== key));
      URL.revokeObjectURL(item.previewUrl);
      previews.current.delete(item.previewUrl);
      if (item.attachmentId === null) return;
      const form = new FormData();
      form.set("attachmentId", item.attachmentId);
      void discard(null, form).then((result) => {
        if (!result.ok) setError(result.message);
      });
    },
    [discard, items],
  );

  const clear = useCallback(() => {
    for (const item of items) {
      URL.revokeObjectURL(item.previewUrl);
      previews.current.delete(item.previewUrl);
    }
    setItems([]);
    setError(null);
  }, [items]);

  return useMemo(
    () => ({
      items,
      readyIds: items.flatMap((item) => (item.status === "ready" && item.attachmentId !== null ? [item.attachmentId] : [])),
      uploading: items.some((item) => item.status === "uploading"),
      error,
      addFiles,
      remove,
      clear,
    }),
    [items, error, addFiles, remove, clear],
  );
}

const STATUS_TEXT: Readonly<Record<AttachmentItem["status"], string>> = {
  uploading: "Uploading",
  ready: "Ready to send",
  failed: "Upload failed",
};

/**
 * The picker: an "Attach images" button that opens the file chooser, a drop zone around the list,
 * each image with its state and a Remove button, and the reason for any refusal in an assertive
 * region. Keyboard users reach the button and every Remove button; dropping and pasting are extras.
 */
export function AttachmentPicker({ controller, disabled = false }: Readonly<{ controller: AttachmentController; disabled?: boolean }>) {
  const inputId = useId();
  const hintId = useId();
  const [dragging, setDragging] = useState(false);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!disabled) controller.addFiles(filesFrom(event.dataTransfer));
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`flex flex-col gap-2 rounded-md border border-dashed p-2 ${dragging ? "border-accent" : "border-transparent"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="file"
          multiple
          accept={ATTACHMENT_MIME_TYPES.join(",")}
          disabled={disabled}
          aria-describedby={hintId}
          className="sr-only"
          onChange={(event) => {
            controller.addFiles([...(event.currentTarget.files ?? [])]);
            event.currentTarget.value = "";
          }}
        />
        <label
          htmlFor={inputId}
          className={`${buttonClass("secondary", "sm")} cursor-pointer focus-within:outline-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent`}
        >
          Attach images
        </label>
        <p id={hintId} className="text-xs text-muted">
          PNG, JPEG, GIF, or WebP, up to {formatMegabytes(10 * 1024 * 1024)} each, {ATTACHMENTS_PER_MESSAGE} per message. You can also drop or paste images here.
        </p>
      </div>
      {controller.items.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label="Images to send">
          {controller.items.map((item) => (
            <li key={item.key} className="flex items-center gap-2 rounded-md border border-line p-1 pr-2 text-xs">
              {/* A local blob: preview of the picked file, which the image optimizer cannot read. */}
              <Image src={item.previewUrl} unoptimized alt="" width={40} height={40} className="size-10 rounded object-cover" />
              <span className="max-w-40 truncate">{item.name}</span>
              <span className="text-muted">{STATUS_TEXT[item.status]}</span>
              <button
                type="button"
                className={buttonClass("secondary", "xs")}
                onClick={() => controller.remove(item.key)}
                aria-label={`Remove ${item.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <LiveRegion tone="status" className="sr-only">
        {controller.uploading ? "Uploading images." : controller.items.length > 0 ? `${controller.readyIds.length} of ${controller.items.length} images ready to send.` : ""}
      </LiveRegion>
      <FailureAnnouncement failure={controller.error === null ? null : { message: controller.error }} className="text-sm" />
    </div>
  );
}
