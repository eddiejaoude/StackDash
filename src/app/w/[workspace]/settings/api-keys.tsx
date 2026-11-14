"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";

import { buttonClass } from "@/components/ui/button";
import { OutcomeAnnouncement, ReferenceNote, type Outcome } from "@/components/ui/live-region";
import { DialogActions, DialogCloseButton, ModalDialog, useModalDialog } from "@/components/ui/modal-dialog";
import { API_KEY_SCOPE_LABELS, API_KEY_SCOPES, type ApiKeyScope } from "@/lib/api/scopes";
import { CREATE_API_KEY_FIELD_ID } from "@/lib/workspaces/paths";

import {
  createApiKey,
  revokeApiKey,
  type ApiKeyActionFailure,
  type CreateApiKeyResult,
  type RevokeApiKeyResult,
} from "./actions";

/** One key as the list shows it. Dates are formatted on the server, in Europe/London. */
export type ApiKeyItem = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: readonly ApiKeyScope[];
  created: string;
  lastUsed: string | null;
  revoked: string | null;
  /** Not revoked, but the API refuses it because the member who created it left the workspace. */
  creatorLeft: boolean;
};

type KeyState = "active" | "creator_left" | "revoked";

function keyStateOf(apiKey: ApiKeyItem): KeyState {
  if (apiKey.revoked !== null) return "revoked";
  return apiKey.creatorLeft ? "creator_left" : "active";
}

const KEY_STATE_BADGES: Record<KeyState, { label: string; className: string }> = {
  active: { label: "Active", className: "border-success/50 text-success" },
  creator_left: { label: "Not working", className: "border-warning/50 text-warning" },
  revoked: { label: "Revoked", className: "border-dashed border-line-strong text-muted" },
};

export function failureOf(state: CreateApiKeyResult | RevokeApiKeyResult | null): ApiKeyActionFailure | undefined {
  return state !== null && !state.ok ? state : undefined;
}

/**
 * Shown when a submit fails, and focused so keyboard and screen reader users land on what went
 * wrong. An unexpected error carries the reference id.
 */
export function ErrorSummary({ failure }: { failure: ApiKeyActionFailure | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  // Every submit returns a new result object, so a repeated failure moves focus again.
  useEffect(() => {
    if (failure !== undefined) ref.current?.focus();
  }, [failure]);
  if (failure === undefined) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="mt-3 rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      <p>
        {failure.message}
        <ReferenceNote referenceId={failure.referenceId} />
      </p>
    </div>
  );
}

/**
 * The API keys section of settings (#162), for owners and admins: create a key, see the new key
 * once, and revoke keys. One status region above the parts that come and go announces each change.
 */
export function ApiKeysManager({
  workspaceSlug,
  keys,
  hasMore,
  listLimit,
}: {
  workspaceSlug: string;
  keys: readonly ApiKeyItem[];
  hasMore: boolean;
  listLimit: number;
}) {
  const [status, setStatus] = useState<Outcome | null>(null);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

  return (
    <div className="px-6 py-5">
      {/* Always mounted so screen readers announce changes to it. */}
      <OutcomeAnnouncement outcome={status} className="text-sm" messageClassName="mb-4" />

      {created === null ? null : (
        <NewKeyPanel
          name={created.name}
          apiKey={created.key}
          onCopied={(copied) =>
            setStatus(
              copied
                ? { tone: "success", message: "Key copied." }
                : { tone: "error", message: "Copying did not work in this browser. Select the key and copy it yourself." },
            )
          }
          onDismiss={() => {
            setCreated(null);
            setStatus({ tone: "success", message: "The new key is hidden. It cannot be shown again." });
          }}
        />
      )}

      <CreateApiKeyForm
        workspaceSlug={workspaceSlug}
        onCreated={(name, key) => {
          setCreated({ name, key });
          setStatus({ tone: "success", message: `Created the key ${name}.` });
        }}
      />

      <h3 className="mt-8 text-sm font-semibold">Keys in this workspace</h3>
      {keys.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No API keys yet. Create one above to read this workspace from a script.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {keys.map((key) => (
            <ApiKeyRow
              key={key.id}
              workspaceSlug={workspaceSlug}
              apiKey={key}
              onRevoked={(name) => setStatus({ tone: "success", message: `Revoked the key ${name}. Requests with it now fail.` })}
            />
          ))}
        </ul>
      )}
      {hasMore ? (
        <p className="mt-3 text-sm text-muted">Showing the newest {listLimit} keys. Older keys are not listed here.</p>
      ) : null}
    </div>
  );
}

