"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useRef, useState, useTransition } from "react";

import {
  regenerateWebhookSecret,
  saveWebhookSigningSecret,
  setUpWebhook,
  type WebhookActionResult,
} from "@/app/w/[workspace]/connections/actions";
import { GuardedButton } from "@/components/guarded-button";
import { buttonClass } from "@/components/ui/button";
import { FailureAnnouncement, LiveRegion, OutcomeAnnouncement, outcomeOf, type Outcome } from "@/components/ui/live-region";

/*
 * The webhook setup panel on a connection's page (#426). The page renders the section and its
 * heading on the server and hands this component plain words and values only: the adapter's
 * declaration holds functions, and the secret never reaches the page except in the result of the
 * action that made it, shown once.
 */

export type WebhookPanelEndpoint = Readonly<{
  mode: "manual" | "automatic";
  url: string;
  awaitingProviderSecret: boolean;
  // Formatted on the server, in Europe/London; null when no delivery arrived in the last 30 days.
  lastDelivery: Readonly<{ iso: string; text: string }> | null;
}>;

export type WebhookPanelView = Readonly<{
  workspaceSlug: string;
  connectionId: string;
  providerName: string;
  pollingNote: string;
  // The explanation under each choice; `automatic` is null when the provider offers setup by hand only.
  choices: Readonly<{ automatic: string | null; manual: string }>;
  writeAccess: boolean;
  secretSource: "stackdash" | "provider";
  manualSteps: readonly string[];
  removalSteps: readonly string[];
  switchNote: string;
  // Set when the workspace holds as many endpoints as it may and this connection has none.
  limitMessage: string | null;
  endpoint: WebhookPanelEndpoint | null;
}>;

type WebhookAction = (previous: WebhookActionResult | null, formData: FormData) => Promise<WebhookActionResult>;

function useWebhookAction(action: WebhookAction, onSecret: (secret: string) => void) {
  return useActionState<WebhookActionResult | null, FormData>(async (previous, formData) => {
    const result = await action(previous, formData);
    if (!result.ok || result.secret === undefined) return result;
    onSecret(result.secret);
    // The secret goes to the panel's own state, never into the form state.
    return { ok: true, message: result.message };
  }, null);
}

function HiddenFields({ workspaceSlug, connectionId }: { workspaceSlug: string; connectionId: string }) {
  return (
    <>
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="connectionId" value={connectionId} />
    </>
  );
}

/** The panel's controls, for owners and admins. */
export function WebhookSetupPanel({ view }: { view: WebhookPanelView }) {
  // A secret StackDash just made, shown until the page is left; it cannot be shown again.
  const [secret, setSecret] = useState<string | null>(null);
  const [status, setStatus] = useState<Outcome | null>(null);
  // Set once setup succeeds: the form that had focus is gone, so focus moves to what replaced it.
  const [justSetUp, setJustSetUp] = useState(false);
  const copied = (what: string) => (ok: boolean) =>
    setStatus(
      ok
        ? { tone: "success", message: `${what} copied.` }
        : { tone: "error", message: `Copying did not work in this browser. Select the ${what.toLowerCase()} and copy it yourself.` },
    );

  return (
    <div className="px-6 py-4 text-sm">
      {/* Always mounted, so screen readers announce every setup result and copy. */}
      <OutcomeAnnouncement outcome={status} messageClassName="mb-3" />
      {view.endpoint === null ? (
        view.limitMessage === null ? (
          <SetupChoiceForm
            view={view}
            onSetUp={(newSecret, message) => {
              if (newSecret !== null) setSecret(newSecret);
              setStatus({ tone: "success", message });
              setJustSetUp(true);
            }}
          />
        ) : (
          <p className="leading-6 text-muted">{view.limitMessage}</p>
        )
      ) : (
        <EndpointDetails
          view={view}
          endpoint={view.endpoint}
          secret={secret}
          focusOnMount={justSetUp}
          onSecret={setSecret}
          onCopied={copied}
        />
      )}
    </div>
  );
}

