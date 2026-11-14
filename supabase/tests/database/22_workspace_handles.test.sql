-- Workspace handles (#258): the format and case-insensitive uniqueness the database enforces, the
-- role check in the only write paths, no write through the Data API, no read of another
-- workspace's handle, and the public page read answering at the handle address, at the slug
-- address (so the proxy can redirect), and never for a released handle or another workspace's
-- handle. Rows are seeded as postgres (the migration owner, which bypasses RLS); members are
-- impersonated through the same role and JWT claims PostgREST uses.
begin;

create extension if not exists pgtap with schema extensions;

select plan(40);

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
  ('a9100001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'wh-owner-a@example.com', '{"user_name": "wh-owner-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a9100001-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'wh-admin-a@example.com', '{"user_name": "wh-admin-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a9100001-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'wh-viewer-a@example.com', '{"user_name": "wh-viewer-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('b9100001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'wh-owner-b@example.com', '{"user_name": "wh-owner-b"}', '{"provider": "github", "providers": ["github"]}', now(), now());

-- Fixed slugs so the addresses are known; real ones are random (generate_workspace_slug).
insert into public.workspaces (id, slug, name, created_by)
values
  ('a9100002-0000-4000-8000-000000000001', 'handleaaaa', 'Handles A', 'a9100001-0000-4000-8000-000000000001'),
  ('b9100002-0000-4000-8000-000000000001', 'handlebbbb', 'Handles B', 'b9100001-0000-4000-8000-000000000001');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('a9100002-0000-4000-8000-000000000001', 'a9100001-0000-4000-8000-000000000001', 'owner'),
  ('a9100002-0000-4000-8000-000000000001', 'a9100001-0000-4000-8000-000000000002', 'admin'),
  ('a9100002-0000-4000-8000-000000000001', 'a9100001-0000-4000-8000-000000000003', 'viewer'),
  ('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', 'owner');

insert into public.projects (id, workspace_id, name)
values
  ('a9100003-0000-4000-8000-000000000001', 'a9100002-0000-4000-8000-000000000001', 'Acme web'),
  ('b9100003-0000-4000-8000-000000000001', 'b9100002-0000-4000-8000-000000000001', 'Other web');

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------
select col_is_null('public', 'workspaces', 'handle', 'workspaces.handle: nullable, so existing workspaces need no backfill');
select is_empty(
  $$ select id from public.workspaces
     where id in ('a9100002-0000-4000-8000-000000000001', 'b9100002-0000-4000-8000-000000000001') and handle is not null $$,
  'workspaces.handle: a new workspace has no handle until it claims one');
select ok(
  (select i.indisunique and pg_catalog.pg_get_indexdef(i.indexrelid) like '%(lower(handle))%'
   from pg_catalog.pg_index i where i.indexrelid = 'public.workspaces_handle_key'::regclass),
  'workspaces_handle_key: a unique index on lower(handle)');
select ok(
  has_column_privilege('authenticated', 'public.workspaces', 'handle', 'select')
  and not has_column_privilege('authenticated', 'public.workspaces', 'handle', 'update')
  and not has_column_privilege('authenticated', 'public.workspaces', 'handle', 'insert'),
  'workspaces.handle: authenticated may read it (rows limited by workspaces_select) and never write it');

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
        (case when p.proname <> 'require_workspace_handle_admin'
                and not has_function_privilege('service_role', p.oid, 'execute') then 'not executable by service_role' end)
    ) as v(problem)
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any (array['require_workspace_handle_admin', 'set_workspace_handle', 'remove_workspace_handle'])
      and v.problem is not null
  $$,
  'handle functions: security definer, empty search_path, never callable by anon or authenticated');
select is(
  (select count(*)::int from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = any (array['require_workspace_handle_admin', 'set_workspace_handle', 'remove_workspace_handle'])),
  3,
  'handle functions: all three exist, so the check above is not vacuous');

-- ---------------------------------------------------------------------------
-- Claiming, and who may
-- ---------------------------------------------------------------------------
select is(
  public.set_workspace_handle('a9100002-0000-4000-8000-000000000001', 'a9100001-0000-4000-8000-000000000001', 'acme-labs'),
  'saved',
  'set_workspace_handle: an owner claims a handle');
select is((select handle from public.workspaces where id = 'a9100002-0000-4000-8000-000000000001'), 'acme-labs',
  'set_workspace_handle: the handle is stored');
