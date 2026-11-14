-- Published metrics (#148): tenant isolation through the Data API, the role check in every
-- publish function, the public read function returning live rows only, the publishable id list,
-- the audit events, unpublish everything, account deletion, and the cap on live self-reported
-- values per project (#220).
-- Rows are seeded as postgres (the migration owner, which bypasses RLS); members are impersonated
-- through the same role and JWT claims PostgREST uses.
begin;

create extension if not exists pgtap with schema extensions;

select plan(55);

-- Test helper, rolled back with the transaction: rows a statement touched as the current role, or
-- -1 when Postgres refuses it (42501). A refused write is any result <= 0.
create schema rls_test;
grant usage on schema rls_test to anon, authenticated;

create function rls_test.affected(p_sql text)
returns integer
language plpgsql
as $fn$
declare
  v_count integer;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
exception
  when insufficient_privilege then
    return -1;
end;
$fn$;

grant execute on function rls_test.affected(text) to anon, authenticated;

-- Users: an owner, an admin, and a viewer of workspace A, and the owner of workspace B.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('a8000001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pm-owner-a@example.com', '{"user_name": "pm-owner-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a8000001-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pm-admin-a@example.com', '{"user_name": "pm-admin-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a8000001-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pm-viewer-a@example.com', '{"user_name": "pm-viewer-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('b8000001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pm-owner-b@example.com', '{"user_name": "pm-owner-b"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('a8000002-0000-4000-8000-000000000001', 'Published A', 'a8000001-0000-4000-8000-000000000001'),
  ('b8000002-0000-4000-8000-000000000001', 'Published B', 'b8000001-0000-4000-8000-000000000001');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('a8000002-0000-4000-8000-000000000001', 'a8000001-0000-4000-8000-000000000001', 'owner'),
  ('a8000002-0000-4000-8000-000000000001', 'a8000001-0000-4000-8000-000000000002', 'admin'),
  ('a8000002-0000-4000-8000-000000000001', 'a8000001-0000-4000-8000-000000000003', 'viewer'),
  ('b8000002-0000-4000-8000-000000000001', 'b8000001-0000-4000-8000-000000000001', 'owner');

insert into public.projects (id, workspace_id, name)
values
  ('a8000003-0000-4000-8000-000000000001', 'a8000002-0000-4000-8000-000000000001', 'Project A'),
  ('a8000003-0000-4000-8000-000000000002', 'a8000002-0000-4000-8000-000000000001', 'Project A2'),
  ('b8000003-0000-4000-8000-000000000001', 'b8000002-0000-4000-8000-000000000001', 'Project B');

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------
select ok((select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.published_metrics'::regclass),
  'published_metrics: row level security is on');
select ok(not has_table_privilege('anon', 'public.published_metrics', 'select'),
  'published_metrics: anon cannot select');
select ok(has_table_privilege('authenticated', 'public.published_metrics', 'select'),
  'published_metrics: authenticated can select (rows limited by the policy)');
select ok(
  not has_table_privilege('authenticated', 'public.published_metrics', 'insert')
  and not has_table_privilege('authenticated', 'public.published_metrics', 'update')
  and not has_table_privilege('authenticated', 'public.published_metrics', 'delete'),
  'published_metrics: authenticated has no insert, update, or delete privilege');

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
        (case when has_function_privilege('authenticated', p.oid, 'execute') then 'executable by authenticated' end)
    ) as v(problem)
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any (array[
        'publish_metric', 'publish_self_reported_metric', 'unpublish_metric', 'unpublish_all_metrics',
        'public_published_metrics', 'require_published_metrics_admin', 'record_publication_event'
      ])
      and v.problem is not null
  $$,
  'published metric functions: security definer, empty search_path, closed to anon and authenticated');

select ok(
  has_function_privilege('service_role', 'public.publish_metric(uuid, uuid, uuid, public.public_metric_id, public.published_metric_rounding, smallint, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.publish_self_reported_metric(uuid, uuid, uuid, text, bigint, text, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.unpublish_metric(uuid, uuid, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.unpublish_all_metrics(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.public_published_metrics(uuid)', 'execute'),
  'published metric functions: the service role can call every one the server uses');

-- Spend, budgets, and alert thresholds have no metric id.
select throws_ok($$ select 'github-spend-actions'::public.public_metric_id $$, '22P02', null,
  'public_metric_id: a spend id is not a value of the enum');
select throws_ok($$ select 'budget'::public.public_metric_id $$, '22P02', null,
  'public_metric_id: a budget id is not a value of the enum');
select ok(
  not exists (
    select 1 from unnest(enum_range(null::public.public_metric_id)) as id
    where id::text ~ '(spend|budget|alert|revenue|fee|cost|amount)'
  ),
  'public_metric_id: no value names spend, budgets, alerts, revenue, fees, or amounts');

-- ---------------------------------------------------------------------------
-- Publishing through the functions
-- ---------------------------------------------------------------------------
select is(
  public.publish_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001',
    'a8000001-0000-4000-8000-000000000001', 'github-stars', 'exact', 0::smallint, 'Published GitHub stars', 'Project Project A. Exact, current.'),
  'published',
  'publish_metric: an owner publishes a metric');

select is(
  (select count(*)::int from public.activity_events
   where workspace_id = 'a8000002-0000-4000-8000-000000000001' and type_id = 'devmacro.metric_published'
     and title = 'Published GitHub stars' and provider is null),
  1,
  'publish_metric: the audit event is in the timeline, as a DevMacro event');

select is(
  public.publish_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001',
    'a8000001-0000-4000-8000-000000000002', 'github-stars', 'exact', 0::smallint, 'Published GitHub stars', null),
  'unchanged',
  'publish_metric: publishing again with the same options changes nothing');

select is(
  (select count(*)::int from public.activity_events
   where workspace_id = 'a8000002-0000-4000-8000-000000000001' and type_id = 'devmacro.metric_published'),
  1,
  'publish_metric: an unchanged publish writes no second event');

select is(
  public.publish_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001',
    'a8000001-0000-4000-8000-000000000002', 'github-stars', 'hundreds', 7::smallint, 'Published GitHub stars', null),
  'published',
  'publish_metric: an admin republishes with other options');

