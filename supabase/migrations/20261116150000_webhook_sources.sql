-- Webhooks per source (#428): a provider whose webhooks belong to one resource rather than to the
-- whole grant (a GitLab project; group webhooks need a paid GitLab tier) keeps one webhook per
-- resource, all pointing at the connection's one endpoint. Expand only: the new column defaults,
-- and the new table is read and written only by code that knows it.
--
-- 1. webhook_sources: the resources ("sources") of an endpoint. A row is a webhook StackDash
--    created there by automatic setup (provider_webhook_id, deleted at the provider on disconnect),
--    a source automatic setup could not give one yet (no provider_webhook_id, tried again after the
--    next sync), or a resource a delivery came from (last_delivery_at, for the setup panel's list
--    of which projects have sent one), or several of these. Service role only, like
--    webhook_endpoints.
-- 2. webhook_sources_enforce_limit: at most 100 sources per endpoint, so a stream of deliveries
--    naming new resources cannot grow the table without bound. Automatic setup creates at most
--    WEBHOOK_SOURCES_PER_ENDPOINT (src/lib/connections/webhook-setup.ts), the same number.
-- 3. webhook_endpoints.per_source: an automatic endpoint whose webhooks are per source names none
--    in provider_webhook_id; its webhook ids are in webhook_sources instead. The check that an
--    automatic endpoint names its provider webhook now applies to the others only.
-- 4. record_webhook_source: a delivery's source and when it arrived, newest time kept.
-- 5. save_created_webhook_source: records the webhook automatic setup created on a source only
--    where none is recorded, so two setups racing for one source never overwrite the id of a
--    webhook that would then be left at the provider with nothing to delete it.
-- 6. delete_webhook_endpoint: reads an endpoint's setup and its sources' webhooks and deletes the
--    endpoint (its sources by cascade) in one transaction, so a failure cannot lose the record of
--    webhooks still at the provider.

-- ── webhook_sources (service role only) ────────────────────────────────────────

create table public.webhook_sources (
  endpoint_id uuid not null references public.webhook_endpoints (id) on delete cascade,
  -- The provider's own id for the resource (a GitLab project id).
  source_id text not null constraint webhook_sources_source_id_length check (char_length(source_id) between 1 and 200),
  -- Its name for the panel (a GitLab project's path), as the provider last reported it.
  source_name text not null constraint webhook_sources_source_name_length check (char_length(source_name) between 1 and 300),
  -- The webhook StackDash created on the resource; null for one the user added by hand.
  provider_webhook_id text constraint webhook_sources_provider_webhook_id_length check (char_length(provider_webhook_id) between 1 and 200),
  last_delivery_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (endpoint_id, source_id)
);

create trigger webhook_sources_set_updated_at before update on public.webhook_sources
  for each row execute function public.set_updated_at();

alter table public.webhook_sources enable row level security;
revoke all on table public.webhook_sources from anon, authenticated;
-- RLS on, no policies, no grants. Service role only.

-- ── webhook_sources_enforce_limit ───────────────────────────────────────────────
-- Refuses a 101st source for an endpoint. Locking the endpoint row serializes two inserts for one
-- endpoint (as webhook_endpoints_enforce_limit locks the workspace). A row that already exists is
-- not counted: a BEFORE INSERT trigger fires before ON CONFLICT is resolved, so an upsert of a
-- known source at the limit would otherwise be refused.

create function public.webhook_sources_enforce_limit()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_count int;
begin
  perform 1 from public.webhook_endpoints e where e.id = new.endpoint_id for no key update;
  if exists (select 1 from public.webhook_sources s where s.endpoint_id = new.endpoint_id and s.source_id = new.source_id) then
    return new;
  end if;
  select count(*) into v_count from public.webhook_sources s where s.endpoint_id = new.endpoint_id;
  if v_count >= 100 then
    raise exception 'webhook endpoint % already has % sources', new.endpoint_id, v_count
      using errcode = 'program_limit_exceeded';
  end if;
  return new;
end;
$$;

revoke execute on function public.webhook_sources_enforce_limit() from public, anon, authenticated;

create trigger webhook_sources_enforce_limit
  before insert on public.webhook_sources
  for each row execute function public.webhook_sources_enforce_limit();

-- ── webhook_endpoints.per_source ────────────────────────────────────────────────

alter table public.webhook_endpoints
  add column per_source boolean not null default false,
  drop constraint webhook_endpoints_automatic_has_provider_webhook,
  add constraint webhook_endpoints_automatic_has_provider_webhook
    check ((setup_mode = 'automatic' and not per_source) = (provider_webhook_id is not null)),
  add constraint webhook_endpoints_per_source_is_automatic check (not per_source or setup_mode = 'automatic');

-- ── record_webhook_source ───────────────────────────────────────────────────────
-- Notes that a verified delivery to p_endpoint_id came from p_source_id, keeping the newest
-- arrival (a provider's retry can arrive after a newer delivery) and the name it was last sent
-- with. Raises program_limit_exceeded for a new source past the endpoint's limit; the caller logs
-- it and goes on, because the delivery itself is unaffected.

create function public.record_webhook_source(
  p_endpoint_id uuid,
  p_source_id text,
  p_source_name text,
  p_received_at timestamptz
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
begin
  if p_endpoint_id is null or p_received_at is null then
    raise exception 'p_endpoint_id and p_received_at are required' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.webhook_sources (endpoint_id, source_id, source_name, last_delivery_at)
  values (p_endpoint_id, p_source_id, p_source_name, p_received_at)
  on conflict (endpoint_id, source_id) do update
    set source_name = excluded.source_name,
        last_delivery_at = greatest(public.webhook_sources.last_delivery_at, excluded.last_delivery_at);
end;
$$;

revoke execute on function public.record_webhook_source(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_webhook_source(uuid, text, text, timestamptz) to service_role;

-- ── save_created_webhook_source ─────────────────────────────────────────────────
-- Returns true when the webhook was recorded, false when the source already holds one: a second
-- setup created a duplicate at the provider, which the caller deletes again. A known source without
-- a webhook (from a delivery, or a failed earlier attempt) takes it. Raises program_limit_exceeded
-- for a new source past the endpoint's limit (webhook_sources_enforce_limit).

create function public.save_created_webhook_source(
  p_endpoint_id uuid,
  p_source_id text,
  p_source_name text,
  p_provider_webhook_id text
)
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_written boolean;
begin
  if p_endpoint_id is null or p_provider_webhook_id is null then
    raise exception 'p_endpoint_id and p_provider_webhook_id are required' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.webhook_sources (endpoint_id, source_id, source_name, provider_webhook_id)
  values (p_endpoint_id, p_source_id, p_source_name, p_provider_webhook_id)
  on conflict (endpoint_id, source_id) do update
    set provider_webhook_id = excluded.provider_webhook_id,
        source_name = excluded.source_name
    where public.webhook_sources.provider_webhook_id is null
  returning true into v_written;
  return coalesce(v_written, false);
end;
$$;

revoke execute on function public.save_created_webhook_source(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.save_created_webhook_source(uuid, text, text, text) to service_role;

-- ── delete_webhook_endpoint ─────────────────────────────────────────────────────
-- Deletes the connection's endpoint and returns what it was, or null when there was none:
-- { setup_mode, provider_webhook_id, sources: [{ source_id, source_name, provider_webhook_id }] },
-- the sources being those holding a webhook StackDash created. The endpoint row is locked first,
-- so a source insert racing the delete (webhook_sources_enforce_limit locks the same row) either
-- lands before the read or fails on the foreign key once the endpoint is gone.

create function public.delete_webhook_endpoint(p_workspace_id uuid, p_connection_id uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_endpoint public.webhook_endpoints%rowtype;
  v_sources jsonb;
begin
  select * into v_endpoint
  from public.webhook_endpoints e
  where e.workspace_id = p_workspace_id and e.connection_id = p_connection_id
  for update;
  if not found then
    return null;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object('source_id', s.source_id, 'source_name', s.source_name, 'provider_webhook_id', s.provider_webhook_id)
             order by s.source_name, s.source_id
           ),
           '[]'::jsonb
         )
    into v_sources
  from public.webhook_sources s
  where s.endpoint_id = v_endpoint.id and s.provider_webhook_id is not null;

  delete from public.webhook_endpoints e where e.id = v_endpoint.id;

  return jsonb_build_object(
    'setup_mode', v_endpoint.setup_mode,
    'provider_webhook_id', v_endpoint.provider_webhook_id,
    'sources', v_sources
  );
end;
$$;

revoke execute on function public.delete_webhook_endpoint(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_webhook_endpoint(uuid, uuid) to service_role;
