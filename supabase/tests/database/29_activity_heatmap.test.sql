-- Dashboard activity heatmap (20261114090000_activity_heatmap.sql): events per weekday and hour of
-- day in the asked time zone, by occurred_at, with the timeline's filters, type ids and severities
-- as alternatives, members only at every role, and nothing from another workspace.
begin;

create extension if not exists pgtap with schema extensions;

select plan(37);

-- Fixtures as postgres: workspace W with an owner, an admin, and a viewer; workspace W2 owned by
-- an outsider, which the viewer also belongs to, so every count below proves it reads only the
-- workspace asked for. W has a Vercel connection A with account XA and a GitHub connection B with
-- account XB. Times are UTC; the comments give Europe/London.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('d4140001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'heatmap-owner@example.com', '{"user_name": "heatmap-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('d4140002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'heatmap-admin@example.com', '{"user_name": "heatmap-admin"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('d4140003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'heatmap-viewer@example.com', '{"user_name": "heatmap-viewer"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('d4140004-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'heatmap-outsider@example.com', '{"user_name": "heatmap-outsider"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('d41400a0-0000-4000-8000-000000000000', 'Heatmap team', 'd4140001-0000-4000-8000-000000000000'),
  ('d41400c0-0000-4000-8000-000000000000', 'Other heatmap team', 'd4140004-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('d41400a0-0000-4000-8000-000000000000', 'd4140001-0000-4000-8000-000000000000', 'owner'),
  ('d41400a0-0000-4000-8000-000000000000', 'd4140002-0000-4000-8000-000000000000', 'admin'),
  ('d41400a0-0000-4000-8000-000000000000', 'd4140003-0000-4000-8000-000000000000', 'viewer'),
  ('d41400c0-0000-4000-8000-000000000000', 'd4140004-0000-4000-8000-000000000000', 'owner'),
  ('d41400c0-0000-4000-8000-000000000000', 'd4140003-0000-4000-8000-000000000000', 'viewer');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds, mode)
values
  ('d41400a1-0000-4000-8000-000000000000', 'd41400a0-0000-4000-8000-000000000000', 'vercel', 'active', 'Vercel heatmap', 3600, null),
  ('d41400b1-0000-4000-8000-000000000000', 'd41400a0-0000-4000-8000-000000000000', 'github', 'active', 'GitHub heatmap', 3600, null),
  ('d41400c1-0000-4000-8000-000000000000', 'd41400c0-0000-4000-8000-000000000000', 'stripe', 'active', 'Stripe heatmap', 3600, 'live');

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind)
values
  ('d41400a2-0000-4000-8000-000000000000', 'd41400a0-0000-4000-8000-000000000000', 'd41400a1-0000-4000-8000-000000000000', 'xa', 'Acme team', 'team'),
  ('d41400b2-0000-4000-8000-000000000000', 'd41400a0-0000-4000-8000-000000000000', 'd41400b1-0000-4000-8000-000000000000', 'xb', 'Acme org', 'organization');

-- Every row is inserted now, so created_at is the test's own clock and never the hour asserted:
-- the counts below can only come from occurred_at.
insert into public.activity_events (workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key)
values
  -- Before the window (Friday 2026-01-09 15:30 GMT): never counted from 2026-06-01.
  ('d41400a0-0000-4000-8000-000000000000', 'd41400b1-0000-4000-8000-000000000000', 'd41400b2-0000-4000-8000-000000000000',
   'github', 'github.stars.daily', 'info', 'Stars', '2026-01-09T15:30:00Z', 'heatmap-old-1'),
  -- Friday 2026-06-05: three deploys in 15:00 BST, the first exactly on a window start used below,
  -- and a failed production deploy in 16:00 BST.
  ('d41400a0-0000-4000-8000-000000000000', 'd41400a1-0000-4000-8000-000000000000', 'd41400a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2026-06-05T14:10:00Z', 'heatmap-fri-1'),
  ('d41400a0-0000-4000-8000-000000000000', 'd41400a1-0000-4000-8000-000000000000', 'd41400a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2026-06-05T14:20:00Z', 'heatmap-fri-2'),
  ('d41400a0-0000-4000-8000-000000000000', 'd41400a1-0000-4000-8000-000000000000', 'd41400a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2026-06-05T14:59:59.999999Z', 'heatmap-fri-3'),
  ('d41400a0-0000-4000-8000-000000000000', 'd41400a1-0000-4000-8000-000000000000', 'd41400a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.failed', 'critical', 'Deploy failed', '2026-06-05T15:00:00Z', 'heatmap-fri-4'),
  -- Saturday 2026-06-06 10:00 BST: StackDash's own sync failure, no provider and no account.
  ('d41400a0-0000-4000-8000-000000000000', 'd41400b1-0000-4000-8000-000000000000', null,
   null, 'stackdash.sync_failed', 'warning', 'Sync failed', '2026-06-06T09:00:00Z', 'heatmap-sat-1'),
  -- Sunday 2026-06-07 23:30 UTC is Monday 00:30 BST: the zone decides the weekday.
  ('d41400a0-0000-4000-8000-000000000000', 'd41400b1-0000-4000-8000-000000000000', 'd41400b2-0000-4000-8000-000000000000',
   'github', 'github.stars.milestone', 'success', 'Milestone', '2026-06-07T23:30:00Z', 'heatmap-mon-1'),
  -- Monday 2026-06-08 09:00 BST: critical, but not a failed type.
  ('d41400a0-0000-4000-8000-000000000000', 'd41400a1-0000-4000-8000-000000000000', 'd41400a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.domain.expired', 'critical', 'Domain expired', '2026-06-08T08:00:00Z', 'heatmap-mon-2'),
  -- Sunday 2026-10-25: London falls back at 01:00 UTC. 01:30 BST, then 01:30 GMT, both hour 1.
  ('d41400a0-0000-4000-8000-000000000000', 'd41400a1-0000-4000-8000-000000000000', 'd41400a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Clock change deploy', '2026-10-25T00:30:00Z', 'heatmap-autumn-1'),
  ('d41400a0-0000-4000-8000-000000000000', 'd41400a1-0000-4000-8000-000000000000', 'd41400a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Clock change deploy', '2026-10-25T01:30:00Z', 'heatmap-autumn-2'),
  -- W2: one Stripe event at the same moment as W's first Friday deploy, which no count for W may include.
  ('d41400c0-0000-4000-8000-000000000000', 'd41400c1-0000-4000-8000-000000000000', null,
   'stripe', 'stripe.charge.succeeded', 'success', 'Payment', '2026-06-05T14:10:00Z', 'heatmap-other-1');

select ok(
  not has_function_privilege('anon',
    'public.activity_heatmap(uuid, timestamptz, text, text[], public.event_severity[], public.provider_id[], uuid[])', 'execute'),
  'activity_heatmap: anon cannot execute it');
select ok(
  not has_function_privilege('service_role',
    'public.activity_heatmap(uuid, timestamptz, text, text[], public.event_severity[], public.provider_id[], uuid[])', 'execute'),
  'activity_heatmap: service_role cannot execute it');
select ok(
  has_function_privilege('authenticated',
    'public.activity_heatmap(uuid, timestamptz, text, text[], public.event_severity[], public.provider_id[], uuid[])', 'execute'),
  'activity_heatmap: authenticated can execute it');
select is(
  pg_get_function_result('public.activity_heatmap(uuid, timestamptz, text, text[], public.event_severity[], public.provider_id[], uuid[])'::regprocedure),
  'TABLE(isodow integer, hour integer, events bigint)',
  'activity_heatmap: returns isodow, hour, and events');
select ok(
  (select not p.prosecdef and p.proconfig = array['search_path=""', 'plan_cache_mode=force_custom_plan']::text[] collate "C"
   from pg_proc p
   where p.oid = 'public.activity_heatmap(uuid, timestamptz, text, text[], public.event_severity[], public.provider_id[], uuid[])'::regprocedure),
  'activity_heatmap: security invoker, with an empty search path and a plan per call');

-- ---------------------------------------------------------------------------
-- As a viewer of W (and of W2).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "d4140003-0000-4000-8000-000000000000", "role": "authenticated"}';

