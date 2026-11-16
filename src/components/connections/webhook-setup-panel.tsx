"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useLayoutEffect, useRef, useState, useTransition } from "react";

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

// Formatted on the server, in Europe/London.
type DeliveryTime = Readonly<{ iso: string; text: string }>;

/**
 * The sources of a provider that keeps one webhook per source (#428, GitLab projects): each one
 * StackDash added a webhook to, and each one a delivery has come from.
 */
export type WebhookPanelSources = Readonly<{
  heading: string;
  empty: string;
  items: readonly Readonly<{ id: string; name: string; addedByStackDash: boolean; lastDelivery: DeliveryTime | null }>[];
}>;

export type WebhookPanelEndpoint = Readonly<{
  mode: "manual" | "automatic";
  url: string;
  awaitingProviderSecret: boolean;
  // Null when no delivery arrived in the last 30 days.
  lastDelivery: DeliveryTime | null;
  // Null for a provider whose deliveries name no source.
  sources: WebhookPanelSources | null;
}>;

export type WebhookPanelView = Readonly<{
  workspaceSlug: string;
  connectionId: string;
  providerName: string;
  pollingNote: string;
  // The explanation under each choice; `automatic` is null when the provider offers setup by hand only.
  choices: Readonly<{ automatic: string | null; manual: string }>;
  writeAccess: boolean;
  // Write access held without an automatic webhook, and the reconnect that gives it up.
  leftoverWriteAccess: Readonly<{ note: string; reconnectHref: string }> | null;
  secretSource: "stackdash" | "provider";
  manualSteps: readonly string[];
  removalSteps: readonly string[];
  // How to move to setup by hand, shown on every automatic webhook.
  switchNote: string;
  // The first line of an automatic webhook's details.
  automaticNote: string;
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
  // With cacheComponents, leaving the route hides it in an Activity with its state kept instead of
  // unmounting it (node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md). Clear the
  // secret and the one-time focus when it is hidden, so neither comes back on return.
  useLayoutEffect(
    () => () => {
      setSecret(null);
      setJustSetUp(false);
      setStatus(null);
    },
    [],
  );
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
      {view.leftoverWriteAccess === null ? null : (
        <p className="mb-4 leading-6">
          {view.leftoverWriteAccess.note}{" "}
          <Link href={view.leftoverWriteAccess.reconnectHref} className="font-medium underline underline-offset-4">
            Reconnect {view.providerName} read-only
          </Link>
        </p>
      )}
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
          onClick={async () => {
            // `navigator.clipboard` is undefined outside a secure context, which throws here
            // rather than rejecting, so both failures land in the catch.
            try {
              await navigator.clipboard.writeText(value);
              onCopied(true);
            } catch {
              onCopied(false);
            }
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
          {view.automaticNote}
        </p>
        <CopyField label="Webhook address" value={endpoint.url} copyLabel="Copy address" onCopied={onCopied("Address")} />
        <LastDelivery endpoint={endpoint} />
        {endpoint.sources === null ? null : <WebhookSourceList sources={endpoint.sources} />}
        <p className="mt-4 leading-6 text-muted">{view.switchNote}</p>
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
      {endpoint.sources === null ? null : <WebhookSourceList sources={endpoint.sources} />}
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
          "None in the last 30 days."
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

/** The list of sources, for members who manage the connection and for those who only read it. */
export function WebhookSourceList({ sources }: { sources: WebhookPanelSources }) {
  const headingId = useId();
  return (
    <div className="mt-4">
      <h3 id={headingId} className="font-medium">
        {sources.heading}
      </h3>
      {sources.items.length === 0 ? (
        <p className="mt-1 leading-6 text-muted">{sources.empty}</p>
      ) : (
        <ul aria-labelledby={headingId} className="mt-2 divide-y divide-line rounded-lg border border-line">
          {sources.items.map((item) => (
            <li key={item.id} className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <span className="font-mono text-xs break-all">{item.name}</span>
              <span className="leading-6 text-muted">
                {item.addedByStackDash ? "Webhook added by StackDash. " : null}
                {item.lastDelivery === null ? (
                  "No delivery yet."
                ) : (
                  <>
                    Last delivery <time dateTime={item.lastDelivery.iso}>{item.lastDelivery.text}</time>.
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