function SetupChoiceForm({ view, onSetUp }: { view: WebhookPanelView; onSetUp: (secret: string | null, message: string) => void }) {
  const [state, formAction, pending] = useActionState<WebhookActionResult | null, FormData>(async (previous, formData) => {
    const result = await setUpWebhook(previous, formData);
    if (!result.ok) return result;
    // Success replaces this form with the webhook's details, so the panel keeps the result, and
    // the secret goes to the panel's own state, never into the form state.
    onSetUp(result.secret ?? null, result.message);
    return { ok: true, message: result.message };
  }, null);
  const id = useId();
  const choices = [
    ...(view.choices.automatic === null
      ? []
      : [{ value: "automatic", label: "Set up automatically", copy: view.choices.automatic, writeAccess: view.writeAccess }]),
    { value: "manual", label: "Set up by hand", copy: view.choices.manual, writeAccess: false },
  ];
  return (
    <form action={formAction}>
      <HiddenFields workspaceSlug={view.workspaceSlug} connectionId={view.connectionId} />
      <p className="leading-6 text-muted">{view.pollingNote}</p>
      <fieldset className="mt-4">
        <legend className="font-medium">How do you want to set up the webhook?</legend>
        <div className="mt-3 flex flex-col gap-3">
          {choices.map((choice) => {
            const optionId = `${id}-${choice.value}`;
            const copyId = `${optionId}-copy`;
            return (
              <div
                key={choice.value}
                className="flex items-start gap-3 rounded-lg border border-line-strong px-4 py-3 has-[:checked]:border-accent"
              >
                <input
                  id={optionId}
                  type="radio"
                  name="mode"
                  value={choice.value}
                  required
                  aria-describedby={copyId}
                  className="mt-0.5 size-5 shrink-0 accent-accent"
                />
                <div>
                  <label htmlFor={optionId} className="flex flex-wrap items-center gap-2 font-medium">
                    {choice.label}
                    {choice.writeAccess ? (
                      <span className="rounded-full border border-warning/50 px-2 py-0.5 text-xs font-medium text-warning">
                        Write access
                      </span>
                    ) : null}
                  </label>
                  <p id={copyId} className="mt-1 leading-6 text-muted">
                    {choice.copy}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>
      <div className="mt-4 flex flex-col items-start gap-2">
        <GuardedButton type="submit" unavailable={pending} className={buttonClass("primary")}>
          {pending ? "Setting up the webhook" : "Set up the webhook"}
        </GuardedButton>
        <FailureAnnouncement failure={pending || state === null || state.ok ? null : state} />
      </div>
    </form>
  );
}

function CopyField({
  label,
  value,
  hint,
  copyLabel,
  onCopied,
}: {
  label: string;
  value: string;
  hint?: string;
  copyLabel: string;
  onCopied: (ok: boolean) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="mt-4">
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className="mt-1 leading-6 text-muted">
          {hint}
        </p>
      )}
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <input
          id={id}
          type="text"
          readOnly
          value={value}
          aria-describedby={hint === undefined ? undefined : hintId}
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          className="block min-h-10 w-full min-w-0 rounded-md border border-line-strong bg-panel-raised px-3 py-2 font-mono text-sm text-foreground"
        />
        <button
          type="button"
          className={`shrink-0 ${buttonClass("raised")}`}
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => onCopied(true),
              () => onCopied(false),
            );
          }}
        >
          {copyLabel}
        </button>
      </div>
    </div>
  );
}

function EndpointDetails({
  view,
  endpoint,
  secret,
  focusOnMount,
  onSecret,
  onCopied,
}: {
  view: WebhookPanelView;
  endpoint: WebhookPanelEndpoint;
  secret: string | null;
  focusOnMount: boolean;
  onSecret: (secret: string) => void;
  onCopied: (what: string) => (ok: boolean) => void;
}) {
  const introRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focusOnMount) introRef.current?.focus();
  }, [focusOnMount]);
  const name = view.providerName;
  const introClass = "leading-6 outline-offset-2";
  if (endpoint.mode === "automatic") {
    return (
      <>
        <p ref={introRef} tabIndex={-1} className={introClass}>
          Set up automatically. StackDash added this webhook in {name} and deletes it when you disconnect.
        </p>
        <CopyField label="Webhook address" value={endpoint.url} copyLabel="Copy address" onCopied={onCopied("Address")} />
        <LastDelivery endpoint={endpoint} />
        {view.writeAccess ? <p className="mt-4 leading-6 text-muted">{view.switchNote}</p> : null}
      </>
    );
  }
  return (
    <>
      <p ref={introRef} tabIndex={-1} className={introClass}>
        Set up by hand. Add the webhook in {name} with these steps:
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 leading-6">
        {view.manualSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <CopyField label="Webhook address" value={endpoint.url} copyLabel="Copy address" onCopied={onCopied("Address")} />
      {view.secretSource === "stackdash" ? (
        <StackDashSecret view={view} secret={secret} onSecret={onSecret} onCopied={onCopied("Secret")} />
      ) : (
        <ProviderSecretForm view={view} awaiting={endpoint.awaitingProviderSecret} />
      )}
      <LastDelivery endpoint={endpoint} />
      <p className="mt-4 leading-6 text-muted">
        When you disconnect, StackDash stops accepting this webhook&apos;s deliveries. Remove it in {name} as well:{" "}
        {view.removalSteps.join(" ")}
      </p>
    </>
  );
}

