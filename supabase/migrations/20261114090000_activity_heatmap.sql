-- The dashboard's activity heatmap (issue #414): how many activity events happened in each weekday
-- and hour of day since p_since, so the page reads at most 168 counts instead of every event row.
-- PostgREST has no GROUP BY without db aggregates, which this project leaves off.
--
-- * Buckets come from occurred_at, never created_at: a sync inserts a provider's events in one
--   burst, so created_at says when DevMacro polled, not when anything happened.
-- * Weekday and hour are read in p_time_zone (the app passes TIMELINE_TIME_ZONE, Europe/London),
--   whatever the session time zone is, so a cell agrees with the timeline's times. isodow is 1
--   (Monday) to 7 (Sunday) and hour 0 to 23. A clock change hour counts in the local hour it
--   showed: 01:30 BST and 01:30 GMT on the autumn change day both land in hour 1.
-- * Filters mirror the timeline query (src/lib/data/timeline.ts), as activity_event_counts does:
--   p_providers empty means any provider, otherwise events with no provider (DevMacro's own) are
--   left out; p_account_ids null means any account, otherwise events with no account are left out.
--   p_type_ids and p_severities are alternatives: an event matches when its type is listed or its
--   severity is, and both empty means every event. The heatmap's failures group is critical
--   events plus the failed types (src/lib/dashboard/heatmap.ts), which one list cannot say.
-- * security invoker: the activity_events select policy scopes every row to the caller's
--   workspaces, and costs one membership lookup per statement, not per row, since
--   20261112090000_select_policies_membership_set.sql. A non-member counts nothing. The explicit
--   membership check returns before any row is read, as timeline_activity_buckets does.
-- * The occurred_at bound keeps the read on activity_events_workspace_timeline_idx
--   (workspace_id, occurred_at desc, id desc). Explain analyze numbers are on #414.
-- * A missing p_since or p_time_zone raises rather than counting everything or bucketing into a
--   null hour; an unknown zone name raises Postgres's own 22023.
create function public.activity_heatmap(
  p_workspace_id uuid,
  p_since timestamptz,
  p_time_zone text,
  p_type_ids text[] default '{}',
  p_severities public.event_severity[] default '{}',
  p_providers public.provider_id[] default '{}',
  p_account_ids uuid[] default null
)
returns table (isodow integer, hour integer, events bigint)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
begin
  if p_since is null or p_time_zone is null then
    raise exception 'p_since and p_time_zone are required' using errcode = '22004';
  end if;
  if not public.has_workspace_role(p_workspace_id, 'viewer') then
    return;
  end if;
  -- Names inside the query avoid isodow, hour, and events, which are this function's output
  -- variables.
  return query
    select
      extract(isodow from e.occurred_at at time zone p_time_zone)::integer,
      extract(hour from e.occurred_at at time zone p_time_zone)::integer,
      count(*)
    from public.activity_events e
    where e.workspace_id = p_workspace_id
      and e.occurred_at >= p_since
      and (
        (coalesce(cardinality(p_type_ids), 0) = 0 and coalesce(cardinality(p_severities), 0) = 0)
        or e.type_id = any (p_type_ids)
        or e.severity = any (p_severities)
      )
      and (coalesce(cardinality(p_providers), 0) = 0 or e.provider = any (p_providers))
      and (p_account_ids is null or e.external_account_id = any (p_account_ids))
    group by 1, 2
    order by 1, 2;
end;
$$;

-- Supabase's default privileges grant execute on every new public function to anon,
-- authenticated, and service_role, so all three are revoked before authenticated gets it back. The
-- service key has no auth.uid() and would count nothing anyway; it has no reason to call this.
revoke execute on function public.activity_heatmap(uuid, timestamptz, text, text[], public.event_severity[], public.provider_id[], uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.activity_heatmap(uuid, timestamptz, text, text[], public.event_severity[], public.provider_id[], uuid[])
  to authenticated;
