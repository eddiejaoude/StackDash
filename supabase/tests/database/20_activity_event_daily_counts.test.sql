-- Event count rollup (20261106090000_activity_event_daily_counts.sql): activity_event_daily_counts
-- equals the activity_events rows grouped by workspace, UTC day, type, provider, and account after
-- every kind of change to the events (inserts, a dedupe conflict, the external account set null, the
-- retention purge, cascades, truncate); the rebuild repairs it and can run again; members read it
-- and activity_event_counts sums it to the raw counts; a non-member counts and reads nothing.
begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

-- Every row on which the rollup and the raw events disagree, in either direction, across all
-- workspaces (the seed's included). Read as postgres, so row level security hides nothing.
create temp view rollup_drift as
with raw as (
  select e.workspace_id, (e.occurred_at at time zone 'UTC')::date as day, e.type_id, e.provider, e.external_account_id,
    count(*)::int as event_count
  from public.activity_events e
  group by 1, 2, 3, 4, 5
),
rollup as (
  select c.workspace_id, c.day, c.type_id, c.provider, c.external_account_id, c.event_count
  from public.activity_event_daily_counts c
)
(select 'rollup only' as side, * from rollup except all select 'rollup only', * from raw)
union all
(select 'raw only', * from raw except all select 'raw only', * from rollup);

-- ---------------------------------------------------------------------------
-- Shape: members read, nobody writes but the owner's functions.
-- ---------------------------------------------------------------------------
select is_empty(
  $$
    select v.problem
    from (
      values
        (case when has_table_privilege('service_role', 'public.activity_event_daily_counts', 'insert, update, delete, truncate')
          then 'service_role can write the rollup' end),
        (case when has_table_privilege('authenticated', 'public.activity_event_daily_counts', 'insert, update, delete, truncate')
          then 'authenticated can write the rollup' end),
        (case when has_table_privilege('anon', 'public.activity_event_daily_counts', 'select')
          then 'anon can read the rollup' end),
        (case when not has_table_privilege('authenticated', 'public.activity_event_daily_counts', 'select')
          then 'authenticated cannot read the rollup' end),
        (case when not (select p.prosecdef from pg_catalog.pg_proc p
                        where p.oid = 'public.activity_events_count_rollup()'::regprocedure)
          then 'trigger function is security invoker' end),
        (case when has_function_privilege('authenticated', 'public.rebuild_activity_event_daily_counts(uuid)', 'execute')
          then 'authenticated can rebuild' end),
        (case when not has_function_privilege('service_role', 'public.rebuild_activity_event_daily_counts(uuid)', 'execute')
          then 'service_role cannot rebuild' end),
        (case when (select count(*) from pg_catalog.pg_trigger t
                    where t.tgrelid = 'public.activity_events'::regclass
                      and t.tgfoid = 'public.activity_events_count_rollup()'::regprocedure) <> 4
          then 'not one trigger each for insert, update, delete, and truncate' end)
    ) as v(problem)
    where v.problem is not null
  $$,
  'rollup shape: members read, only the trigger and the service role rebuild write, four triggers');

-- Fixtures as postgres: a member and an outsider, one workspace with two connections and accounts.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('b2010001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'rollup-member@example.com', '{"user_name": "rollup-member"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('b2010002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'rollup-outsider@example.com', '{"user_name": "rollup-outsider"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values ('b20100a0-0000-4000-8000-000000000000', 'Rollup team', 'b2010001-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values ('b20100a0-0000-4000-8000-000000000000', 'b2010001-0000-4000-8000-000000000000', 'viewer');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values
  ('b20100c1-0000-4000-8000-000000000000', 'b20100a0-0000-4000-8000-000000000000', 'fake', 'active', 'Rollup one', 3600),
  ('b20100c2-0000-4000-8000-000000000000', 'b20100a0-0000-4000-8000-000000000000', 'fake', 'active', 'Rollup two', 3600);

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind)
values
  ('b20100e1-0000-4000-8000-000000000000', 'b20100a0-0000-4000-8000-000000000000',
   'b20100c1-0000-4000-8000-000000000000', 'ext-rollup-one', 'Rollup account one', 'team'),
  ('b20100e2-0000-4000-8000-000000000000', 'b20100a0-0000-4000-8000-000000000000',
   'b20100c2-0000-4000-8000-000000000000', 'ext-rollup-two', 'Rollup account two', 'team');

-- ---------------------------------------------------------------------------
-- Inserts: one statement, several days, types, accounts, and an event with no provider.
-- ---------------------------------------------------------------------------
insert into public.activity_events (
  workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key
)
values
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c1-0000-4000-8000-000000000000', 'b20100e1-0000-4000-8000-000000000000',
   'fake', 'fake.deploy.succeeded', 'success', 'Deploy', '2026-10-19T23:59:59.999Z', 'rollup-day-before'),
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c1-0000-4000-8000-000000000000', 'b20100e1-0000-4000-8000-000000000000',
   'fake', 'fake.deploy.succeeded', 'success', 'Deploy', '2026-10-20T00:00:00Z', 'rollup-first'),
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c1-0000-4000-8000-000000000000', 'b20100e1-0000-4000-8000-000000000000',
   'fake', 'fake.deploy.succeeded', 'success', 'Deploy', '2026-10-20T12:00:00Z', 'rollup-noon'),
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c1-0000-4000-8000-000000000000', 'b20100e1-0000-4000-8000-000000000000',
   'fake', 'fake.signup', 'info', 'New signup', '2026-10-20T13:00:00Z', 'rollup-signup'),
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c2-0000-4000-8000-000000000000', 'b20100e2-0000-4000-8000-000000000000',
   'fake', 'fake.deploy.succeeded', 'success', 'Deploy', '2026-10-20T14:00:00Z', 'rollup-other-account'),
  ('b20100a0-0000-4000-8000-000000000000', null, null,
   null, 'stackdash.alert_triggered', 'warning', 'Alert', '2026-10-20T15:00:00Z', 'rollup-alert'),
  -- Older than the retention cut used below.
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c1-0000-4000-8000-000000000000', 'b20100e1-0000-4000-8000-000000000000',
   'fake', 'fake.deploy.succeeded', 'success', 'Deploy', '2025-09-15T08:00:00Z', 'rollup-old-one'),
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c1-0000-4000-8000-000000000000', null,
   'fake', 'fake.deploy.succeeded', 'success', 'Deploy', '2025-09-16T08:00:00Z', 'rollup-old-two');

