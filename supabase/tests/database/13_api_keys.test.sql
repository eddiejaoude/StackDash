-- Public REST API keys (#162): a key of workspace A can never read workspace B through any API read
-- function, a key reads only what its scopes allow, revoked keys and keys whose creator left read
-- nothing, and the key table is managed by owners and admins without ever exposing token_hash.
-- The API runs these functions as the service role, so they are called as service_role here.
begin;

create extension if not exists pgtap with schema extensions;

select plan(57);

-- Test helpers, rolled back with the transaction.
create schema api_test;
grant usage on schema api_test to anon, authenticated, service_role;

-- The digest the app stores: SHA-256 hex of the key text (src/lib/api/keys.ts, hashApiKey).
create function api_test.hash(p_key text)
returns text
language sql
immutable
as $fn$
  select encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
$fn$;

-- Rows a statement touched, or -1 when Postgres refused it (42501), as in 01_tenant_isolation.
create function api_test.affected(p_sql text)
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

grant execute on function api_test.hash(text) to anon, authenticated, service_role;
grant execute on function api_test.affected(text) to anon, authenticated, service_role;

-- Total rows every API read function returns for one key, for "reads nothing" checks.
create function api_test.rows_for(p_key text)
returns bigint
language sql
as $fn$
  select
    (select count(*) from public.api_workspaces(api_test.hash(p_key)))
    + (select count(*) from public.api_projects(api_test.hash(p_key), null, null, 100))
    + (select count(*) from public.api_connections(api_test.hash(p_key), null, null, 100))
    + (select count(*) from public.api_usage_snapshots(api_test.hash(p_key), null, null, null, null, null, null, null, null, null, 100))
    + (select count(*) from public.api_activity_events(api_test.hash(p_key), null, null, null, null, null, null, null, 100))
    + (select count(*) from public.api_triggered_alerts(api_test.hash(p_key), null, null, null, 100))
$fn$;

grant execute on function api_test.rows_for(text) to service_role;

-- ── Fixtures, as postgres ──────────────────────────────────────────────────────
-- Users: owner, admin, and viewer of workspace A; owner of workspace B.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('a1620000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'api-owner-a@example.com', '{"user_name": "api-owner-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a1620000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'api-admin-a@example.com', '{"user_name": "api-admin-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a1620000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'api-viewer-a@example.com', '{"user_name": "api-viewer-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('b1620000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'api-owner-b@example.com', '{"user_name": "api-owner-b"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('a1620000-0000-4000-8000-000000000010', 'API workspace A', 'a1620000-0000-4000-8000-000000000001'),
  ('b1620000-0000-4000-8000-000000000010', 'API workspace B', 'b1620000-0000-4000-8000-000000000001');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('a1620000-0000-4000-8000-000000000010', 'a1620000-0000-4000-8000-000000000001', 'owner'),
  ('a1620000-0000-4000-8000-000000000010', 'a1620000-0000-4000-8000-000000000002', 'admin'),
  ('a1620000-0000-4000-8000-000000000010', 'a1620000-0000-4000-8000-000000000003', 'viewer'),
  ('b1620000-0000-4000-8000-000000000010', 'b1620000-0000-4000-8000-000000000001', 'owner');

-- One row per API resource in each workspace. Workspace A has a second, newer project for paging.
insert into public.projects (id, workspace_id, name, created_at)
values
  ('a1620000-0000-4000-8000-000000000011', 'a1620000-0000-4000-8000-000000000010', 'Project A', timestamptz '2026-10-01 09:00:00+00'),
  ('a1620000-0000-4000-8000-000000000018', 'a1620000-0000-4000-8000-000000000010', 'Project A2', timestamptz '2026-10-02 09:00:00+00'),
  ('b1620000-0000-4000-8000-000000000011', 'b1620000-0000-4000-8000-000000000010', 'Project B', timestamptz '2026-10-01 09:00:00+00');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values
  ('a1620000-0000-4000-8000-000000000012', 'a1620000-0000-4000-8000-000000000010', 'fake', 'active', 'Connection A', 3600),
  ('b1620000-0000-4000-8000-000000000012', 'b1620000-0000-4000-8000-000000000010', 'fake', 'active', 'Connection B', 3600);

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind, project_id)
values
  ('a1620000-0000-4000-8000-000000000013', 'a1620000-0000-4000-8000-000000000010', 'a1620000-0000-4000-8000-000000000012',
   'ext-a', 'Account A', 'team', 'a1620000-0000-4000-8000-000000000011'),
  ('b1620000-0000-4000-8000-000000000013', 'b1620000-0000-4000-8000-000000000010', 'b1620000-0000-4000-8000-000000000012',
   'ext-b', 'Account B', 'team', 'b1620000-0000-4000-8000-000000000011');

insert into public.usage_snapshots (
  id, workspace_id, connection_id, external_account_id, metric_key, kind, label, snapshot_date,
  amount_minor, currency, period_start, period_end, retrieved_at, provenance_source
)
values
  ('a1620000-0000-4000-8000-000000000014', 'a1620000-0000-4000-8000-000000000010', 'a1620000-0000-4000-8000-000000000012',
   'a1620000-0000-4000-8000-000000000013', 'fake.spend', 'verified_spend', 'Spend A', date '2026-10-01',
   1234, 'USD', timestamptz '2026-10-01 00:00:00+00', timestamptz '2026-11-01 00:00:00+00', now(), 'provider_api'),
  ('b1620000-0000-4000-8000-000000000014', 'b1620000-0000-4000-8000-000000000010', 'b1620000-0000-4000-8000-000000000012',
   'b1620000-0000-4000-8000-000000000013', 'fake.spend', 'verified_spend', 'Spend B', date '2026-10-01',
   5678, 'USD', timestamptz '2026-10-01 00:00:00+00', timestamptz '2026-11-01 00:00:00+00', now(), 'provider_api');

insert into public.activity_events (id, workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key)
values
  ('a1620000-0000-4000-8000-000000000015', 'a1620000-0000-4000-8000-000000000010', 'a1620000-0000-4000-8000-000000000012',
   'a1620000-0000-4000-8000-000000000013', 'fake', 'fake.deployment', 'info', 'Event A', now(), 'api-event-a'),
  ('b1620000-0000-4000-8000-000000000015', 'b1620000-0000-4000-8000-000000000010', 'b1620000-0000-4000-8000-000000000012',
   'b1620000-0000-4000-8000-000000000013', 'fake', 'fake.deployment', 'info', 'Event B', now(), 'api-event-b');

insert into public.alert_rules (id, workspace_id, kind, scope, metric_key, threshold_percent)
values
  ('a1620000-0000-4000-8000-000000000016', 'a1620000-0000-4000-8000-000000000010', 'allowance_percent', 'workspace', 'fake.minutes', 80),
  ('b1620000-0000-4000-8000-000000000016', 'b1620000-0000-4000-8000-000000000010', 'allowance_percent', 'workspace', 'fake.minutes', 80);

insert into public.triggered_alerts (id, workspace_id, rule_id, cycle_key, threshold_label, is_estimated, message)
values
  ('a1620000-0000-4000-8000-000000000017', 'a1620000-0000-4000-8000-000000000010', 'a1620000-0000-4000-8000-000000000016',
   '2026-10-01', '80%', false, 'Alert A'),
  ('b1620000-0000-4000-8000-000000000017', 'b1620000-0000-4000-8000-000000000010', 'b1620000-0000-4000-8000-000000000016',
   '2026-10-01', '80%', false, 'Alert B');

-- Keys: workspace A has a full key, a usage-only key, a revoked key, and a key made by the admin
-- (who leaves the workspace below); workspace B has one full key.
insert into public.api_keys (id, workspace_id, name, token_hash, token_prefix, scopes, created_by, revoked_at)
values
  ('a1620000-0000-4000-8000-000000000020', 'a1620000-0000-4000-8000-000000000010', 'Full A',
   api_test.hash('pgtap-api-key-a'), 'sd_pgtapKyA', '{usage:read,events:read,alerts:read,connections:read}',
   'a1620000-0000-4000-8000-000000000001', null),
  ('a1620000-0000-4000-8000-000000000021', 'a1620000-0000-4000-8000-000000000010', 'Usage A',
   api_test.hash('pgtap-api-key-a-usage'), 'sd_pgtapKyU', '{usage:read}',
   'a1620000-0000-4000-8000-000000000001', null),
  ('a1620000-0000-4000-8000-000000000022', 'a1620000-0000-4000-8000-000000000010', 'Revoked A',
   api_test.hash('pgtap-api-key-a-revoked'), 'sd_pgtapKyR', '{usage:read,events:read,alerts:read,connections:read}',
   'a1620000-0000-4000-8000-000000000001', now()),
  ('a1620000-0000-4000-8000-000000000023', 'a1620000-0000-4000-8000-000000000010', 'Admin A',
   api_test.hash('pgtap-api-key-a-admin'), 'sd_pgtapKyD', '{usage:read,events:read,alerts:read,connections:read}',
   'a1620000-0000-4000-8000-000000000002', null),
  ('b1620000-0000-4000-8000-000000000020', 'b1620000-0000-4000-8000-000000000010', 'Full B',
   api_test.hash('pgtap-api-key-b'), 'sd_pgtapKyB', '{usage:read,events:read,alerts:read,connections:read}',
   'b1620000-0000-4000-8000-000000000001', null);

-- ---------------------------------------------------------------------------
-- authenticate_api_key: the one key check.
-- ---------------------------------------------------------------------------
set local role service_role;

select is((select status from public.authenticate_api_key(api_test.hash('pgtap-api-key-a'))), 'valid',
  'authenticate: a working key is valid');
select is((select request_count from public.authenticate_api_key(api_test.hash('pgtap-api-key-a'))), 2,
  'authenticate: every request in the same minute window is counted');
select isnt((select last_used_at from public.api_keys where id = 'a1620000-0000-4000-8000-000000000020'), null,
  'authenticate: a valid request records last_used_at');
select is((select status from public.authenticate_api_key(api_test.hash('pgtap-api-key-a-revoked'))), 'revoked',
  'authenticate: a revoked key is reported as revoked');
select is_empty($$ select key_id from public.api_key_request_windows where key_id = 'a1620000-0000-4000-8000-000000000022' $$,
  'authenticate: a revoked key is never counted against the rate limit');
select is_empty($$ select status from public.authenticate_api_key(api_test.hash('pgtap-api-key-unknown')) $$,
  'authenticate: an unknown key returns no row');
select is((select status from public.authenticate_api_key(api_test.hash('pgtap-api-key-a-admin'))), 'valid',
  'authenticate control: the admin''s key works while the admin is a member');

reset role;
delete from public.workspace_members
where workspace_id = 'a1620000-0000-4000-8000-000000000010' and user_id = 'a1620000-0000-4000-8000-000000000002';
set local role service_role;

select is((select status from public.authenticate_api_key(api_test.hash('pgtap-api-key-a-admin'))), 'creator_left',
  'authenticate: a key stops working when the member who created it leaves the workspace');

-- ---------------------------------------------------------------------------
-- Isolation: each read function returns exactly its key's workspace rows.
-- ---------------------------------------------------------------------------
select results_eq($$ select id from public.api_workspaces(api_test.hash('pgtap-api-key-a')) $$,
  $$ values ('a1620000-0000-4000-8000-000000000010'::uuid) $$,
  'isolation workspaces: a key of workspace A reads workspace A only');
select results_eq($$ select id from public.api_workspaces(api_test.hash('pgtap-api-key-b')) $$,
  $$ values ('b1620000-0000-4000-8000-000000000010'::uuid) $$,
  'isolation workspaces: a key of workspace B reads workspace B only');
select results_eq($$ select id from public.api_projects(api_test.hash('pgtap-api-key-a'), null, null, 100) $$,
  $$ values ('a1620000-0000-4000-8000-000000000011'::uuid), ('a1620000-0000-4000-8000-000000000018'::uuid) $$,
  'isolation projects: a key of workspace A reads workspace A projects only, oldest first');
select results_eq($$ select id from public.api_projects(api_test.hash('pgtap-api-key-b'), null, null, 100) $$,
  $$ values ('b1620000-0000-4000-8000-000000000011'::uuid) $$,
  'isolation projects: a key of workspace B reads workspace B projects only');
select results_eq($$ select id from public.api_connections(api_test.hash('pgtap-api-key-a'), null, null, 100) $$,
  $$ values ('a1620000-0000-4000-8000-000000000012'::uuid) $$,
  'isolation connections: a key of workspace A reads workspace A connections only');
select results_eq($$ select id from public.api_connections(api_test.hash('pgtap-api-key-b'), null, null, 100) $$,
  $$ values ('b1620000-0000-4000-8000-000000000012'::uuid) $$,
  'isolation connections: a key of workspace B reads workspace B connections only');
select results_eq(
  $$ select id from public.api_usage_snapshots(api_test.hash('pgtap-api-key-a'), null, null, null, null, null, null, null, null, null, 100) $$,
  $$ values ('a1620000-0000-4000-8000-000000000014'::uuid) $$,
  'isolation usage snapshots: a key of workspace A reads workspace A snapshots only');
select results_eq(
  $$ select id from public.api_usage_snapshots(api_test.hash('pgtap-api-key-b'), null, null, null, null, null, null, null, null, null, 100) $$,
  $$ values ('b1620000-0000-4000-8000-000000000014'::uuid) $$,
  'isolation usage snapshots: a key of workspace B reads workspace B snapshots only');
select results_eq(
  $$ select id from public.api_activity_events(api_test.hash('pgtap-api-key-a'), null, null, null, null, null, null, null, 100) $$,
  $$ values ('a1620000-0000-4000-8000-000000000015'::uuid) $$,
  'isolation events: a key of workspace A reads workspace A events only');
select results_eq(
  $$ select id from public.api_activity_events(api_test.hash('pgtap-api-key-b'), null, null, null, null, null, null, null, 100) $$,
  $$ values ('b1620000-0000-4000-8000-000000000015'::uuid) $$,
  'isolation events: a key of workspace B reads workspace B events only');
select results_eq($$ select id from public.api_triggered_alerts(api_test.hash('pgtap-api-key-a'), null, null, null, 100) $$,
  $$ values ('a1620000-0000-4000-8000-000000000017'::uuid) $$,
  'isolation triggered alerts: a key of workspace A reads workspace A alerts only');
select results_eq($$ select id from public.api_triggered_alerts(api_test.hash('pgtap-api-key-b'), null, null, null, 100) $$,
  $$ values ('b1620000-0000-4000-8000-000000000017'::uuid) $$,
  'isolation triggered alerts: a key of workspace B reads workspace B alerts only');

-- Naming another workspace's rows in a filter finds nothing.
select is_empty(
  $$ select id from public.api_usage_snapshots(api_test.hash('pgtap-api-key-a'), null, null, null, null, null,
       'b1620000-0000-4000-8000-000000000012', null, null, null, 100) $$,
  'isolation usage snapshots: a key of workspace A filtering on a workspace B connection reads nothing');
select is_empty(
  $$ select id from public.api_usage_snapshots(api_test.hash('pgtap-api-key-a'), null, null, null, null, null,
       null, 'b1620000-0000-4000-8000-000000000011', null, null, 100) $$,
  'isolation usage snapshots: a key of workspace A filtering on a workspace B project reads nothing');

-- ---------------------------------------------------------------------------
-- Scopes: a usage-only key.
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select id from public.api_usage_snapshots(api_test.hash('pgtap-api-key-a-usage'), null, null, null, null, null, null, null, null, null, 100) $$,
  $$ values ('a1620000-0000-4000-8000-000000000014'::uuid) $$,
  'scopes: a usage:read key reads usage snapshots');
select is_empty(
  $$ select id from public.api_activity_events(api_test.hash('pgtap-api-key-a-usage'), null, null, null, null, null, null, null, 100) $$,
  'scopes: a key without events:read reads no events');
select is_empty($$ select id from public.api_triggered_alerts(api_test.hash('pgtap-api-key-a-usage'), null, null, null, 100) $$,
  'scopes: a key without alerts:read reads no triggered alerts');
select is_empty($$ select id from public.api_connections(api_test.hash('pgtap-api-key-a-usage'), null, null, 100) $$,
  'scopes: a key without connections:read reads no connections');
select results_eq($$ select id from public.api_workspaces(api_test.hash('pgtap-api-key-a-usage')) $$,
  $$ values ('a1620000-0000-4000-8000-000000000010'::uuid) $$,
  'scopes: any working key reads its workspace');
select is((select count(*) from public.api_projects(api_test.hash('pgtap-api-key-a-usage'), null, null, 100)), 2::bigint,
  'scopes: any working key reads its projects');

-- ---------------------------------------------------------------------------
-- Keys that must not work read nothing anywhere.
-- ---------------------------------------------------------------------------
select is(api_test.rows_for('pgtap-api-key-a-revoked'), 0::bigint,
  'revoked: a revoked key reads nothing from any API read function');
select is(api_test.rows_for('pgtap-api-key-a-admin'), 0::bigint,
  'creator left: a key whose creator left reads nothing from any API read function');

-- ---------------------------------------------------------------------------
-- Keyset pagination.
-- ---------------------------------------------------------------------------
select results_eq($$ select id from public.api_projects(api_test.hash('pgtap-api-key-a'), null, null, 1) $$,
  $$ values ('a1620000-0000-4000-8000-000000000011'::uuid) $$,
  'pagination: the first page of one holds the oldest project');
select results_eq(
  $$ select id from public.api_projects(api_test.hash('pgtap-api-key-a'),
       timestamptz '2026-10-01 09:00:00+00', 'a1620000-0000-4000-8000-000000000011', 1) $$,
  $$ values ('a1620000-0000-4000-8000-000000000018'::uuid) $$,
  'pagination: the page after the cursor starts at the next project');

reset role;

-- ---------------------------------------------------------------------------
-- Grants: the API functions and the counter table are service role only, and
-- token_hash is never readable through the Data API.
-- ---------------------------------------------------------------------------
select is_empty(
  $$
    select r.role || ' ' || f.fn
    from unnest(array['anon', 'authenticated']) as r(role)
    cross join unnest(array[
      'public.authenticate_api_key(text)',
      'public.api_key_workspace(text, public.api_key_scope)',
      'public.api_workspaces(text)',
      'public.api_projects(text, timestamptz, uuid, integer)',
      'public.api_connections(text, timestamptz, uuid, integer)',
      'public.api_usage_snapshots(text, date, date, text, public.metric_kind, public.provider_id, uuid, uuid, date, uuid, integer)',
      'public.api_activity_events(text, timestamptz, timestamptz, text, public.event_severity, public.provider_id, timestamptz, uuid, integer)',
      'public.api_triggered_alerts(text, boolean, timestamptz, uuid, integer)'
    ]) as f(fn)
    where has_function_privilege(r.role, f.fn, 'execute')
  $$,
  'grants: anon and authenticated cannot execute the key check or any API read function');
select ok(not has_column_privilege('authenticated', 'public.api_keys', 'token_hash', 'select'),
  'grants: authenticated cannot read api_keys.token_hash');
select is_empty(
  $$
    select t.role || ' ' || t.tbl || ' ' || p.priv
    from (values ('anon', 'public.api_keys'), ('anon', 'public.api_key_request_windows'),
                 ('authenticated', 'public.api_key_request_windows')) as t(role, tbl)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
    where case
      when p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') then has_any_column_privilege(t.role, t.tbl, p.priv)
      else has_table_privilege(t.role, t.tbl, p.priv)
    end
  $$,
  'grants: anon holds nothing on api_keys, and nobody but the service role touches api_key_request_windows');

-- ---------------------------------------------------------------------------
-- Managing keys through the Data API: owners and admins only (#104).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1620000-0000-4000-8000-000000000001", "role": "authenticated"}';

select results_eq(
  $$ select id from public.api_keys order by id $$,
  $$ values ('a1620000-0000-4000-8000-000000000020'::uuid), ('a1620000-0000-4000-8000-000000000021'::uuid),
            ('a1620000-0000-4000-8000-000000000022'::uuid), ('a1620000-0000-4000-8000-000000000023'::uuid) $$,
  'manage: the owner of A lists the keys of workspace A only');
select throws_ok($$ select token_hash from public.api_keys $$, '42501'::char(5), null::text,
  'manage: the owner of A cannot read token_hash');
select throws_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes)
     values ('b1620000-0000-4000-8000-000000000010', 'Planted', api_test.hash('pgtap-planted'), 'sd_pgtapPln', '{usage:read}') $$,
  '42501'::char(5), null::text,
  'manage: the owner of A cannot create a key in workspace B');
