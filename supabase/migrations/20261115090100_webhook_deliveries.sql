-- Provider webhooks (#28). Grant model: see 20261031090000_tenancy.sql.
--
-- - webhook_endpoints: one URL per connection for providers whose webhook is set up per account
--   (`/api/webhooks/<provider>/<endpoint id>`), with the secret that verifies its deliveries as
--   AES-256-GCM ciphertext sealed by the app like provider credentials (#35). Providers with one
--   URL on StackDash's own app registration keep their secret in the environment and need no row.
-- - webhook_deliveries: every verified delivery, unique per (provider, delivery id), so a repeated
--   delivery is acknowledged and dropped. Holds the parsed outcome until the webhook job has
--   processed it, then only the key, for the deduplication window (30 days, retention job).
-- - sync_jobs.webhook_delivery_id: the delivery a `webhook` job processes. The route stores the
--   delivery and queues its job in one transaction (record_webhook_delivery).
--
-- Every table here is service role only: RLS on, no policies, no grants. Every function is called
-- only by the server with the service role.

create type public.webhook_delivery_status as enum ('received', 'processed');

-- ── webhook_endpoints (service role only) ───────────────────────────────────────
-- Ciphertext of the secret, associated data `webhook_endpoint:<workspace id>:<connection id>`
-- (src/lib/data/webhook-endpoints.ts). One endpoint per connection: setting the secret again keeps
-- the URL the provider already holds.

create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null,
  provider public.provider_id not null,
  key_id text not null,
  iv bytea not null,
  ciphertext bytea not null,
  auth_tag bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhook_endpoints_connection_id_key unique (connection_id),
  constraint webhook_endpoints_connection_fkey foreign key (workspace_id, connection_id)
    references public.connections (workspace_id, id) on delete cascade
);

create index webhook_endpoints_workspace_id_idx on public.webhook_endpoints (workspace_id);

create trigger webhook_endpoints_set_updated_at before update on public.webhook_endpoints
  for each row execute function public.set_updated_at();

-- ── webhook_deliveries (service role only) ──────────────────────────────────────
-- endpoint_id is null for a delivery to an app-level URL. Deleting a connection deletes its
-- endpoint and, through it, that endpoint's deliveries and their jobs.

create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  provider public.provider_id not null,
  -- The provider's own id for the delivery (GitHub's X-GitHub-Delivery, Svix's webhook-id).
  delivery_id text not null constraint webhook_deliveries_delivery_id_length check (char_length(delivery_id) between 1 and 200),
  endpoint_id uuid references public.webhook_endpoints (id) on delete cascade,
  status public.webhook_delivery_status not null default 'received',
  -- What the delivery means (WebhookOutcome as JSON), kept until the job has processed it.
  outcome jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint webhook_deliveries_provider_delivery_id_key unique (provider, delivery_id),
  constraint webhook_deliveries_processed_at_matches_status check ((status = 'processed') = (processed_at is not null)),
  constraint webhook_deliveries_received_has_outcome check (status = 'processed' or outcome is not null)
);

create index webhook_deliveries_endpoint_id_idx on public.webhook_deliveries (endpoint_id);
-- Retention deletes rows received more than 30 days ago (purge_webhook_deliveries).
create index webhook_deliveries_received_at_idx on public.webhook_deliveries (received_at);

-- ── sync_jobs: the delivery a webhook job processes ─────────────────────────────
-- Set exactly when the kind is webhook, so purging a delivery (which deletes its job by cascade)
-- can never take another kind of job with it.

alter table public.sync_jobs
  add column webhook_delivery_id uuid references public.webhook_deliveries (id) on delete cascade,
  add constraint sync_jobs_webhook_delivery_matches_kind check ((kind = 'webhook') = (webhook_delivery_id is not null));

create index sync_jobs_webhook_delivery_id_idx on public.sync_jobs (webhook_delivery_id) where webhook_delivery_id is not null;

-- ── Row level security and grants ───────────────────────────────────────────────

alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;

revoke all on table public.webhook_endpoints, public.webhook_deliveries from anon, authenticated;

