-- Live refresh broadcasts (20261122210934_live_refresh_broadcast.sql): every insert or update
-- statement on activity_events, usage_snapshots, connections, and triggered_alerts writes one
-- private Broadcast message per workspace it wrote, whatever its row count, carrying the table, the
-- operation, the connections that brought provider data, and the write's time; statements that
-- write no row and deletes send nothing; any writer's statement sends, a signed-in admin's
-- included. On realtime.messages, a member of the workspace receives its topic, and nobody else
-- does: not a non-member, not a member of another workspace, not anon, and no topic of another
-- shape. No client can send on it, through Realtime or by writing the table.
begin;

create extension if not exists pgtap with schema extensions;

select plan(23);

-- ---------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------
select is_empty(
  $$
    select v.problem
    from (
      values
        (case when not (select p.prosecdef from pg_catalog.pg_proc p
                        where p.oid = 'public.broadcast_live_change()'::regprocedure)
          then 'trigger function is security invoker' end),
        (case when not (select p.proconfig @> array['search_path=""'] from pg_catalog.pg_proc p
                        where p.oid = 'public.broadcast_live_change()'::regprocedure)
          then 'trigger function does not pin an empty search_path' end),
        (case when has_function_privilege('anon', 'public.broadcast_live_change()', 'execute')
          then 'anon can call the trigger function' end),
        (case when has_function_privilege('authenticated', 'public.broadcast_live_change()', 'execute')
          then 'authenticated can call the trigger function' end),
        (case when has_function_privilege('service_role', 'public.broadcast_live_change()', 'execute')
          then 'service_role can call the trigger function' end)
    ) as v(problem)
    where v.problem is not null
  $$,
  'live broadcast shape: a security definer trigger function with an empty search_path that no client role can call');

-- tgtype 4 is an after insert statement trigger, 16 an after update one; neither has an old table.
-- name columns carry collation "C"; cast to the default collation so the row comparison against the
-- text literals below is well defined.
select results_eq(
  $$
    select c.relname::text collate "default", t.tgname::text collate "default", t.tgtype::int,
      t.tgnewtable::text collate "default", t.tgoldtable::text collate "default"
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    where t.tgfoid = 'public.broadcast_live_change()'::regprocedure
    order by 1, 2
  $$,
  $$
    values
      ('activity_events', 'activity_events_live_insert', 4, 'new_rows', null::text),
      ('activity_events', 'activity_events_live_update', 16, 'new_rows', null::text),
      ('connections', 'connections_live_insert', 4, 'new_rows', null::text),
      ('connections', 'connections_live_update', 16, 'new_rows', null::text),
      ('triggered_alerts', 'triggered_alerts_live_insert', 4, 'new_rows', null::text),
      ('triggered_alerts', 'triggered_alerts_live_update', 16, 'new_rows', null::text),
      ('usage_snapshots', 'usage_snapshots_live_insert', 4, 'new_rows', null::text),
      ('usage_snapshots', 'usage_snapshots_live_update', 16, 'new_rows', null::text)
  $$,
  'live broadcast triggers: one after insert and one after update statement trigger on each live table, none on delete');

-- A permissive insert, update, or all policy would let a client send on a workspace topic.
select results_eq(
  $$
    select p.policyname::text collate "default", p.permissive, p.cmd, p.roles::text[] collate "default"
    from pg_catalog.pg_policies p
    where p.schemaname = 'realtime' and p.tablename = 'messages'
    order by 1
  $$,
  $$ values ('workspace_live_select', 'PERMISSIVE', 'SELECT', array['authenticated']) $$,
  'realtime.messages policies: only the select policy for authenticated, so no client may write a message');

