-- Sync engine (20261031100000_sync_engine.sql) and OAuth flow context
-- (20261031100100_oauth_state_pending_installation.sql): service only
-- functions, claim semantics, one open sync per connection, and the
-- oauth_states reconnect link staying inside its workspace.
begin;

create extension if not exists pgtap with schema extensions;

select plan(32);

-- Fixtures as postgres: one owner, workspace W with connections C1 and C2,
-- workspace W2 with connection C3.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('f0000001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'rls-sync-owner@example.com', '{"user_name": "rls-sync-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('f00000a0-0000-4000-8000-000000000000', 'Sync team', 'f0000001-0000-4000-8000-000000000000'),
  ('f00000b0-0000-4000-8000-000000000000', 'Other sync team', 'f0000001-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('f00000a0-0000-4000-8000-000000000000', 'f0000001-0000-4000-8000-000000000000', 'owner'),
  ('f00000b0-0000-4000-8000-000000000000', 'f0000001-0000-4000-8000-000000000000', 'owner');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values
  ('f00000a1-0000-4000-8000-000000000000', 'f00000a0-0000-4000-8000-000000000000', 'fake', 'active', 'Sync connection one', 3600),
  ('f00000a2-0000-4000-8000-000000000000', 'f00000a0-0000-4000-8000-000000000000', 'fake', 'active', 'Sync connection two', 3600),
  ('f00000b1-0000-4000-8000-000000000000', 'f00000b0-0000-4000-8000-000000000000', 'fake', 'active', 'Other connection', 3600);

-- Scratch space for claim results, rolled back with the transaction.
create schema rls_test;

-- ---------------------------------------------------------------------------
-- New functions: security definer, empty search_path, service role only.
-- ---------------------------------------------------------------------------
select results_eq(
  $$
    select p.proname::text collate "default"
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any (array[
        'enqueue_sync_job', 'request_manual_sync', 'enqueue_due_syncs', 'latest_usage_resets',
        'purge_usage_snapshots', 'purge_activity_events', 'purge_sync_jobs'
      ])
    order by 1
  $$,
  $$
    values ('enqueue_due_syncs'), ('enqueue_sync_job'), ('latest_usage_resets'), ('purge_activity_events'),
           ('purge_sync_jobs'), ('purge_usage_snapshots'), ('request_manual_sync')
  $$,
  'sync functions: every sync engine and retention function exists in public');

-- Lists each function with the rule it breaks, so a failure names both.
select is_empty(
  $$
    select p.oid::regprocedure::text || ': ' || v.problem
    from pg_catalog.pg_proc p
    cross join lateral (
      values
        (case when not p.prosecdef then 'not security definer' end),
        (case when not coalesce(p.proconfig && array['search_path=""', 'search_path='], false) then 'search_path not empty' end),
        (case when has_function_privilege('anon', p.oid, 'execute') then 'executable by anon' end),
        (case when has_function_privilege('authenticated', p.oid, 'execute') then 'executable by authenticated' end),
        (case when not has_function_privilege('service_role', p.oid, 'execute') then 'not executable by service_role' end)
    ) as v(problem)
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any (array[
        'enqueue_sync_job', 'request_manual_sync', 'enqueue_due_syncs', 'latest_usage_resets',
        'purge_usage_snapshots', 'purge_activity_events', 'purge_sync_jobs'
      ])
      and v.problem is not null
  $$,
  'sync functions: each is security definer, sets search_path to empty, and only service_role may execute it');

set local role authenticated;
set local request.jwt.claims to '{"sub": "f0000001-0000-4000-8000-000000000000", "role": "authenticated"}';

select throws_ok(
  $$ select public.enqueue_sync_job('f00000a0-0000-4000-8000-000000000000', 'f00000a1-0000-4000-8000-000000000000') $$,
  '42501'::char(5), null::text,
  'sync functions: even a workspace owner cannot call enqueue_sync_job through the Data API');
select throws_ok(
  $$ select public.request_manual_sync('f00000a0-0000-4000-8000-000000000000', 'f00000a1-0000-4000-8000-000000000000', 60) $$,
  '42501'::char(5), null::text,
  'sync functions: authenticated cannot call request_manual_sync (cooldown is enforced server side)');
select throws_ok($$ select public.enqueue_due_syncs(10) $$, '42501'::char(5), null::text,
  'sync functions: authenticated cannot call enqueue_due_syncs');
select throws_ok($$ select public.purge_sync_jobs(now(), 10) $$, '42501'::char(5), null::text,
  'sync functions: authenticated cannot call purge_sync_jobs');

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- claim_sync_jobs. now() is fixed for the whole transaction, so "due" and
-- "lease held" are set relative to it. Run_after values far in the past put
-- these jobs ahead of any other rows in the local database (claim orders by
-- run_after, id), and every check filters to these ids.
-- Instance wide kinds need no connection, so the one-open-sync index does not
-- interfere. True skip locked contention needs two sessions and is out of
-- reach in one transaction; the lease is what stops a second claimer here.
-- ---------------------------------------------------------------------------
insert into public.sync_jobs (id, kind, status, run_after, attempts, max_attempts, locked_until)
values
  -- J1 queued and due: claimed first.
  ('f00000c1-0000-4000-8000-000000000000', 'retention', 'queued', timestamptz '1970-01-01 00:00:00+00', 0, 5, null),
  -- J2 queued but not due yet: never claimed.
  ('f00000c2-0000-4000-8000-000000000000', 'retention', 'queued', now() + interval '1 hour', 0, 5, null),
  -- J3 running with an expired lease: its tick died, so it is claimable again.
  ('f00000c3-0000-4000-8000-000000000000', 'retention', 'running', timestamptz '1970-01-02 00:00:00+00', 1, 5, timestamptz '1970-01-02 00:05:00+00'),
  -- J4 running with a live lease: someone holds it.
  ('f00000c4-0000-4000-8000-000000000000', 'retention', 'running', timestamptz '1970-01-02 00:00:00+00', 1, 5, now() + interval '1 hour'),
  -- J5 queued and due but out of attempts: never claimed.
  ('f00000c5-0000-4000-8000-000000000000', 'daily_summary', 'queued', timestamptz '1970-01-01 00:00:00+00', 5, 5, null),
  -- J6 running, lease expired on its final attempt: marked failed.
  ('f00000c6-0000-4000-8000-000000000000', 'daily_summary', 'running', timestamptz '1970-01-01 00:00:00+00', 5, 5, timestamptz '1970-01-01 00:05:00+00');

create table rls_test.first_claim as select * from public.claim_sync_jobs(1, 60);

select results_eq(
  $$ select id from rls_test.first_claim $$,
  $$ values ('f00000c1-0000-4000-8000-000000000000'::uuid) $$,
  'claim: respects p_limit and takes the oldest due job first');

select results_eq(
  $$ select status::text, attempts, locked_until, started_at from public.sync_jobs where id = 'f00000c1-0000-4000-8000-000000000000' $$,
  $$ values ('running'::text, 1, now() + interval '60 seconds', now()) $$,
  'claim: a claimed job is running, attempts + 1, leased for p_lease_seconds, started now');

create table rls_test.second_claim as select * from public.claim_sync_jobs(100, 60);

select results_eq(
  $$
    select id from rls_test.second_claim
    where id::text like 'f00000c_-0000-4000-8000-000000000000'
    order by id
  $$,
  $$ values ('f00000c3-0000-4000-8000-000000000000'::uuid) $$,
  'claim: reclaims an expired lease, skips leased, not yet due, out of attempts, and already claimed jobs');

select results_eq(
  $$ select status::text, attempts, locked_until from public.sync_jobs where id = 'f00000c3-0000-4000-8000-000000000000' $$,
  $$ values ('running'::text, 2, now() + interval '60 seconds') $$,
  'claim: reclaiming an expired lease counts another attempt and takes a fresh lease');

select results_eq(
  $$
    select id, status::text, attempts, locked_until from public.sync_jobs
    where id in ('f00000c2-0000-4000-8000-000000000000', 'f00000c4-0000-4000-8000-000000000000', 'f00000c5-0000-4000-8000-000000000000')
    order by id
  $$,
  $$
    values
      ('f00000c2-0000-4000-8000-000000000000'::uuid, 'queued'::text, 0, null::timestamptz),
      ('f00000c4-0000-4000-8000-000000000000'::uuid, 'running'::text, 1, now() + interval '1 hour'),
      ('f00000c5-0000-4000-8000-000000000000'::uuid, 'queued'::text, 5, null::timestamptz)
  $$,
  'claim: not yet due, live lease, and out of attempts jobs are left untouched');

select results_eq(
  $$ select status::text, error_code, locked_until, finished_at from public.sync_jobs where id = 'f00000c6-0000-4000-8000-000000000000' $$,
  $$ values ('failed'::text, 'lease_expired'::text, null::timestamptz, now()) $$,
  'claim: a job whose lease expired on its final attempt is marked failed with lease_expired');

select is_empty(
  $$ select id from public.claim_sync_jobs(100, 60) where id::text like 'f00000c_-0000-4000-8000-000000000000' $$,
  'claim: a second claimer gets nothing while the leases are held (no job runs twice)');

select throws_ok($$ select * from public.claim_sync_jobs(0, 60) $$, '22023'::char(5), null::text,
  'claim: p_limit outside 1..100 is rejected');

-- ---------------------------------------------------------------------------
-- One open sync per connection.
-- ---------------------------------------------------------------------------
select has_index('public', 'sync_jobs', 'sync_jobs_one_open_sync_per_connection',
  'one open sync: the partial unique index exists on sync_jobs');

insert into public.sync_jobs (id, workspace_id, connection_id, kind)
values ('f00000d1-0000-4000-8000-000000000000', 'f00000a0-0000-4000-8000-000000000000', 'f00000a1-0000-4000-8000-000000000000', 'sync');

select throws_ok(
  $$
    insert into public.sync_jobs (workspace_id, connection_id, kind)
    values ('f00000a0-0000-4000-8000-000000000000', 'f00000a1-0000-4000-8000-000000000000', 'sync')
  $$,
  '23505'::char(5), null::text,
  'one open sync: a second queued sync for the same connection conflicts');
select throws_ok(
  $$
    insert into public.sync_jobs (workspace_id, connection_id, kind, status)
    values ('f00000a0-0000-4000-8000-000000000000', 'f00000a1-0000-4000-8000-000000000000', 'sync', 'running')
  $$,
  '23505'::char(5), null::text,
  'one open sync: a running sync alongside a queued one for the same connection conflicts');
select lives_ok(
  $$
    insert into public.sync_jobs (workspace_id, connection_id, kind)
    values ('f00000a0-0000-4000-8000-000000000000', 'f00000a1-0000-4000-8000-000000000000', 'daily_summary')
  $$,
  'one open sync: other job kinds for the same connection are not limited');

select is(public.enqueue_sync_job('f00000a0-0000-4000-8000-000000000000', 'f00000a1-0000-4000-8000-000000000000'), false,
  'one open sync: enqueue_sync_job returns false while a sync is already open');
select is(public.enqueue_sync_job('f00000b0-0000-4000-8000-000000000000', 'f00000a2-0000-4000-8000-000000000000'), false,
  'one open sync: enqueue_sync_job refuses a connection from another workspace');
select is(public.enqueue_sync_job('f00000a0-0000-4000-8000-000000000000', 'f00000a2-0000-4000-8000-000000000000'), true,
  'one open sync: enqueue_sync_job queues a sync for a connection with none open');
select is(public.request_manual_sync('f00000b0-0000-4000-8000-000000000000', 'f00000a1-0000-4000-8000-000000000000', 60), 'not_found',
  'one open sync: request_manual_sync reports not_found for a connection in another workspace');

update public.sync_jobs set status = 'succeeded', finished_at = now()
where id = 'f00000d1-0000-4000-8000-000000000000';

select lives_ok(
  $$
    insert into public.sync_jobs (workspace_id, connection_id, kind)
    values ('f00000a0-0000-4000-8000-000000000000', 'f00000a1-0000-4000-8000-000000000000', 'sync')
  $$,
  'one open sync: once the open sync finishes, a new one can be queued');

-- ---------------------------------------------------------------------------
-- oauth_states flow context columns.
-- ---------------------------------------------------------------------------
select has_column('public', 'oauth_states', 'pending_installation_id',
  'oauth_states: pending_installation_id exists');
select has_column('public', 'oauth_states', 'reconnect_connection_id',
  'oauth_states: reconnect_connection_id exists');

select is_empty(
  $$
    select r.role || ' ' || c.col || ' ' || p.priv
    from unnest(array['anon', 'authenticated']) as r(role)
    cross join unnest(array['pending_installation_id', 'reconnect_connection_id']) as c(col)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p(priv)
    where has_column_privilege(r.role, 'public.oauth_states', c.col, p.priv)
  $$,
  'oauth_states: anon and authenticated hold no privilege on the new columns (service role only)');

set local role authenticated;
set local request.jwt.claims to '{"sub": "f0000001-0000-4000-8000-000000000000", "role": "authenticated"}';

select throws_ok($$ select reconnect_connection_id, pending_installation_id from public.oauth_states $$,
  '42501'::char(5), null::text,
  'oauth_states: an authenticated owner cannot read the flow context columns');

reset role;
reset request.jwt.claims;

select throws_ok(
  $$
    insert into public.oauth_states (state, workspace_id, provider, user_id, expires_at, reconnect_connection_id)
    values ('rls-sync-cross-state', 'f00000b0-0000-4000-8000-000000000000', 'fake', 'f0000001-0000-4000-8000-000000000000',
            now() + interval '10 minutes', 'f00000a2-0000-4000-8000-000000000000')
  $$,
  '23503'::char(5), null::text,
  'oauth_states: reconnect_connection_id cannot point at a connection in another workspace');

select lives_ok(
  $$
    insert into public.oauth_states (state, workspace_id, provider, user_id, expires_at, reconnect_connection_id, pending_installation_id)
    values ('rls-sync-same-state', 'f00000a0-0000-4000-8000-000000000000', 'fake', 'f0000001-0000-4000-8000-000000000000',
            now() + interval '10 minutes', 'f00000a2-0000-4000-8000-000000000000', '12345678')
  $$,
  'oauth_states: reconnect_connection_id may point at a connection in its own workspace');

select throws_ok(
  $$
    insert into public.oauth_states (state, workspace_id, provider, user_id, expires_at, pending_installation_id)
    values ('rls-sync-bad-install', 'f00000a0-0000-4000-8000-000000000000', 'fake', 'f0000001-0000-4000-8000-000000000000',
            now() + interval '10 minutes', '123; drop table')
  $$,
  '23514'::char(5), null::text,
  'oauth_states: pending_installation_id must be digits only (untrusted callback input)');

delete from public.connections where id = 'f00000a2-0000-4000-8000-000000000000';

select is_empty(
  $$ select state from public.oauth_states where state = 'rls-sync-same-state' $$,
  'oauth_states: deleting the reconnected connection removes its pending state row');

-- ---------------------------------------------------------------------------
-- RLS stays on for every table after these migrations.
-- ---------------------------------------------------------------------------
select is_empty(
  $$
    select c.relname::text
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  $$,
  'rls enabled: no table in schema public has row level security disabled after the sync engine migrations');

select * from finish();

rollback;