select results_eq(
  $$
    select rounding::text, delay_days::int, (revoked_at is null)
    from public.published_metrics
    where project_id = 'a8000003-0000-4000-8000-000000000001' and metric_id = 'github-stars'
    order by published_at, (revoked_at is null)
  $$,
  $$ values ('exact'::text, 0, false), ('hundreds'::text, 7, true) $$,
  'publish_metric: new options revoke the old row and keep it as history, one live row');

select throws_ok(
  $$ select public.publish_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001',
       'a8000001-0000-4000-8000-000000000003', 'supabase-signups-7d', 'exact', 0::smallint, 't', null) $$,
  '42501', null,
  'publish_metric: a viewer cannot publish');

select throws_ok(
  $$ select public.publish_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001',
       'b8000001-0000-4000-8000-000000000001', 'supabase-signups-7d', 'exact', 0::smallint, 't', null) $$,
  '42501', null,
  'publish_metric: an owner of another workspace cannot publish here');

select is(
  public.publish_metric('a8000002-0000-4000-8000-000000000001', 'b8000003-0000-4000-8000-000000000001',
    'a8000001-0000-4000-8000-000000000001', 'supabase-signups-7d', 'exact', 0::smallint, 't', null),
  'not_found',
  'publish_metric: another workspace''s project is not found');

select throws_ok(
  $$ select public.publish_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001',
       'a8000001-0000-4000-8000-000000000001', 'supabase-signups-7d', 'exact', 3::smallint, 't', null) $$,
  '23514', null,
  'publish_metric: a delay other than 0 or 7 days is refused');

select is(
  public.publish_self_reported_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001',
    'a8000001-0000-4000-8000-000000000001', ' Downloads ', 4200, 'downloads', 'Published Downloads (self-reported)',
    'Project Acme web. 4,200 downloads.'),
  'published',
  'publish_self_reported_metric: an owner publishes a self-reported value');

select is(
  (select body from public.activity_events
   where workspace_id = 'a8000002-0000-4000-8000-000000000001' and type_id = 'devmacro.metric_published'
     and title = 'Published Downloads (self-reported)'),
  'Project Acme web. 4,200 downloads.',
  'publish_self_reported_metric: the audit event names the project and the value');

