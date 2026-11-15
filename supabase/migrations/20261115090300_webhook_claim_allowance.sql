-- Provider webhooks (#28), review round two. A follow-up migration, not an edit of
-- 20261115090200_webhook_delivery_review.sql, because that one is already applied to existing
-- databases.
--
-- 1. `webhook` jobs get a claim of their own. 20261115090200 put them ahead of every other kind in
--    claim_sync_jobs, so ten or more due deliveries took the whole claim of a tick and no sync,
--    summary, alert, digest, or retention job ran for as long as they kept arriving.
--    claim_sync_jobs now claims every kind but `webhook`, in its original run_after, id order, and
--    claim_webhook_jobs claims only `webhook` jobs. The runner calls both each tick with separate
--    limits (WEBHOOK_TICK_CLAIM_LIMIT and TICK_CLAIM_LIMIT in src/lib/jobs/runner.ts), so neither
--    can take the other's share, and starts the webhook jobs first.
-- 2. record_webhook_delivery refuses an outcome whose `kind` is missing or unknown. The row it
--    stores for one would be `received` with no job (only `ignored` skips the job), which nothing
--    ever processes and which answers a retry of the same delivery as a duplicate.

-- ── claim_sync_jobs ─────────────────────────────────────────────────────────────
-- As in 20261031090300_jobs_and_invites.sql, except that `webhook` jobs are left to
-- claim_webhook_jobs. Security invoker: only the service role may call it, and the service role
-- already owns every write it makes. Jobs that have used all attempts are never claimed; one whose
-- lease expired on its final attempt is marked failed so it stops looking busy.

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
  where j.kind <> 'webhook'
    and j.status = 'running'
    and j.locked_until < now()
    and j.attempts >= j.max_attempts;

  return query
  with candidates as (
    select c.id
    from public.sync_jobs c
    where c.kind <> 'webhook'
      and c.attempts < c.max_attempts
      and (
        (c.status = 'queued' and c.run_after <= now())
        or (c.status = 'running' and c.locked_until < now())
      )
    order by c.run_after, c.id
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

-- ── claim_webhook_jobs ──────────────────────────────────────────────────────────
-- claim_sync_jobs for `webhook` jobs only, oldest first by run_after and id, with the same limits,
-- lease, skip locked claim, and final-attempt fail-out. Security invoker, service role only, like
-- claim_sync_jobs.

create function public.claim_webhook_jobs(p_limit int, p_lease_seconds int)
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
  where j.kind = 'webhook'
    and j.status = 'running'
    and j.locked_until < now()
    and j.attempts >= j.max_attempts;

  return query
  with candidates as (
    select c.id
    from public.sync_jobs c
    where c.kind = 'webhook'
      and c.attempts < c.max_attempts
      and (
        (c.status = 'queued' and c.run_after <= now())
        or (c.status = 'running' and c.locked_until < now())
      )
    order by c.run_after, c.id
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

revoke execute on function public.claim_webhook_jobs(int, int) from public, anon, authenticated;
grant execute on function public.claim_webhook_jobs(int, int) to service_role;

-- ── record_webhook_delivery ─────────────────────────────────────────────────────
-- As in 20261115090200_webhook_delivery_review.sql, except that an outcome whose `kind` is not
-- `events`, `uninstalled`, or `ignored` is refused: `->> 'kind'` is null for `{}`, a JSON null, an
-- array, or a scalar, and such a row would be stored `received` with no job. This function is what
-- keeps "a received delivery has a job" true, so it does not rely on its caller for it.

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
  if coalesce(p_outcome ->> 'kind', '') not in ('events', 'uninstalled', 'ignored') then
    raise exception 'p_outcome kind must be events, uninstalled, or ignored' using errcode = 'invalid_parameter_value';
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