select lives_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes)
     values ('a1620000-0000-4000-8000-000000000010', 'New A', api_test.hash('pgtap-api-key-a-new'), 'sd_pgtapKyN', '{events:read}') $$,
  'manage: the owner of A creates a key in workspace A');
select is((select created_by from public.api_keys where token_prefix = 'sd_pgtapKyN'),
  'a1620000-0000-4000-8000-000000000001'::uuid,
  'manage: a new key is recorded in its creator''s name');
select is(
  api_test.affected($$ update public.api_keys set revoked_at = timestamptz '2000-01-01 00:00:00+00'
                       where token_prefix = 'sd_pgtapKyN' $$),
  1,
  'manage: the owner of A revokes a key of workspace A');
select is(
  (select array[revoked_at = now(), revoked_by = 'a1620000-0000-4000-8000-000000000001'::uuid]
   from public.api_keys where token_prefix = 'sd_pgtapKyN'),
  array[true, true],
  'manage: the database stamps the revoke time and who revoked it, whatever the caller sent');
select throws_ok(
  $$ update public.api_keys set revoked_at = null where token_prefix = 'sd_pgtapKyN' $$,
  '23514'::char(5), null::text,
  'manage: a revoked key cannot be brought back');
select throws_ok($$ update public.api_keys set name = 'Renamed' where id = 'a1620000-0000-4000-8000-000000000020' $$,
  '42501'::char(5), null::text,
  'manage: only revoked_at is writable, so a key''s name and scopes are fixed');
