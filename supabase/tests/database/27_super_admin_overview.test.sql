-- Super admin figures (20261112101200_super_admin_overview.sql): service role only, instance-wide
-- counts that only count what they say, workspace pages that are bounded and resume after a
-- cursor, and job health per kind. Totals and provider rows are compared with a snapshot taken
-- before the fixtures, because the seed and earlier files may leave rows of their own.
begin;

create extension if not exists pgtap with schema extensions;

select plan(21);

-- ---------------------------------------------------------------------------
-- Shape: security definer, empty search_path, service role only.
-- ---------------------------------------------------------------------------
create temp table admin_functions (signature text primary key) on commit drop;
insert into admin_functions values
  ('public.admin_instance_totals()'),
  ('public.admin_workspace_stats(integer, timestamptz, uuid)'),
  ('public.admin_provider_usage()'),
  ('public.admin_job_health()'),
  ('public.admin_job_failures()'),
  ('public.admin_latest_migration()');

select is(
  (select count(*)::int from admin_functions f join pg_catalog.pg_proc p on p.oid = f.signature::regprocedure
   where p.prosecdef and coalesce(p.proconfig && array['search_path=""', 'search_path='], false)),
  6,
  'admin functions: every one is security definer with an empty search_path');
select is(
  (select count(*)::int from admin_functions f where has_function_privilege('service_role', f.signature, 'execute')),
  6,
  'admin functions: the service role can execute every one');
select is(
  (select count(*)::int from admin_functions f where has_function_privilege('authenticated', f.signature, 'execute')),
  0,
  'admin functions: a signed-in user can execute none, whatever their workspace role');
select is(
  (select count(*)::int from admin_functions f where has_function_privilege('anon', f.signature, 'execute')),
  0,
  'admin functions: anon can execute none');

-- ---------------------------------------------------------------------------
-- Fixtures. Each new user also gets a personal workspace and its owner membership from
-- handle_auth_user_created.
-- ---------------------------------------------------------------------------
create temp table totals_before on commit drop as select * from public.admin_instance_totals();
create temp table providers_before on commit drop as select * from public.admin_provider_usage();

-- U1 is new and signed in today. U2 joined 40 days ago and last signed in then.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, last_sign_in_at)
values
  ('a2500001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin-one@example.com', '{"user_name": "admin-one"}', '{"provider": "github", "providers": ["github"]}', now(), now(), now()),
  ('a2500002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin-two@example.com', '{"user_name": "admin-two"}', '{"provider": "github", "providers": ["github"]}',
   now() - interval '40 days', now() - interval '40 days', now() - interval '40 days');

-- W, a shared workspace created 20 days ago with both users.
insert into public.workspaces (id, name, created_by, created_at)
values ('a25000a0-0000-4000-8000-000000000000', 'Admin team', 'a2500001-0000-4000-8000-000000000000', now() - interval '20 days');
insert into public.workspace_members (workspace_id, user_id, role)
values
  ('a25000a0-0000-4000-8000-000000000000', 'a2500001-0000-4000-8000-000000000000', 'owner'),
  ('a25000a0-0000-4000-8000-000000000000', 'a2500002-0000-4000-8000-000000000000', 'viewer');

-- W: Vercel active and revoked, GitHub needing attention. U1's personal workspace: Vercel active.
-- U2's personal workspace: only a revoked Vercel connection, so it does not use Vercel any more.
insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
select v.id, v.workspace_id, v.provider::public.provider_id, v.status::public.connection_status, v.display_name, 3600
from (values
  ('a25000a1-0000-4000-8000-000000000000'::uuid, 'a25000a0-0000-4000-8000-000000000000'::uuid, 'vercel', 'active', 'Vercel'),
  ('a25000a2-0000-4000-8000-000000000000'::uuid, 'a25000a0-0000-4000-8000-000000000000'::uuid, 'vercel', 'revoked', 'Old Vercel'),
  ('a25000a3-0000-4000-8000-000000000000'::uuid, 'a25000a0-0000-4000-8000-000000000000'::uuid, 'github', 'needs_attention', 'GitHub')
) as v (id, workspace_id, provider, status, display_name);
insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
select 'a25000b1-0000-4000-8000-000000000000', w.id, 'vercel', 'active', 'Personal Vercel', 3600
from public.workspaces w where w.created_by = 'a2500001-0000-4000-8000-000000000000' and w.is_personal;
insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
select 'a25000c1-0000-4000-8000-000000000000', w.id, 'vercel', 'revoked', 'Gone Vercel', 3600
from public.workspaces w where w.created_by = 'a2500002-0000-4000-8000-000000000000' and w.is_personal;

