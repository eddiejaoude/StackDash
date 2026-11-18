-- Whether a webhook target is simulated (#495, 20261118140000_webhook_targets_simulated.sql):
-- list_webhook_targets returns `simulated` on the account match, the installation match, and both
-- together, true exactly when the connection's granted_scopes holds 'simulated:read'
-- (SIMULATED_SCOPE), whatever other scopes it holds; it returns every target of either kind, real
-- and simulated alike, and leaves keeping one kind to the webhook job. The change is expand only:
-- the four columns callers before #495 read keep their names and types beside the new one (a later
-- expand may add more), a call naming the older parameters returns the same rows, and the grants
-- are unchanged.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS).
begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

-- Fixtures: one workspace with five GitHub connections of installation inst-1, each including
-- account acct-1: real, simulated, simulated with the write scope of automatic webhook setup, no
-- scopes at all, and a scope that only looks like the marker.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c3800001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'simulated-targets-owner@example.com', '{"user_name": "simulated-targets-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values ('c3800002-0000-4000-8000-000000000001', 'Simulated targets', 'c3800001-0000-4000-8000-000000000001');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds, external_installation_id, granted_scopes, granted_at)
values
  ('c3800003-0000-4000-8000-000000000001', 'c3800002-0000-4000-8000-000000000001', 'github', 'active', 'Real', 3600, 'inst-1',
   '{repo,read:org}', '2026-11-18T08:00:00Z'),
  ('c3800003-0000-4000-8000-000000000002', 'c3800002-0000-4000-8000-000000000001', 'github', 'active', 'Simulated', 3600, 'inst-1',
   '{simulated:read}', '2026-11-18T09:00:00Z'),
  ('c3800003-0000-4000-8000-000000000003', 'c3800002-0000-4000-8000-000000000001', 'github', 'failed', 'Simulated with write', 3600, 'inst-1',
   '{simulated:read,simulated:webhooks:write}', null),
  ('c3800003-0000-4000-8000-000000000004', 'c3800002-0000-4000-8000-000000000001', 'github', 'needs_attention', 'No scopes', 3600, 'inst-1',
   '{}', null),
  ('c3800003-0000-4000-8000-000000000005', 'c3800002-0000-4000-8000-000000000001', 'github', 'active', 'Lookalike', 3600, 'inst-1',
   '{simulated:readonly,Simulated:read}', null);

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind, included)
values
  ('c3800004-0000-4000-8000-000000000001', 'c3800002-0000-4000-8000-000000000001', 'c3800003-0000-4000-8000-000000000001', 'acct-1', 'Account', 'org', true),
  ('c3800004-0000-4000-8000-000000000002', 'c3800002-0000-4000-8000-000000000001', 'c3800003-0000-4000-8000-000000000002', 'acct-1', 'Account', 'org', true),
  ('c3800004-0000-4000-8000-000000000003', 'c3800002-0000-4000-8000-000000000001', 'c3800003-0000-4000-8000-000000000003', 'acct-1', 'Account', 'org', true),
  ('c3800004-0000-4000-8000-000000000004', 'c3800002-0000-4000-8000-000000000001', 'c3800003-0000-4000-8000-000000000004', 'acct-1', 'Account', 'org', true),
  ('c3800004-0000-4000-8000-000000000005', 'c3800002-0000-4000-8000-000000000001', 'c3800003-0000-4000-8000-000000000005', 'acct-1', 'Account', 'org', true);

-- ---------------------------------------------------------------------------
-- The result, the grants, and the callers before #495
-- ---------------------------------------------------------------------------
select set_has(
  $$ select a.name, a.type::regtype::text
     from pg_catalog.pg_proc p,
       unnest(p.proargnames, p.proallargtypes, p.proargmodes::text[]) as a(name, type, mode)
     where p.oid = 'public.list_webhook_targets(public.provider_id, text, uuid, text)'::regprocedure and a.mode = 't' $$,
  $$ values ('workspace_id', 'uuid'), ('connection_id', 'uuid'), ('account_id', 'uuid'),
            ('granted_at', 'timestamp with time zone'), ('simulated', 'boolean') $$,
  'list_webhook_targets: the result keeps the four columns callers before #495 read, by name and type, and has `simulated` boolean');
select is(
  (select count(*)::int from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'list_webhook_targets'),
  1,
  'list_webhook_targets: one function, so a call naming only the older parameters is never ambiguous');