select is(
  public.set_workspace_handle('a9100002-0000-4000-8000-000000000001', 'a9100001-0000-4000-8000-000000000002', 'acme-labs'),
  'unchanged',
  'set_workspace_handle: an admin may set it, and the same handle again changes nothing');
select throws_ok(
  $$ select public.set_workspace_handle('a9100002-0000-4000-8000-000000000001', 'a9100001-0000-4000-8000-000000000003', 'acme-viewer') $$,
  '42501', null,
  'set_workspace_handle: a viewer cannot set the handle');
select throws_ok(
  $$ select public.set_workspace_handle('a9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', 'acme-other') $$,
  '42501', null,
  'set_workspace_handle: the owner of another workspace cannot set this workspace''s handle');
select throws_ok(
  $$ select public.set_workspace_handle('a9100002-0000-4000-8000-000000000001', null, 'acme-nobody') $$,
  '42501', null,
  'set_workspace_handle: no actor cannot set the handle');
select throws_ok(
  $$ select public.remove_workspace_handle('a9100002-0000-4000-8000-000000000001', 'a9100001-0000-4000-8000-000000000003') $$,
  '42501', null,
  'remove_workspace_handle: a viewer cannot remove the handle');
select throws_ok(
  $$ select public.set_workspace_handle('a9100002-0000-4000-8000-000000000001', 'a9100001-0000-4000-8000-000000000001', null) $$,
  '22023', null,
  'set_workspace_handle: a null handle is refused; removing has its own function');
select is((select handle from public.workspaces where id = 'a9100002-0000-4000-8000-000000000001'), 'acme-labs',
  'set_workspace_handle: refused calls left the handle as it was');

-- ---------------------------------------------------------------------------
-- Format (workspaces_handle_format)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.set_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', 'ab') $$,
  '23514', null,
  'workspaces_handle_format: 2 characters is refused');
select is(
  public.set_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', repeat('b', 32)),
  'saved',
  'workspaces_handle_format: 32 characters is accepted');
select throws_ok(
  $$ select public.set_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', repeat('b', 33)) $$,
  '23514', null,
  'workspaces_handle_format: 33 characters is refused');
select throws_ok(
  $$ select public.set_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', 'Other-Labs') $$,
  '23514', null,
  'workspaces_handle_format: capitals are refused, so a stored handle is always lowercase');
select throws_ok(
  $$ select public.set_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', 'other--labs') $$,
  '23514', null,
  'workspaces_handle_format: a double hyphen is refused');
select throws_ok(
  $$ select public.set_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', '-other') $$,
  '23514', null,
  'workspaces_handle_format: a leading hyphen is refused');
select throws_ok(
  $$ select public.set_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', 'café') $$,
  '23514', null,
  'workspaces_handle_format: a letter outside a to z is refused');

-- ---------------------------------------------------------------------------
-- Uniqueness, and a taken handle
-- ---------------------------------------------------------------------------
select is(
  public.set_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', 'acme-labs'),
  'taken',
  'set_workspace_handle: another workspace cannot claim a taken handle');
select is(
  public.set_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', 'handleaaaa'),
  'taken',
  'set_workspace_handle: another workspace''s slug cannot be claimed as a handle');
-- The index on lower(handle), not only the format check, keeps a case variant out: bypass the
-- check to prove it.
alter table public.workspaces drop constraint workspaces_handle_format;
select throws_ok(
  $$ update public.workspaces set handle = 'ACME-LABS' where id = 'b9100002-0000-4000-8000-000000000001' $$,
  '23505', null,
  'workspaces_handle_key: a handle that differs only in case is refused');

-- ---------------------------------------------------------------------------
-- Reading: members of the workspace only
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a9100001-0000-4000-8000-000000000003", "role": "authenticated"}';
select results_eq(
  $$ select handle from public.workspaces where id = 'a9100002-0000-4000-8000-000000000001' $$,
  $$ values ('acme-labs'::text) $$,
  'tenant isolation control: a viewer of workspace A reads its handle');

set local request.jwt.claims to '{"sub": "b9100001-0000-4000-8000-000000000001", "role": "authenticated"}';
select is_empty(
  $$ select id from public.workspaces where handle = 'acme-labs' $$,
  'tenant isolation: a member of workspace B cannot read workspace A by its handle');

