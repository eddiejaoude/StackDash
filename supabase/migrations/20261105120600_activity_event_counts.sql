-- Event markers on the dashboard trend charts (#168): how many events of the given types happened
-- in each UTC day or UTC month, per provider and type, from p_since onward.
--
-- * A bucket is the UTC calendar day or month of occurred_at, the same days usage_snapshots
--   .snapshot_date and the trend buckets use, whatever the session time zone is. bucket_start is
--   its first day.
-- * Filters mirror the timeline query (src/lib/data/timeline.ts), so a marker counts exactly the
--   events its timeline link lists: p_providers empty means any provider, otherwise events with no
--   provider (StackDash's own, such as stackdash.alert_triggered) are left out; p_account_ids null
--   means any account, otherwise events with no account are left out.
-- * security definer with one membership check up front, so a non-member counts nothing and no
--   row is read for them. As security invoker, the activity_events select policy called
--   public.has_workspace_role (security definer, so never inlined) once per scanned row. Measured
--   with explain (analyze, buffers) on #191 over 2.3 million synthetic events in one workspace:
--   30 days went from 3.1 s to about 45 ms, 13 months from 35.7 s per page to about 0.55 s.
-- * Grouping by month here keeps the result at most one row per bucket, provider, and type, so it
--   fits one PostgREST response and the caller never pages: an offset page would run the whole
--   aggregate again.
-- * No index serves the type filter. The planner reads the window through
--   activity_events_workspace_timeline_idx or activity_events_occurred_at_idx and filters the types
--   on the heap rows, or scans the table when the window is most of it. One generic plan cannot
--   fit both a 30 day and a 13 month window (after five calls it chose the index for 13 months and
--   ran about a third slower), so every call is planned for its own arguments.

create function public.activity_event_counts(
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
  set plan_cache_mode = force_custom_plan
as $$
begin
  if p_bucket is null or p_bucket not in ('day', 'month') then
    raise exception 'p_bucket must be day or month, not %', coalesce(p_bucket, 'null') using errcode = '22023';
  end if;
  if not public.has_workspace_role(p_workspace_id, 'viewer') then
    return;
  end if;
  return query
    select date_trunc(p_bucket, e.occurred_at at time zone 'UTC')::date, e.provider, e.type_id, count(*)
    from public.activity_events e
    where e.workspace_id = p_workspace_id
      and e.occurred_at >= (p_since::timestamp at time zone 'UTC')
      and e.type_id = any (p_type_ids)
      and (coalesce(cardinality(p_providers), 0) = 0 or e.provider = any (p_providers))
      and (p_account_ids is null or e.external_account_id = any (p_account_ids))
    group by 1, 2, 3;
end;
$$;

-- Supabase's default privileges grant execute on every new public function to anon,
-- authenticated, and service_role, so all three are revoked before authenticated gets it back. The
-- service key has no auth.uid() and would count nothing anyway; it has no reason to call this.
revoke execute on function public.activity_event_counts(uuid, date, text, text[], public.provider_id[], uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.activity_event_counts(uuid, date, text, text[], public.provider_id[], uuid[])
  to authenticated;
