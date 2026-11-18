-- A webhook uninstall that names an installation (#480): list_webhook_targets matches
-- p_installation_id against connections.external_installation_id on live connections of the
-- provider only, one row per connection with no account, and only the endpoint's own connection for
-- a per-connection URL; exactly one of p_external_id and p_installation_id is required, and a call
-- naming only the parameters code before #480 sends still works; an index serves the lookup;
-- record_webhook_delivery accepts an uninstall naming an account (with or without `by`) or an
-- installation and refuses one naming neither; members read external_installation_id and nobody
-- writes it through the Data API; granted_at is the column alone on the installation match too
-- (#502).
-- Rows are seeded as postgres (the migration owner, which bypasses RLS).
begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

-- Fixtures: workspaces A and B. Installation inst-1 on fake connections: A active (with an
-- included account), A failed, B needs_attention (no accounts), A pending, A revoked; inst-1 on
-- a GitHub connection in B; inst-2 on a fake connection in B; a fake connection with no
-- installation in A. One endpoint on A's active connection.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c3300001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'installation-owner@example.com', '{"user_name": "installation-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('c3300002-0000-4000-8000-000000000001', 'Installations A', 'c3300001-0000-4000-8000-000000000001'),
  ('c3300002-0000-4000-8000-000000000002', 'Installations B', 'c3300001-0000-4000-8000-000000000001');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('c3300002-0000-4000-8000-000000000001', 'c3300001-0000-4000-8000-000000000001', 'owner'),
  ('c3300002-0000-4000-8000-000000000002', 'c3300001-0000-4000-8000-000000000001', 'owner');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds, external_installation_id, granted_at)
values
  ('c3300003-0000-4000-8000-000000000001', 'c3300002-0000-4000-8000-000000000001', 'fake', 'active', 'A active', 3600, 'inst-1', '2026-11-16T08:00:00Z'),
  ('c3300003-0000-4000-8000-000000000002', 'c3300002-0000-4000-8000-000000000001', 'fake', 'failed', 'A failed', 3600, 'inst-1', null),
  ('c3300003-0000-4000-8000-000000000003', 'c3300002-0000-4000-8000-000000000002', 'fake', 'needs_attention', 'B reconnect', 3600, 'inst-1', null),
  ('c3300003-0000-4000-8000-000000000004', 'c3300002-0000-4000-8000-000000000001', 'fake', 'pending', 'A pending', 3600, 'inst-1', null),
  ('c3300003-0000-4000-8000-000000000005', 'c3300002-0000-4000-8000-000000000001', 'fake', 'revoked', 'A revoked', 3600, 'inst-1', null),
  ('c3300003-0000-4000-8000-000000000006', 'c3300002-0000-4000-8000-000000000002', 'github', 'active', 'B GitHub', 3600, 'inst-1', null),
  ('c3300003-0000-4000-8000-000000000007', 'c3300002-0000-4000-8000-000000000002', 'fake', 'active', 'B other installation', 3600, 'inst-2', null),
  ('c3300003-0000-4000-8000-000000000008', 'c3300002-0000-4000-8000-000000000001', 'fake', 'active', 'A no installation', 3600, null, null);

-- An account whose external id equals the installation id: the installation form never reads it.
insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind, included)
values
  ('c3300004-0000-4000-8000-000000000001', 'c3300002-0000-4000-8000-000000000001', 'c3300003-0000-4000-8000-000000000001', 'acct-1', 'Account', 'team', true),
  ('c3300004-0000-4000-8000-000000000002', 'c3300002-0000-4000-8000-000000000001', 'c3300003-0000-4000-8000-000000000008', 'inst-1', 'Lookalike', 'team', true);

insert into public.webhook_endpoints (id, workspace_id, connection_id, provider, key_id, iv, ciphertext, auth_tag)
values
  ('c3300005-0000-4000-8000-000000000001', 'c3300002-0000-4000-8000-000000000001', 'c3300003-0000-4000-8000-000000000001',
   'fake', 'deadbeef', '\x00'::bytea, '\x01'::bytea, '\x02'::bytea);

-- A's active connection has a recorded grant (08:00) and a credential saved later (09:00), which
-- must not move its grant time; A's failed connection has no recorded grant but a credential; B's
-- needs_attention one has neither.
insert into public.connection_credentials (connection_id, workspace_id, key_id, iv, ciphertext, auth_tag, updated_at)
values
  ('c3300003-0000-4000-8000-000000000001', 'c3300002-0000-4000-8000-000000000001', 'deadbeef',
   '\x00'::bytea, '\x01'::bytea, '\x02'::bytea, '2026-11-16T09:00:00Z'),
  ('c3300003-0000-4000-8000-000000000002', 'c3300002-0000-4000-8000-000000000001', 'deadbeef',
   '\x00'::bytea, '\x01'::bytea, '\x02'::bytea, '2026-11-12T10:00:00Z');

-- ---------------------------------------------------------------------------
-- The index and the grants
-- ---------------------------------------------------------------------------
select ok(
  (select pg_catalog.pg_get_indexdef(i.indexrelid) like '%(provider, external_installation_id)%WHERE (external_installation_id IS NOT NULL)%'
   from pg_catalog.pg_index i where i.indexrelid = 'public.connections_provider_installation_idx'::regclass),
  'connections_provider_installation_idx: a partial index on (provider, external_installation_id) for the installation lookup');
select ok(
  has_column_privilege('authenticated', 'public.connections', 'external_installation_id', 'select')
  and not has_column_privilege('authenticated', 'public.connections', 'external_installation_id', 'update')
  and not has_column_privilege('authenticated', 'public.connections', 'external_installation_id', 'insert'),
  'connections.external_installation_id: members read it; the Data API cannot write it, so no member decides which connections an uninstall marks');
select is_empty(
  $$ select r.role from unnest(array['anon', 'authenticated']) as r(role)
     where has_function_privilege(r.role, 'public.list_webhook_targets(public.provider_id, text, uuid, text)', 'execute') $$,
  'list_webhook_targets: anon and authenticated cannot execute it');
select ok(
  has_function_privilege('service_role', 'public.list_webhook_targets(public.provider_id, text, uuid, text)', 'execute'),
  'list_webhook_targets: the service role can execute it');
select is(
  (select count(*)::int from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'list_webhook_targets'),
  1,
  'list_webhook_targets: one function, so a call naming only the older parameters is never ambiguous');

-- ---------------------------------------------------------------------------
-- list_webhook_targets by installation
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select connection_id from public.list_webhook_targets('fake', p_installation_id => 'inst-1') $$,
  $$ values ('c3300003-0000-4000-8000-000000000001'::uuid), ('c3300003-0000-4000-8000-000000000002'::uuid),
            ('c3300003-0000-4000-8000-000000000003'::uuid) $$,
  'installation: every active, failed, and needs_attention connection of the provider with that installation, across workspaces, by connection id');