select results_eq(
  $$ select isodow, hour, events from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London') $$,
  $$ values (1, 0, 1::bigint), (1, 9, 1::bigint), (5, 15, 3::bigint), (5, 16, 1::bigint), (6, 10, 1::bigint), (7, 1, 2::bigint) $$,
  'activity_heatmap: counts every event since p_since by London weekday (1 is Monday) and hour, in order');

select is(
  (select sum(events)::int from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-01-01T00:00:00Z', 'Europe/London')),
  10,
  'activity_heatmap: an earlier p_since counts the older event too');

select is(
  (select events::int from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-05T14:10:00Z', 'Europe/London')
   where isodow = 5 and hour = 15),
  3,
  'activity_heatmap: p_since is inclusive');

select is(
  (select events::int from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-05T14:10:00.000001Z', 'Europe/London')
   where isodow = 5 and hour = 15),
  2,
  'activity_heatmap: an event a microsecond before p_since is left out');

select is(
  (select events::int from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-10-01T00:00:00Z', 'Europe/London')
   where isodow = 7 and hour = 1),
  2,
  'activity_heatmap: 01:30 BST and 01:30 GMT on the autumn clock change both count in hour 1');

-- A session time zone 5:30 from UTC proves the hour comes from p_time_zone, not the session.
set local timezone to 'Asia/Kolkata';
select results_eq(
  $$ select isodow, hour, events from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'UTC') $$,
  $$ values (1, 8, 1::bigint), (5, 14, 3::bigint), (5, 15, 1::bigint), (6, 9, 1::bigint), (7, 0, 1::bigint), (7, 1, 1::bigint), (7, 23, 1::bigint) $$,
  'activity_heatmap: in UTC the Sunday night event stays on Sunday and every hour moves, whatever the session zone');
