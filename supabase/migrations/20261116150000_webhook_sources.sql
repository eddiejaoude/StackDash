-- Webhooks per source (#428): a provider whose webhooks belong to one resource rather than to the
-- whole grant (a GitLab project; group webhooks need a paid GitLab tier) keeps one webhook per
-- resource, all pointing at the connection's one endpoint. Expand only: the new column defaults,
-- and the new table is read and written only by code that knows it.
--
-- 1. webhook_sources: the resources ("sources") of an endpoint. A row is either a webhook StackDash
--    created there by automatic setup (provider_webhook_id, deleted at the provider on disconnect)
--    or a resource a delivery came from (last_delivery_at, for the setup panel's list of which
--    projects have sent one), or both. Service role only, like webhook_endpoints.
-- 2. webhook_sources_enforce_limit: at most 100 sources per endpoint, so a stream of deliveries
--    naming new resources cannot grow the table without bound. Automatic setup creates at most
--    WEBHOOK_SOURCES_PER_ENDPOINT (src/lib/connections/webhook-setup.ts), the same number.
-- 3. webhook_endpoints.per_source: an automatic endpoint whose webhooks are per source names none
--    in provider_webhook_id; its webhook ids are in webhook_sources instead. The check that an
--    automatic endpoint names its provider webhook now applies to the others only.
-- 4. record_webhook_source: a delivery's source and when it arrived, newest time kept.

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