select is_empty(
  $$ select 1 from public.list_webhook_targets('fake', p_installation_id => 'inst-1')
     where connection_id in ('c3300003-0000-4000-8000-000000000004', 'c3300003-0000-4000-8000-000000000005') $$,
  'installation: pending and revoked connections are no targets (boundary: status)');
select is_empty(
  $$ select 1 from public.list_webhook_targets('fake', p_installation_id => 'inst-1')
     where connection_id = 'c3300003-0000-4000-8000-000000000006' $$,
  'installation: the same installation id on another provider''s connection is not matched (boundary: provider)');
select results_eq(
  $$ select connection_id from public.list_webhook_targets('github', p_installation_id => 'inst-1') $$,
  $$ values ('c3300003-0000-4000-8000-000000000006'::uuid) $$,
  'installation: the other provider finds only its own connection');
select is_empty(
  $$ select 1 from public.list_webhook_targets('fake', p_installation_id => 'inst-9') $$,
  'installation: an unknown installation finds no targets (boundary: no match)');
select is_empty(
  $$ select 1 from public.list_webhook_targets('fake', p_installation_id => 'inst-1')
     where connection_id = 'c3300003-0000-4000-8000-000000000008' $$,
  'installation: an account whose external id equals the installation id is not matched (boundary: forms stay apart)');
select is(
  (select bool_and(account_id is null) from public.list_webhook_targets('fake', p_installation_id => 'inst-1')),
  true,
  'installation: one row per connection with no account, including a connection with no accounts');
select is(
  (select workspace_id::text || ' ' || granted_at::text from public.list_webhook_targets('fake', p_installation_id => 'inst-1')
   where connection_id = 'c3300003-0000-4000-8000-000000000001'),
  'c3300002-0000-4000-8000-000000000001 ' || '2026-11-16T08:00:00Z'::timestamptz::text,
  'installation: each target names its workspace and when its connection was granted, which a later credential save does not move (boundary: refresh after grant)');
select results_eq(
  $$ select connection_id from public.list_webhook_targets('fake', p_endpoint_id => 'c3300005-0000-4000-8000-000000000001', p_installation_id => 'inst-1') $$,
  $$ values ('c3300003-0000-4000-8000-000000000001'::uuid) $$,
  'installation: a per-connection delivery reaches only the endpoint''s own connection');