select is_empty($$ select * from rollup_drift $$, 'rollup after inserts: equals the raw events');

select results_eq(
  $$
    select type_id, provider::text, external_account_id, event_count
    from public.activity_event_daily_counts
    where workspace_id = 'b20100a0-0000-4000-8000-000000000000' and day = '2026-10-20'
    order by type_id, external_account_id
  $$,
  $$
    values
      ('fake.deploy.succeeded', 'fake', 'b20100e1-0000-4000-8000-000000000000'::uuid, 2),
      ('fake.deploy.succeeded', 'fake', 'b20100e2-0000-4000-8000-000000000000'::uuid, 1),
      ('fake.signup', 'fake', 'b20100e1-0000-4000-8000-000000000000'::uuid, 1),
      ('stackdash.alert_triggered', null::text, null::uuid, 1)
  $$,
  'rollup after inserts: one row per UTC day, type, provider, and account, events with no provider under null');

-- ---------------------------------------------------------------------------
-- Dedupe conflict: the duplicate is skipped by on conflict do nothing and must count nothing.
-- ---------------------------------------------------------------------------
insert into public.activity_events (
  workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key
)
values
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c1-0000-4000-8000-000000000000', 'b20100e1-0000-4000-8000-000000000000',
   'fake', 'fake.deploy.failed', 'critical', 'Duplicate', '2026-10-21T09:00:00Z', 'rollup-first'),
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c1-0000-4000-8000-000000000000', 'b20100e1-0000-4000-8000-000000000000',
   'fake', 'fake.signup', 'info', 'New signup', '2026-10-21T09:00:00Z', 'rollup-new-signup')
on conflict (workspace_id, dedupe_key) do nothing;

select is_empty($$ select * from rollup_drift $$, 'rollup after a dedupe conflict: equals the raw events');

