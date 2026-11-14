-- Events per connection for the timeline's connection badges (issue #245): the logo of every
-- connection with events in view and how many it holds, under the same filters as the event list.
-- PostgREST has no GROUP BY without db aggregates, which this project leaves off, and neither
-- existing counter fits: count_activity_events needs account ids, type ids, and a window, and the
-- activity_event_daily_counts rollup has neither connection_id nor severity.
--
-- Security definer with one membership check up front, like activity_event_counts: a non-member
-- gets no rows. Every row read is still scoped to p_workspace_id. As security invoker, the
-- activity_events and connections select policies ran on every row: 427 ms for 22,975 events on
-- the local stack, against 5.5 ms behind the single check (explain analyze, as a member).
--
-- Cost: with no filter this reads every event the workspace keeps (13 months, see
-- HISTORY_RETENTION_MONTHS), on every timeline render. At the #191 scale, 2.3 million committed
-- events in one workspace measured with explain analyze in an isolated Postgres 17.11, it takes
-- 134 to 148 ms; a severity filter takes 88 ms, 30 days 54 ms, and one day 1 ms. Accepted while no
-- workspace is near that size; serving the unfiltered badges from a rollup with connection_id and
-- severity is #249.
--
-- Every filter mirrors listTimelineEvents (src/lib/data/timeline.ts), so a badge counts what the
-- timeline lists across all of its pages. An empty array means no filter on that column, except
-- p_hidden_type_ids, which always excludes what it lists. p_account_ids null means every account,
-- and an empty array means none. The window is half open: occurred_at >= p_from and < p_until,
-- and a null bound is open. Events with no connection (StackDash's own, such as daily summaries)
-- belong to no badge.
--
-- The window and account filters are "(p_x is null or ...)" predicates, which only a plan made
-- for the call's own arguments can turn into a range scan of
-- activity_events_workspace_timeline_idx, so every call is planned for its arguments, as in
-- activity_event_counts.
create function public.timeline_connection_event_counts(
  p_workspace_id uuid,
  p_type_ids text[] default '{}',
  p_hidden_type_ids text[] default '{}',
  p_severities public.event_severity[] default '{}',
  p_providers public.provider_id[] default '{}',
  p_account_ids uuid[] default null,
  p_from timestamptz default null,
  p_until timestamptz default null
)
returns table (connection_id uuid, provider public.provider_id, display_name text, events bigint)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
begin
  if not public.has_workspace_role(p_workspace_id, 'viewer') then
    return;
  end if;
  return query
    select c.id, c.provider, c.display_name, count(*)
    from public.activity_events e
    join public.connections c on c.workspace_id = e.workspace_id and c.id = e.connection_id
    where e.workspace_id = p_workspace_id
      and (coalesce(cardinality(p_type_ids), 0) = 0 or e.type_id = any (p_type_ids))
      and e.type_id <> all (coalesce(p_hidden_type_ids, '{}'))
      and (coalesce(cardinality(p_severities), 0) = 0 or e.severity = any (p_severities))
      and (coalesce(cardinality(p_providers), 0) = 0 or e.provider = any (p_providers))
      and (p_account_ids is null or e.external_account_id = any (p_account_ids))
      and (p_from is null or e.occurred_at >= p_from)
      and (p_until is null or e.occurred_at < p_until)
    group by c.id, c.provider, c.display_name;
end;
$$;

-- Supabase's default privileges grant execute on every new public function to anon,
-- authenticated, and service_role, so all three are revoked before authenticated gets it back. The
-- service key has no auth.uid() and would count nothing anyway; it has no reason to call this.
revoke execute on function public.timeline_connection_event_counts(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.timeline_connection_event_counts(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz)
  to authenticated;
