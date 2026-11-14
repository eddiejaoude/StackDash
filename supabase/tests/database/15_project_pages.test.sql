-- Public project pages (#150): nothing is public by default, the role check and audit event in
-- every write function, slugs unique per workspace, and the public read answering only for a page
-- that is on and has something published (the same empty answer for an unknown address, a page
-- that is off, and a page with nothing published), for the page and for the sitemap alike.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS); members are impersonated
-- through the same role and JWT claims PostgREST uses.
begin;

create extension if not exists pgtap with schema extensions;

select plan(43);

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
  ('a9000001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pp-owner-a@example.com', '{"user_name": "pp-owner-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a9000001-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pp-admin-a@example.com', '{"user_name": "pp-admin-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a9000001-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pp-viewer-a@example.com', '{"user_name": "pp-viewer-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('b9000001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'pp-owner-b@example.com', '{"user_name": "pp-owner-b"}', '{"provider": "github", "providers": ["github"]}', now(), now());

-- Fixed slugs so the addresses are known; real ones are random (generate_workspace_slug).
insert into public.workspaces (id, slug, name, created_by)
values
  ('a9000002-0000-4000-8000-000000000001', 'pagetestaa', 'Pages A', 'a9000001-0000-4000-8000-000000000001'),
  ('b9000002-0000-4000-8000-000000000001', 'pagetestbb', 'Pages B', 'b9000001-0000-4000-8000-000000000001');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000001', 'owner'),
  ('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000002', 'admin'),
  ('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000003', 'viewer'),
  ('b9000002-0000-4000-8000-000000000001', 'b9000001-0000-4000-8000-000000000001', 'owner');

insert into public.projects (id, workspace_id, name)
values
  ('a9000003-0000-4000-8000-000000000001', 'a9000002-0000-4000-8000-000000000001', 'Acme web'),
  ('a9000003-0000-4000-8000-000000000002', 'a9000002-0000-4000-8000-000000000001', 'Acme docs'),
  ('b9000003-0000-4000-8000-000000000001', 'b9000002-0000-4000-8000-000000000001', 'Other web');

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------
select ok((select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.project_pages'::regclass),
  'project_pages: row level security is on');
select ok(not has_table_privilege('anon', 'public.project_pages', 'select'),
  'project_pages: anon cannot select');
select ok(
  has_table_privilege('authenticated', 'public.project_pages', 'select')
  and not has_table_privilege('authenticated', 'public.project_pages', 'insert')
  and not has_table_privilege('authenticated', 'public.project_pages', 'update')
  and not has_table_privilege('authenticated', 'public.project_pages', 'delete'),
  'project_pages: authenticated can select (rows limited by the policy) and nothing else');

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
      and p.proname = any (array['save_project_page', 'disable_project_page', 'public_project_page', 'public_project_page_sitemap'])
      and v.problem is not null
  $$,
  'project page functions: security definer, empty search_path, service role only');
select is(
  (select count(*)::int from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = any (array['save_project_page', 'disable_project_page', 'public_project_page', 'public_project_page_sitemap'])),
  4,
  'project page functions: all four exist, so the check above is not vacuous');

-- Nothing is public by default: a project has no page until someone turns it on.
select is_empty($$ select project_id from public.project_pages $$,
  'project_pages: creating projects creates no page');

-- ---------------------------------------------------------------------------
-- Turning a page on
-- ---------------------------------------------------------------------------
select is(
  public.save_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000001', 'acme-web', false),
  'enabled',
  'save_project_page: an owner turns a page on');
select is(
  (select body from public.activity_events
   where workspace_id = 'a9000002-0000-4000-8000-000000000001' and type_id = 'stackdash.project_page_enabled'
     and title = 'Turned on the public project page' and provider is null),
  'Project Acme web. Address /@pagetestaa/acme-web. Search engines are asked not to index it.',
  'save_project_page: the audit event names the project, the address, and the indexing choice');
select is(
  public.save_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000001', 'acme-web', false),
  'unchanged',
  'save_project_page: saving the same settings again changes nothing');
select is(
  (select count(*)::int from public.activity_events
   where workspace_id = 'a9000002-0000-4000-8000-000000000001' and type_id like 'stackdash.project_page_%'),
  1,
  'save_project_page: an unchanged save writes no second event');
