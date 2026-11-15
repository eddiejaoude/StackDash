-- Share surfaces (#149): the per IP rate limit counters are service only and store hashes, never
-- raw IPs; view counts are recorded only for live publications, are readable by members of their
-- workspace only, and follow the project; the purge functions delete by age in batches.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS); members are impersonated
-- through the same role and JWT claims PostgREST uses.
begin;

create extension if not exists pgtap with schema extensions;

select plan(27);

-- Users: the owner and a viewer of workspace A, and the owner of workspace B.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('a9000001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'share-owner-a@example.com', '{"user_name": "share-owner-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a9000001-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'share-viewer-a@example.com', '{"user_name": "share-viewer-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('b9000001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'share-owner-b@example.com', '{"user_name": "share-owner-b"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('a9000002-0000-4000-8000-000000000001', 'Share A', 'a9000001-0000-4000-8000-000000000001'),
  ('b9000002-0000-4000-8000-000000000001', 'Share B', 'b9000001-0000-4000-8000-000000000001');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000001', 'owner'),
  ('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000002', 'viewer'),
  ('b9000002-0000-4000-8000-000000000001', 'b9000001-0000-4000-8000-000000000001', 'owner');

insert into public.projects (id, workspace_id, name)
values
  ('a9000003-0000-4000-8000-000000000001', 'a9000002-0000-4000-8000-000000000001', 'Project A'),
  ('a9000003-0000-4000-8000-000000000002', 'a9000002-0000-4000-8000-000000000001', 'Project A2'),
  ('b9000003-0000-4000-8000-000000000001', 'b9000002-0000-4000-8000-000000000001', 'Project B');

select public.publish_metric('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
  'a9000001-0000-4000-8000-000000000001', 'github-stars', 'exact', 0::smallint, 'Published GitHub stars', null);
select public.publish_metric('b9000002-0000-4000-8000-000000000001', 'b9000003-0000-4000-8000-000000000001',
  'b9000001-0000-4000-8000-000000000001', 'github-stars', 'exact', 0::smallint, 'Published GitHub stars', null);

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
   where c.oid in ('public.public_rate_limit_counters'::regclass, 'public.published_metric_views'::regclass)),
  'share tables: row level security is on');
select ok(
  not has_table_privilege('anon', 'public.public_rate_limit_counters', 'select')
  and not has_table_privilege('authenticated', 'public.public_rate_limit_counters', 'select')
  and not has_table_privilege('authenticated', 'public.public_rate_limit_counters', 'insert'),
  'public_rate_limit_counters: closed to anon and authenticated');
select ok(
  not has_table_privilege('anon', 'public.published_metric_views', 'select')
  and has_table_privilege('authenticated', 'public.published_metric_views', 'select')
  and not has_table_privilege('authenticated', 'public.published_metric_views', 'insert')
  and not has_table_privilege('authenticated', 'public.published_metric_views', 'update')
  and not has_table_privilege('authenticated', 'public.published_metric_views', 'delete'),
  'published_metric_views: members may select (rows limited by the policy) and never write');

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
        (case when not has_function_privilege('service_role', p.oid, 'execute') then 'not executable by the service role' end)
    ) as v(problem)
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any (array[
        'bump_public_rate_limit', 'record_published_metric_view',
        'purge_public_rate_limit_counters', 'purge_published_metric_views'
      ])
      and v.problem is not null
  $$,
  'share functions: security definer, empty search_path, service role only');

select is(
  (select count(*)::int from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = any (array['bump_public_rate_limit', 'record_published_metric_view',
       'purge_public_rate_limit_counters', 'purge_published_metric_views'])),
  4,
  'share functions: all four exist, so the check above is not vacuous');

-- ---------------------------------------------------------------------------
-- Rate limit counters
-- ---------------------------------------------------------------------------
select is(public.bump_public_rate_limit(repeat('a', 64)), 1, 'bump_public_rate_limit: the first request in a minute counts 1');
select is(public.bump_public_rate_limit(repeat('a', 64)), 2, 'bump_public_rate_limit: the next one in the same minute counts 2');
select is(public.bump_public_rate_limit(repeat('b', 64)), 1, 'bump_public_rate_limit: another IP hash has its own count');

select throws_ok($$ select public.bump_public_rate_limit('203.0.113.7') $$, '23514', null,
  'bump_public_rate_limit: a raw IP address is refused, only a SHA-256 hex digest is stored');
select throws_ok($$ select public.bump_public_rate_limit(repeat('A', 64)) $$, '23514', null,
  'bump_public_rate_limit: an uppercase digest is refused (boundary: one canonical form per IP)');

-- Last minute's window is a different row, so a new minute starts again from 1.
insert into public.public_rate_limit_counters (ip_hash, window_start, count)
values (repeat('c', 64), date_trunc('minute', now()) - interval '1 minute', 500);
select is(public.bump_public_rate_limit(repeat('c', 64)), 1, 'bump_public_rate_limit: a new minute starts from 1 (boundary: window edge)');

-- ---------------------------------------------------------------------------
-- View counts
-- ---------------------------------------------------------------------------
select public.record_published_metric_view('a9000003-0000-4000-8000-000000000001', 'github-stars', 'badge');
select public.record_published_metric_view('a9000003-0000-4000-8000-000000000001', 'github-stars', 'badge');
select public.record_published_metric_view('a9000003-0000-4000-8000-000000000001', 'github-stars', 'card');