select is_empty(
  $$
    select 1 from public.activity_event_daily_counts
    where workspace_id = 'b20100a0-0000-4000-8000-000000000000' and type_id = 'fake.deploy.failed'
  $$,
  'rollup after a dedupe conflict: the skipped duplicate is not counted');

-- ---------------------------------------------------------------------------
-- Deleting an account sets external_account_id null on its events (an update of the event rows).
-- ---------------------------------------------------------------------------
delete from public.external_accounts where id = 'b20100e2-0000-4000-8000-000000000000';

select is_empty($$ select * from rollup_drift $$, 'rollup after an account delete sets events'' account null: equals the raw events');

select results_eq(
  $$
    select external_account_id, event_count
    from public.activity_event_daily_counts
    where workspace_id = 'b20100a0-0000-4000-8000-000000000000' and day = '2026-10-20' and type_id = 'fake.deploy.succeeded'
    order by external_account_id nulls last
  $$,
  $$ values ('b20100e1-0000-4000-8000-000000000000'::uuid, 2), (null::uuid, 1) $$,
  'rollup after an account delete: the count moves from the account to no account');

-- ---------------------------------------------------------------------------
-- Retention purge (#37).
-- ---------------------------------------------------------------------------
select public.purge_activity_events('2026-01-01T00:00:00Z', 10000);

select is_empty($$ select * from rollup_drift $$, 'rollup after the retention purge: equals the raw events');

select is_empty(
  $$
    select 1 from public.activity_event_daily_counts
    where workspace_id = 'b20100a0-0000-4000-8000-000000000000' and day < '2026-01-01'
  $$,
  'rollup after the retention purge: purged days have no rows left, not zeros');

-- ---------------------------------------------------------------------------
-- Reads: a member sees the counts and activity_event_counts sums them to the raw counts.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "b2010001-0000-4000-8000-000000000000", "role": "authenticated"}';
set local timezone to 'Europe/London';

select results_eq(
  $$
    select bucket_start, provider::text, type_id, event_count
    from public.activity_event_counts(
      'b20100a0-0000-4000-8000-000000000000', '2025-01-01', 'month',
      array['fake.deploy.succeeded', 'fake.signup', 'stackdash.alert_triggered']
    )
    order by 1, 2, 3
  $$,
  $$
    select date_trunc('month', e.occurred_at at time zone 'UTC')::date, e.provider::text, e.type_id, count(*)
    from public.activity_events e
    where e.workspace_id = 'b20100a0-0000-4000-8000-000000000000'
      and e.occurred_at >= '2025-01-01T00:00:00Z'
      and e.type_id = any (array['fake.deploy.succeeded', 'fake.signup', 'stackdash.alert_triggered'])
    group by 1, 2, 3
    order by 1, 2, 3
  $$,
  'activity_event_counts by month: the rollup sums to the raw events counted the same way');

select results_eq(
  $$
    select bucket_start, provider::text, type_id, event_count
    from public.activity_event_counts(
      'b20100a0-0000-4000-8000-000000000000', '2026-10-20', 'day', array['fake.deploy.succeeded', 'fake.signup'],
      '{}', array['b20100e1-0000-4000-8000-000000000000']::uuid[]
    )
    order by 1, 2, 3
  $$,
  $$
    select (e.occurred_at at time zone 'UTC')::date, e.provider::text, e.type_id, count(*)
    from public.activity_events e
    where e.workspace_id = 'b20100a0-0000-4000-8000-000000000000'
      and e.occurred_at >= '2026-10-20T00:00:00Z'
      and e.type_id = any (array['fake.deploy.succeeded', 'fake.signup'])
      and e.external_account_id = 'b20100e1-0000-4000-8000-000000000000'
    group by 1, 2, 3
    order by 1, 2, 3
  $$,
  'activity_event_counts by day for one account: the rollup sums to the raw events counted the same way');

select is(
  (select sum(event_count)::int from public.activity_event_daily_counts where workspace_id = 'b20100a0-0000-4000-8000-000000000000'),
  (select count(*)::int from public.activity_events where workspace_id = 'b20100a0-0000-4000-8000-000000000000'),
  'rollup select: a member reads their workspace''s counts');

-- The outsider: nothing through the function, nothing through the table, and no writes.
set local request.jwt.claims to '{"sub": "b2010002-0000-4000-8000-000000000000", "role": "authenticated"}';