select throws_ok(
  $$ select public.save_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000002',
       'a9000001-0000-4000-8000-000000000003', 'acme-docs', false) $$,
  '42501', null,
  'save_project_page: a viewer cannot turn a page on');
select is(
  public.save_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000002',
    'a9000001-0000-4000-8000-000000000002', 'acme-web', false),
  'slug_taken',
  'save_project_page: another project in the workspace cannot take the same slug');
select is(
  public.save_project_page('b9000002-0000-4000-8000-000000000001', 'b9000003-0000-4000-8000-000000000001',
    'b9000001-0000-4000-8000-000000000001', 'acme-web', false),
  'enabled',
  'save_project_page: a project in another workspace may use the same slug');
select is(
  public.save_project_page('a9000002-0000-4000-8000-000000000001', 'b9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000001', 'other-web', false),
  'not_found',
  'save_project_page: another workspace''s project is not found');
select throws_ok(
  $$ select public.save_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000002',
       'a9000001-0000-4000-8000-000000000001', 'Acme Docs', false) $$,
  '23514', null,
  'project_pages_slug_format: a slug with capitals or spaces is refused');
select throws_ok(
  $$ select public.save_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000002',
       'a9000001-0000-4000-8000-000000000001', repeat('a', 41), false) $$,
  '23514', null,
  'project_pages_slug_format: a slug longer than 40 characters is refused');
select is(
  public.save_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000002', 'acme-web', true),
  'updated',
  'save_project_page: an admin changes a page that is on');
select is(
  (select count(*)::int from public.activity_events
   where workspace_id = 'a9000002-0000-4000-8000-000000000001' and type_id = 'stackdash.project_page_updated'
     and body = 'Project Acme web. Address /@pagetestaa/acme-web. Search engines may index it.'),
  1,
  'save_project_page: the change writes an "Updated" audit event');

-- ---------------------------------------------------------------------------
-- The public read: on, and something published
-- ---------------------------------------------------------------------------
set local role service_role;
select is_empty($$ select project_id from public.public_project_page('pagetestaa', 'acme-web') $$,
  'public_project_page: a page that is on but has nothing published answers nothing');
select is_empty($$ select page_slug from public.public_project_page_sitemap(100) $$,
  'public_project_page_sitemap: a page with nothing published is not listed');
reset role;

select is(
  public.publish_metric('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000001', 'github-stars', 'exact', 0::smallint, 'Published GitHub stars', 'Project Acme web. Exact, current.'),
  'published',
  'public read setup: the project publishes a metric');
select is(
  public.publish_self_reported_metric('b9000002-0000-4000-8000-000000000001', 'b9000003-0000-4000-8000-000000000001',
    'b9000001-0000-4000-8000-000000000001', 'Downloads', 10, 'downloads', 'Published Downloads (self-reported)', null),
  'published',
  'public read setup: workspace B publishes only a self-reported value');

set local role service_role;
select results_eq(
  $$ select project_id, workspace_id, project_name, indexable from public.public_project_page('pagetestaa', 'acme-web') $$,
  $$ values ('a9000003-0000-4000-8000-000000000001'::uuid, 'a9000002-0000-4000-8000-000000000001'::uuid, 'Acme web'::text, true) $$,
  'public_project_page: a page that is on with a live publication answers with its project');
select results_eq(
  $$ select project_id from public.public_project_page('pagetestbb', 'acme-web') $$,
  $$ values ('b9000003-0000-4000-8000-000000000001'::uuid) $$,
  'public_project_page: a self-reported value alone makes a page public, and the same slug in workspace B is B''s page');
select is_empty($$ select project_id from public.public_project_page('pagetestaa', 'acme-docs') $$,
  'public_project_page: a project without a page answers nothing');
select is_empty($$ select project_id from public.public_project_page('nosuchwork', 'acme-web') $$,
  'public_project_page: an unknown workspace answers nothing');
select results_eq(
  $$ select workspace_slug, page_slug from public.public_project_page_sitemap(100) $$,
  $$ values ('pagetestaa'::text, 'acme-web'::text) $$,
  'public_project_page_sitemap: lists the indexable public page, not the page that asks not to be indexed');
