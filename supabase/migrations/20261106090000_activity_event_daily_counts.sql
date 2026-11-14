-- Event counts kept as events are written (#201), so the trend markers' 13 month count reads a
-- rollup instead of every event of the window. Grant model: see 20261031090000_tenancy.sql.
--
-- * activity_event_daily_counts holds how many activity_events rows exist per workspace, UTC day of
--   occurred_at, type id, provider, and external account. It is a pure function of activity_events:
--   statement level triggers on activity_events change it in the same transaction as the events,
--   so every writer (the sync and daily summary jobs, alert runs, notification events,
--   record_publication_event), the retention purge (#37), and the foreign key actions (cascade from
--   workspaces and connections, set null from external_accounts) keep it equal to the events
--   without knowing it exists. Only rows an insert really added reach the trigger's transition
--   table, so a dedupe conflict (on conflict do nothing) counts nothing. Decision record:
--   https://github.com/eddiejaoude/StackDash/issues/201#issuecomment-6687534075
-- * Members read it through the Data API like activity_events; nobody writes it but the trigger
--   function and the rebuild below, not even the service role.
-- * activity_event_counts now sums at most one row per day, type, provider, and account. Measured
--   with explain (analyze, buffers) as a member over 2.3 million synthetic events in one workspace
--   (quoted on the pull request for #201): 13 months went from 763 ms (a table scan of 2.1 million
--   events) to 1.7 ms (1,850 rollup rows), 30 days from 55 ms to 0.7 ms. The insert trigger took
--   0.7 ms for a 1,000 event batch, the delete trigger 4.2 ms for a 10,000 event purge batch.

-- ── activity_event_daily_counts ─────────────────────────────────────────────────

create table public.activity_event_daily_counts (
  workspace_id uuid not null,
  day date not null,
  type_id text not null,
  provider public.provider_id,
  external_account_id uuid,
  -- Zero only inside the transaction that removes the row (see the trigger function).
  event_count int not null constraint activity_event_daily_counts_count_nonnegative check (event_count >= 0),
  -- Events with no provider or no account are counted under null, as one key.
  constraint activity_event_daily_counts_key
    unique nulls not distinct (workspace_id, day, type_id, provider, external_account_id),
  -- Deferred: deleting a workspace sets external_account_id null on its events (the external_accounts
  -- action) before or after it deletes them (the workspaces action), and the trigger may count the
  -- null account key of a workspace already gone in this transaction. The events delete removes that
  -- row again before commit, when the deferred check skips it.
  constraint activity_event_daily_counts_workspace_fkey foreign key (workspace_id)
    references public.workspaces (id) on delete cascade deferrable initially deferred
);

-- activity_event_counts reads (workspace_id, day >= since) through the key's index, filtering the
-- type ids inside it (measured for 30 days; for 13 months the planner scanned the 3,205 row table
-- instead, in under a millisecond). The trigger matches rows on the same key; no other index is needed.

alter table public.activity_event_daily_counts enable row level security;
revoke all on table public.activity_event_daily_counts from anon, authenticated;
-- A write here that is not mirrored in activity_events would show wrong markers until a rebuild, so
-- the service role reads only; the trigger function and the rebuild run as the owner.
revoke insert, update, delete, truncate on table public.activity_event_daily_counts from service_role;

grant select on table public.activity_event_daily_counts to authenticated;

create policy activity_event_daily_counts_select on public.activity_event_daily_counts for select to authenticated
  using (public.has_workspace_role(workspace_id, 'viewer'));

-- ── Keeping the counts ──────────────────────────────────────────────────────────
-- One grouped statement per activity_events statement, not one per row. An update (only the
-- external_accounts set null action does one today) is the delete of its old rows plus the insert of
-- its new rows.
--
-- Every writer locks the rollup rows it shares with another writer in key order (workspace_id,
-- day, type_id, provider, external_account_id), so two statements touching the same keys queue
-- instead of deadlocking (#236 review: a purge batch against a sync insert deadlocked 3 runs out of
-- 3 once the decrement locked in plan order). The decrement first locks its rows with an ordered
-- select ... for update, then subtracts in one update, so a concurrent increment of the same row is
-- re-read before subtracting and never lost; rows it brings to zero are then deleted by a second
-- statement. The increment is an upsert whose rows arrive ordered by key. An update decrements its
-- old keys, then increments its new keys.

create function public.activity_events_count_rollup()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    truncate public.activity_event_daily_counts;
    return null;
  end if;

  if tg_op in ('DELETE', 'UPDATE') then
    perform 1
    from public.activity_event_daily_counts c
    join (
      select distinct o.workspace_id, (o.occurred_at at time zone 'UTC')::date as day, o.type_id, o.provider,
        o.external_account_id
      from old_rows o
    ) g
      on c.workspace_id = g.workspace_id
      and c.day = g.day
      and c.type_id = g.type_id
      and c.provider is not distinct from g.provider
      and c.external_account_id is not distinct from g.external_account_id
    order by c.workspace_id, c.day, c.type_id, c.provider, c.external_account_id
    for update of c;

    with gone as (
      select o.workspace_id, (o.occurred_at at time zone 'UTC')::date as day, o.type_id, o.provider,
        o.external_account_id, count(*)::int as n
      from old_rows o
      group by 1, 2, 3, 4, 5
    )
    update public.activity_event_daily_counts c
    set event_count = c.event_count - g.n
    from gone g
    where c.workspace_id = g.workspace_id
      and c.day = g.day
      and c.type_id = g.type_id
      and c.provider is not distinct from g.provider
      and c.external_account_id is not distinct from g.external_account_id;

    delete from public.activity_event_daily_counts c
    using (select distinct o.workspace_id, (o.occurred_at at time zone 'UTC')::date as day from old_rows o) t
    where c.workspace_id = t.workspace_id
      and c.day = t.day
      and c.event_count = 0;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    insert into public.activity_event_daily_counts as c (
      workspace_id, day, type_id, provider, external_account_id, event_count
    )
    select n.workspace_id, (n.occurred_at at time zone 'UTC')::date, n.type_id, n.provider,
      n.external_account_id, count(*)::int
    from new_rows n
    group by 1, 2, 3, 4, 5
    order by 1, 2, 3, 4, 5
    on conflict on constraint activity_event_daily_counts_key
      do update set event_count = c.event_count + excluded.event_count;
  end if;

  return null;
end;
$$;

revoke execute on function public.activity_events_count_rollup() from public, anon, authenticated, service_role;

create trigger activity_events_count_insert
  after insert on public.activity_events
  referencing new table as new_rows
  for each statement execute function public.activity_events_count_rollup();

create trigger activity_events_count_update
  after update on public.activity_events
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.activity_events_count_rollup();

create trigger activity_events_count_delete
  after delete on public.activity_events
  referencing old table as old_rows
  for each statement execute function public.activity_events_count_rollup();

create trigger activity_events_count_truncate
  after truncate on public.activity_events
  for each statement execute function public.activity_events_count_rollup();

-- ── Backfill and repair ─────────────────────────────────────────────────────────
-- Recounts one workspace's rollup from its events and returns how many rollup rows it wrote.
-- Re-runnable: it replaces the workspace's rows, so running it twice, or on a workspace the trigger
-- already keeps, changes nothing. One workspace per call keeps each run short. It holds a share row
-- exclusive lock on activity_events until the caller's transaction ends, so no event write can slip
-- between the delete and the recount, and two rebuilds take turns; reads are not blocked.

create function public.rebuild_activity_event_daily_counts(p_workspace_id uuid)
  returns int
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_rows int;
begin
  if p_workspace_id is null then
    raise exception 'p_workspace_id is required' using errcode = 'invalid_parameter_value';
  end if;

  lock table public.activity_events in share row exclusive mode;

  delete from public.activity_event_daily_counts c where c.workspace_id = p_workspace_id;

  insert into public.activity_event_daily_counts (workspace_id, day, type_id, provider, external_account_id, event_count)
  select e.workspace_id, (e.occurred_at at time zone 'UTC')::date, e.type_id, e.provider, e.external_account_id,
    count(*)::int
  from public.activity_events e
  where e.workspace_id = p_workspace_id
  group by 1, 2, 3, 4, 5;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.rebuild_activity_event_daily_counts(uuid) from public, anon, authenticated;
grant execute on function public.rebuild_activity_event_daily_counts(uuid) to service_role;

-- The backfill: every workspace that exists now. Creating the triggers above already holds a lock
-- on activity_events that blocks event writes until this migration commits, so none is missed.
select public.rebuild_activity_event_daily_counts(w.id) from public.workspaces w order by w.id;

-- ── activity_event_counts reads the rollup ──────────────────────────────────────
-- Same arguments, filters, and result as 20261105120600_activity_event_counts.sql, which explains
-- the bucket and filter rules. The bucket of a day is the day, or the first of its month; the day is
-- cast to timestamp so date_trunc never consults the session time zone. plan_cache_mode is no longer
-- forced: whichever plan the planner keeps reads at most a few thousand rollup rows per workspace.

create or replace function public.activity_event_counts(
  p_workspace_id uuid,
  p_since date,
  p_bucket text,
  p_type_ids text[],
  p_providers public.provider_id[] default '{}',
  p_account_ids uuid[] default null
)
  returns table (bucket_start date, provider public.provider_id, type_id text, event_count bigint)
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
begin
  if p_bucket is null or p_bucket not in ('day', 'month') then
    raise exception 'p_bucket must be day or month, not %', coalesce(p_bucket, 'null') using errcode = '22023';
  end if;
  if not public.has_workspace_role(p_workspace_id, 'viewer') then
    return;
  end if;
  return query
    select date_trunc(p_bucket, c.day::timestamp)::date, c.provider, c.type_id, sum(c.event_count)::bigint
    from public.activity_event_daily_counts c
    where c.workspace_id = p_workspace_id
      and c.day >= p_since
      and c.type_id = any (p_type_ids)
      and (coalesce(cardinality(p_providers), 0) = 0 or c.provider = any (p_providers))
      and (p_account_ids is null or c.external_account_id = any (p_account_ids))
    group by 1, 2, 3;
end;
$$;