-- ---------------------------------------------------------------------------
-- Fixtures as postgres: an admin and a viewer of workspace A, an outsider, and workspace B.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c6280001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'live-admin@example.com', '{"user_name": "live-admin"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('c6280002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'live-viewer@example.com', '{"user_name": "live-viewer"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('c6280003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'live-outsider@example.com', '{"user_name": "live-outsider"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('c62800a0-0000-4000-8000-000000000000', 'Live A', 'c6280001-0000-4000-8000-000000000000'),
  ('c62800b0-0000-4000-8000-000000000000', 'Live B', 'c6280003-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('c62800a0-0000-4000-8000-000000000000', 'c6280001-0000-4000-8000-000000000000', 'admin'),
  ('c62800a0-0000-4000-8000-000000000000', 'c6280002-0000-4000-8000-000000000000', 'viewer'),
  ('c62800b0-0000-4000-8000-000000000000', 'c6280003-0000-4000-8000-000000000000', 'owner');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values
  ('c62800c1-0000-4000-8000-000000000000', 'c62800a0-0000-4000-8000-000000000000', 'fake', 'active', 'Live one', 3600),
  ('c62800c2-0000-4000-8000-000000000000', 'c62800a0-0000-4000-8000-000000000000', 'fake', 'active', 'Live two', 3600),
  ('c62800c3-0000-4000-8000-000000000000', 'c62800a0-0000-4000-8000-000000000000', 'fake', 'failed', 'Live three', 3600),
  ('c62800d1-0000-4000-8000-000000000000', 'c62800b0-0000-4000-8000-000000000000', 'fake', 'active', 'Live B one', 3600);

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind)
values
  ('c62800e1-0000-4000-8000-000000000000', 'c62800a0-0000-4000-8000-000000000000',
   'c62800c1-0000-4000-8000-000000000000', 'ext-live-one', 'Live account one', 'team'),
  ('c62800e2-0000-4000-8000-000000000000', 'c62800a0-0000-4000-8000-000000000000',
   'c62800c2-0000-4000-8000-000000000000', 'ext-live-two', 'Live account two', 'team'),
  ('c62800e4-0000-4000-8000-000000000000', 'c62800b0-0000-4000-8000-000000000000',
   'c62800d1-0000-4000-8000-000000000000', 'ext-live-b', 'Live account B', 'team');

insert into public.alert_rules (id, workspace_id, kind, scope, threshold_amount_minor, currency)
values ('c62800f1-0000-4000-8000-000000000000', 'c62800a0-0000-4000-8000-000000000000', 'spend_amount', 'workspace', 1000, 'USD');

-- The messages on the two workspaces' topics, read as postgres. `payload` leaves out what changes
-- per message (the id realtime.send adds and changed_at); `stamped` checks both: changed_at is the
-- transaction's start, the value now() returns in this test's single transaction.
create temp view live_messages as
select m.topic, m.event, m.extension, m.private,
  m.payload - 'id' - 'changed_at' as payload,
  m.payload ? 'id' and (m.payload ->> 'changed_at')::timestamptz = now() as stamped
from realtime.messages m
where m.topic in (
  'workspace-live:c62800a0-0000-4000-8000-000000000000',
  'workspace-live:c62800b0-0000-4000-8000-000000000000'
);

-- ---------------------------------------------------------------------------
-- Inserts: one message per statement and workspace, with the provider data's connections.
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'workspace-live:c62800%';

insert into public.activity_events (
  workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key
)
values
  ('c62800a0-0000-4000-8000-000000000000', 'c62800c2-0000-4000-8000-000000000000', 'c62800e2-0000-4000-8000-000000000000',
   'fake', 'fake.deploy.succeeded', 'success', 'Deploy', now(), 'live-two'),
  ('c62800a0-0000-4000-8000-000000000000', 'c62800c1-0000-4000-8000-000000000000', 'c62800e1-0000-4000-8000-000000000000',
   'fake', 'fake.signup', 'info', 'New signup', now(), 'live-one'),
  ('c62800a0-0000-4000-8000-000000000000', 'c62800c1-0000-4000-8000-000000000000', 'c62800e1-0000-4000-8000-000000000000',
   'fake', 'fake.signup', 'info', 'New signup', now(), 'live-one-again'),
  -- StackDash's own event about connection three: no provider, so not data received from it.
  ('c62800a0-0000-4000-8000-000000000000', 'c62800c3-0000-4000-8000-000000000000', null,
   null, 'stackdash.sync_failed', 'critical', 'Sync failed', now(), 'live-sync-failed'),
  ('c62800b0-0000-4000-8000-000000000000', 'c62800d1-0000-4000-8000-000000000000', 'c62800e4-0000-4000-8000-000000000000',
   'fake', 'fake.signup', 'info', 'New signup', now(), 'live-b');

select results_eq(
  $$ select topic, payload from live_messages order by topic $$,
  $$
    values
      ('workspace-live:c62800a0-0000-4000-8000-000000000000',
       '{"table": "activity_events", "operation": "INSERT",
         "connection_ids": ["c62800c1-0000-4000-8000-000000000000", "c62800c2-0000-4000-8000-000000000000"]}'::jsonb),
      ('workspace-live:c62800b0-0000-4000-8000-000000000000',
       '{"table": "activity_events", "operation": "INSERT", "connection_ids": ["c62800d1-0000-4000-8000-000000000000"]}'::jsonb)
  $$,
  'activity_events insert across two workspaces: one message each, naming the distinct connections of provider events only');

