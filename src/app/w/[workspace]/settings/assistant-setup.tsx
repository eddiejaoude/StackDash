"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { buttonClass } from "@/components/ui/button";
import { OutcomeAnnouncement, type Outcome } from "@/components/ui/live-region";
import { API_KEY_SCOPES } from "@/lib/api/scopes";
import { mcpClientSetups } from "@/lib/mcp/setup";

import { createApiKey, type CreateApiKeyResult } from "./actions";
import { ErrorSummary, failureOf, NewKeyPanel } from "./api-keys";

/** The name of every key made here, so the API keys list says what each one is for. */
const ASSISTANT_KEY_NAME = "AI assistant";

/**
 * The AI assistants section of settings (#163): this instance's MCP server URL and the snippet
 * that connects each client. Owners and admins create the assistant's key here in one step (#254),
 * through the same createApiKey action as the API keys section, so the same role check and key
 * limit apply. The new key is shown once, and filled into the snippets that hold a key.
 */
export function AssistantSetup({
  workspaceSlug,
  endpointUrl,
  canManageKeys,
  maxKeys,
}: {
  workspaceSlug: string;
  endpointUrl: string;
  canManageKeys: boolean;
  maxKeys: number;
}) {
  const [status, setStatus] = useState<Outcome | null>(null);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  // Set when the key is hidden, so focus goes back to the button that made it.
  const [returnFocus, setReturnFocus] = useState(false);

  return (
    <section aria-labelledby="assistants-title" className="mt-6 rounded-xl border border-line bg-panel">
      <div className="border-b border-line px-6 py-4">
        <h2 id="assistants-title" className="text-sm font-semibold">
          AI assistants
        </h2>
        <p className="mt-1 text-sm text-muted">
          Let Claude, Cursor, or another assistant answer questions about this workspace through its MCP server. The
          server only reads, and it uses an API key, so the assistant sees only what the key may read.{" "}
          <Link href="/docs/mcp" className="text-foreground underline underline-offset-2">
            Read the MCP guide
          </Link>
        </p>
      </div>
      <div className="px-6 py-5 text-sm">
        <dl className="grid gap-1 sm:grid-cols-3 sm:gap-4">
          <dt className="text-muted">Server URL</dt>
          <dd className="break-all font-mono sm:col-span-2">{endpointUrl}</dd>
        </dl>
        {/* Always mounted so screen readers announce changes to it. */}
        <OutcomeAnnouncement outcome={status} messageClassName="mt-4" />
        <ol className="mt-5 list-decimal space-y-2 pl-5">
          <li>
            {canManageKeys ? (
              <>
                Create a key for the assistant. It gets every scope, so the assistant can answer any question,
                including about spend. It counts toward this workspace&apos;s {maxKeys} keys and is listed under API keys,
                where you can revoke it.
                {created === null ? (
                  <CreateAssistantKeyForm
                    workspaceSlug={workspaceSlug}
                    focusOnMount={returnFocus}
                    onCreated={(name, key) => {
                      setCreated({ name, key });
                      setStatus({ tone: "success", message: `Created the key ${name}.` });
                    }}
                  />
                ) : (
                  <div className="mt-3">
                    <NewKeyPanel
                      name={created.name}
                      apiKey={created.key}
                      onCopied={(copied) =>
                        setStatus(
                          copied
                            ? { tone: "success", message: "Key copied." }
                            : {
                                tone: "error",
                                message: "Copying did not work in this browser. Select the key and copy it yourself.",
                              },
                        )
                      }
                      onDismiss={() => {
                        setCreated(null);
                        setReturnFocus(true);
                        setStatus({ tone: "success", message: "The new key is hidden. It cannot be shown again." });
                      }}
                    />
                  </div>
                )}
              </>
            ) : (
              <>
                Ask an owner or admin of this workspace for an API key for the assistant. Give it every scope so the
                assistant can answer any question. Without usage and spend, it sees no amounts anywhere, including in
                events and alerts.
              </>
            )}
          </li>
          <li>
            Add the server to your assistant with one of the snippets below.
            {created === null
              ? null
              : " The Claude Desktop and other clients snippets hold the new key. Claude Code and Cursor read it from STACKDASH_API_KEY."}
          </li>
        </ol>
        {mcpClientSetups(endpointUrl, created?.key ?? null).map((setup) => (
          <div key={setup.id} className="mt-6">
            <h3 id={`assistant-${setup.id}-title`} className="font-semibold">
              {setup.name}
            </h3>
            <p className="mt-1 text-muted">{setup.instructions}</p>
            {/* Scrollable blocks take focus so keyboard users can scroll them, as on the docs pages, and
                are named regions so a screen reader says which client's snippet has focus. */}
            <pre
              tabIndex={0}
              role="region"
              aria-labelledby={`assistant-${setup.id}-title`}
              className="mt-2 overflow-x-auto rounded-lg border border-line bg-panel-raised p-4 font-mono text-[13px] leading-6 text-foreground/90"
            >
              <code>{setup.snippet}</code>
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * One button that submits a create with the assistant's name and every scope. The key goes to
 * onCreated and stays out of the form state, as in the API keys section.
 */
function CreateAssistantKeyForm({
  workspaceSlug,
  focusOnMount,
  onCreated,
}: {
  workspaceSlug: string;
  focusOnMount: boolean;
  onCreated: (name: string, key: string) => void;
}) {
  const [state, formAction, pending] = useActionState<CreateApiKeyResult | null, FormData>(
    async (previous, formData) => {
      const result = await createApiKey(previous, formData);
      if (result.ok) onCreated(result.name, result.key);
      return result.ok ? { ...result, key: "" } : result;
    },
    null,
  );

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="name" value={ASSISTANT_KEY_NAME} />
      {API_KEY_SCOPES.map((scope) => (
        <input key={scope} type="hidden" name="scope" value={scope} />
      ))}
      {/* Back from hiding the key, focus lands here rather than on the page. */}
      <button type="submit" disabled={pending} autoFocus={focusOnMount} className={`shrink-0 ${buttonClass("primary")}`}>
        {pending ? "Creating key" : "Create assistant key"}
      </button>
      <ErrorSummary failure={failureOf(state)} />
    </form>
  );
}
