-- Marks a webhook StackDash created on a source that an older build made, so the after-sync pass
-- updates it once (#617).
--
-- GitLab automatic setup created each project webhook with the connection's secret as its secret
-- token until #616, which creates them with a signing token instead and no secret token. A webhook
-- made before #616 still sends the secret in plain text in `X-Gitlab-Token`, and the secret is now
-- also the key that signs the connection's newer webhooks. The after-sync pass
-- (addMissingSourceWebhooks, src/lib/connections/webhook-setup.ts) calls the adapter's per-source
-- `update` for every source whose webhook is marked, and clears the mark once the update succeeds
-- or the webhook is gone at the provider, so each one costs one call rather than one per sync.
--
-- New rows default to false: save_created_webhook_source only ever records a webhook the current
-- build made. The next migration (20261122090100_webhook_source_outdated_backfill.sql) marks the
-- existing ones.
--
-- Service role only, like the rest of the table (RLS on, no policies, no grants), so no policy or
-- grant changes. Adding a column with a constant default does not rewrite the table.

alter table public.webhook_sources
  add column provider_webhook_outdated boolean not null default false;

comment on column public.webhook_sources.provider_webhook_outdated is
  'The webhook StackDash created here was made by an older build and is updated once after a sync (#617).';
