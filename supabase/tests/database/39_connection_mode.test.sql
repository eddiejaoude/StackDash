-- The mode of each connection, live or test (#481, 20261118150000_connection_mode.sql):
-- connections.mode is a nullable connection_mode members read and nobody writes through the Data
-- API; list_webhook_targets returns it as a column of its result, on the account match, the
-- installation match, and both, beside every column callers before #481 read, with the parameters
-- and grants unchanged, and null for a provider that records no mode. The contract step that
-- requires a mode on every Stripe connection past pending, and its backfill run (#567), are
-- covered by 40_connection_mode_required.test.sql.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS).
begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- Fixtures: one workspace. Stripe account acct_1 is included by a live and a test mode connection
-- of installation inst-1, and by a needs_attention test mode one; GitHub account octo-1 by a
-- connection that records no mode, as every provider but Stripe.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c3900001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'mode-owner@example.com', '{"user_name": "mode-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values ('c3900002-0000-4000-8000-000000000001', 'Connection modes', 'c3900001-0000-4000-8000-000000000001');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds, external_installation_id, mode)
values
  ('c3900003-0000-4000-8000-000000000001', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'active', 'Live', 3600, 'inst-1', 'live'),
  ('c3900003-0000-4000-8000-000000000002', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'failed', 'Test', 3600, 'inst-1', 'test'),
  ('c3900003-0000-4000-8000-000000000003', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'needs_attention', 'Needs attention', 3600, 'inst-1', 'test'),
  ('c3900003-0000-4000-8000-000000000004', 'c3900002-0000-4000-8000-000000000001', 'github', 'active', 'No mode', 3600, null, null);

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind, included)
values
  ('c3900004-0000-4000-8000-000000000001', 'c3900002-0000-4000-8000-000000000001', 'c3900003-0000-4000-8000-000000000001', 'acct_1', 'Account', 'account', true),
  ('c3900004-0000-4000-8000-000000000002', 'c3900002-0000-4000-8000-000000000001', 'c3900003-0000-4000-8000-000000000002', 'acct_1', 'Account', 'account', true),
  ('c3900004-0000-4000-8000-000000000003', 'c3900002-0000-4000-8000-000000000001', 'c3900003-0000-4000-8000-000000000003', 'acct_1', 'Account', 'account', true),
  ('c3900004-0000-4000-8000-000000000004', 'c3900002-0000-4000-8000-000000000001', 'c3900003-0000-4000-8000-000000000004', 'octo-1', 'Organization', 'org', true);

-- ---------------------------------------------------------------------------
-- connections.mode
-- ---------------------------------------------------------------------------
select col_type_is('public', 'connections', 'mode', 'connection_mode', 'connections.mode is a connection_mode');
select col_is_null('public', 'connections', 'mode', 'connections.mode is nullable: every provider but Stripe has none, and a pending Stripe connection none yet');
select enum_has_labels('public', 'connection_mode', array['live', 'test'], 'connection_mode is live or test, in that order');
select ok(
  has_column_privilege('authenticated', 'public.connections', 'mode', 'select'),
  'members read mode with the rest of their connection row');
select ok(
  not has_column_privilege('authenticated', 'public.connections', 'mode', 'update')
    and not has_column_privilege('authenticated', 'public.connections', 'mode', 'insert'),
  'nobody writes mode through the Data API');

-- ---------------------------------------------------------------------------
-- list_webhook_targets
-- ---------------------------------------------------------------------------
select set_has(
  $$ select a.name, a.type::regtype::text
     from pg_catalog.pg_proc p,
       unnest(p.proargnames, p.proallargtypes, p.proargmodes::text[]) as a(name, type, mode)
     where p.oid = 'public.list_webhook_targets(public.provider_id, text, uuid, text)'::regprocedure and a.mode = 't' $$,
  $$ values ('workspace_id', 'uuid'), ('connection_id', 'uuid'), ('account_id', 'uuid'),
            ('granted_at', 'timestamp with time zone'), ('simulated', 'boolean'), ('mode', 'connection_mode') $$,
  'list_webhook_targets: the result keeps every column callers before #481 read, by name and type, and has `mode`');
select is(
  (select count(*)::int from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'list_webhook_targets'),
  1,
  'list_webhook_targets: one function, so a call naming only the older parameters is never ambiguous');
select ok(
  has_function_privilege('service_role', 'public.list_webhook_targets(public.provider_id, text, uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.list_webhook_targets(public.provider_id, text, uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.list_webhook_targets(public.provider_id, text, uuid, text)', 'execute'),
  'list_webhook_targets: only the service role can still execute it');
select results_eq(
  $$ select connection_id, mode from public.list_webhook_targets('stripe', 'acct_1') $$,
  $$ values ('c3900003-0000-4000-8000-000000000001'::uuid, 'live'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000002'::uuid, 'test'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000003'::uuid, 'test'::public.connection_mode) $$,
  'account: every target of the account with its mode, a needs_attention one too (the job keeps one mode)');
select results_eq(
  $$ select connection_id, mode from public.list_webhook_targets('stripe', p_installation_id => 'inst-1') $$,
  $$ values ('c3900003-0000-4000-8000-000000000001'::uuid, 'live'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000002'::uuid, 'test'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000003'::uuid, 'test'::public.connection_mode) $$,
  'installation: each connection with its mode, as on the account match');
select results_eq(
  $$ select connection_id, mode from public.list_webhook_targets('stripe', 'acct_1', p_installation_id => 'inst-1') $$,
  $$ values ('c3900003-0000-4000-8000-000000000001'::uuid, 'live'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000002'::uuid, 'test'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000003'::uuid, 'test'::public.connection_mode) $$,
  'account and installation: each target with its mode (#497 and #481 together)');
select results_eq(
  $$ select connection_id, mode from public.list_webhook_targets('github', 'octo-1') $$,
  $$ values ('c3900003-0000-4000-8000-000000000004'::uuid, null::public.connection_mode) $$,
  'another provider: its target has no mode (boundary: null), and its deliveries name none');

select * from finish();

rollback;
