-- Reads for the year in review slides (issue #262): the busiest day, the most active provider, and
-- the longest run of successful deployments of one calendar year, for the members of a workspace.
-- Decision record (which figures are safe to show):
-- https://github.com/eddiejaoude/StackDash/issues/262#issuecomment-6790096177
--
-- Both functions count in the database and return a handful of rows, because the figures need
-- every event of the year and PostgREST has no GROUP BY without db aggregates, which this project
-- leaves off. Reading the events into the app instead would page through up to a year of rows.
--
-- * Security definer with one membership check up front, like activity_event_counts and
--   timeline_connection_event_counts: a non-member gets nothing, and the activity_events select
--   policy does not run once per row. Every row read is still scoped to p_workspace_id and to
--   p_account_ids, the workspace's included accounts (the public metric engine's scope), so events
--   with no account, such as StackDash's daily summaries, never count.
-- * The window is half open, occurred_at >= p_from and < p_until, at most 366 days long, so the
--   day rows stay one per London day of one year.
-- * Every call is planned for its own arguments, as in activity_event_counts: a generic plan
--   cannot fit both a week of a new workspace and a whole year.

-- ── year_review_event_counts ────────────────────────────────────────────────────
-- Events of every type except p_excluded_type_ids (the app passes the payment types, because a
-- payment count hints at revenue), counted two ways in one scan of the window:
-- * bucket 'day': per Europe/London calendar day of occurred_at, the days the timeline groups
--   events by (TIMELINE_TIME_ZONE in src/lib/timeline/query.ts). provider is null.
-- * bucket 'provider': per provider over the whole window. day is null; an event with an account
--   but no provider is counted under a null provider, which the app leaves out.
-- At most 366 day rows plus one row per provider, inside one PostgREST response.
--
-- Plan, measured with explain (analyze, buffers) in a rolled back transaction on the local stack,
-- for 100,000 events of this workspace in 2026 among 1,125,164 events in the table: a BitmapAnd of
-- activity_events_workspace_type_time_idx (added below; workspace_id with the occurred_at range as
-- its index condition) and activity_events_external_account_id_idx, a bitmap heap scan of the
-- 74,557 rows left after the payment filter, then one HashAggregate for both buckets: 33 to 45 ms
-- (31 to 32 ms through the function as a member). The time grows with the workspace's own events
-- in the year: a workspace holding nearly the whole table took 755 ms for one million events, as a
-- sequential scan. Budget discussion: https://github.com/eddiejaoude/StackDash/issues/262
create function public.year_review_event_counts(
  p_workspace_id uuid,
  p_account_ids uuid[],
  p_excluded_type_ids text[],
  p_from timestamptz,
  p_until timestamptz
)
returns table (bucket text, day date, provider public.provider_id, events bigint)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
begin
  if p_from is null or p_until is null or p_until <= p_from or p_until - p_from > interval '366 days' then
    raise exception 'the window must be from before until and at most 366 days long' using errcode = '22023';
  end if;
  if not public.has_workspace_role(p_workspace_id, 'viewer') then
    return;
  end if;
  return query
    select
      case when grouping(e.london_day) = 0 then 'day' else 'provider' end,
      e.london_day,
      e.provider,
      count(*)
    from (
      select (a.occurred_at at time zone 'Europe/London')::date as london_day, a.provider
      from public.activity_events a
      where a.workspace_id = p_workspace_id
        and a.external_account_id = any (p_account_ids)
        and a.type_id <> all (coalesce(p_excluded_type_ids, '{}'))
        and a.occurred_at >= p_from
        and a.occurred_at < p_until
    ) e
    group by grouping sets ((e.london_day), (e.provider));
end;
$$;

-- ── year_review_longest_run ─────────────────────────────────────────────────────
-- The most p_success_type_id events in a row in the window, in occurred_at order, with no
-- p_failure_type_id event between them. Events of other types neither extend nor break a run. A
-- run that began before p_from counts from p_from. When a success and a failure share an instant,
-- the failure is taken first, so a tie never lengthens a run. 0 with no success in the window.
--
-- Each failure starts a group (the running count of failures so far), and a group's successes are
-- one run. One row comes back.
--
-- Index: activity_events_workspace_type_time_idx (workspace_id, type_id, occurred_at), added
-- below, reads only the two types' rows of the window instead of every event of the year: 55 ms
-- for one million events of one workspace, against 480 ms without it, and 4 to 6 ms in the
-- measurement above.
create function public.year_review_longest_run(
  p_workspace_id uuid,
  p_account_ids uuid[],
  p_success_type_id text,
  p_failure_type_id text,
  p_from timestamptz,
  p_until timestamptz
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
declare
  v_longest integer;
begin
  if p_from is null or p_until is null or p_until <= p_from or p_until - p_from > interval '366 days' then
    raise exception 'the window must be from before until and at most 366 days long' using errcode = '22023';
  end if;
  if p_success_type_id is null or p_failure_type_id is null or p_success_type_id = p_failure_type_id then
    raise exception 'the success and failure types must be two different types' using errcode = '22023';
  end if;
  if not public.has_workspace_role(p_workspace_id, 'viewer') then
    return 0;
  end if;
  select coalesce(max(r.successes), 0)::integer into v_longest
  from (
    select count(*) filter (where not o.failed) as successes
    from (
      select
        a.type_id = p_failure_type_id as failed,
        count(*) filter (where a.type_id = p_failure_type_id)
          over (order by a.occurred_at, (a.type_id = p_failure_type_id) desc rows unbounded preceding) as failures_so_far
      from public.activity_events a
      where a.workspace_id = p_workspace_id
        and a.external_account_id = any (p_account_ids)
        and a.type_id in (p_success_type_id, p_failure_type_id)
        and a.occurred_at >= p_from
        and a.occurred_at < p_until
    ) o
    group by o.failures_so_far
  ) r;
  return v_longest;
end;
$$;

create index activity_events_workspace_type_time_idx on public.activity_events (workspace_id, type_id, occurred_at);

-- Supabase's default privileges grant execute on every new public function to anon,
-- authenticated, and service_role, so all three are revoked before authenticated gets it back. The
-- service key has no auth.uid() and would count nothing anyway; it has no reason to call these.
revoke execute on function public.year_review_event_counts(uuid, uuid[], text[], timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.year_review_event_counts(uuid, uuid[], text[], timestamptz, timestamptz)
  to authenticated;
revoke execute on function public.year_review_longest_run(uuid, uuid[], text, text, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.year_review_longest_run(uuid, uuid[], text, text, timestamptz, timestamptz)
  to authenticated;