-- webhook_endpoints and webhook_deliveries: RLS on, no policies, no grants. Service role only.

-- ── record_webhook_delivery ─────────────────────────────────────────────────────
-- Stores a verified delivery and queues its webhook job in one transaction. Returns false when
-- (provider, delivery id) is already stored: the provider retried, and the first delivery's job
-- does the work. Two concurrent copies of one delivery serialize on the unique key, so exactly one
-- returns true. The job is instance-wide (no workspace): an app-level delivery can reach several
-- workspaces, and the job finds them (list_webhook_targets).

create function public.record_webhook_delivery(
  p_provider public.provider_id,
  p_delivery_id text,
  p_outcome jsonb,
  p_endpoint_id uuid default null
)
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_provider is null or p_outcome is null then
    raise exception 'p_provider and p_outcome are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_endpoint_id is not null and not exists (
    select 1 from public.webhook_endpoints e where e.id = p_endpoint_id and e.provider = p_provider
  ) then
    raise exception 'p_endpoint_id must name an endpoint of p_provider' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.webhook_deliveries (provider, delivery_id, endpoint_id, outcome)
  values (p_provider, p_delivery_id, p_endpoint_id, p_outcome)
  on conflict (provider, delivery_id) do nothing
  returning id into v_id;

  if v_id is null then
    return false;
  end if;

  insert into public.sync_jobs (kind, webhook_delivery_id) values ('webhook', v_id);
  return true;
end;
$$;

revoke execute on function public.record_webhook_delivery(public.provider_id, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.record_webhook_delivery(public.provider_id, text, jsonb, uuid) to service_role;

-- ── list_webhook_targets ────────────────────────────────────────────────────────
-- Where a delivery's external account lands: each included external account with that external id
-- on an active or needs_attention connection of the provider, in every workspace for an app-level
-- delivery, and only on the endpoint's own connection when p_endpoint_id is set. Bounded at 100:
-- one provider account connected to more workspaces than that reaches the first by id, and polling
-- still brings the rest their events. Security invoker: only the service role may call it, and it
-- already reads every row it needs.

create index external_accounts_external_id_idx on public.external_accounts (external_id);

create function public.list_webhook_targets(
  p_provider public.provider_id,
  p_external_id text,
  p_endpoint_id uuid default null
)
  returns table (workspace_id uuid, connection_id uuid, account_id uuid)
  language sql
  stable
  set search_path = ''
as $$
  select a.workspace_id, a.connection_id, a.id
  from public.external_accounts a
  join public.connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
  where a.external_id = p_external_id
    and a.included
    and c.provider = p_provider
    and c.status in ('active', 'needs_attention')
    and (
      p_endpoint_id is null
      or exists (
        select 1 from public.webhook_endpoints e
        where e.id = p_endpoint_id and e.workspace_id = c.workspace_id and e.connection_id = c.id
      )
    )
  order by a.id
  limit 100;
$$;

revoke execute on function public.list_webhook_targets(public.provider_id, text, uuid) from public, anon, authenticated;
grant execute on function public.list_webhook_targets(public.provider_id, text, uuid) to service_role;

-- ── purge_webhook_deliveries ────────────────────────────────────────────────────
-- Every delivery received before p_before, processed or not: one still unprocessed after 30 days
-- belongs to a job that used all its attempts. Deleting it deletes that job too.

create function public.purge_webhook_deliveries(p_before timestamptz, p_limit int)
  returns int
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_deleted int;
begin
  if p_before is null or p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'p_before is required and p_limit must be between 1 and 10000' using errcode = 'invalid_parameter_value';
  end if;

  with doomed as (
    select d.id from public.webhook_deliveries d
    where d.received_at < p_before
    order by d.id
    limit p_limit
    for update skip locked
  )
  delete from public.webhook_deliveries d using doomed where d.id = doomed.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.purge_webhook_deliveries(timestamptz, int) from public, anon, authenticated;
grant execute on function public.purge_webhook_deliveries(timestamptz, int) to service_role;
