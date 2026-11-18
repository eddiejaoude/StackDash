-- The mode of each connection, live or test (#481, 20261118150000_connection_mode.sql and
-- 20261118150100_connection_mode_backfill.sql): connections.mode is a nullable connection_mode
-- members read and nobody writes through the Data API; list_webhook_targets returns it as a column
-- of its result, on the account match, the installation match, and both, null where none is
-- recorded, beside every column callers before #481 read, with the parameters and grants unchanged;
-- backfill_connection_mode fills a Stripe connection's mode from its authorized account label,
-- batched and re-runnable, and never overwrites a recorded mode or touches another provider, a
-- pending connection, or one with no label.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS).
begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

-- Fixtures: one workspace. Stripe account acct_1 is included by a live and a test mode connection
-- of installation inst-1, and by a connection with no recorded mode. The backfill rows below have
-- no mode yet: a live label, a test mode label, the simulated test mode label, a label recorded
-- already (live), no label, a pending one, and a GitHub one with a test mode looking label.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c3900001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'mode-owner@example.com', '{"user_name": "mode-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values ('c3900002-0000-4000-8000-000000000001', 'Connection modes', 'c3900001-0000-4000-8000-000000000001');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds, external_installation_id, mode, authorized_account_label)
values
  ('c3900003-0000-4000-8000-000000000001', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'active', 'Live', 3600, 'inst-1', 'live', null),
  ('c3900003-0000-4000-8000-000000000002', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'failed', 'Test', 3600, 'inst-1', 'test', null),
  ('c3900003-0000-4000-8000-000000000003', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'needs_attention', 'No mode', 3600, 'inst-1', null, null),
  ('c3900003-0000-4000-8000-000000000011', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'active', 'Backfill live', 3600, null, null,
   'Stripe account acct_2'),
  ('c3900003-0000-4000-8000-000000000012', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'failed', 'Backfill test', 3600, null, null,
   'Stripe account acct_2 (test mode)'),
  ('c3900003-0000-4000-8000-000000000013', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'active', 'Backfill simulated', 3600, null, null,
   'Example Stripe account (test mode)'),
  ('c3900003-0000-4000-8000-000000000014', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'active', 'Recorded', 3600, null, 'live',
   'Stripe account acct_3 (test mode)'),
  ('c3900003-0000-4000-8000-000000000015', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'active', 'No label', 3600, null, null, null),
  ('c3900003-0000-4000-8000-000000000016', 'c3900002-0000-4000-8000-000000000001', 'stripe', 'pending', 'Pending', 3600, null, null,
   'Stripe account acct_4 (test mode)'),
  ('c3900003-0000-4000-8000-000000000017', 'c3900002-0000-4000-8000-000000000001', 'github', 'active', 'Other provider', 3600, null, null,
   'octo (test mode)');

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind, included)
values
  ('c3900004-0000-4000-8000-000000000001', 'c3900002-0000-4000-8000-000000000001', 'c3900003-0000-4000-8000-000000000001', 'acct_1', 'Account', 'account', true),
  ('c3900004-0000-4000-8000-000000000002', 'c3900002-0000-4000-8000-000000000001', 'c3900003-0000-4000-8000-000000000002', 'acct_1', 'Account', 'account', true),
  ('c3900004-0000-4000-8000-000000000003', 'c3900002-0000-4000-8000-000000000001', 'c3900003-0000-4000-8000-000000000003', 'acct_1', 'Account', 'account', true);

-- ---------------------------------------------------------------------------
-- connections.mode
-- ---------------------------------------------------------------------------
select col_type_is('public', 'connections', 'mode', 'connection_mode', 'connections.mode is a connection_mode');
select col_is_null('public', 'connections', 'mode', 'connections.mode is nullable: every provider but Stripe has none');
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
            ('c3900003-0000-4000-8000-000000000003'::uuid, null::public.connection_mode) $$,
  'account: every target of the account, each with its mode, null where none is recorded (the job keeps one mode)');
select results_eq(
  $$ select connection_id, mode from public.list_webhook_targets('stripe', p_installation_id => 'inst-1') $$,
  $$ values ('c3900003-0000-4000-8000-000000000001'::uuid, 'live'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000002'::uuid, 'test'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000003'::uuid, null::public.connection_mode) $$,
  'installation: each connection with its mode, as on the account match');
select results_eq(
  $$ select connection_id, mode from public.list_webhook_targets('stripe', 'acct_1', p_installation_id => 'inst-1') $$,
  $$ values ('c3900003-0000-4000-8000-000000000001'::uuid, 'live'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000002'::uuid, 'test'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000003'::uuid, null::public.connection_mode) $$,
  'account and installation: each target with its mode (#497 and #481 together)');

-- ---------------------------------------------------------------------------
-- backfill_connection_mode
-- ---------------------------------------------------------------------------
select ok(
  has_function_privilege('service_role', 'public.backfill_connection_mode(int)', 'execute')
    and not has_function_privilege('anon', 'public.backfill_connection_mode(int)', 'execute')
    and not has_function_privilege('authenticated', 'public.backfill_connection_mode(int)', 'execute'),
  'backfill_connection_mode: only the service role can execute it');
select throws_ok(
  $$ select public.backfill_connection_mode(0) $$,
  '22023', 'p_limit must be between 1 and 10000',
  'backfill_connection_mode: refuses a limit of zero (boundary)');
select is(public.backfill_connection_mode(1), 1, 'backfill_connection_mode: fills at most p_limit connections in one call (boundary: one)');
select is(public.backfill_connection_mode(1000), 2, 'backfill_connection_mode: the next call fills the rest');
select is(public.backfill_connection_mode(1000), 0, 'backfill_connection_mode: running it again changes nothing (re-runnable)');
select results_eq(
  $$ select id, mode from public.connections
     where id in ('c3900003-0000-4000-8000-000000000011', 'c3900003-0000-4000-8000-000000000012', 'c3900003-0000-4000-8000-000000000013',
                  'c3900003-0000-4000-8000-000000000014')
     order by id $$,
  $$ values ('c3900003-0000-4000-8000-000000000011'::uuid, 'live'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000012'::uuid, 'test'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000013'::uuid, 'test'::public.connection_mode),
            ('c3900003-0000-4000-8000-000000000014'::uuid, 'live'::public.connection_mode) $$,
  'backfill_connection_mode: a test mode label is test and any other is live; a recorded mode is never overwritten');
select is_empty(
  $$ select id from public.connections
     where id in ('c3900003-0000-4000-8000-000000000015', 'c3900003-0000-4000-8000-000000000016', 'c3900003-0000-4000-8000-000000000017')
       and mode is not null $$,
  'backfill_connection_mode: leaves a connection with no label, a pending one, and another provider''s null (boundary)');

select * from finish();

rollback;
