-- Live updates (issue #129): publish the sync-written tables the workspace screens read to Supabase
-- Realtime. The user-edited tables they also read (external_accounts, projects, budgets,
-- alert_rules) stay unpublished: the Server Function that edits one refreshes the page itself.
--
-- The workspace layout mounts one client channel per workspace (src/components/app/live-refresh.tsx)
-- that listens for inserts and updates filtered by workspace_id and refreshes the page, so the
-- Server Components read again. Realtime checks each change against the subscriber's select
-- policy before delivering it, so a member only hears about rows the pages would show them:
--
-- - activity_events: synced events on the timeline and the dashboard.
-- - usage_snapshots: spend, usage, and allowance figures on the dashboard and the trends.
-- - connections: sync status, last synced time, and errors on the connection pages and the
--   dashboard. Its select grant is the whole row, which the pages already show to every member;
--   the credentials live in connection_credentials, which is never published.
-- - triggered_alerts: the alerts page and the dashboard alerts summary.
--
-- Never publish connection_credentials (sealed provider tokens), oauth_states (PKCE verifiers
-- bound to a user), access_invites (invited email addresses), or any other service only table.
-- They are closed to anon and authenticated, so Realtime would deliver nothing, but publishing
-- them still streams their rows through the replication slot for no reader.
-- supabase/tests/database/07_realtime_publication.test.sql pins the exact list. Since
-- 20261123085405_live_refresh_broadcast_contract.sql the publication holds no table and live
-- refresh reads Broadcast instead; 07 pins it empty.
--
-- Replica identity stays the default (primary key). Inserts and updates carry the whole new row,
-- which is what the workspace_id filter and the select policy are checked against, so no change is
-- needed for them. Only deletes would need replica identity full, and the screens do not listen for
-- deletes: Realtime cannot apply a filter to a delete, retention only purges rows older than the
-- screens show, and a member who disconnects a provider sees the result in that action's response.
--
-- Idempotent: each table is added only when it is not in the publication yet.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['activity_events', 'usage_snapshots', 'connections', 'triggered_alerts']
  loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;