select throws_ok($$ delete from public.api_keys where id = 'a1620000-0000-4000-8000-000000000020' $$,
  '42501'::char(5), null::text,
  'manage: keys are revoked, never deleted, through the Data API');

set local request.jwt.claims to '{"sub": "a1620000-0000-4000-8000-000000000003", "role": "authenticated"}';

select is_empty($$ select id from public.api_keys $$,
  'manage: a viewer of A cannot list the keys of workspace A');
select throws_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes)
     values ('a1620000-0000-4000-8000-000000000010', 'Viewer key', api_test.hash('pgtap-viewer'), 'sd_pgtapVwr', '{usage:read}') $$,
  '42501'::char(5), null::text,
  'manage: a viewer cannot create a key');
select cmp_ok(
  api_test.affected($$ update public.api_keys set revoked_at = now() where id = 'a1620000-0000-4000-8000-000000000020' $$),
  '<=', 0,
  'manage: a viewer cannot revoke a key');

set local request.jwt.claims to '{"sub": "b1620000-0000-4000-8000-000000000001", "role": "authenticated"}';

select results_eq($$ select id from public.api_keys $$,
  $$ values ('b1620000-0000-4000-8000-000000000020'::uuid) $$,
  'manage: the owner of B lists the keys of workspace B only');

