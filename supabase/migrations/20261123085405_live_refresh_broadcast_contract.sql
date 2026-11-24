-- Live refresh through one Broadcast per statement (#628, #635), the contract step: take the four
-- live tables out of the supabase_realtime publication. It follows the expand step,
-- 20261122210934_live_refresh_broadcast.sql, by at least one release. That step added the statement
-- triggers and the realtime.messages policy that replace the publication, and LiveRefresh
-- (src/components/app/live-refresh.tsx) listens to its workspace's private Broadcast topic since.
-- Nothing in the app or the e2e suite subscribes to Postgres Changes any more.
--
-- Why not leave them published: a client that subscribes to Postgres Changes on one of them (a tab
-- still running a build from before the expand step, or a signed-in user's own channel) would bring
-- back what #628 removed. The Postgres Changes poller then reads every row a bulk write adds, checks
-- it against every subscription to its table, and sends one message per row to each subscriber of
-- the workspace, every one counted against the project's message limit, which Broadcast shares
-- (#627). So one bulk write could still stop live refresh in every workspace. Unpublished, Realtime
-- sends no change from these tables and refuses a new subscription to them.
--
-- Rollback: a build from after the expand step runs unchanged, because it reads only the Broadcast
-- topic. A rollback to a build without 20261122210934_live_refresh_broadcast.sql loses live refresh,
-- since that build listened to Postgres Changes on these tables: its pages stop updating live and
-- show new data on the next navigation or reload. No data is lost, and nothing but live refresh is
-- affected.
--
-- The publication itself stays, with no table in it: Supabase creates it, and Realtime reads it for
-- any Postgres Changes subscription. supabase/tests/database/07_realtime_publication.test.sql pins
-- that it publishes nothing.
--
-- Idempotent: each table is dropped only while it is in the publication.
do $$
declare
  v_table text;
begin
  foreach v_table in array array['activity_events', 'usage_snapshots', 'connections', 'triggered_alerts']
  loop
    if exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', v_table);
    end if;
  end loop;
end;
$$;
