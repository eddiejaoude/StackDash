-- Activity overview histogram on the timeline (issue #377): how many events match the timeline's
-- filters, across all of its pages, in at most 12 equal slices of time. Each slice links to the
-- timeline narrowed to that slice. PostgREST has no GROUP BY without db aggregates, which this
-- project leaves off, so the counting happens here.
--
-- Filters: every filter mirrors timeline_connection_event_counts
-- (20261110090000_timeline_title_search.sql) and listTimelineEvents (src/lib/data/timeline.ts), so
-- the bars add up to what the list shows over all of its pages. An empty array means no filter on
-- that column, except p_hidden_type_ids, which always excludes what it lists. p_account_ids null
-- means every account, and an empty array means none. p_title_pattern is a case-insensitive
-- regular expression the app builds with titleSearchPattern (src/lib/timeline/query.ts), escaped so
-- it matches literally; null means no search. The window is half open, occurred_at >= p_from and
-- < p_until, and a null bound is open. Unlike the badges, events with no connection (StackDash's
-- own, such as daily summaries) count, because the list shows them. The app passes its date
-- filter here, never the selected slice, so the histogram keeps its full context.
--
-- Slices:
-- * Bounds are p_from and p_until when given. A missing bound comes from the matching events: the
--   earliest occurred_at floored to its UTC hour, or the latest occurred_at plus one UTC hour,
--   floored, so the latest event sits inside the half open range. With a missing bound and no
--   matching event there are no bounds, so no rows come back. With both bounds given and no
--   matching event, every slice comes back with 0. Bounds out of order or equal return no rows.
-- * Every slice is ceil(span seconds / 12 / 60) minutes wide, at least one minute, so there are at
--   most 12. Slices are counted in UTC seconds, never local days, so a DST change in Europe/London
--   does not stretch or shrink one. The last slice ends at the upper bound, so it can be narrower.
-- * bucket_start is inclusive and bucket_end exclusive, matching the window.
-- * Slice index arithmetic is in whole microseconds (bigint), so an event one microsecond before a
--   boundary never rounds into the next slice.
--
-- Cost: the matching events are read once, into a materialized list of timestamps. The missing
-- bounds are its min and max, and the counts are one grouped pass over it by slice index, joined to
-- the generated slices; nothing is scanned once per slice. With no window this reads every event
-- the workspace keeps, as the unfiltered badges do.
--
-- Security invoker: the activity_events select policy is a membership set evaluated once per
-- query since 20261112090000_select_policies_membership_set.sql, not once per row, so the row
-- policy stands as a second guard. The membership check comes first, before any bound is worked
-- out, so a non-member gets no rows: not even the zero slices that explicit bounds alone could
-- produce.
--
-- The window and account filters are "(p_x is null or ...)" predicates, which only a plan made for
-- the call's own arguments can turn into a range scan of activity_events_workspace_timeline_idx, so
-- every call is planned for its arguments, as in timeline_connection_event_counts.
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
returns table (bucket_start timestamptz, bucket_end timestamptz, events bigint)
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
  -- Names inside the query avoid bucket_start, bucket_end, and events, which are this function's
  -- output variables.
  return query
    with matched as materialized (
      select e.occurred_at
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
        count(*) as n
      from matched m
      cross join spec s
      where m.occurred_at >= s.lo
        and m.occurred_at < s.hi
      group by 1
    )
    select sl.slice_start, sl.slice_end, coalesce(c.n, 0)::bigint
    from slices sl
    left join counts c on c.i = sl.i
    order by sl.i;
end;
$$;

-- Supabase's default privileges grant execute on every new public function to anon,
-- authenticated, and service_role, so all three are revoked before authenticated gets it back. The
-- service key has no auth.uid() and would count nothing anyway; it has no reason to call this.
revoke execute on function public.timeline_activity_buckets(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.timeline_activity_buckets(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)
  to authenticated;