-- ---------------------------------------------------------------------------
-- The limit of 20 keys that are not revoked per workspace (api_keys_enforce_limit).
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes)
     values ('b1620000-0000-4000-8000-000000000010', 'New B', api_test.hash('pgtap-api-key-b-new'), 'sd_pgtapKyM', '{usage:read}') $$,
  'limit: the owner of B creates a key in workspace B');

set local request.jwt.claims to '{"sub": "a1620000-0000-4000-8000-000000000001", "role": "authenticated"}';

-- Workspace A holds 3 keys that are not revoked: Full A, Usage A, and Admin A, whose creator left
-- but which still counts until it is revoked. 17 more reach the limit.
select lives_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes)
     select 'a1620000-0000-4000-8000-000000000010', 'Cap ' || i, api_test.hash('pgtap-cap-' || i),
            'sd_pgtapC' || lpad(i::text, 2, '0'), '{usage:read}'
     from generate_series(1, 17) as i $$,
  'limit: an admin creates keys up to the 20th that is not revoked');
select throws_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes)
     values ('a1620000-0000-4000-8000-000000000010', 'Cap 18', api_test.hash('pgtap-cap-18'), 'sd_pgtapC18', '{usage:read}') $$,
  '54000'::char(5), null::text,
  'limit: a 21st key that is not revoked is refused with program_limit_exceeded');

