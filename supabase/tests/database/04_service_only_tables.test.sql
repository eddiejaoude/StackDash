-- Service only surface: credential, OAuth state, and invite tables are closed
-- to anon and authenticated; privileged functions are not callable from the
-- Data API; the authorization helper is membership scoped; the invite hook
-- fails closed.
begin;

create extension if not exists pgtap with schema extensions;

select plan(37);

-- Fixtures as postgres: owner and viewer of one workspace, plus an outsider.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('e0000001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'rls-service-owner@example.com', '{"user_name": "rls-service-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('e0000002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'rls-service-outsider@example.com', '{"user_name": "rls-service-outsider"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('e0000003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'rls-service-viewer@example.com', '{"user_name": "rls-service-viewer"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values ('e00000a0-0000-4000-8000-000000000000', 'Service only team', 'e0000001-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('e00000a0-0000-4000-8000-000000000000', 'e0000001-0000-4000-8000-000000000000', 'owner'),
  ('e00000a0-0000-4000-8000-000000000000', 'e0000003-0000-4000-8000-000000000000', 'viewer');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values ('e00000a1-0000-4000-8000-000000000000', 'e00000a0-0000-4000-8000-000000000000', 'fake', 'active', 'Service connection', 3600);

insert into public.connection_credentials (connection_id, workspace_id, key_id, iv, ciphertext, auth_tag)
values ('e00000a1-0000-4000-8000-000000000000', 'e00000a0-0000-4000-8000-000000000000', 'deadbeef',
        '\x00'::bytea, '\x01'::bytea, '\x02'::bytea);

insert into public.oauth_states (state, workspace_id, provider, user_id, expires_at)
values ('rls-service-state', 'e00000a0-0000-4000-8000-000000000000', 'fake', 'e0000001-0000-4000-8000-000000000000',
        now() + interval '10 minutes');

insert into public.access_invites (email, invited_by)
values ('rls-service-invited@example.com', 'pgtap');

-- ---------------------------------------------------------------------------
-- anon: no select, no insert on the service only tables.
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';

select throws_ok($$ select connection_id from public.connection_credentials $$, '42501'::char(5), null::text,
  'service only: anon cannot select connection_credentials');
select throws_ok($$
    insert into public.connection_credentials (connection_id, workspace_id, key_id, iv, ciphertext, auth_tag)
    values ('e00000a1-0000-4000-8000-000000000000', 'e00000a0-0000-4000-8000-000000000000', 'anon0000', '\x00', '\x00', '\x00')
  $$, '42501'::char(5), null::text,
  'service only: anon cannot insert connection_credentials');
select throws_ok($$ select state from public.oauth_states $$, '42501'::char(5), null::text,
  'service only: anon cannot select oauth_states');
select throws_ok($$
    insert into public.oauth_states (state, workspace_id, provider, user_id, expires_at)
    values ('anon-state', 'e00000a0-0000-4000-8000-000000000000', 'fake', 'e0000001-0000-4000-8000-000000000000', now() + interval '10 minutes')
  $$, '42501'::char(5), null::text,
  'service only: anon cannot insert oauth_states');
select throws_ok($$ select email from public.access_invites $$, '42501'::char(5), null::text,
  'service only: anon cannot select access_invites');
select throws_ok($$ insert into public.access_invites (email, invited_by) values ('rls-anon-self@example.com', 'self') $$,
  '42501'::char(5), null::text,
  'service only: anon cannot insert access_invites (cannot self invite)');

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- authenticated, as the workspace owner (the strongest signed in case).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "e0000001-0000-4000-8000-000000000000", "role": "authenticated"}';

select throws_ok($$ select connection_id from public.connection_credentials $$, '42501'::char(5), null::text,
  'service only: an authenticated owner cannot select connection_credentials, even for their own connection');
select throws_ok($$
    insert into public.connection_credentials (connection_id, workspace_id, key_id, iv, ciphertext, auth_tag)
    values ('e00000a1-0000-4000-8000-000000000000', 'e00000a0-0000-4000-8000-000000000000', 'auth0000', '\x00', '\x00', '\x00')
  $$, '42501'::char(5), null::text,
  'service only: an authenticated owner cannot insert connection_credentials');
select throws_ok($$ select state from public.oauth_states $$, '42501'::char(5), null::text,
  'service only: an authenticated owner cannot select oauth_states');
select throws_ok($$
    insert into public.oauth_states (state, workspace_id, provider, user_id, expires_at)
    values ('auth-state', 'e00000a0-0000-4000-8000-000000000000', 'fake', 'e0000001-0000-4000-8000-000000000000', now() + interval '10 minutes')
  $$, '42501'::char(5), null::text,
  'service only: an authenticated owner cannot insert oauth_states');
select throws_ok($$ select email from public.access_invites $$, '42501'::char(5), null::text,
  'service only: an authenticated user cannot select access_invites');
select throws_ok($$ insert into public.access_invites (email, invited_by) values ('rls-auth-friend@example.com', 'self') $$,
  '42501'::char(5), null::text,
  'service only: an authenticated user cannot insert access_invites');

-- Privileged functions are not callable through the Data API.
select throws_ok($$ select * from public.claim_sync_jobs(10, 60) $$, '42501'::char(5), null::text,
  'service only: authenticated cannot execute claim_sync_jobs');
select throws_ok($$ select * from public.create_workspace('e0000001-0000-4000-8000-000000000000', 'Self serve', false) $$,
  '42501'::char(5), null::text,
  'service only: authenticated cannot execute create_workspace');
select throws_ok($$ select public.hook_before_user_created('{"user": {"email": "rls-service-invited@example.com"}}'::jsonb) $$,
  '42501'::char(5), null::text,
  'service only: authenticated cannot execute hook_before_user_created (no invite list probing)');

reset role;
reset request.jwt.claims;

-- Grants are the outer wall: anon and authenticated hold no privilege of any
-- kind, table or column level, on the service only tables.
select is_empty(
  $$
    select r.role || ' ' || t.tbl || ' ' || p.priv
    from unnest(array['anon', 'authenticated']) as r(role)
    cross join unnest(array['public.connection_credentials', 'public.oauth_states', 'public.access_invites']) as t(tbl)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
    where case
      when p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') then has_any_column_privilege(r.role, t.tbl, p.priv)
      else has_table_privilege(r.role, t.tbl, p.priv)
    end
  $$,
  'service only: anon and authenticated hold no table or column privilege on connection_credentials, oauth_states, access_invites');

-- ---------------------------------------------------------------------------
-- has_workspace_role is membership scoped and rank aware.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "e0000002-0000-4000-8000-000000000000", "role": "authenticated"}';

