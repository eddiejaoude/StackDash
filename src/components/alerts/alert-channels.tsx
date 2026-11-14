"use client";

import { useActionState, useId, useState } from "react";

import {
  addAlertChannel,
  deleteAlertChannel,
  sendAlertChannelTest,
  updateAlertChannel,
  type AlertActionResult,
} from "@/app/w/[workspace]/alerts/actions";
import { GuardedButton } from "@/components/guarded-button";
import { buttonClass } from "@/components/ui/button";
import { LiveRegion, OutcomeAnnouncement, outcomeOf } from "@/components/ui/live-region";
import { ALERT_SETTINGS_IDS } from "@/lib/workspaces/paths";

import { ConfirmDelete } from "./confirm-delete";
import {
  ErrorSummary,
  failureOf,
  SelectField,
  submitWithoutReset,
  TextField,
} from "./form-controls";
import { DESTINATION_KIND_LABELS, DIGEST_LABELS, type ChannelFormValues, type Option } from "./labels";
import { Badge, CreateDisclosure, EditableRow } from "./list-items";

/*
 * Alert channels (#153): Discord, Slack, and generic webhooks. The URL is written once, when the
 * channel is added, and never shown again: it is the channel's secret. To change it, remove the
 * channel and add it again.
 */

const URL_HINTS: Record<ChannelFormValues["kind"], string> = {
  discord: "In Discord: channel settings, Integrations, Webhooks, New Webhook, Copy Webhook URL.",
  slack: "In Slack: create an app with incoming webhooks for the channel, then copy its webhook URL. It starts with https://hooks.slack.com/services/.",
  webhook: "Any https URL that accepts a JSON POST. StackDash signs each request so the receiver can check it came from here.",
};

