-- Realtime publication (issues #129, #628): the workspace screens refresh live from one Broadcast
-- per statement (20261122210934_live_refresh_broadcast.sql), not from Postgres Changes, so
-- supabase_realtime publishes no table (20261122211518_live_refresh_broadcast_contract.sql). A
-- published table streams its rows through the replication slot to any client that subscribes to
-- Postgres Changes on it, one message per row (#627), so this file fails CI the moment a migration
-- publishes one, above all the credential, OAuth state, and invite tables.
begin;

create extension if not exists pgtap with schema extensions;

select plan(2);

-- A FOR ALL TABLES publication would include every table without listing one.
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