select is(public.has_workspace_role('e00000a0-0000-4000-8000-000000000000', 'viewer'), false,
  'has_workspace_role: returns false for a signed in non-member');

set local request.jwt.claims to '{"role": "authenticated"}';

select is(public.has_workspace_role('e00000a0-0000-4000-8000-000000000000', 'viewer'), false,
  'has_workspace_role: returns false when the JWT carries no user id');

set local request.jwt.claims to '{"sub": "e0000001-0000-4000-8000-000000000000", "role": "authenticated"}';

select is(public.has_workspace_role('e00000a0-0000-4000-8000-000000000000', 'owner'), true,
  'has_workspace_role: returns true for an owner asking for owner');

set local request.jwt.claims to '{"sub": "e0000003-0000-4000-8000-000000000000", "role": "authenticated"}';

select is(public.has_workspace_role('e00000a0-0000-4000-8000-000000000000', 'viewer'), true,
  'has_workspace_role: returns true for a viewer asking for viewer');
select is(public.has_workspace_role('e00000a0-0000-4000-8000-000000000000', 'admin'), false,
  'has_workspace_role: returns false for a viewer asking for admin');

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Function execute privileges (BackTalk 0074: revoke from PUBLIC, grant narrowly).
-- ---------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.claim_sync_jobs(integer, integer)', 'execute'),
  'function grants: authenticated cannot execute claim_sync_jobs');
