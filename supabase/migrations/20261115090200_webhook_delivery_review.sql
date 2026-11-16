-- Provider webhooks (#28), review round one. A follow-up migration, not an edit of
-- 20261115090100_webhook_deliveries.sql, because that one is already applied to existing databases.
--
-- 1. Deliveries are deduplicated per (provider, endpoint, delivery id). Svix and Standard Webhooks
--    send one message id to every endpoint of an account, so two connections of one provider
--    account, each with its own endpoint, receive the same id. Keyed per provider only, the second
--    was dropped as a duplicate, and a connection secret (which its user holds) could claim ids for
--    the whole provider. An app-level delivery has no endpoint; nulls are not distinct, so its id is
--    still unique per provider.
-- 2. record_webhook_delivery stores an `ignored` outcome as processed, with no outcome and no job: a
--    job would only mark it processed. The row stays, so a repeat is still recognized. An ignored
--    delivery stored before this migration is finished the same way; its job then finds nothing
--    left to do, so no stored outcome a job reads back is ever `ignored`.
-- 3. list_webhook_targets also returns `failed` connections (polling is erroring but still
--    scheduled, so push is the one path still working), and the time the target connection's
--    credential was last written, so an uninstall older than a reconnect can be told apart.
-- 4. claim_sync_jobs claims `webhook` jobs before every other kind. They make no provider calls, and
--    the route promises the event on the next tick, which ordering by run_after alone could not keep
--    behind a backlog of syncs.

-- ── webhook_deliveries: dedupe key per endpoint ─────────────────────────────────

alter table public.webhook_deliveries
  drop constraint webhook_deliveries_provider_delivery_id_key,
  add constraint webhook_deliveries_provider_endpoint_delivery_id_key
    unique nulls not distinct (provider, endpoint_id, delivery_id);

-- ── record_webhook_delivery ─────────────────────────────────────────────────────
-- Stores a verified delivery and, unless its outcome is `ignored`, queues its webhook job in one
-- transaction. Returns false when (provider, endpoint, delivery id) is already stored: the provider
-- retried, and the first delivery's job does the work. Two concurrent copies of one delivery
-- serialize on the unique key, so exactly one returns true. An `ignored` delivery is stored already
-- processed, without its outcome, and queues nothing; it still returns true the first time. The job
-- is instance-wide (no workspace): an app-level delivery can reach several workspaces, and the job
-- finds them (list_webhook_targets).

create or replace function public.record_webhook_delivery(
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
  v_ignored boolean;
begin
  if p_provider is null or p_outcome is null then
    raise exception 'p_provider and p_outcome are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_endpoint_id is not null and not exists (
    select 1 from public.webhook_endpoints e where e.id = p_endpoint_id and e.provider = p_provider
  ) then
    raise exception 'p_endpoint_id must name an endpoint of p_provider' using errcode = 'invalid_parameter_value';
  end if;

  v_ignored := p_outcome ->> 'kind' = 'ignored';

  insert into public.webhook_deliveries (provider, delivery_id, endpoint_id, status, outcome, processed_at)
  values (
    p_provider,
    p_delivery_id,
    p_endpoint_id,
    case when v_ignored then 'processed' else 'received' end::public.webhook_delivery_status,
    case when v_ignored then null else p_outcome end,
    case when v_ignored then now() end
  )
  on conflict (provider, endpoint_id, delivery_id) do nothing
  returning id into v_id;

  if v_id is null then
    return false;
  end if;

  if not v_ignored then
    insert into public.sync_jobs (kind, webhook_delivery_id) values ('webhook', v_id);
  end if;
  return true;
end;
$$;

revoke execute on function public.record_webhook_delivery(public.provider_id, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.record_webhook_delivery(public.provider_id, text, jsonb, uuid) to service_role;

-- An ignored delivery stored before this migration is finished like a new one; its queued job then
-- finds the delivery processed and succeeds without doing anything.
update public.webhook_deliveries
set status = 'processed', processed_at = now(), outcome = null
where status = 'received' and outcome ->> 'kind' = 'ignored';

-- ── list_webhook_targets ────────────────────────────────────────────────────────
-- Where a delivery's external account lands: each included external account with that external id
-- on a connection of the provider that is active, failed, or needs_attention (everything but
-- pending, which has no grant yet, and revoked, which the user removed), in every workspace for an
-- app-level delivery, and only on the endpoint's own connection when p_endpoint_id is set. Failed
-- connections are included because polling still runs for them and may not recover inside the
-- adapter's backfill window. credential_updated_at is when the connection's credential was last
-- written (null without one): a reconnect writes it, so an uninstall that happened before it is
-- stale. Bounded at 100: one provider account connected to more workspaces than that reaches the
-- first by id, and polling still brings the rest their events. Security invoker: only the service
-- role may call it, and it already reads every row it needs. Dropped and created again because
-- its result gains a column.

drop function public.list_webhook_targets(public.provider_id, text, uuid);

create function public.list_webhook_targets(
  p_provider public.provider_id,
  p_external_id text,
  p_endpoint_id uuid default null
)
  returns table (workspace_id uuid, connection_id uuid, account_id uuid, credential_updated_at timestamptz)
  language sql
  stable
  set search_path = ''
as $$
  select a.workspace_id, a.connection_id, a.id, cc.updated_at
  from public.external_accounts a
  join public.connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
  left join public.connection_credentials cc on cc.workspace_id = c.workspace_id and cc.connection_id = c.id
  where a.external_id = p_external_id
    and a.included
    and c.provider = p_provider
    and c.status in ('active', 'failed', 'needs_attention')
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

-- ── claim_sync_jobs ─────────────────────────────────────────────────────────────
-- As in 20261031090300_jobs_and_invites.sql, except that `webhook` jobs are claimed before every
-- other kind, then by run_after and id. A webhook job only writes rows (no provider call), so each
-- tick applies up to p_limit pending deliveries before it starts any sync. Security invoker: only
-- the service role may call it, and the service role already owns every write it makes. Jobs that
-- have used all attempts are never claimed; one whose lease expired on its final attempt is marked
-- failed so it stops looking busy.

create or replace function public.claim_sync_jobs(p_limit int, p_lease_seconds int)
  returns setof public.sync_jobs
  language plpgsql
  volatile
  set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'p_limit must be between 1 and 100' using errcode = 'invalid_parameter_value';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'p_lease_seconds must be between 1 and 3600' using errcode = 'invalid_parameter_value';
  end if;

  update public.sync_jobs j
  set status = 'failed',
      locked_until = null,
      finished_at = now(),
      error_code = coalesce(j.error_code, 'lease_expired')
  where j.status = 'running'
    and j.locked_until < now()
    and j.attempts >= j.max_attempts;

  return query
  with candidates as (
    select c.id
    from public.sync_jobs c
    where c.attempts < c.max_attempts
      and (
        (c.status = 'queued' and c.run_after <= now())
        or (c.status = 'running' and c.locked_until < now())
      )
    -- false sorts before true: webhook jobs first.
    order by c.kind <> 'webhook', c.run_after, c.id
    limit p_limit
    for update skip locked
  )
  update public.sync_jobs j
  set status = 'running',
      locked_until = now() + make_interval(secs => p_lease_seconds),
      attempts = j.attempts + 1,
      started_at = now(),
      finished_at = null
  from candidates
  where j.id = candidates.id
  returning j.*;
end;
$$;

revoke execute on function public.claim_sync_jobs(int, int) from public, anon, authenticated;
grant execute on function public.claim_sync_jobs(int, int) to service_role;