function RuleChoices({
  idPrefix,
  values,
  onChange,
  ruleOptions,
  error,
}: {
  idPrefix: string;
  values: Pick<ChannelFormValues, "rules" | "ruleIds">;
  onChange: (patch: Partial<ChannelFormValues>) => void;
  ruleOptions: Option[];
  error: string | undefined;
}) {
  const errorId = `${idPrefix}-rules-error`;
  return (
    <fieldset aria-describedby={error === undefined ? undefined : errorId}>
      <legend className="text-sm font-medium">Alerts to send</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {(
          [
            { value: "all", label: "Every alert rule" },
            { value: "chosen", label: "Only the rules I choose" },
          ] as const
        ).map((choice, index) => {
          const optionId = index === 0 ? `${idPrefix}-rules` : `${idPrefix}-rules-${choice.value}`;
          return (
            <label
              key={choice.value}
              htmlFor={optionId}
              className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-line-strong bg-panel-raised px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                id={optionId}
                type="radio"
                name="rules"
                value={choice.value}
                checked={values.rules === choice.value}
                onChange={() => onChange({ rules: choice.value })}
                className="size-4 accent-accent"
              />
              {choice.label}
            </label>
          );
        })}
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="mt-2 text-sm text-danger">
          <span className="font-medium">Error: </span>
          {error}
        </p>
      )}
      {values.rules === "chosen" ? (
        ruleOptions.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No alert rules yet. Add a rule above first, or send every alert.</p>
        ) : (
          <ul className="mt-3 space-y-2" aria-label="Alert rules this channel receives">
            {ruleOptions.map((rule) => {
              const checkboxId = `${idPrefix}-rule-${rule.value}`;
              const checked = values.ruleIds.includes(rule.value);
              return (
                <li key={rule.value}>
                  <label htmlFor={checkboxId} className="inline-flex min-h-6 cursor-pointer items-start gap-2 text-sm">
                    <input
                      id={checkboxId}
                      type="checkbox"
                      name="ruleIds"
                      value={rule.value}
                      checked={checked}
                      onChange={() =>
                        onChange({
                          ruleIds: checked ? values.ruleIds.filter((id) => id !== rule.value) : [...values.ruleIds, rule.value],
                        })
                      }
                      className="mt-0.5 size-4 shrink-0 accent-accent"
                    />
                    {rule.label}
                  </label>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </fieldset>
  );
}

/** Adds a channel, or edits one when `destinationId` is set (everything but the URL and kind). */
export function ChannelForm({
  workspaceSlug,
  ruleOptions,
  initial,
  destinationId,
  title,
  onSaved,
  onCancel,
}: {
  workspaceSlug: string;
  ruleOptions: Option[];
  initial: ChannelFormValues;
  destinationId?: string;
  title: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const isEdit = destinationId !== undefined;
  const [values, setValues] = useState(initial);
  const [state, formAction, pending] = useActionState<AlertActionResult | null, FormData>(async (previous, formData) => {
    const result = await (isEdit ? updateAlertChannel : addAlertChannel)(previous, formData);
    if (result.ok) {
      if (isEdit) onSaved?.();
      else setValues(initial);
    }
    return result;
  }, null);
  const id = useId();
  const errors = failureOf(state)?.fieldErrors ?? {};
  const update = (patch: Partial<ChannelFormValues>) => setValues((current) => ({ ...current, ...patch }));
  const fieldIds = {
    kind: `${id}-kind`,
    name: `${id}-name`,
    url: `${id}-url`,
    rules: `${id}-rules`,
    digest: `${id}-digest`,
  };
  const signingSecret = !isEdit && state?.ok === true ? state.signingSecret : undefined;

  return (
    <form action={formAction} onSubmit={submitWithoutReset(formAction)} aria-label={title} className="space-y-5">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      {destinationId === undefined ? null : <input type="hidden" name="destinationId" value={destinationId} />}

      <ErrorSummary state={state} title={isEdit ? "The changes were not saved" : "The channel was not added"} fieldIds={fieldIds} />

      {isEdit ? null : (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id={fieldIds.kind}
            name="kind"
            label="Where to post"
            error={errors.kind}
            value={values.kind}
            onChange={(kind) => {
              if (kind === "discord" || kind === "slack" || kind === "webhook") update({ kind });
            }}
            options={Object.entries(DESTINATION_KIND_LABELS).map(([value, label]) => ({ value, label }))}
          />
        </div>
      )}

      <div className="max-w-md">
        <TextField
          id={fieldIds.name}
          name="name"
          label="Channel name"
          hint="Up to 80 characters, such as #alerts or Ops webhook. Only StackDash shows it."
          error={errors.name}
          value={values.name}
          onChange={(name) => update({ name })}
        />
      </div>

      {isEdit ? null : (
        <TextField
          id={fieldIds.url}
          name="url"
          label="Webhook URL"
          hint={`${URL_HINTS[values.kind]} StackDash stores it encrypted and never shows it again.`}
          error={errors.url}
          value={values.url}
          onChange={(url) => update({ url })}
        />
      )}

      <RuleChoices idPrefix={id} values={values} onChange={update} ruleOptions={ruleOptions} error={errors.rules} />

      <div className="max-w-xs">
        <SelectField
          id={fieldIds.digest}
          name="digest"
          label="Digest"
          hint="The daily or weekly summary of alerts, usage, and spend."
          error={errors.digest}
          value={values.digest}
          onChange={(digest) => {
            if (digest === "off" || digest === "daily" || digest === "weekly") update({ digest });
          }}
          options={Object.entries(DIGEST_LABELS).map(([value, label]) => ({ value, label }))}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <GuardedButton type="submit" unavailable={pending} className={buttonClass("primary")}>
          {pending ? "Saving" : isEdit ? "Save changes" : "Add channel"}
        </GuardedButton>
        {onCancel === undefined ? null : (
          <button type="button" onClick={onCancel} className={buttonClass("raised")}>
            Cancel
          </button>
        )}
      </div>

      <LiveRegion tone="status" className="text-sm">
        {!pending && state?.ok === true && !isEdit ? (
          <div className="space-y-2">
            <p className="text-success">Channel added. Send a test message to check it.</p>
            {signingSecret === undefined ? null : (
              <div className="rounded-lg border border-line bg-panel-raised px-4 py-3">
                <p className="font-medium">Signing secret</p>
                <p className="mt-1 text-muted">
                  Copy it now: StackDash does not show it again. Your receiver checks the webhook-signature header with it.
                </p>
                <code className="mt-2 block break-all font-mono text-xs text-foreground">{signingSecret}</code>
              </div>
            )}
          </div>
        ) : null}
      </LiveRegion>
    </form>
  );
}

export function NewChannel({
  workspaceSlug,
  ruleOptions,
  initial,
}: {
  workspaceSlug: string;
  ruleOptions: Option[];
  initial: ChannelFormValues;
}) {
  return (
    <CreateDisclosure
      id={ALERT_SETTINGS_IDS.newChannel}
      label="New channel"
      title="Add a channel"
      renderForm={(close) => (
        <ChannelForm workspaceSlug={workspaceSlug} ruleOptions={ruleOptions} initial={initial} title="Add a channel" onCancel={close} />
      )}
    />
  );
}

function TestButton({ workspaceSlug, destinationId, name }: { workspaceSlug: string; destinationId: string; name: string }) {
  const [state, formAction, pending] = useActionState<AlertActionResult | null, FormData>(sendAlertChannelTest, null);
  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="destinationId" value={destinationId} />
      <GuardedButton type="submit" unavailable={pending} className={buttonClass("raised", "xs")}>
        {pending ? "Sending" : "Send test message"}
        <span className="sr-only">: {name}</span>
      </GuardedButton>
      <OutcomeAnnouncement
        inline
        outcome={outcomeOf(pending ? null : state, `Test message sent to ${name}.`)}
        className="basis-full text-sm"
      />
    </form>
  );
}

export type ChannelRow = {
  id: string;
  kind: ChannelFormValues["kind"];
  name: string;
  host: string;
  allRules: boolean;
  ruleIds: string[];
  digest: ChannelFormValues["digest"];
  needsAttention: boolean;
  /** Plain words for the last failure, with its reference id, or null. */
  problem: string | null;
  lastDelivered: string | null;
};

export function ChannelListItem({
  row,
  workspaceSlug,
  ruleOptions,
  canManage,
  afterDeleteFocusId,
}: {
  row: ChannelRow;
  workspaceSlug: string;
  ruleOptions: Option[];
  canManage: boolean;
  afterDeleteFocusId: string;
}) {
  const kind = DESTINATION_KIND_LABELS[row.kind];
  const receives = row.allRules
    ? "Every alert rule"
    : `${row.ruleIds.length} chosen ${row.ruleIds.length === 1 ? "rule" : "rules"}`;
  return (
    <EditableRow
      summary={row.name}
      details={
        <>
          <p>
            {kind} at {row.host}
          </p>
          <p>
            Sends: {receives}, {DIGEST_LABELS[row.digest].toLowerCase()}
          </p>
          <p>{row.lastDelivered === null ? "Nothing delivered yet" : `Last delivered ${row.lastDelivered}`}</p>
          {row.problem === null ? null : <p className="text-danger">{row.problem}</p>}
        </>
      }
      badges={<Badge tone={row.needsAttention ? "danger" : "neutral"}>{row.needsAttention ? "Needs attention" : "Active"}</Badge>}
      editLabel={canManage ? "Edit channel" : null}
      editTitle="Edit channel"
      actions={
        canManage ? (
          <>
            <TestButton workspaceSlug={workspaceSlug} destinationId={row.id} name={row.name} />
            <ConfirmDelete
              label="Remove channel"
              accessibleSuffix={row.name}
              title="Remove this channel?"
              description={`${row.name} (${kind}) stops receiving alerts, and StackDash deletes its webhook URL. This cannot be undone.`}
              confirmLabel="Remove channel"
              action={deleteAlertChannel}
              fields={{ workspace: workspaceSlug, destinationId: row.id }}
              afterDeleteFocusId={afterDeleteFocusId}
            />
          </>
        ) : null
      }
      renderForm={(done) => (
        <ChannelForm
          workspaceSlug={workspaceSlug}
          ruleOptions={ruleOptions}
          initial={{ kind: row.kind, name: row.name, url: "", rules: row.allRules ? "all" : "chosen", ruleIds: row.ruleIds, digest: row.digest }}
          destinationId={row.id}
          title="Edit channel"
          onSaved={() => done("Channel saved.")}
          onCancel={() => done(null)}
        />
      )}
    />
  );
}
