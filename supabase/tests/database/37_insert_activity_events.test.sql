-- Event writes that fill in a missing body (#499, 20261118120000_insert_activity_events.sql): new
-- events are inserted and counted; a stored event whose body is null takes the first non-null body
-- a later write brings, and nothing else of it changes; a stored body is never replaced or
-- cleared; the first row of a key in one call is the one written; a fill-in never crosses
-- workspaces, is not counted as new, and leaves the event count rollup as it was; only the
-- service role may call it.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS).
begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c3700001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'event-body-owner@example.com', '{"user_name": "event-body-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('c3700002-0000-4000-8000-000000000001', 'Event body A', 'c3700001-0000-4000-8000-000000000001'),
  ('c3700002-0000-4000-8000-000000000002', 'Event body B', 'c3700001-0000-4000-8000-000000000001');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values
  ('c3700003-0000-4000-8000-000000000001', 'c3700002-0000-4000-8000-000000000001', 'vercel', 'active', 'Vercel A', 3600),
  ('c3700003-0000-4000-8000-000000000002', 'c3700002-0000-4000-8000-000000000002', 'vercel', 'active', 'Vercel B', 3600),
  ('c3700003-0000-4000-8000-000000000003', 'c3700002-0000-4000-8000-000000000001', 'gitlab', 'active', 'GitLab A', 3600);

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind, included)
values ('c3700004-0000-4000-8000-000000000001', 'c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000003',
        'gitlab-group-1', 'Group 1', 'team', true);

-- One event row as the job store sends it: the activity_events insert columns, as JSON. A `later`
-- row differs from the first write in every column the function could reach but the key: another
-- connection, account, provider, type, severity, title, link, and a time on another UTC day, so a
-- function that took any of them would change the row and the event count rollup.
create function pg_temp.event_row(
  p_workspace text, p_connection text, p_key text, p_body text, p_later boolean default false
) returns jsonb language sql as $$
  select jsonb_build_object(
    'workspace_id', p_workspace,
    'connection_id', case when p_later then 'c3700003-0000-4000-8000-000000000003' else p_connection end,
    'external_account_id', case when p_later then 'c3700004-0000-4000-8000-000000000001' end,
    'provider', case when p_later then 'gitlab' else 'vercel' end,
    'type_id', case when p_later then 'gitlab.deployment.failed' else 'vercel.deployment.failed' end,
    'severity', case when p_later then 'warning' else 'critical' end,
    'title', case when p_later then 'A different title' else 'Production deployment of web failed' end,
    'body', p_body,
    'url', case when p_later then 'https://vercel.com/acme/web/dpl_1/inspect' else 'https://vercel.com/acme/web/dpl_1' end,
    'occurred_at', case when p_later then '2026-11-19T09:00:00Z' else '2026-11-18T09:00:00Z' end,
    'dedupe_key', p_key
  )
$$;

create temp view a_events as
select dedupe_key, body, title, severity, url, occurred_at, connection_id, created_at, id, type_id, provider,
  external_account_id
from public.activity_events where workspace_id = 'c3700002-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- New rows
-- ---------------------------------------------------------------------------
select is(
  public.insert_activity_events(jsonb_build_array(
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_null:ERROR', null),
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_set:ERROR', 'Error code: BUILD_FAILED'),
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_keep_null:ERROR', null),
    pg_temp.event_row('c3700002-0000-4000-8000-000000000002', 'c3700003-0000-4000-8000-000000000002', 'vercel:dpl_null:ERROR', null)
  )),
  4,
  'new events are inserted and counted'
);

select is(public.insert_activity_events('[]'::jsonb), 0, 'an empty array writes nothing (boundary)');

create temp table before_fill as select * from a_events;
create temp table rollup_before as
select workspace_id, day, type_id, provider, external_account_id, event_count
from public.activity_event_daily_counts
where workspace_id in ('c3700002-0000-4000-8000-000000000001', 'c3700002-0000-4000-8000-000000000002');