-- Workspace A is now full. A signed-in caller who is not an admin of it is not counted: row level
-- security answers them, as for a workspace under the limit, and the count (and its lock) is skipped.
set local request.jwt.claims to '{"sub": "b1620000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes)
     values ('a1620000-0000-4000-8000-000000000010', 'Planted', api_test.hash('pgtap-planted-full'), 'sd_pgtapPlF', '{usage:read}') $$,
  '42501'::char(5), null::text,
  'limit: the owner of B gets insufficient_privilege, not the limit, for a full workspace A');
set local request.jwt.claims to '{"sub": "a1620000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes)
     values ('a1620000-0000-4000-8000-000000000010', 'Viewer key', api_test.hash('pgtap-viewer-full'), 'sd_pgtapVwF', '{usage:read}') $$,
  '42501'::char(5), null::text,
  'limit: a viewer of A gets insufficient_privilege, not the limit, for a full workspace A');

-- The service role has no auth.uid() and is always counted.
reset role;
reset request.jwt.claims;
select throws_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes, created_by)
     values ('a1620000-0000-4000-8000-000000000010', 'Service key', api_test.hash('pgtap-service-full'), 'sd_pgtapSvF', '{usage:read}',
             'a1620000-0000-4000-8000-000000000001') $$,
  '54000'::char(5), null::text,
  'limit: the service role is counted too, so a 21st key is refused without a signed-in user');

set local role authenticated;
set local request.jwt.claims to '{"sub": "a1620000-0000-4000-8000-000000000001", "role": "authenticated"}';

update public.api_keys set revoked_at = now() where token_prefix = 'sd_pgtapC01';

select lives_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes)
     values ('a1620000-0000-4000-8000-000000000010', 'Cap 18', api_test.hash('pgtap-cap-18'), 'sd_pgtapC18', '{usage:read}') $$,
  'limit: revoking a key frees its place');

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Scopes check: at least one scope, with no upper bound tied to the enum's size.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes, created_by)
     values ('b1620000-0000-4000-8000-000000000010', 'No scopes', api_test.hash('pgtap-no-scopes'), 'sd_pgtapNoS', '{}',
             'b1620000-0000-4000-8000-000000000001') $$,
  '23514'::char(5), null::text,
  'scopes check: a key with no scopes is refused');

select * from finish();

rollback;