select is_empty(
  $$ select r.role from unnest(array['anon', 'authenticated']) as r(role)
     where has_function_privilege(r.role, 'public.list_webhook_targets(public.provider_id, text, uuid, text)', 'execute') $$,
  'list_webhook_targets: anon and authenticated still cannot execute it');
select ok(
  has_function_privilege('service_role', 'public.list_webhook_targets(public.provider_id, text, uuid, text)', 'execute'),
  'list_webhook_targets: the service role can still execute it');
select results_eq(
  $$ select workspace_id, connection_id, account_id, granted_at
     from public.list_webhook_targets(p_provider => 'github', p_external_id => 'acct-1') $$,
  $$ values
       ('c3800002-0000-4000-8000-000000000001'::uuid, 'c3800003-0000-4000-8000-000000000001'::uuid,
        'c3800004-0000-4000-8000-000000000001'::uuid, '2026-11-18T08:00:00Z'::timestamptz),
       ('c3800002-0000-4000-8000-000000000001'::uuid, 'c3800003-0000-4000-8000-000000000002'::uuid,
        'c3800004-0000-4000-8000-000000000002'::uuid, '2026-11-18T09:00:00Z'::timestamptz),
       ('c3800002-0000-4000-8000-000000000001'::uuid, 'c3800003-0000-4000-8000-000000000003'::uuid,
        'c3800004-0000-4000-8000-000000000003'::uuid, null::timestamptz),
       ('c3800002-0000-4000-8000-000000000001'::uuid, 'c3800003-0000-4000-8000-000000000004'::uuid,
        'c3800004-0000-4000-8000-000000000004'::uuid, null::timestamptz),
       ('c3800002-0000-4000-8000-000000000001'::uuid, 'c3800003-0000-4000-8000-000000000005'::uuid,
        'c3800004-0000-4000-8000-000000000005'::uuid, null::timestamptz) $$,
  'account: a call naming the parameters code before #495 sends gets every target, real and simulated, with the columns it read before');

-- ---------------------------------------------------------------------------
-- simulated
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select connection_id, simulated from public.list_webhook_targets('github', 'acct-1') $$,
  $$ values ('c3800003-0000-4000-8000-000000000001'::uuid, false), ('c3800003-0000-4000-8000-000000000002'::uuid, true),
            ('c3800003-0000-4000-8000-000000000003'::uuid, true), ('c3800003-0000-4000-8000-000000000004'::uuid, false),
            ('c3800003-0000-4000-8000-000000000005'::uuid, false) $$,
  'account: each target says whether its connection is simulated, by the marker scope alone');
select results_eq(
  $$ select connection_id, simulated from public.list_webhook_targets('github', p_installation_id => 'inst-1') $$,
  $$ values ('c3800003-0000-4000-8000-000000000001'::uuid, false), ('c3800003-0000-4000-8000-000000000002'::uuid, true),
            ('c3800003-0000-4000-8000-000000000003'::uuid, true), ('c3800003-0000-4000-8000-000000000004'::uuid, false),
            ('c3800003-0000-4000-8000-000000000005'::uuid, false) $$,
  'installation: each connection says whether it is simulated, as on the account match');
select results_eq(
  $$ select connection_id, simulated from public.list_webhook_targets('github', 'acct-1', p_installation_id => 'inst-1') $$,
  $$ values ('c3800003-0000-4000-8000-000000000001'::uuid, false), ('c3800003-0000-4000-8000-000000000002'::uuid, true),
            ('c3800003-0000-4000-8000-000000000003'::uuid, true), ('c3800003-0000-4000-8000-000000000004'::uuid, false),
            ('c3800003-0000-4000-8000-000000000005'::uuid, false) $$,
  'account and installation: each target says whether it is simulated (#497 and #495 together)');
select is(
  (select simulated from public.list_webhook_targets('github', 'acct-1') where connection_id = 'c3800003-0000-4000-8000-000000000004'),
  false,
  'simulated: a connection with no granted scopes is real, never null (boundary: empty)');
select is(
  (select simulated from public.list_webhook_targets('github', 'acct-1') where connection_id = 'c3800003-0000-4000-8000-000000000005'),
  false,
  'simulated: a scope that only resembles the marker, by prefix or case, is not it (boundary: lookalike)');

select * from finish();

rollback;