select is_empty($$ select page_slug from public.public_project_page_sitemap(0) $$,
  'public_project_page_sitemap: a limit of zero lists nothing');
reset role;

-- Unpublishing everything takes the page offline with it.
select results_eq(
  $$ select * from public.unpublish_all_metrics('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000001') $$,
  $$ values (1, 0) $$,
  'unpublish everything: revokes the page''s only publication');
set local role service_role;
select is_empty($$ select project_id from public.public_project_page('pagetestaa', 'acme-web') $$,
  'public_project_page: once nothing is published the page answers nothing, though it is still on');
reset role;

-- ---------------------------------------------------------------------------
-- Turning a page off
-- ---------------------------------------------------------------------------
select public.publish_metric('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
  'a9000001-0000-4000-8000-000000000001', 'github-stars', 'exact', 0::smallint, 'Published GitHub stars', null);

select throws_ok(
  $$ select public.disable_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
       'a9000001-0000-4000-8000-000000000003') $$,
  '42501', null,
  'disable_project_page: a viewer cannot turn a page off');
select is(
  public.disable_project_page('b9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'b9000001-0000-4000-8000-000000000001'),
  'not_found',
  'disable_project_page: another workspace''s page is not found');
select is(
  public.disable_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000002'),
  'disabled',
  'disable_project_page: an admin turns a page off');
select is(
  (select body from public.activity_events
   where workspace_id = 'a9000002-0000-4000-8000-000000000001' and type_id = 'stackdash.project_page_disabled'
     and title = 'Turned off the public project page'),
  'Project Acme web. The page is no longer public.',
  'disable_project_page: the audit event names the project');
set local role service_role;
select is_empty($$ select project_id from public.public_project_page('pagetestaa', 'acme-web') $$,
  'public_project_page: a page that is off answers nothing, though its metric is still published');
select is_empty($$ select page_slug from public.public_project_page_sitemap(100) where workspace_slug = 'pagetestaa' $$,
  'public_project_page_sitemap: a page that is off leaves the sitemap');
reset role;
select is(
  public.disable_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000002'),
  'not_found',
  'disable_project_page: a page that is already off is not found');
select is(
  public.save_project_page('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000002',
    'a9000001-0000-4000-8000-000000000001', 'acme-web', false),
  'slug_taken',
  'project_pages: a page that is off keeps its slug reserved');

-- ---------------------------------------------------------------------------
-- Tenant isolation through the normal client
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a9000001-0000-4000-8000-000000000003", "role": "authenticated"}';

select results_eq(
  $$ select slug, enabled from public.project_pages where workspace_id = 'a9000002-0000-4000-8000-000000000001' $$,
  $$ values ('acme-web'::text, false) $$,
  'tenant isolation control: a viewer of workspace A sees its page settings');

set local request.jwt.claims to '{"sub": "b9000001-0000-4000-8000-000000000001", "role": "authenticated"}';

select is_empty(
  $$ select project_id from public.project_pages where workspace_id = 'a9000002-0000-4000-8000-000000000001' $$,
  'tenant isolation: a member of workspace B cannot select workspace A''s page');

set local request.jwt.claims to '{"sub": "a9000001-0000-4000-8000-000000000001", "role": "authenticated"}';

select ok(
  rls_test.affected($$ update public.project_pages set enabled = true where workspace_id = 'a9000002-0000-4000-8000-000000000001' $$) <= 0
  and rls_test.affected($$ insert into public.project_pages (project_id, workspace_id, slug, enabled)
                           values ('a9000003-0000-4000-8000-000000000002', 'a9000002-0000-4000-8000-000000000001', 'acme-docs', true) $$) <= 0,
  'role matrix: even the owner cannot turn a page on through the Data API (the functions write the audit event)');
select throws_ok($$ select * from public.public_project_page('pagetestaa', 'acme-web') $$, '42501', null,
  'public_project_page: a signed-in member cannot call it');

reset role;
reset request.jwt.claims;

set local role anon;
select throws_ok($$ select * from public.public_project_page_sitemap(100) $$, '42501', null,
  'anon: cannot call public_project_page_sitemap; the sitemap calls it on the server');
reset role;

select * from finish();

rollback;