select is_empty(
  $$ select 1 from live_messages where event <> 'change' or extension <> 'broadcast' or not private or not stamped $$,
  'live messages: private broadcasts of event change, with an id and the write''s time');

delete from realtime.messages where topic like 'workspace-live:c62800%';

insert into public.usage_snapshots (
  workspace_id, connection_id, external_account_id, metric_key, kind, label, snapshot_date, value, unit, point_at,
  retrieved_at, provenance_source
)
select 'c62800a0-0000-4000-8000-000000000000', 'c62800c1-0000-4000-8000-000000000000', 'c62800e1-0000-4000-8000-000000000000',
  'live.metric_' || g || '.count', 'usage', 'Metric ' || g, current_date, g, 'requests', now(), now(), 'provider_api'
from generate_series(1, 1000) as g;

select results_eq(
  $$ select topic, payload from live_messages $$,
  $$
    values
      ('workspace-live:c62800a0-0000-4000-8000-000000000000',
       '{"table": "usage_snapshots", "operation": "INSERT", "connection_ids": ["c62800c1-0000-4000-8000-000000000000"]}'::jsonb)
  $$,
  'usage_snapshots insert of 1,000 rows: one message, not one per row');

-- ---------------------------------------------------------------------------
-- An upsert: the insert trigger for the rows it added, the update trigger for those it changed.
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'workspace-live:c62800%';

insert into public.usage_snapshots (
  workspace_id, connection_id, external_account_id, metric_key, kind, label, snapshot_date, value, unit, point_at,
  retrieved_at, provenance_source
)
values
  ('c62800a0-0000-4000-8000-000000000000', 'c62800c1-0000-4000-8000-000000000000', 'c62800e1-0000-4000-8000-000000000000',
   'live.metric_1.count', 'usage', 'Metric 1', current_date, 5000, 'requests', now(), now(), 'provider_api'),
  ('c62800a0-0000-4000-8000-000000000000', 'c62800c2-0000-4000-8000-000000000000', 'c62800e2-0000-4000-8000-000000000000',
   'live.metric_1.count', 'usage', 'Metric 1', current_date, 7, 'requests', now(), now(), 'provider_api')
on conflict on constraint usage_snapshots_account_metric_date_key do update set value = excluded.value;

select results_eq(
  $$ select topic, payload from live_messages order by payload ->> 'operation' $$,
  $$
    values
      ('workspace-live:c62800a0-0000-4000-8000-000000000000',
       '{"table": "usage_snapshots", "operation": "INSERT", "connection_ids": ["c62800c2-0000-4000-8000-000000000000"]}'::jsonb),
      ('workspace-live:c62800a0-0000-4000-8000-000000000000',
       '{"table": "usage_snapshots", "operation": "UPDATE", "connection_ids": ["c62800c1-0000-4000-8000-000000000000"]}'::jsonb)
  $$,
  'usage_snapshots upsert: one insert message for the added row and one update message for the changed row');

-- ---------------------------------------------------------------------------
-- Updates: connections bring no connection ids; statements that write no row send nothing.
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'workspace-live:c62800%';

update public.connections
set display_name = display_name || ' renamed'
where id in ('c62800c1-0000-4000-8000-000000000000', 'c62800c2-0000-4000-8000-000000000000', 'c62800d1-0000-4000-8000-000000000000');

select results_eq(
  $$ select topic, payload from live_messages order by topic $$,
  $$
    values
      ('workspace-live:c62800a0-0000-4000-8000-000000000000',
       '{"table": "connections", "operation": "UPDATE", "connection_ids": []}'::jsonb),
      ('workspace-live:c62800b0-0000-4000-8000-000000000000',
       '{"table": "connections", "operation": "UPDATE", "connection_ids": []}'::jsonb)
  $$,
  'connections update of three rows in two workspaces: one message each, no connection ids');

delete from realtime.messages where topic like 'workspace-live:c62800%';

update public.connections set display_name = 'Nobody' where id = '00000000-0000-4000-8000-000000000000';

insert into public.activity_events (
  workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key
)
values
  ('c62800a0-0000-4000-8000-000000000000', 'c62800c1-0000-4000-8000-000000000000', 'c62800e1-0000-4000-8000-000000000000',
   'fake', 'fake.signup', 'info', 'Duplicate', now(), 'live-one')
