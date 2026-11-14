-- Headline strip event counts from the daily rollup (issue #320). count_activity_events
-- (20261105120700_count_activity_events.sql) counted raw activity_events as security invoker, so the
-- activity_events select policy ran has_workspace_role once per scanned row: a member's month
-- window took 326 to 426 ms over 1,000,000 synthetic events. headline_event_counts sums
-- activity_event_daily_counts (20261106090000_activity_event_daily_counts.sql) behind one membership
-- check, like activity_event_counts. Before and after explain analyze numbers:
-- https://github.com/eddiejaoude/StackDash/issues/320
--
-- Same counts as before for the same windows. The headline's windows are UTC calendar dates with both
-- ends inclusive (DateRange in src/lib/dashboard/headline.ts), and count_activity_events was always
-- called with the window's first UTC instant and the instant after its last UTC day, so it counted
-- whole UTC days. The rollup's day is the UTC day of occurred_at, so a window of whole UTC days is
-- exactly the rollup rows from p_start to p_end.
--
-- The rollup has no connection_id, so each count takes its connection from the external account the
-- rollup row is keyed by. Only the accounts passed in count, and every one has a connection
-- (external_accounts.connection_id is not null); the only writer of accounted signup and deploy
-- events, insertEvents in src/lib/jobs/ingest.ts, stores the account's own connection on the event.
--
-- Security definer with one membership check up front: a non-member gets no rows. Every row read is
-- still scoped to p_workspace_id, and the account join matches the workspace too. The read is a
-- range of the rollup key's index (workspace_id, day, ...).
create function public.headline_event_counts(
  p_workspace_id uuid,
  p_account_ids uuid[],
  p_type_ids text[],
  p_start date,
  p_end date
)
returns table (connection_id uuid, type_id text, events integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_workspace_role(p_workspace_id, 'viewer') then
    return;
  end if;
  return query
    select a.connection_id, c.type_id, sum(c.event_count)::integer
    from public.activity_event_daily_counts c
    join public.external_accounts a on a.workspace_id = c.workspace_id and a.id = c.external_account_id
    where c.workspace_id = p_workspace_id
      and c.day >= p_start
      and c.day <= p_end
      and c.type_id = any (p_type_ids)
      and c.external_account_id = any (p_account_ids)
    group by a.connection_id, c.type_id;
end;
$$;

-- Supabase's default privileges grant execute on every new public function to anon, authenticated,
-- and service_role, so all three are revoked before authenticated gets it back.
revoke execute on function public.headline_event_counts(uuid, uuid[], text[], date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.headline_event_counts(uuid, uuid[], text[], date, date) to authenticated;

-- Its only caller, getHeadlineEvents, now reads headline_event_counts.
drop function public.count_activity_events(uuid, uuid[], text[], timestamptz, timestamptz);