-- W: three events on two days.
insert into public.activity_events (workspace_id, connection_id, provider, type_id, severity, title, occurred_at, dedupe_key)
values
  ('a25000a0-0000-4000-8000-000000000000', 'a25000a1-0000-4000-8000-000000000000', 'vercel', 'vercel.deployment_ready', 'info', 'Deployed', '2026-11-01T10:00:00Z', 'admin-1'),
  ('a25000a0-0000-4000-8000-000000000000', 'a25000a1-0000-4000-8000-000000000000', 'vercel', 'vercel.deployment_ready', 'info', 'Deployed', '2026-11-01T11:00:00Z', 'admin-2'),
  ('a25000a0-0000-4000-8000-000000000000', null, null, 'stackdash.daily_summary', 'info', 'Daily summary', '2026-11-02T08:00:00Z', 'admin-3');

-- ---------------------------------------------------------------------------
-- Totals: the change the fixtures made, field by field.
-- ---------------------------------------------------------------------------
select results_eq(
  $$
    select a.users - b.users, a.users_new_7d - b.users_new_7d, a.users_new_30d - b.users_new_30d,
           a.users_signed_in_30d - b.users_signed_in_30d
    from public.admin_instance_totals() a, totals_before b
  $$,
  $$ values (2::bigint, 1::bigint, 1::bigint, 1::bigint) $$,
  'admin_instance_totals: users count everyone, new users only inside the window, and active users by last sign-in');

select results_eq(
  $$
    select a.workspaces - b.workspaces, a.workspaces_new_7d - b.workspaces_new_7d,
           a.workspaces_new_30d - b.workspaces_new_30d, a.memberships - b.memberships
    from public.admin_instance_totals() a, totals_before b
  $$,
  $$ values (3::bigint, 2::bigint, 3::bigint, 4::bigint) $$,
  'admin_instance_totals: two personal workspaces today and one shared 20 days ago, with four memberships');

select results_eq(
  $$
    select a.connections - b.connections, a.events - b.events
    from public.admin_instance_totals() a, totals_before b
  $$,
  $$ values (3::bigint, 3::bigint) $$,
  'admin_instance_totals: revoked connections are not counted, and every event is');