on conflict do nothing;

select is_empty(
  $$ select 1 from live_messages $$,
  'statements that write no row (an update matching nothing, a dedupe conflict) send no message');

delete from public.activity_events where workspace_id = 'c62800a0-0000-4000-8000-000000000000';
delete from public.usage_snapshots where workspace_id = 'c62800a0-0000-4000-8000-000000000000';

select is_empty($$ select 1 from live_messages $$, 'deletes send no message');

-- ---------------------------------------------------------------------------
-- triggered_alerts: written by the jobs, acknowledged by a signed-in admin. Both send.
-- ---------------------------------------------------------------------------
insert into public.triggered_alerts (workspace_id, rule_id, cycle_key, threshold_label, is_estimated, message)
values ('c62800a0-0000-4000-8000-000000000000', 'c62800f1-0000-4000-8000-000000000000', '2026-11-01', '$10.00', false,
  'Spend crossed $10.00');

select results_eq(
  $$ select topic, payload from live_messages $$,
  $$
    values
      ('workspace-live:c62800a0-0000-4000-8000-000000000000',
       '{"table": "triggered_alerts", "operation": "INSERT", "connection_ids": []}'::jsonb)
  $$,
  'triggered_alerts insert: one message, no connection ids');

delete from realtime.messages where topic like 'workspace-live:c62800%';

set local role authenticated;
set local request.jwt.claims to '{"sub": "c6280001-0000-4000-8000-000000000000", "role": "authenticated"}';

update public.triggered_alerts
set acknowledged_at = now(), acknowledged_by = 'c6280001-0000-4000-8000-000000000000'
where workspace_id = 'c62800a0-0000-4000-8000-000000000000';

reset role;
reset request.jwt.claims;

select results_eq(
  $$ select topic, payload, stamped from live_messages $$,
  $$
    values
      ('workspace-live:c62800a0-0000-4000-8000-000000000000',
       '{"table": "triggered_alerts", "operation": "UPDATE", "connection_ids": []}'::jsonb, true)
  $$,
  'triggered_alerts acknowledged by a signed-in admin: the trigger writes the message although the admin cannot');

-- ---------------------------------------------------------------------------
-- Receiving: realtime.authorize is what Realtime runs when a channel joins or sends a new token.
-- It inserts a probe message per read extension on the topic, reads them back as the role, and
-- tries an insert per write extension; then it rolls all of it back. Realtime's own tenant
-- migrations create it, not this repository's: it arrived in Realtime v2.141.0 (Supabase CLI
-- v2.121.0 starts v2.143.4; CLI v2.120.0 starts v2.140.10, which has none, so the tests below fail
-- there with "function realtime.authorize does not exist"). They pass on Realtime v2.167.0, the
-- image CLI 3.2.0 starts, which docs/operations/deploy.md asks for.
-- ---------------------------------------------------------------------------
select results_eq(
  $$
    select read_allowed, write_allowed
    from realtime.authorize(
      'authenticated', 'workspace-live:c62800a0-0000-4000-8000-000000000000',
      '{"sub": "c6280002-0000-4000-8000-000000000000", "role": "authenticated"}',
      'c6280002-0000-4000-8000-000000000000', '{}', array['broadcast', 'presence'], array['broadcast', 'presence']
    )
  $$,
  $$ values (array[true, false], array[false, false]) $$,
  'a viewer of the workspace receives its broadcasts, reads no presence, and can send nothing');

select results_eq(
  $$
    select read_allowed, write_allowed
    from realtime.authorize(
      'authenticated', 'workspace-live:c62800a0-0000-4000-8000-000000000000',
      '{"sub": "c6280001-0000-4000-8000-000000000000", "role": "authenticated"}',
      'c6280001-0000-4000-8000-000000000000', '{}', array['broadcast'], array['broadcast', 'presence']
    )
  $$,
  $$ values (array[true], array[false, false]) $$,
  'an admin of the workspace receives its broadcasts and can send nothing either');

select results_eq(
  $$
    select read_allowed, write_allowed
    from realtime.authorize(
      'authenticated', 'workspace-live:c62800a0-0000-4000-8000-000000000000',
      '{"sub": "c6280003-0000-4000-8000-000000000000", "role": "authenticated"}',
      'c6280003-0000-4000-8000-000000000000', '{}', array['broadcast', 'presence'], array['broadcast', 'presence']
    )
  $$,
  $$ values (array[false, false], array[false, false]) $$,
  'a non-member receives nothing on the workspace topic and can send nothing');