select is(
  public.publish_self_reported_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001',
    'a8000001-0000-4000-8000-000000000001', 'DOWNLOADS', 1, 'downloads', 't', null),
  'duplicate',
  'publish_self_reported_metric: a second live value with the same name, ignoring case and spaces, is refused');

select throws_ok(
  $$ insert into public.published_metrics (workspace_id, project_id, metric_id, self_reported_label, self_reported_value, self_reported_unit, published_by)
     values ('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001', 'github-stars', 'Stars', 5, 'stars',
             'a8000001-0000-4000-8000-000000000001') $$,
  '23514', null,
  'published_metrics_source: a row cannot be an engine metric and a self-reported value at once');

select throws_ok(
  $$ select public.publish_self_reported_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001',
       'a8000001-0000-4000-8000-000000000001', 'Rating', -1, 'points', 't', null) $$,
  '23514', null,
  'published_metrics_source: a negative self-reported value is refused');

-- ---------------------------------------------------------------------------
-- Tenant isolation through the normal client
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a8000001-0000-4000-8000-000000000003", "role": "authenticated"}';

select is(
  (select count(*)::int from public.published_metrics where workspace_id = 'a8000002-0000-4000-8000-000000000001'),
  3,
  'tenant isolation control: a viewer of workspace A sees its rows, history included');

set local request.jwt.claims to '{"sub": "b8000001-0000-4000-8000-000000000001", "role": "authenticated"}';

select is_empty(
  $$ select id from public.published_metrics where workspace_id = 'a8000002-0000-4000-8000-000000000001' $$,
  'tenant isolation: a member of workspace B cannot select workspace A''s published rows');
select ok(
  rls_test.affected($$ update public.published_metrics set revoked_at = now() where workspace_id = 'a8000002-0000-4000-8000-000000000001' $$) <= 0,
  'tenant isolation: a member of workspace B cannot revoke workspace A''s rows');
select ok(
  rls_test.affected($$ delete from public.published_metrics where workspace_id = 'a8000002-0000-4000-8000-000000000001' $$) <= 0,
  'tenant isolation: a member of workspace B cannot delete workspace A''s rows');
select ok(
  rls_test.affected($$ insert into public.published_metrics (workspace_id, project_id, metric_id, published_by)
                       values ('b8000002-0000-4000-8000-000000000001', 'b8000003-0000-4000-8000-000000000001', 'github-stars',
                               'b8000001-0000-4000-8000-000000000001') $$) <= 0,
  'role matrix: even an owner cannot insert through the Data API');
select throws_ok(
  $$ select * from public.public_published_metrics('a8000003-0000-4000-8000-000000000001') $$,
  '42501', null,
  'public_published_metrics: a signed-in member of another workspace cannot call it');

set local request.jwt.claims to '{"sub": "a8000001-0000-4000-8000-000000000001", "role": "authenticated"}';

select ok(
  rls_test.affected($$ update public.published_metrics set revoked_at = now() where workspace_id = 'a8000002-0000-4000-8000-000000000001' $$) <= 0,
  'role matrix: even the owner cannot revoke through the Data API (the functions write the audit event)');
select throws_ok(
  $$ select public.unpublish_all_metrics('a8000002-0000-4000-8000-000000000001', 'a8000001-0000-4000-8000-000000000001') $$,
  '42501', null,
  'unpublish_all_metrics: not callable through the Data API, even by the owner');

reset role;
reset request.jwt.claims;

set local role anon;
select throws_ok($$ select id from public.published_metrics $$, '42501', null,
  'anon: cannot read published_metrics directly');
select throws_ok($$ select * from public.public_published_metrics('a8000003-0000-4000-8000-000000000001') $$, '42501', null,
  'anon: cannot call public_published_metrics; the public route calls it on the server');
reset role;

-- ---------------------------------------------------------------------------
-- The public read: live rows only
-- ---------------------------------------------------------------------------
set local role service_role;

