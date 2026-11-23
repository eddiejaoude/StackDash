-- Realtime publication (issue #129): the workspace screens refresh live from a private Broadcast
-- (41_live_refresh_broadcast.test.sql). These tables stay published for one release, so a rollback
-- to the previous build, which used Postgres Changes, keeps live refresh. Anything else in
-- supabase_realtime streams its rows through the replication slot, so this file fails CI the moment
-- a migration publishes another table, above all the credential, OAuth state, and invite tables.
begin;

create extension if not exists pgtap with schema extensions;

select plan(4);

-- A FOR ALL TABLES publication would include every service only table, whatever the list says.
select results_eq(
  $$
    select puballtables, pubinsert, pubupdate
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  $$,
  $$ values (false, true, true) $$,
  'realtime publication: supabase_realtime exists, lists its tables, and publishes inserts and updates'
);

select results_eq(
  $$
    -- name columns carry collation "C"; cast to the default collation so the
    -- row comparison against the text literals below is well defined.
    select (schemaname || '.' || tablename)::text collate "default"
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
    order by 1
  $$,
  $$
    values
      ('public.activity_events'), ('public.connections'),
      ('public.triggered_alerts'), ('public.usage_snapshots')
  $$,
  'realtime publication: exactly activity_events, connections, triggered_alerts, and usage_snapshots are published'
);

select is_empty(
  $$
    select tablename::text
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename in ('connection_credentials', 'oauth_states', 'access_invites', 'profiles')
  $$,
  'realtime publication: connection_credentials, oauth_states, access_invites, and profiles are never published'
);

-- Guards against a vacuous pass of the check above: the excluded tables must still exist under
-- these names, or a rename would make the absence meaningless.
select results_eq(
  $$
    select c.relname::text collate "default"
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname in ('connection_credentials', 'oauth_states', 'access_invites', 'profiles')
    order by 1
  $$,
  $$ values ('access_invites'), ('connection_credentials'), ('oauth_states'), ('profiles') $$,
  'realtime publication: the never published tables exist under the names checked above'
);

select * from finish();

rollback;