select results_eq(
  $$
    select read_allowed
    from realtime.authorize(
      'authenticated', 'workspace-live:c62800b0-0000-4000-8000-000000000000',
      '{"sub": "c6280002-0000-4000-8000-000000000000", "role": "authenticated"}',
      'c6280002-0000-4000-8000-000000000000', '{}', array['broadcast'], '{}'
    )
  $$,
  $$ values (array[false]) $$,
  'a member of one workspace receives nothing on another workspace''s topic');

select results_eq(
  $$
    select read_allowed, write_allowed
    from realtime.authorize(
      'anon', 'workspace-live:c62800a0-0000-4000-8000-000000000000', '{"role": "anon"}', '', '{}',
      array['broadcast'], array['broadcast']
    )
  $$,
  $$ values (array[false], array[false]) $$,
  'anon receives nothing on a workspace topic and can send nothing');

-- Other shapes of topic, for a member of workspace A: matched as text, never cast, so none errors.
select results_eq(
  $$
    select t.topic, a.read_allowed
    from (
      values
        ('workspace-live:c62800a0-0000-4000-8000-000000000000:1'),
        ('workspace-live:C62800A0-0000-4000-8000-000000000000'),
        ('workspace-live:not-a-uuid'),
        ('workspace-live:'),
        ('c62800a0-0000-4000-8000-000000000000')
    ) as t(topic)
    cross join lateral realtime.authorize(
      'authenticated', t.topic, '{"sub": "c6280002-0000-4000-8000-000000000000", "role": "authenticated"}',
      'c6280002-0000-4000-8000-000000000000', '{}', array['broadcast'], '{}'
    ) as a
    order by t.topic collate "C"
  $$,
  $$
    values
      ('c62800a0-0000-4000-8000-000000000000', array[false]),
      ('workspace-live:', array[false]),
      ('workspace-live:C62800A0-0000-4000-8000-000000000000', array[false]),
      ('workspace-live:c62800a0-0000-4000-8000-000000000000:1', array[false]),
      ('workspace-live:not-a-uuid', array[false])
  $$,
  'topics of any other shape: a member receives nothing, and none raises an error');

-- The e2e fixtures join as the service role, which bypasses row level security.
select results_eq(
  $$
    select read_allowed
    from realtime.authorize(
      'service_role', 'workspace-live:c62800a0-0000-4000-8000-000000000000', '{"role": "service_role"}', '', '{}',
      array['broadcast'], '{}'
    )
  $$,
  $$ values (array[true]) $$,
  'the service role receives a workspace topic');

-- ---------------------------------------------------------------------------
-- Sending as a member, outside Realtime: neither a direct write nor realtime.send lands a message.
-- ---------------------------------------------------------------------------
delete from realtime.messages where topic like 'workspace-live:c62800%';

set local role authenticated;
set local request.jwt.claims to '{"sub": "c6280001-0000-4000-8000-000000000000", "role": "authenticated"}';

select throws_ok(
  $$
    insert into realtime.messages (topic, extension, event, payload, private)
    values ('workspace-live:c62800a0-0000-4000-8000-000000000000', 'broadcast', 'change', '{"table": "connections"}', true)
  $$,
  '42501'::char(5), null::text,
  'a member cannot write a message on the workspace topic');

-- realtime.send catches the refused insert and raises a warning instead.
select lives_ok(
  $$ select realtime.send('{"table": "connections"}', 'change', 'workspace-live:c62800a0-0000-4000-8000-000000000000', true) $$,
  'realtime.send called by a member does not fail');

reset role;
reset request.jwt.claims;

select is_empty($$ select 1 from live_messages $$, 'realtime.send called by a member writes no message');

-- A member removed from the workspace stops receiving at the next check: a join, or a new token.
delete from public.workspace_members
where workspace_id = 'c62800a0-0000-4000-8000-000000000000' and user_id = 'c6280002-0000-4000-8000-000000000000';

select results_eq(
  $$
    select read_allowed
    from realtime.authorize(
      'authenticated', 'workspace-live:c62800a0-0000-4000-8000-000000000000',
      '{"sub": "c6280002-0000-4000-8000-000000000000", "role": "authenticated"}',
      'c6280002-0000-4000-8000-000000000000', '{}', array['broadcast'], '{}'
    )
  $$,
  $$ values (array[false]) $$,
  'a member removed from the workspace receives nothing on its topic at the next check');

select * from finish();

rollback;