select results_eq(
  $$ select coalesce(metric_id::text, self_reported_label), rounding::text, delay_days::int
     from public.public_published_metrics('a8000003-0000-4000-8000-000000000001') order by 1 $$,
  $$ values ('Downloads'::text, 'exact'::text, 0), ('github-stars'::text, 'hundreds'::text, 7) $$,
  'public_published_metrics: returns the project''s live rows, not the revoked history');
select is_empty(
  $$ select id from public.public_published_metrics('b8000003-0000-4000-8000-000000000001') $$,
  'public_published_metrics: a project with nothing published returns nothing');

reset role;

select is(
  public.unpublish_metric('a8000002-0000-4000-8000-000000000001',
    (select id from public.published_metrics where metric_id = 'github-stars' and revoked_at is null),
    'a8000001-0000-4000-8000-000000000002', 'Unpublished GitHub stars'),
  'unpublished',
  'unpublish_metric: an admin unpublishes a metric');
select is(
  (select count(*)::int from public.activity_events
   where workspace_id = 'a8000002-0000-4000-8000-000000000001' and type_id = 'devmacro.metric_unpublished'
     and title = 'Unpublished GitHub stars'),
  1,
  'unpublish_metric: the audit event is in the timeline');
select is(
  public.unpublish_metric('a8000002-0000-4000-8000-000000000001',
    (select id from public.published_metrics where metric_id = 'github-stars' order by published_at desc limit 1),
    'a8000001-0000-4000-8000-000000000002', 't'),
  'not_found',
  'unpublish_metric: an already revoked row is not found');
select is(
  public.unpublish_metric('b8000002-0000-4000-8000-000000000001',
    (select id from public.published_metrics where self_reported_label = 'Downloads'),
    'b8000001-0000-4000-8000-000000000001', 't'),
  'not_found',
  'unpublish_metric: another workspace''s row is not found, the same answer as a missing one');

set local role service_role;
select results_eq(
  $$ select coalesce(metric_id::text, self_reported_label) from public.public_published_metrics('a8000003-0000-4000-8000-000000000001') $$,
  $$ values ('Downloads'::text) $$,
  'public_published_metrics: an unpublished metric disappears from the public read');
reset role;

-- ---------------------------------------------------------------------------
-- Unpublish everything
-- ---------------------------------------------------------------------------
select is(
  public.publish_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000002',
    'a8000001-0000-4000-8000-000000000001', 'vercel-deployments-7d', 'exact', 0::smallint, 'Published Deployments in 7 days', null),
  'published',
  'unpublish everything setup: a second project publishes a metric');
select throws_ok(
  $$ select public.unpublish_all_metrics('a8000002-0000-4000-8000-000000000001', 'a8000001-0000-4000-8000-000000000003') $$,
  '42501', null,
  'unpublish_all_metrics: a viewer cannot unpublish everything');
select results_eq(
  $$ select * from public.unpublish_all_metrics('a8000002-0000-4000-8000-000000000001', 'a8000001-0000-4000-8000-000000000001') $$,
  $$ values (2, 0) $$,
  'unpublish_all_metrics: revokes every live row of every project in the workspace');
select is(
  (select count(*)::int from public.published_metrics where workspace_id = 'a8000002-0000-4000-8000-000000000001' and revoked_at is null),
  0,
  'unpublish_all_metrics: nothing in the workspace is live afterwards');
select is(
  (select body from public.activity_events
   where workspace_id = 'a8000002-0000-4000-8000-000000000001' and type_id = 'devmacro.metrics_unpublished_all'
     and title = 'Unpublished everything'),
  '2 metrics are no longer public.',
  'unpublish_all_metrics: one "Unpublished everything" event says how many');
select results_eq(
  $$ select * from public.unpublish_all_metrics('a8000002-0000-4000-8000-000000000001', 'a8000001-0000-4000-8000-000000000001') $$,
  $$ values (0, 0) $$,
  'unpublish_all_metrics: running it again revokes nothing');

-- ---------------------------------------------------------------------------
-- Account deletion (#42) removes every row its user published
-- ---------------------------------------------------------------------------
select is(
  public.publish_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000001',
    'a8000001-0000-4000-8000-000000000001', 'supabase-signups-7d', 'exact', 0::smallint, 't', null),
  'published',
  'account deletion setup: the owner publishes one more metric');