function StackDashSecret({
  view,
  secret,
  onSecret,
  onCopied,
}: {
  view: WebhookPanelView;
  secret: string | null;
  onSecret: (secret: string) => void;
  onCopied: (ok: boolean) => void;
}) {
  const [state, formAction, pending] = useWebhookAction(regenerateWebhookSecret, onSecret);
  return (
    <>
      {secret === null ? (
        <p className="mt-4 leading-6 text-muted">
          <span className="font-medium text-foreground">Webhook secret: </span>
          StackDash shows the secret only once, when it is made. If you no longer have it, make a new one and replace
          it in {view.providerName}.
        </p>
      ) : (
        <CopyField
          label="Webhook secret"
          value={secret}
          hint="Copy it now: this is the only time StackDash shows it. Leaving this page hides it."
          copyLabel="Copy secret"
          onCopied={onCopied}
        />
      )}
      <form action={formAction} className="mt-3 flex flex-col items-start gap-2">
        <HiddenFields workspaceSlug={view.workspaceSlug} connectionId={view.connectionId} />
        <GuardedButton type="submit" unavailable={pending} className={buttonClass("outline")}>
          {pending ? "Making a new secret" : "Make a new secret"}
        </GuardedButton>
        <OutcomeAnnouncement outcome={outcomeOf(pending ? null : state, state?.ok === true ? state.message : null)} />
      </form>
    </>
  );
}

function ProviderSecretForm({ view, awaiting }: { view: WebhookPanelView; awaiting: boolean }) {
  const [state, formAction, pending] = useWebhookAction(saveWebhookSigningSecret, () => undefined);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const fieldError = state !== null && !state.ok ? state.fieldErrors?.signingSecret : undefined;
  const inputRef = useRef<HTMLInputElement>(null);
  // A refused secret puts focus back on the field its error describes.
  useEffect(() => {
    if (fieldError !== undefined) inputRef.current?.focus();
  }, [state, fieldError]);
  return (
    <form action={formAction} className="mt-4">
      <HiddenFields workspaceSlug={view.workspaceSlug} connectionId={view.connectionId} />
      <label htmlFor={id} className="block font-medium">
        Signing secret from {view.providerName}
      </label>
      <p id={hintId} className="mt-1 leading-6 text-muted">
        {awaiting
          ? `Deliveries are refused until you paste it. ${view.providerName} shows it on the webhook once you have added it.`
          : `Saved. If you replace the webhook's secret in ${view.providerName}, paste the new one here.`}
      </p>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <input
          ref={inputRef}
          id={id}
          name="signingSecret"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={fieldError === undefined ? undefined : true}
          aria-describedby={fieldError === undefined ? hintId : `${hintId} ${errorId}`}
          className="block min-h-10 w-full min-w-0 rounded-md border border-line-strong bg-panel-raised px-3 py-2 font-mono text-sm text-foreground"
        />
        <GuardedButton type="submit" unavailable={pending} className={`shrink-0 ${buttonClass("outline")}`}>
          {pending ? "Saving" : "Save signing secret"}
        </GuardedButton>
      </div>
      {fieldError === undefined ? null : (
        <p id={errorId} className="mt-2 text-danger">
          <span className="font-medium">Error: </span>
          {fieldError}
        </p>
      )}
      <OutcomeAnnouncement
        className="mt-2"
        outcome={outcomeOf(pending || fieldError !== undefined ? null : state, state?.ok === true ? state.message : null)}
      />
    </form>
  );
}

/**
 * When the last delivery arrived, in a polite live region, so a member who sends a test delivery
 * from the provider hears it arrive after checking again. Checking re-renders the page on the
 * server; nothing polls.
 */
function LastDelivery({ endpoint }: { endpoint: WebhookPanelEndpoint }) {
  const { refresh } = useRouter();
  const [checking, startChecking] = useTransition();
  return (
    <div className="mt-4 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-4">
      <LiveRegion tone="status" as="p" className="leading-6">
        <span className="font-medium">Last delivery: </span>
        {checking ? (
          "Checking"
        ) : endpoint.lastDelivery === null ? (
          "None has arrived yet."
        ) : (
          <time dateTime={endpoint.lastDelivery.iso}>{endpoint.lastDelivery.text}</time>
        )}
      </LiveRegion>
      <GuardedButton
        type="button"
        unavailable={checking}
        className={`shrink-0 ${buttonClass("outline", "sm")}`}
        onClick={() => startChecking(() => refresh())}
      >
        Check for deliveries
      </GuardedButton>
    </div>
  );
}