reset timezone;

-- Filters.
select results_eq(
  $$ select isodow, hour, events from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London',
       p_type_ids => array['vercel.deployment.succeeded']) $$,
  $$ values (5, 15, 3::bigint), (7, 1, 2::bigint) $$,
  'activity_heatmap: p_type_ids counts only the listed types');

select results_eq(
  $$ select isodow, hour, events from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London',
       p_severities => array['critical']::public.event_severity[]) $$,
  $$ values (1, 9, 1::bigint), (5, 16, 1::bigint) $$,
  'activity_heatmap: p_severities counts only the listed severities');

select results_eq(
  $$ select isodow, hour, events from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London',
       p_type_ids => array['vercel.deployment.failed', 'stackdash.sync_failed'],
       p_severities => array['critical']::public.event_severity[]) $$,
  $$ values (1, 9, 1::bigint), (5, 16, 1::bigint), (6, 10, 1::bigint) $$,
  'activity_heatmap: types and severities are alternatives, and an event matching both counts once');

select results_eq(
  $$ select isodow, hour, events from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London',
       p_providers => array['github']::public.provider_id[]) $$,
  $$ values (1, 0, 1::bigint) $$,
  'activity_heatmap: p_providers counts only those providers and leaves out events with no provider');

select results_eq(
  $$ select isodow, hour, events from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London',
       p_account_ids => array['d41400a2-0000-4000-8000-000000000000']::uuid[]) $$,
  $$ values (1, 9, 1::bigint), (5, 15, 3::bigint), (5, 16, 1::bigint), (7, 1, 2::bigint) $$,
  'activity_heatmap: p_account_ids counts only those accounts and leaves out events with no account');

select is_empty(
  $$ select * from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London',
       p_account_ids => '{}'::uuid[]) $$,
  'activity_heatmap: an empty account list matches nothing');

select is(
  (select sum(events)::int from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London',
     p_type_ids => null, p_severities => null, p_providers => null)),
  9,
  'activity_heatmap: null type, severity, and provider lists mean every event, like empty ones');

select is_empty(
  $$ select * from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London',
       p_type_ids => array['github.release.published']) $$,
  'activity_heatmap: a type with no events returns no cells, not zero ones');

select is_empty(
  $$ select * from public.activity_heatmap('d41400ff-0000-4000-8000-000000000000', '2026-01-01T00:00:00Z', 'Europe/London') $$,
  'activity_heatmap: a workspace that does not exist returns no cells');

-- Bad arguments.
select throws_ok(
  $$ select * from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', null, 'Europe/London') $$,
  '22004',
  'p_since and p_time_zone are required',
  'activity_heatmap: a null p_since raises rather than counting everything');