select is(
  (select granted_at from public.list_webhook_targets('fake', p_installation_id => 'inst-1')
   where connection_id = 'c3300003-0000-4000-8000-000000000002'),
  null::timestamptz,
  'installation: a live connection with no recorded grant has no grant time, though it has a credential (boundary: fallback gone, #502)');
select is(
  (select granted_at from public.list_webhook_targets('fake', p_installation_id => 'inst-1')
   where connection_id = 'c3300003-0000-4000-8000-000000000003'),
  null::timestamptz,
  'installation: a live connection with neither a recorded grant nor a credential has no grant time (boundary: no credential)');

-- ---------------------------------------------------------------------------
-- list_webhook_targets by account, as before
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select account_id from public.list_webhook_targets('fake', 'acct-1') $$,
  $$ values ('c3300004-0000-4000-8000-000000000001'::uuid) $$,
  'account: positional p_provider and p_external_id, as code before #480 calls it, still match by account');
select results_eq(
  $$ select account_id from public.list_webhook_targets(p_provider => 'fake', p_external_id => 'acct-1', p_endpoint_id => 'c3300005-0000-4000-8000-000000000001') $$,
  $$ values ('c3300004-0000-4000-8000-000000000001'::uuid) $$,
  'account: the three named parameters PostgREST sends for code before #480 still resolve');
select throws_ok(
  $$ select * from public.list_webhook_targets('fake') $$,
  '22023'::char(5), null::text,
  'targets: naming neither an account nor an installation is refused (boundary: neither)');
select throws_ok(
  $$ select * from public.list_webhook_targets('fake', 'acct-1', p_installation_id => 'inst-1') $$,
  '22023'::char(5), null::text,
  'targets: naming both is refused (boundary: both)');

-- ---------------------------------------------------------------------------
-- record_webhook_delivery: what an uninstall must name
-- ---------------------------------------------------------------------------
select is(
  public.record_webhook_delivery('fake', 'installation-test-account', '{"kind": "uninstalled", "externalAccountId": "acct-1", "occurredAt": "2026-11-16T09:00:00Z"}'::jsonb),
  true,
  'record: an account uninstall without `by`, the shape before #480, is still accepted');
select is(
  public.record_webhook_delivery('fake', 'installation-test-installation',
    '{"kind": "uninstalled", "by": "installation", "installationId": "inst-1", "occurredAt": "2026-11-16T09:00:00Z"}'::jsonb),
  true,
  'record: an installation uninstall is accepted');
select is(
  public.record_webhook_delivery('fake', 'installation-test-by-account',
    '{"kind": "uninstalled", "by": "account", "externalAccountId": "acct-1", "occurredAt": "2026-11-16T09:00:00Z"}'::jsonb),
  true,
  'record: an account uninstall with `by` account is accepted');

-- True when record_webhook_delivery refuses the outcome as an invalid parameter.
create function pg_temp.refuses(p_delivery_id text, p_outcome jsonb)
  returns boolean
  language plpgsql
as $$
begin
  perform public.record_webhook_delivery('fake', p_delivery_id, p_outcome);
  return false;
exception when invalid_parameter_value then
  return true;
end;
$$;

create temporary table refused_uninstalls (name text, outcome jsonb) on commit drop;
insert into refused_uninstalls (name, outcome)
values
  ('empty installation id', '{"kind": "uninstalled", "by": "installation", "installationId": "", "occurredAt": "2026-11-16T09:00:00Z"}'),
  ('installation naming an account', '{"kind": "uninstalled", "by": "installation", "externalAccountId": "acct-1", "occurredAt": "2026-11-16T09:00:00Z"}'),
  ('installation id without by', '{"kind": "uninstalled", "installationId": "inst-1", "occurredAt": "2026-11-16T09:00:00Z"}'),
  ('empty account id', '{"kind": "uninstalled", "externalAccountId": "", "occurredAt": "2026-11-16T09:00:00Z"}'),
  ('non-string account id', '{"kind": "uninstalled", "externalAccountId": 42, "occurredAt": "2026-11-16T09:00:00Z"}'),
  ('unknown by', '{"kind": "uninstalled", "by": "organization", "externalAccountId": "acct-1", "occurredAt": "2026-11-16T09:00:00Z"}');

select results_eq(
  $$ select name, pg_temp.refuses('installation-test-refused-' || name, outcome) from refused_uninstalls order by name $$,
  $$ select name, true from refused_uninstalls order by name $$,
  'record: an uninstall with an empty id, the other form''s id, no `by` for an installation, a non-string id, or an unknown `by` is refused (boundaries)');
select is_empty(
  $$ select 1 from public.webhook_deliveries where delivery_id like 'installation-test-refused-%' $$,
  'record: a refused uninstall stores no delivery');

select * from finish();

rollback;