delete from auth.users where id = 'a8000001-0000-4000-8000-000000000002';

select ok(
  not exists (select 1 from public.published_metrics where published_by = 'a8000001-0000-4000-8000-000000000002')
  and exists (select 1 from public.published_metrics where published_by = 'a8000001-0000-4000-8000-000000000001' and revoked_at is null),
  'account deletion: the deleted admin''s rows are gone, the owner''s live row stays');

-- ---------------------------------------------------------------------------
-- At most 100 live self-reported values per project (#220), so the public read stays far below
-- PostgREST's max_rows. Project B starts with 99 live values, revoked history, and an engine
-- metric; only the live self-reported rows count.
-- ---------------------------------------------------------------------------
insert into public.published_metrics (workspace_id, project_id, self_reported_label, self_reported_value, self_reported_unit, published_by)
select 'b8000002-0000-4000-8000-000000000001', 'b8000003-0000-4000-8000-000000000001', 'Value ' || n, n, 'things',
       'b8000001-0000-4000-8000-000000000001'
from generate_series(1, 99) as n;
insert into public.published_metrics (workspace_id, project_id, self_reported_label, self_reported_value, self_reported_unit, published_by,
                                      revoked_at, revoked_by)
select 'b8000002-0000-4000-8000-000000000001', 'b8000003-0000-4000-8000-000000000001', 'Old ' || n, n, 'things',
       'b8000001-0000-4000-8000-000000000001', now(), 'b8000001-0000-4000-8000-000000000001'
from generate_series(1, 5) as n;
insert into public.published_metrics (workspace_id, project_id, metric_id, published_by)
values ('b8000002-0000-4000-8000-000000000001', 'b8000003-0000-4000-8000-000000000001', 'github-stars',
        'b8000001-0000-4000-8000-000000000001');

select is(
  public.publish_self_reported_metric('b8000002-0000-4000-8000-000000000001', 'b8000003-0000-4000-8000-000000000001',
    'b8000001-0000-4000-8000-000000000001', 'Value 100', 100, 'things', 'Published Value 100 (self-reported)', null),
  'published',
  'publish_self_reported_metric: the 100th live value is published (boundary: exactly the cap)');
select is(
  public.publish_self_reported_metric('b8000002-0000-4000-8000-000000000001', 'b8000003-0000-4000-8000-000000000001',
    'b8000001-0000-4000-8000-000000000001', 'Value 101', 101, 'things', 'Published Value 101 (self-reported)', null),
  'limit_reached',
  'publish_self_reported_metric: a 101st live value is refused (boundary: one past the cap)');
select ok(
  (select count(*) from public.published_metrics
   where project_id = 'b8000003-0000-4000-8000-000000000001' and metric_id is null and revoked_at is null) = 100
  and not exists (select 1 from public.activity_events where title = 'Published Value 101 (self-reported)'),
  'publish_self_reported_metric: a refused value writes no row and no audit event');

set local role service_role;
select is(
  (select count(*)::int from public.public_published_metrics('b8000003-0000-4000-8000-000000000001')),
  101,
  'public_published_metrics: a project at the cap returns its 100 values and its engine metric');
reset role;

select is(
  public.publish_self_reported_metric('a8000002-0000-4000-8000-000000000001', 'a8000003-0000-4000-8000-000000000002',
    'a8000001-0000-4000-8000-000000000001', 'Value 101', 101, 'things', 't', null),
  'published',
  'publish_self_reported_metric: the cap is per project, so another project still publishes');

select is(
  public.unpublish_metric('b8000002-0000-4000-8000-000000000001',
    (select id from public.published_metrics where self_reported_label = 'Value 1' and revoked_at is null),
    'b8000001-0000-4000-8000-000000000001', 'Unpublished Value 1')
  || ' ' ||
  public.publish_self_reported_metric('b8000002-0000-4000-8000-000000000001', 'b8000003-0000-4000-8000-000000000001',
    'b8000001-0000-4000-8000-000000000001', 'Value 101', 101, 'things', 't', null),
  'unpublished published',
  'publish_self_reported_metric: unpublishing one value makes room for another (boundary: one under the cap)');

select * from finish();

rollback;