select throws_ok(
  $$ select * from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', null) $$,
  '22004',
  'p_since and p_time_zone are required',
  'activity_heatmap: a null p_time_zone raises rather than bucketing into a null hour');
select throws_ok(
  $$ select * from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Mars/Olympus_Mons') $$,
  '22023',
  null,
  'activity_heatmap: an unknown time zone raises');

-- Tenant isolation from a member of both workspaces: each call counts only the asked workspace.
select results_eq(
  $$ select isodow, hour, events from public.activity_heatmap('d41400c0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London') $$,
  $$ values (5, 15, 1::bigint) $$,
  'activity_heatmap: tenant isolation: a member of both workspaces counts only W2''s event in W2');
select is(
  (select events::int from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London')
   where isodow = 5 and hour = 15),
  3,
  'activity_heatmap: tenant isolation: W2''s event at the same moment never counts in W');

-- ---------------------------------------------------------------------------
-- Role matrix: every member role reads the same counts.
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "d4140001-0000-4000-8000-000000000000", "role": "authenticated"}';
select is(
  (select sum(events)::int from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London')),
  9,
  'activity_heatmap: role matrix: the owner counts every event');
select is_empty(
  $$ select * from public.activity_heatmap('d41400c0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London') $$,
  'activity_heatmap: tenant isolation: W''s owner counts nothing in W2, where they are not a member');

set local request.jwt.claims to '{"sub": "d4140002-0000-4000-8000-000000000000", "role": "authenticated"}';
select is(
  (select sum(events)::int from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London')),
  9,
  'activity_heatmap: role matrix: an admin counts every event');
select is_empty(
  $$ select * from public.activity_heatmap('d41400c0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London') $$,
  'activity_heatmap: tenant isolation: W''s admin counts nothing in W2');

set local request.jwt.claims to '{"sub": "d4140003-0000-4000-8000-000000000000", "role": "authenticated"}';
select is(
  (select sum(events)::int from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London')),
  9,
  'activity_heatmap: role matrix: a viewer counts every event');

-- A removed viewer counts nothing on the next statement.
reset role;
delete from public.workspace_members
where workspace_id = 'd41400a0-0000-4000-8000-000000000000' and user_id = 'd4140003-0000-4000-8000-000000000000';
set local role authenticated;
select is_empty(
  $$ select * from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London') $$,
  'activity_heatmap: role matrix: a removed viewer counts nothing');
select is(
  (select sum(events)::int from public.activity_heatmap('d41400c0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London')),
  1,
  'activity_heatmap: role matrix: the removed viewer still counts the workspace they belong to');

-- ---------------------------------------------------------------------------
-- As someone outside W.
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "d4140004-0000-4000-8000-000000000000", "role": "authenticated"}';

select is_empty(
  $$ select * from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-01-01T00:00:00Z', 'Europe/London') $$,
  'activity_heatmap: tenant isolation: a non member counts nothing in W');
select is_empty(
  $$ select * from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-01-01T00:00:00Z', 'Europe/London',
       p_severities => array['critical']::public.event_severity[]) $$,
  'activity_heatmap: tenant isolation: a non member counts nothing with a filter either');
select is(
  (select sum(events)::int from public.activity_heatmap('d41400c0-0000-4000-8000-000000000000', '2026-06-01T00:00:00Z', 'Europe/London')),
  1,
  'activity_heatmap: the outsider still counts their own workspace');

-- A signed in caller with no workspace claim at all.
set local request.jwt.claims to '{"role": "authenticated"}';
select is_empty(
  $$ select * from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-01-01T00:00:00Z', 'Europe/London') $$,
  'activity_heatmap: a token with no user counts nothing');

-- ---------------------------------------------------------------------------
-- Signed out: no execute grant.
-- ---------------------------------------------------------------------------
reset request.jwt.claims;
set local role anon;

select throws_ok(
  $$ select * from public.activity_heatmap('d41400a0-0000-4000-8000-000000000000', '2026-01-01T00:00:00Z', 'Europe/London') $$,
  '42501',
  null,
  'activity_heatmap: anon is denied');

reset role;

select * from finish();
rollback;
