-- Severity in the timeline's activity overview (issue #397): each slice of
-- timeline_activity_buckets (20261112212026_timeline_activity_buckets.sql) also counts its critical
-- and its warning events, so the overview can stack them inside each bar and a burst of failures
-- shows before anyone reads a row.
--
-- Additive: bucket_start, bucket_end, and events keep their names, types, order, and values, and
-- critical_events and warning_events come after them. The deployed app selects
-- "bucket_start, bucket_end, events" by name, so it keeps working while this lands before the app
-- that reads the new columns. The arguments and their defaults are unchanged, so every grant
-- below names the same signature.
--
-- Postgres cannot change a function's output columns with create or replace ("cannot change
-- return type of existing function"), so the function is dropped and created again in this one
-- migration, as 20261110090000_timeline_title_search.sql did for timeline_connection_event_counts.
-- The CLI sends a migration's statements as one batch that Postgres runs as one transaction, so
-- no caller sees the function missing. No table, row, or index is touched.
--
-- The two new counts are filtered aggregates over the same materialized list and the same grouped
-- pass, which now carries each matching event's severity beside its time. They follow the
-- function's filters: with a severity filter of info only, both are 0. They are never more than
-- events. Before and after explain analyze numbers: https://github.com/eddiejaoude/DevMacro/issues/397
--
-- Everything else is as 20261112212026 describes it: the filters, the bounds, the slices, the
-- membership check before any bound is worked out, security invoker, and a plan made for each
-- call's own arguments.
drop function public.timeline_activity_buckets(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text);

create function public.timeline_activity_buckets(
  p_workspace_id uuid,
  p_type_ids text[] default '{}',
  p_hidden_type_ids text[] default '{}',
  p_severities public.event_severity[] default '{}',
  p_providers public.provider_id[] default '{}',
  p_account_ids uuid[] default null,
  p_from timestamptz default null,
  p_until timestamptz default null,
  p_title_pattern text default null
)
returns table (
  bucket_start timestamptz,
  bucket_end timestamptz,
  events bigint,
  critical_events bigint,
  warning_events bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
begin
  if not public.has_workspace_role(p_workspace_id, 'viewer') then
    return;
  end if;
  -- Names inside the query avoid bucket_start, bucket_end, events, critical_events, and
  -- warning_events, which are this function's output variables.
  return query
    with matched as materialized (
      select e.occurred_at, e.severity
      from public.activity_events e
      where e.workspace_id = p_workspace_id
        and (coalesce(cardinality(p_type_ids), 0) = 0 or e.type_id = any (p_type_ids))
        and e.type_id <> all (coalesce(p_hidden_type_ids, '{}'))
        and (coalesce(cardinality(p_severities), 0) = 0 or e.severity = any (p_severities))
        and (coalesce(cardinality(p_providers), 0) = 0 or e.provider = any (p_providers))
        and (p_account_ids is null or e.external_account_id = any (p_account_ids))
        and (p_from is null or e.occurred_at >= p_from)
        and (p_until is null or e.occurred_at < p_until)
        and (p_title_pattern is null or e.title ~* p_title_pattern)
    ),
    bounds as (
      select
        coalesce(p_from, date_trunc('hour', min(m.occurred_at), 'UTC')) as lo,
        coalesce(p_until, date_trunc('hour', max(m.occurred_at), 'UTC') + interval '1 hour') as hi
      from matched m
    ),
    spec as (
      select
        b.lo,
        b.hi,
        (extract(epoch from b.lo) * 1000000)::bigint as lo_us,
        greatest(60, ceil(extract(epoch from (b.hi - b.lo)) / 12 / 60) * 60)::bigint as width_s
      from bounds b
      where b.lo is not null and b.hi is not null and b.hi > b.lo
    ),
    slices as (
      select
        g.i,
        s.lo + (g.i * s.width_s) * interval '1 second' as slice_start,
        least(s.hi, s.lo + ((g.i + 1) * s.width_s) * interval '1 second') as slice_end
      from spec s
      cross join generate_series(0, (ceil(extract(epoch from (s.hi - s.lo)) / s.width_s))::integer - 1) as g(i)
    ),
    counts as (
      select
        (((extract(epoch from m.occurred_at) * 1000000)::bigint - s.lo_us) / (s.width_s * 1000000))::integer as i,
        count(*) as n,
        count(*) filter (where m.severity = 'critical') as n_critical,
        count(*) filter (where m.severity = 'warning') as n_warning
      from matched m
      cross join spec s
      where m.occurred_at >= s.lo
        and m.occurred_at < s.hi
      group by 1
    )
    select sl.slice_start, sl.slice_end, coalesce(c.n, 0)::bigint, coalesce(c.n_critical, 0)::bigint,
      coalesce(c.n_warning, 0)::bigint
    from slices sl
    left join counts c on c.i = sl.i
    order by sl.i;
end;
$$;

-- As in 20261112212026: Supabase's default privileges grant execute on every new public function
-- to anon, authenticated, and service_role, so all three are revoked before authenticated gets it
-- back.
revoke execute on function public.timeline_activity_buckets(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.timeline_activity_buckets(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)
  to authenticated;