set local request.jwt.claims to '{"sub": "a9100001-0000-4000-8000-000000000001", "role": "authenticated"}';
select ok(
  rls_test.affected($$ update public.workspaces set handle = 'acme-direct' where id = 'a9100002-0000-4000-8000-000000000001' $$) <= 0,
  'role matrix: even the owner cannot set the handle through the Data API');
select throws_ok(
  $$ select public.set_workspace_handle('a9100002-0000-4000-8000-000000000001', 'a9100001-0000-4000-8000-000000000001', 'acme-rpc') $$,
  '42501', null,
  'set_workspace_handle: a signed-in member cannot call it; the Server Action calls it on the server');
reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- The public read
-- ---------------------------------------------------------------------------
select public.save_project_page('a9100002-0000-4000-8000-000000000001', 'a9100003-0000-4000-8000-000000000001',
  'a9100001-0000-4000-8000-000000000001', 'acme-web', true);
select is(
  (select body from public.activity_events
   where workspace_id = 'a9100002-0000-4000-8000-000000000001' and type_id = 'stackdash.project_page_enabled'),
  'Project Acme web. Address /@acme-labs/acme-web. Search engines may index it.',
  'save_project_page: the audit event names the handle address while the workspace has a handle');
select public.publish_metric('a9100002-0000-4000-8000-000000000001', 'a9100003-0000-4000-8000-000000000001',
  'a9100001-0000-4000-8000-000000000001', 'github-stars', 'exact', 0::smallint, 'Published GitHub stars', null);
select public.save_project_page('b9100002-0000-4000-8000-000000000001', 'b9100003-0000-4000-8000-000000000001',
  'b9100001-0000-4000-8000-000000000001', 'other-web', false);
select public.publish_metric('b9100002-0000-4000-8000-000000000001', 'b9100003-0000-4000-8000-000000000001',
  'b9100001-0000-4000-8000-000000000001', 'github-stars', 'exact', 0::smallint, 'Published GitHub stars', null);

set local role service_role;
select results_eq(
  $$ select project_id, workspace_slug, workspace_handle from public.public_project_page('acme-labs', 'acme-web') $$,
  $$ values ('a9100003-0000-4000-8000-000000000001'::uuid, 'handleaaaa'::text, 'acme-labs'::text) $$,
  'public_project_page: the handle address answers with the page');
select results_eq(
  $$ select project_id, workspace_handle from public.public_project_page('handleaaaa', 'acme-web') $$,
  $$ values ('a9100003-0000-4000-8000-000000000001'::uuid, 'acme-labs'::text) $$,
  'public_project_page: the slug address answers too, naming the handle the proxy redirects to');
select is_empty($$ select project_id from public.public_project_page('no-such-handle', 'acme-web') $$,
  'public_project_page: an unknown handle answers nothing');
select is_empty($$ select project_id from public.public_project_page(repeat('b', 32), 'acme-web') $$,
  'public_project_page: another workspace''s handle with this page slug answers nothing, the same as an unknown handle');
select results_eq(
  $$ select workspace_slug, workspace_handle, page_slug from public.public_project_page_sitemap(100) where workspace_slug = 'handleaaaa' $$,
  $$ values ('handleaaaa'::text, 'acme-labs'::text, 'acme-web'::text) $$,
  'public_project_page_sitemap: lists the page with its handle');
reset role;

-- Changing the handle releases the old one at once.
select is(
  public.set_workspace_handle('a9100002-0000-4000-8000-000000000001', 'a9100001-0000-4000-8000-000000000002', 'acme-two'),
  'saved',
  'set_workspace_handle: an admin changes the handle');
set local role service_role;
select is_empty($$ select project_id from public.public_project_page('acme-labs', 'acme-web') $$,
  'public_project_page: the old handle answers nothing once it changed');
reset role;
select is(
  public.set_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001', 'acme-labs'),
  'saved',
  'set_workspace_handle: another workspace may claim a released handle straight away');
select is(
  public.remove_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001'),
  'removed',
  'remove_workspace_handle: an owner removes the handle');
select is(
  public.remove_workspace_handle('b9100002-0000-4000-8000-000000000001', 'b9100001-0000-4000-8000-000000000001'),
  'unchanged',
  'remove_workspace_handle: removing it again changes nothing');

select * from finish();

rollback;