select is_empty(
  $$
    select 1 from public.activity_event_counts(
      'b20100a0-0000-4000-8000-000000000000', '2025-01-01', 'month',
      array['fake.deploy.succeeded', 'fake.signup', 'stackdash.alert_triggered']
    )
  $$,
  'activity_event_counts: a non-member counts nothing from the rollup');

select is_empty(
  $$ select 1 from public.activity_event_daily_counts where workspace_id = 'b20100a0-0000-4000-8000-000000000000' $$,
  'rollup select: a non-member reads no counts of another workspace');

select throws_ok(
  $$
    insert into public.activity_event_daily_counts (workspace_id, day, type_id, provider, external_account_id, event_count)
    values ('b20100a0-0000-4000-8000-000000000000', '2026-10-20', 'fake.signup', 'fake', null, 100)
  $$,
  '42501'::char(5), null::text,
  'rollup insert: a signed in user cannot write counts');

reset role;
reset request.jwt.claims;
reset timezone;

-- ---------------------------------------------------------------------------
-- Cascade: deleting a connection deletes its events.
-- ---------------------------------------------------------------------------
delete from public.connections where id = 'b20100c1-0000-4000-8000-000000000000';

select is_empty($$ select * from rollup_drift $$, 'rollup after a connection delete cascades to its events: equals the raw events');

-- ---------------------------------------------------------------------------
-- Rebuild (the migration's backfill): repairs a wrong rollup and is re-runnable.
-- ---------------------------------------------------------------------------
insert into public.activity_events (
  workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key
)
values
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c2-0000-4000-8000-000000000000', null,
   'fake', 'fake.deploy.succeeded', 'success', 'Deploy', '2026-10-22T10:00:00Z', 'rollup-rebuild-one'),
  ('b20100a0-0000-4000-8000-000000000000', 'b20100c2-0000-4000-8000-000000000000', null,
   'fake', 'fake.signup', 'info', 'New signup', '2026-10-23T10:00:00Z', 'rollup-rebuild-two');
update public.activity_event_daily_counts set event_count = event_count + 5
where workspace_id = 'b20100a0-0000-4000-8000-000000000000' and day = '2026-10-22';
delete from public.activity_event_daily_counts
where workspace_id = 'b20100a0-0000-4000-8000-000000000000' and day = '2026-10-23';

select results_eq(
  $$ select side, day, event_count from rollup_drift order by side, day $$,
  $$
    values
      ('raw only', '2026-10-22'::date, 1), ('raw only', '2026-10-23'::date, 1), ('rollup only', '2026-10-22'::date, 6)
  $$,
  'rollup drift check: a wrong and a missing count both show, so the equality checks above are not vacuous');

select public.rebuild_activity_event_daily_counts('b20100a0-0000-4000-8000-000000000000');

select is_empty($$ select * from rollup_drift $$, 'rollup rebuild: a wrong and a missing count are recounted from the events');

select is(
  public.rebuild_activity_event_daily_counts('b20100a0-0000-4000-8000-000000000000'),
  (select count(*)::int from public.activity_event_daily_counts where workspace_id = 'b20100a0-0000-4000-8000-000000000000'),
  'rollup rebuild: running it again rewrites the same rows');

-- ---------------------------------------------------------------------------
-- Workspace delete: no count outlives the workspace, and the deferred foreign key holds.
-- ---------------------------------------------------------------------------
delete from public.workspaces where id = 'b20100a0-0000-4000-8000-000000000000';

select lives_ok(
  $$ set constraints public.activity_event_daily_counts_workspace_fkey immediate $$,
  'rollup after a workspace delete: no count is left pointing at the deleted workspace');

select is_empty(
  $$ select 1 from public.activity_event_daily_counts where workspace_id = 'b20100a0-0000-4000-8000-000000000000' $$,
  'rollup after a workspace delete: no counts are left for it');

-- ---------------------------------------------------------------------------
-- Truncate.
-- ---------------------------------------------------------------------------
truncate public.activity_events;

select is_empty($$ select 1 from public.activity_event_daily_counts $$, 'rollup after truncate: empty, like the events');

select * from finish();
rollback;
