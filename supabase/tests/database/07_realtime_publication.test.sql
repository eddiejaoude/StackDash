-- Realtime publication (issues #129, #628, #635): the workspace screens refresh live from one private
-- Broadcast per statement (20261122210934_live_refresh_broadcast.sql,
-- 41_live_refresh_broadcast.test.sql), not from Postgres Changes, so supabase_realtime publishes no
-- table (20261123085405_live_refresh_broadcast_contract.sql). The empty publication is pinned
-- because any table added to it would stream its rows through the replication slot to every client
-- that subscribes to Postgres Changes on it, one message per row, each spending the project's
-- message limit that live refresh shares (#627). So this file fails CI the moment a migration
-- publishes a table, above all the credential, OAuth state, and invite tables.
begin;

create extension if not exists pgtap with schema extensions;

select plan(2);

-- A FOR ALL TABLES publication would include every table without listing one. One row also proves
-- the publication exists, so the check below cannot pass for want of it.
select results_eq(
  $$
    select puballtables
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  $$,
  $$ values (false) $$,
  'realtime publication: supabase_realtime exists and publishes only the tables it lists'
);

select is_empty(
  $$
    select (schemaname || '.' || tablename)::text
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
  $$,
  'realtime publication: no table is published, the live tables included, because live refresh reads Broadcast'
);

select * from finish();

rollback;