-- ---------------------------------------------------------------------------
-- Per workspace.
-- ---------------------------------------------------------------------------
-- The cursor (W's created_at, the largest id) puts W first on the page, so this also proves rows
-- with the cursor's created_at and a smaller id come next.
select results_eq(
  $$
    select workspace_id, name, is_personal, members, connections, events
    from public.admin_workspace_stats(1,
      (select created_at from public.workspaces where id = 'a25000a0-0000-4000-8000-000000000000'),
      'ffffffff-ffff-4fff-bfff-ffffffffffff')
  $$,
  $$ values ('a25000a0-0000-4000-8000-000000000000'::uuid, 'Admin team'::text, false, 2::bigint, 2::bigint, 3::bigint) $$,
  'admin_workspace_stats: members, connections that are not revoked, and stored events of one workspace');

select is_empty(
  $$
    select * from public.admin_workspace_stats(100,
      (select created_at from public.workspaces where id = 'a25000a0-0000-4000-8000-000000000000'),
      'a25000a0-0000-4000-8000-000000000000')
    where workspace_id = 'a25000a0-0000-4000-8000-000000000000'
  $$,
  'admin_workspace_stats: the page after a cursor never repeats the cursor row');

select is(
  (select count(*)::int from (
     select s.created_at, s.workspace_id,
            lag(s.created_at) over () as previous_created_at, lag(s.workspace_id) over () as previous_id
     from public.admin_workspace_stats(100) s
   ) page
   where page.previous_id is not null and (page.created_at, page.workspace_id) >= (page.previous_created_at, page.previous_id)),
  0,
  'admin_workspace_stats: rows come newest first, ties broken by id, so the last row is a cursor for the next page');

select is((select count(*)::int from public.admin_workspace_stats(0)), 1, 'admin_workspace_stats: a page size of zero is raised to one');
select is((select count(*)::int from public.admin_workspace_stats(null)), 1, 'admin_workspace_stats: a missing page size is one');
select is(
  (select count(*)::int from public.admin_workspace_stats(1000)),
  (select least(count(*), 100)::int from public.workspaces),
  'admin_workspace_stats: a page size over 100 is lowered to 100');

-- ---------------------------------------------------------------------------
-- Providers: the change the fixtures made.
-- ---------------------------------------------------------------------------
select results_eq(
  $$
    select a.provider::text,
           a.workspaces - coalesce(b.workspaces, 0), a.active - coalesce(b.active, 0),
           a.needs_attention - coalesce(b.needs_attention, 0), a.revoked - coalesce(b.revoked, 0)
    from public.admin_provider_usage() a
    left join providers_before b on b.provider = a.provider
    where a.provider in ('vercel', 'github')
    order by a.provider::text
  $$,
  $$ values ('github'::text, 1::bigint, 0::bigint, 1::bigint, 0::bigint), ('vercel'::text, 2::bigint, 2::bigint, 0::bigint, 2::bigint) $$,
  'admin_provider_usage: a workspace counts once per provider, and one with only revoked connections not at all');

-- ---------------------------------------------------------------------------
-- Jobs. Cleared inside this transaction (rolled back below) so the expectations are exact.
-- ---------------------------------------------------------------------------
delete from public.sync_jobs;

insert into public.sync_jobs (kind, status, run_after, locked_until, finished_at, error_code)
values
  ('retention', 'queued', now() - interval '1 hour', null, null, null),
  ('retention', 'queued', now() + interval '1 hour', null, null, null),
  ('retention', 'queued', now() - interval '2 hours', null, null, 'timeout'),
  ('retention', 'running', now() - interval '3 hours', now() - interval '1 minute', null, null),
  ('retention', 'running', now() - interval '3 hours', now() + interval '1 minute', null, null),
  ('retention', 'succeeded', now() - interval '2 hours', null, now() - interval '1 hour', null),
  ('retention', 'succeeded', now() - interval '3 days', null, now() - interval '2 days', null),
  ('retention', 'failed', now() - interval '2 hours', null, now() - interval '90 minutes', 'rate_limited'),
  ('retention', 'failed', now() - interval '3 hours', null, now() - interval '2 hours', 'rate_limited'),
  ('retention', 'failed', now() - interval '4 hours', null, now() - interval '3 hours', null),
  ('retention', 'failed', now() - interval '4 days', null, now() - interval '3 days', 'timeout');

select results_eq(
  $$
    select kind::text, queued, due, retrying, running, stale, succeeded_24h, failed_24h,
           oldest_due_at = now() - interval '2 hours', last_finished_at = now() - interval '1 hour'
    from public.admin_job_health()
  $$,
  $$ values ('retention'::text, 3::bigint, 2::bigint, 1::bigint, 2::bigint, 1::bigint, 1::bigint, 3::bigint, true, true) $$,
  'admin_job_health: due excludes future runs, stale is a running job past its lease, and the 24 hour counts drop older jobs');

select results_eq(
  $$ select kind::text, error_code, failures, last_failed_at = now() - interval '90 minutes' from public.admin_job_failures() $$,
  $$ values ('retention'::text, 'rate_limited'::text, 2::bigint, true), ('retention'::text, 'unknown'::text, 1::bigint, false) $$,
  'admin_job_failures: failures in the last 24 hours by code, most frequent first, a missing code as unknown');

select is_empty(
  $$ select * from public.admin_job_failures() where error_code = 'timeout' $$,
  'admin_job_failures: a failure older than 24 hours and a retry still queued are not failures today');

delete from public.sync_jobs;
select is_empty($$ select * from public.admin_job_health() $$, 'admin_job_health: no jobs means no rows');

-- ---------------------------------------------------------------------------
-- Deployment.
-- ---------------------------------------------------------------------------
select matches(
  public.admin_latest_migration(),
  '^[0-9]{14}$',
  'admin_latest_migration: the newest version the CLI recorded');

-- ---------------------------------------------------------------------------
-- As a signed-in workspace owner: no access.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a2500001-0000-4000-8000-000000000000", "role": "authenticated"}';

select throws_ok(
  $$ select * from public.admin_instance_totals() $$,
  '42501',
  null,
  'admin_instance_totals: a workspace owner is refused');
select throws_ok(
  $$ select * from public.admin_workspace_stats(10) $$,
  '42501',
  null,
  'admin_workspace_stats: a workspace owner is refused');

reset request.jwt.claims;
reset role;

select * from finish();
rollback;