select ok(not has_function_privilege('anon', 'public.claim_sync_jobs(integer, integer)', 'execute'),
  'function grants: anon cannot execute claim_sync_jobs');
select ok(not has_function_privilege('authenticated', 'public.create_workspace(uuid, text, boolean)', 'execute'),
  'function grants: authenticated cannot execute create_workspace');
select ok(not has_function_privilege('anon', 'public.create_workspace(uuid, text, boolean)', 'execute'),
  'function grants: anon cannot execute create_workspace');
select ok(has_function_privilege('authenticated', 'public.has_workspace_role(uuid, public.workspace_role)', 'execute'),
  'function grants: authenticated can execute has_workspace_role (policies call it)');
select ok(not has_function_privilege('anon', 'public.has_workspace_role(uuid, public.workspace_role)', 'execute'),
  'function grants: anon cannot execute has_workspace_role');
select ok(not has_function_privilege('authenticated', 'public.hook_before_user_created(jsonb)', 'execute'),
  'function grants: authenticated cannot execute hook_before_user_created');
select ok(not has_function_privilege('anon', 'public.hook_before_user_created(jsonb)', 'execute'),
  'function grants: anon cannot execute hook_before_user_created');
select ok(has_function_privilege('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'execute'),
  'function grants: supabase_auth_admin can execute hook_before_user_created');
select ok(has_table_privilege('supabase_auth_admin', 'public.access_invites', 'select'),
  'function grants: supabase_auth_admin can read access_invites for the hook');

-- Every security definer function in public pins search_path to empty and is
-- closed to anon, so none can be hijacked or called without signing in.
select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and not exists (
        select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
      and not coalesce(p.proconfig && array['search_path=""', 'search_path='], false)
  $$,
  'function grants: every security definer function in public sets search_path to empty');
select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and not exists (
        select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
      and has_function_privilege('anon', p.oid, 'execute')
  $$,
  'function grants: anon cannot execute any security definer function in public');

-- ---------------------------------------------------------------------------
-- Invite only sign up: the before-user-created hook, called with the payload
-- shape Supabase Auth sends.
-- ---------------------------------------------------------------------------
select is(
  public.hook_before_user_created(
    '{"metadata": {"name": "before-user-created", "ip_address": "127.0.0.1"},
      "user": {"id": "e0000009-0000-4000-8000-000000000000", "email": "rls-service-uninvited@example.com", "app_metadata": {"provider": "github"}, "user_metadata": {}}}'::jsonb
  ) -> 'error' ->> 'http_code',
  '403',
  'invite hook: an uninvited email is rejected with http_code 403');

select is(
  public.hook_before_user_created(
    '{"metadata": {"name": "before-user-created"}, "user": {"email": "rls-service-uninvited@example.com"}}'::jsonb
  ) -> 'error' ->> 'message',
  'This email has not been invited to the StackDash test.',
  'invite hook: the rejection message tells the user they have not been invited');

select ok(
  not (
    public.hook_before_user_created(
      '{"metadata": {"name": "before-user-created", "ip_address": "127.0.0.1"},
        "user": {"id": "e0000008-0000-4000-8000-000000000000", "email": "RLS-Service-Invited@Example.com", "app_metadata": {"provider": "github"}, "user_metadata": {}}}'::jsonb
    ) ? 'error'
  ),
  'invite hook: an invited email is allowed, matched case insensitively');

select ok(
  public.hook_before_user_created('{"metadata": {"name": "before-user-created"}, "user": {"phone": "+447700900000"}}'::jsonb) ? 'error',
  'invite hook: a user without an email is rejected (fails closed)');

select * from finish();

rollback;
