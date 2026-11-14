-- Sync engine (#44, #53, #60, #37 retention). Builds on sync_jobs and claim_sync_jobs from
-- 20261031090300_jobs_and_invites.sql. Every function here is called only by the server with the
-- service role (the tick route and the queue module); none is granted to anon or authenticated.
--
-- Retention deletes use indexes that already exist: usage_snapshots_snapshot_date_idx,
-- activity_events_occurred_at_idx, and sync_jobs_created_at_idx.

-- ── One open sync per connection ────────────────────────────────────────────────
-- At most one queued or running sync job per connection. Enqueueing is an insert that does nothing
-- on conflict with this index, so the scheduler, "Sync now", and the initial sync can all ask at
-- once without stacking jobs.
--
-- It is also what makes token refresh safe: providers with rotating refresh tokens (for example
-- Supabase and Vercel) invalidate a refresh token once it is used, so two concurrent syncs of one
-- connection would race to refresh, and the loser would save a dead token and lose the connection.
-- With one open job per connection, refreshes for a connection are serialized.
create unique index sync_jobs_one_open_sync_per_connection
  on public.sync_jobs (connection_id)
  where kind = 'sync' and status in ('queued', 'running');

-- ── enqueue_sync_job ────────────────────────────────────────────────────────────
-- Queues a sync for one connection of one workspace. Returns true when a job was queued, false when
-- one was already open or the connection does not belong to the workspace.

create function public.enqueue_sync_job(p_workspace_id uuid, p_connection_id uuid)
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_inserted int;
begin
  insert into public.sync_jobs (workspace_id, connection_id, kind)
  select c.workspace_id, c.id, 'sync'
  from public.connections c
  where c.id = p_connection_id and c.workspace_id = p_workspace_id
  on conflict (connection_id) where kind = 'sync' and status in ('queued', 'running') do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

revoke execute on function public.enqueue_sync_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_sync_job(uuid, uuid) to service_role;

-- ── request_manual_sync ─────────────────────────────────────────────────────────
-- "Sync now" with a cooldown, checked and recorded in one statement so two quick clicks (or two
-- members) cannot both pass the check. Returns 'queued', 'already_queued', 'cooldown', or
-- 'not_found' (also for a connection in another workspace).

create function public.request_manual_sync(p_workspace_id uuid, p_connection_id uuid, p_cooldown_seconds int)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_id uuid;
  v_inserted int;
begin
  if p_cooldown_seconds is null or p_cooldown_seconds < 0 or p_cooldown_seconds > 86400 then
    raise exception 'p_cooldown_seconds must be between 0 and 86400' using errcode = 'invalid_parameter_value';
  end if;

  update public.connections c
  set last_sync_requested_at = now()
  where c.id = p_connection_id
    and c.workspace_id = p_workspace_id
    and (
      c.last_sync_requested_at is null
      or c.last_sync_requested_at <= now() - make_interval(secs => p_cooldown_seconds)
    )
  returning c.id into v_id;

  if v_id is null then
    if exists (
      select 1 from public.connections c where c.id = p_connection_id and c.workspace_id = p_workspace_id
    ) then
      return 'cooldown';
    end if;
    return 'not_found';
  end if;

  insert into public.sync_jobs (workspace_id, connection_id, kind)
  values (p_workspace_id, p_connection_id, 'sync')
  on conflict (connection_id) where kind = 'sync' and status in ('queued', 'running') do nothing;

  get diagnostics v_inserted = row_count;
  return case when v_inserted = 1 then 'queued' else 'already_queued' end;
end;
$$;

revoke execute on function public.request_manual_sync(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.request_manual_sync(uuid, uuid, int) to service_role;

-- ── enqueue_due_syncs ───────────────────────────────────────────────────────────
-- The scheduler's step on every tick: queue a sync for each connection that is due. Active
-- connections are due at next_sync_at (null means never scheduled, so due now). Failed connections
-- are due when their backoff has elapsed (next_sync_at). needs_attention, pending, and revoked
-- connections wait for the user. Connections that already have an open job are skipped before the
-- limit applies, so they cannot starve the rest.

create function public.enqueue_due_syncs(p_limit int)
  returns int
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_inserted int;
begin
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'p_limit must be between 1 and 5000' using errcode = 'invalid_parameter_value';
  end if;

  with due as (
    select c.id, c.workspace_id
    from public.connections c
    where c.status in ('active', 'failed')
      and (c.next_sync_at is null or c.next_sync_at <= now())
      and not exists (
        select 1
        from public.sync_jobs j
        where j.connection_id = c.id and j.kind = 'sync' and j.status in ('queued', 'running')
      )
    order by c.next_sync_at nulls first, c.id
    limit p_limit
  )
  insert into public.sync_jobs (workspace_id, connection_id, kind)
  select due.workspace_id, due.id, 'sync'
  from due
  on conflict (connection_id) where kind = 'sync' and status in ('queued', 'running') do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke execute on function public.enqueue_due_syncs(int) from public, anon, authenticated;
grant execute on function public.enqueue_due_syncs(int) to service_role;

-- ── latest_usage_resets ─────────────────────────────────────────────────────────
-- The reset time on the most recent snapshot of each metric of one external account, so the sync
-- can tell when a billing period rolled over (stackdash.allowance_reset). Walks the
-- (external_account_id, metric_key, snapshot_date) unique index.

create function public.latest_usage_resets(p_workspace_id uuid, p_external_account_id uuid)
  returns table (metric_key text, resets_at timestamptz)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select distinct on (s.metric_key) s.metric_key, s.resets_at
  from public.usage_snapshots s
  where s.workspace_id = p_workspace_id and s.external_account_id = p_external_account_id
  order by s.metric_key, s.snapshot_date desc
$$;

revoke execute on function public.latest_usage_resets(uuid, uuid) from public, anon, authenticated;
grant execute on function public.latest_usage_resets(uuid, uuid) to service_role;

-- ── Retention (#37) ─────────────────────────────────────────────────────────────
-- Each call deletes at most p_limit rows, oldest primary keys first, and returns how many it
-- deleted. The retention job calls them until a call deletes fewer than p_limit, so a run is short
-- transactions instead of one long lock, and a run cut short is finished by the next one.

create function public.purge_usage_snapshots(p_before date, p_limit int)
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
    select s.id from public.usage_snapshots s
    where s.snapshot_date < p_before
    order by s.id
    limit p_limit
    for update skip locked
  )
  delete from public.usage_snapshots s using doomed where s.id = doomed.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create function public.purge_activity_events(p_before timestamptz, p_limit int)
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
    select e.id from public.activity_events e
    where e.occurred_at < p_before
    order by e.id
    limit p_limit
    for update skip locked
  )
  delete from public.activity_events e using doomed where e.id = doomed.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Only finished jobs: a queued or running job is never deleted, whatever its age.
create function public.purge_sync_jobs(p_before timestamptz, p_limit int)
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
    select j.id from public.sync_jobs j
    where j.created_at < p_before and j.status in ('succeeded', 'failed')
    order by j.id
    limit p_limit
    for update skip locked
  )
  delete from public.sync_jobs j using doomed where j.id = doomed.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.purge_usage_snapshots(date, int) from public, anon, authenticated;
revoke execute on function public.purge_activity_events(timestamptz, int) from public, anon, authenticated;
revoke execute on function public.purge_sync_jobs(timestamptz, int) from public, anon, authenticated;
grant execute on function public.purge_usage_snapshots(date, int) to service_role;
grant execute on function public.purge_activity_events(timestamptz, int) to service_role;
grant execute on function public.purge_sync_jobs(timestamptz, int) to service_role;