-- ---------------------------------------------------------------------------
-- A later write of stored events, as the poll after a delivery: every other column differs.
-- ---------------------------------------------------------------------------
select is(
  public.insert_activity_events(jsonb_build_array(
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_null:ERROR', 'Error code: BUILD_FAILED', true),
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_set:ERROR', 'Error code: OTHER', true),
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_keep_null:ERROR', null, true)
  )),
  0,
  'a write of stored events counts nothing new, filled in or not'
);

select is(
  (select body from a_events where dedupe_key = 'vercel:dpl_null:ERROR'),
  'Error code: BUILD_FAILED',
  'null to value: a stored null body takes the later body'
);

select is_empty(
  $$
    select b.dedupe_key from before_fill b join a_events a using (id)
    where (a.dedupe_key, a.title, a.severity, a.url, a.occurred_at, a.connection_id, a.created_at, a.type_id,
        a.provider, a.external_account_id)
      is distinct from (b.dedupe_key, b.title, b.severity, b.url, b.occurred_at, b.connection_id, b.created_at,
        b.type_id, b.provider, b.external_account_id)
  $$,
  'a fill-in changes no column but body'
);

select is(
  (select body from a_events where dedupe_key = 'vercel:dpl_set:ERROR'),
  'Error code: BUILD_FAILED',
  'value to other value: a stored body is never replaced'
);

select is(
  (select body from a_events where dedupe_key = 'vercel:dpl_keep_null:ERROR'),
  null,
  'null to null: a stored null body stays null'
);

select is(
  (select body from public.activity_events
   where workspace_id = 'c3700002-0000-4000-8000-000000000002' and dedupe_key = 'vercel:dpl_null:ERROR'),
  null,
  'a fill-in never reaches another workspace''s event with the same key'
);

select set_eq(
  $$
    select workspace_id, day, type_id, provider, external_account_id, event_count
    from public.activity_event_daily_counts
    where workspace_id in ('c3700002-0000-4000-8000-000000000001', 'c3700002-0000-4000-8000-000000000002')
  $$,
  $$ select * from rollup_before $$,
  'a fill-in leaves the event count rollup as it was'
);

-- value to null: a write without a body leaves the stored body alone.
select is(
  public.insert_activity_events(jsonb_build_array(
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_null:ERROR', null)
  )),
  0,
  'a write without a body counts nothing new'
);
select is(
  (select body from a_events where dedupe_key = 'vercel:dpl_null:ERROR'),
  'Error code: BUILD_FAILED',
  'value to null: a stored body is never cleared'
);

-- ---------------------------------------------------------------------------
-- One call naming a key twice: the first row is the one written, as the insert alone did.
-- ---------------------------------------------------------------------------
select is(
  public.insert_activity_events(jsonb_build_array(
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_twice:ERROR', null),
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_twice:ERROR', 'Error code: BUILD_FAILED')
  )),
  1,
  'a key named twice in one call is inserted once'
);
select is(
  (select body from a_events where dedupe_key = 'vercel:dpl_twice:ERROR'),
  null,
  'a key named twice in one call keeps its first row, body included'
);

select is(
  public.insert_activity_events(jsonb_build_array(
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_twice:ERROR', 'Error code: BUILD_FAILED'),
    pg_temp.event_row('c3700002-0000-4000-8000-000000000001', 'c3700003-0000-4000-8000-000000000001', 'vercel:dpl_twice:ERROR', 'Error code: OTHER')
  )),
  0,
  'a stored key named twice in a later call counts nothing new'
);
select is(
  (select body from a_events where dedupe_key = 'vercel:dpl_twice:ERROR'),
  'Error code: BUILD_FAILED',
  'a stored key named twice in a later call takes the first row''s body'
);

-- ---------------------------------------------------------------------------
-- Input and grants
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.insert_activity_events('{"dedupe_key": "x"}'::jsonb) $$,
  '22023',
  'p_rows must be a JSON array',
  'an object instead of an array is refused'
);

select ok(
  not has_function_privilege('anon', 'public.insert_activity_events(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.insert_activity_events(jsonb)', 'execute'),
  'anon and authenticated cannot call insert_activity_events'
);

select ok(
  has_function_privilege('service_role', 'public.insert_activity_events(jsonb)', 'execute'),
  'the service role can call insert_activity_events'
);

select * from finish();
rollback;