/** The key a create just returned, shown once with a copy button; settings never shows it again. */
export function NewKeyPanel({
  name,
  apiKey,
  onCopied,
  onDismiss,
}: {
  name: string;
  apiKey: string;
  onCopied: (copied: boolean) => void;
  onDismiss: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inputId = useId();
  const warningId = useId();

  // The form that had focus stays, but the key is what to act on next.
  useEffect(() => {
    headingRef.current?.focus();
  }, [apiKey]);

  return (
    <section
      aria-labelledby={`${inputId}-title`}
      className="mb-6 rounded-lg border border-success/60 bg-success/10 px-4 py-4"
    >
      <h3 id={`${inputId}-title`} ref={headingRef} tabIndex={-1} className="text-sm font-semibold">
        Copy the key for {name} now
      </h3>
      <p id={warningId} className="mt-1 text-sm">
        This is the only time StackDash shows it. Store it somewhere safe, such as a password manager or your
        deployment&apos;s secret settings. If you lose it, revoke it and create another.
      </p>
      <label htmlFor={inputId} className="mt-3 block text-sm font-medium">
        API key
      </label>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <input
          id={inputId}
          type="text"
          readOnly
          value={apiKey}
          aria-describedby={warningId}
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          className="block min-h-10 w-full min-w-0 rounded-md border border-line-strong bg-panel-raised px-3 py-2 font-mono text-sm text-foreground"
        />
        <button
          type="button"
          className={`shrink-0 ${buttonClass("primary")}`}
          onClick={() => {
            navigator.clipboard.writeText(apiKey).then(
              () => onCopied(true),
              () => onCopied(false),
            );
          }}
        >
          Copy key
        </button>
      </div>
      <button type="button" onClick={onDismiss} className={`mt-3 ${buttonClass("secondary")}`}>
        Hide key
      </button>
    </section>
  );
}

function CreateApiKeyForm({
  workspaceSlug,
  onCreated,
}: {
  workspaceSlug: string;
  onCreated: (name: string, key: string) => void;
}) {
  // Controlled so a rejected submit keeps what was typed and ticked.
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlySet<ApiKeyScope>>(new Set());
  const [state, formAction, pending] = useActionState<CreateApiKeyResult | null, FormData>(
    async (previous, formData) => {
      const result = await createApiKey(previous, formData);
      if (result.ok) {
        onCreated(result.name, result.key);
        setName("");
        setScopes(new Set());
      }
      // The key is handed to onCreated and kept out of the form state.
      return result.ok ? { ...result, key: "" } : result;
    },
    null,
  );
  const id = useId();
  const nameHintId = `${id}-name-hint`;
  const nameErrorId = `${id}-name-error`;
  const scopesErrorId = `${id}-scopes-error`;
  const failure = failureOf(state);
  const nameError = failure?.fieldErrors?.name;
  const scopesError = failure?.fieldErrors?.scopes;
  const nameRef = useRef<HTMLInputElement>(null);
  // Arriving from the palette's "Create API key" (`createApiKeyPath`) starts in the name field, so
  // the action reads as one step. The URL fragment is read once, on arrival.
  useEffect(() => {
    if (window.location.hash === `#${CREATE_API_KEY_FIELD_ID}`) nameRef.current?.focus();
  }, []);

  return (
    <form
      // Submitted here rather than through the `action` prop: React resets a form after its action
      // runs, and while it restores a controlled text field (it syncs the default value), a reset
      // unticks controlled checkboxes. A successful create clears the fields itself above.
      onSubmit={(event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        startTransition(() => formAction(formData));
      }}
    >
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <label htmlFor={CREATE_API_KEY_FIELD_ID} className="block text-sm font-medium">
        Key name
      </label>
      <p id={nameHintId} className="mt-1 text-sm text-muted">
        Up to 80 characters. Name it after the script or tool that will use it.
      </p>
      <input
        ref={nameRef}
        id={CREATE_API_KEY_FIELD_ID}
        name="name"
        type="text"
        autoComplete="off"
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-invalid={nameError === undefined ? undefined : true}
        aria-describedby={nameError === undefined ? nameHintId : `${nameHintId} ${nameErrorId}`}
        className={`mt-2 block min-h-10 w-full rounded-md border bg-panel-raised px-3 py-2 text-sm text-foreground sm:max-w-md ${
          nameError === undefined ? "border-line-strong" : "border-danger"
        }`}
      />
      {nameError === undefined ? null : (
        <p id={nameErrorId} className="mt-2 text-sm text-danger">
          <span className="font-medium">Error: </span>
          {nameError}
        </p>
      )}

      <fieldset className="mt-5" aria-describedby={scopesError === undefined ? undefined : scopesErrorId}>
        <legend className="text-sm font-medium">What the key may read</legend>
        <p className="mt-1 text-sm text-muted">Keys only ever read. Choose at least one.</p>
        <div className="mt-2 grid gap-2">
          {API_KEY_SCOPES.map((scope) => {
            const optionId = `${id}-scope-${scope.replace(":", "-")}`;
            return (
              <div key={scope} className="flex items-start gap-2">
                <input
                  id={optionId}
                  type="checkbox"
                  name="scope"
                  value={scope}
                  checked={scopes.has(scope)}
                  onChange={(event) => {
                    const next = new Set(scopes);
                    if (event.target.checked) next.add(scope);
                    else next.delete(scope);
                    setScopes(next);
                  }}
                  aria-describedby={`${optionId}-description`}
                  className="mt-0.5 size-5 shrink-0"
                />
                <label htmlFor={optionId} className="text-sm">
                  <span className="font-medium">{API_KEY_SCOPE_LABELS[scope].label}</span>{" "}
                  <code className="font-mono text-xs text-muted">{scope}</code>
                  <span id={`${optionId}-description`} className="block text-muted">
                    {API_KEY_SCOPE_LABELS[scope].description}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
        {scopesError === undefined ? null : (
          <p id={scopesErrorId} className="mt-2 text-sm text-danger">
            <span className="font-medium">Error: </span>
            {scopesError}
          </p>
        )}
      </fieldset>

      <button type="submit" disabled={pending} className={`mt-5 shrink-0 ${buttonClass("primary")}`}>
        {pending ? "Creating" : "Create key"}
      </button>
      <ErrorSummary failure={failure} />
    </form>
  );
}

function ApiKeyRow({
  workspaceSlug,
  apiKey,
  onRevoked,
}: {
  workspaceSlug: string;
  apiKey: ApiKeyItem;
  onRevoked: (name: string) => void;
}) {
  const state = keyStateOf(apiKey);
  const badge = KEY_STATE_BADGES[state];
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="break-words font-medium">{apiKey.name}</span>
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
        </p>
        {state === "creator_left" ? (
          <p className="mt-1 text-warning">
            Its creator left the workspace, so requests with it fail. Revoke it and create a new key.
          </p>
        ) : null}
        <p className="mt-1 font-mono text-xs text-muted">{apiKey.tokenPrefix}…</p>
        <p className="mt-1 text-muted">
          Reads: {apiKey.scopes.map((scope) => API_KEY_SCOPE_LABELS[scope].label).join(", ")}
        </p>
        <p className="mt-1 text-xs text-muted">
          Created {apiKey.created}. {apiKey.lastUsed === null ? "Never used." : `Last used ${apiKey.lastUsed}.`}
          {apiKey.revoked === null ? null : ` Revoked ${apiKey.revoked}.`}
        </p>
      </div>
      {state === "revoked" ? null : (
        <RevokeApiKeyDialog workspaceSlug={workspaceSlug} apiKey={apiKey} onRevoked={onRevoked} />
      )}
    </li>
  );
}

/**
 * Revoke button plus a `ModalDialog` that says what revoking does before confirming. Escape or
 * Cancel returns focus to the button; after a revoke the button is gone, so the status region
 * announces the result instead.
 */
function RevokeApiKeyDialog({
  workspaceSlug,
  apiKey,
  onRevoked,
}: {
  workspaceSlug: string;
  apiKey: ApiKeyItem;
  onRevoked: (name: string) => void;
}) {
  const dialog = useModalDialog();

  return (
    <>
      <button
        type="button"
        onClick={(event) => dialog.open(event.currentTarget)}
        className={`shrink-0 self-start ${buttonClass("danger-quiet", "sm")}`}
      >
        Revoke<span className="sr-only"> {apiKey.name}</span>
      </button>
      <ModalDialog
        dialog={dialog}
        title={`Revoke ${apiKey.name}?`}
        description="Every script or tool using this key gets an error from its next request. A revoked key cannot be turned back on; create a new key if you need access again."
      >
        <RevokeConfirmation
          workspaceSlug={workspaceSlug}
          apiKey={apiKey}
          onRevoked={(name) => {
            dialog.close("completed");
            onRevoked(name);
          }}
        />
      </ModalDialog>
    </>
  );
}

function RevokeConfirmation({
  workspaceSlug,
  apiKey,
  onRevoked,
}: {
  workspaceSlug: string;
  apiKey: ApiKeyItem;
  onRevoked: (name: string) => void;
}) {
  const [state, formAction, pending] = useActionState<RevokeApiKeyResult | null, FormData>(
    async (previous, formData) => {
      const result = await revokeApiKey(previous, formData);
      if (result.ok) onRevoked(result.name);
      return result;
    },
    null,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="keyId" value={apiKey.id} />
      <ErrorSummary failure={failureOf(state)} />
      <DialogActions>
        <DialogCloseButton unavailable={pending} />
        <button type="submit" disabled={pending} className={buttonClass("danger")}>
          {pending ? "Revoking" : "Revoke key"}
        </button>
      </DialogActions>
    </form>
  );
}