select results_eq(
  $$
    select workspace_id, surface::text, views, view_date
    from public.published_metric_views
    where project_id = 'a9000003-0000-4000-8000-000000000001'
    order by surface
  $$,
  $$ values
    ('a9000002-0000-4000-8000-000000000001'::uuid, 'badge'::text, 2, (now() at time zone 'utc')::date),
    ('a9000002-0000-4000-8000-000000000001'::uuid, 'card'::text, 1, (now() at time zone 'utc')::date)
  $$,
  'record_published_metric_view: one row per surface and UTC day, counted up, in the publication''s workspace');

select public.record_published_metric_view('a9000003-0000-4000-8000-000000000001', 'supabase-signups-7d', 'badge');
select public.record_published_metric_view('a9000003-0000-4000-8000-000000000002', 'github-stars', 'badge');
select public.record_published_metric_view('a9000004-0000-4000-8000-000000000009', 'github-stars', 'badge');
select is(
  (select count(*)::int from public.published_metric_views
   where metric_id = 'supabase-signups-7d'
      or project_id in ('a9000003-0000-4000-8000-000000000002', 'a9000004-0000-4000-8000-000000000009')),
  0,
  'record_published_metric_view: an unpublished metric, a project with nothing published, and an unknown project record nothing');

-- Unpublishing stops the count; the counted days stay for the owner.
select public.unpublish_all_metrics('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000001');
select public.record_published_metric_view('a9000003-0000-4000-8000-000000000001', 'github-stars', 'badge');
select is(
  (select views from public.published_metric_views
   where project_id = 'a9000003-0000-4000-8000-000000000001' and surface = 'badge'),
  2,
  'record_published_metric_view: a revoked publication is not counted, earlier counts stay');

select public.record_published_metric_view('b9000003-0000-4000-8000-000000000001', 'github-stars', 'badge');

-- ---------------------------------------------------------------------------
-- Reading counts through the Data API
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a9000001-0000-4000-8000-000000000002", "role": "authenticated"}';

select is(
  (select count(*)::int from public.published_metric_views),
  2,
  'published_metric_views: a viewer reads the counts of their own workspace only');
select is(
  (select count(*)::int from public.published_metric_views where workspace_id = 'b9000002-0000-4000-8000-000000000001'),
  0,
  'published_metric_views: a member of A reads nothing of B');
select throws_ok(
  $$ insert into public.published_metric_views (workspace_id, project_id, metric_id, surface, view_date)
     values ('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001', 'github-stars', 'badge', current_date - 1) $$,
  '42501', null,
  'published_metric_views: a member cannot write a count');
select throws_ok($$ select public.record_published_metric_view('a9000003-0000-4000-8000-000000000001', 'github-stars', 'badge') $$,
  '42501', null,
  'record_published_metric_view: a member cannot call it');
select throws_ok($$ select public.bump_public_rate_limit(repeat('d', 64)) $$, '42501', null,
  'bump_public_rate_limit: a member cannot call it');

set local request.jwt.claims to '{"sub": "b9000001-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  (select count(*)::int from public.published_metric_views),
  1,
  'published_metric_views: the owner of B reads only B''s counts');

reset role;
reset request.jwt.claims;

set local role anon;
select throws_ok($$ select views from public.published_metric_views $$, '42501', null,
  'published_metric_views: anon cannot read counts');
select throws_ok($$ select count from public.public_rate_limit_counters $$, '42501', null,
  'public_rate_limit_counters: anon cannot read counters');
reset role;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
insert into public.published_metric_views (workspace_id, project_id, metric_id, surface, view_date, views)
values
  ('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001', 'github-stars', 'badge', date '2025-01-01', 4),
  ('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001', 'github-stars', 'badge', date '2025-01-02', 4);

select is(public.purge_published_metric_views(date '2025-01-02', 100), 1,
  'purge_published_metric_views: deletes days strictly before the cutoff (boundary: the cutoff day stays)');

-- Windows far in the past put these ahead of any counter the app or an e2e run left on this
-- database, and a cutoff just as old reaches none of those. Two are due, so the batch of 1 is
-- a real limit.
insert into public.public_rate_limit_counters (ip_hash, window_start)
values
  (repeat('e', 64), timestamptz '1970-01-01 00:00:00+00'),
  (repeat('e', 64), timestamptz '1970-01-01 00:01:00+00'),
  (repeat('e', 64), timestamptz '1970-01-01 00:02:00+00');

select is(public.purge_public_rate_limit_counters(timestamptz '1970-01-01 00:02:00+00', 1), 1,
  'purge_public_rate_limit_counters: deletes at most p_limit rows (boundary: a batch of 1 with two rows due)');
select is(public.purge_public_rate_limit_counters(timestamptz '1970-01-01 00:02:00+00', 100), 1,
  'purge_public_rate_limit_counters: deletes windows strictly before the cutoff (boundary: the cutoff minute stays)');
select throws_ok($$ select public.purge_published_metric_views(current_date, 0) $$, '22023', null,
  'purge_published_metric_views: a limit below 1 is refused');

-- Deleting the project deletes its counts.
delete from public.projects where id = 'a9000003-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.published_metric_views where project_id = 'a9000003-0000-4000-8000-000000000001'),
  0,
  'published_metric_views: deleting the project deletes its counts');

select * from finish();
rollback;
