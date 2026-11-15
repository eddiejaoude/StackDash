-- Provider webhooks (#28): a delivery is stored once per (provider, delivery id) and queues exactly
-- one webhook job with it; a webhook job always names its delivery and no other job does; a
-- delivery's account maps to included accounts of live connections, only the endpoint's own
-- connection for a per-connection URL; retention deletes old deliveries only, and their jobs with
-- them; the tables and functions are service role only.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS); anon and authenticated
-- are impersonated through the same role and JWT claims PostgREST uses.
begin;

create extension if not exists pgtap with schema extensions;

select plan(40);

-- Fixtures: workspaces A and B, each with an active fake connection that sees account fake-acct-1.
-- A also has a revoked connection and an account that is not included; B a GitHub connection with
-- the same external id, and a needs_attention connection.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c3100001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'webhook-owner-a@example.com', '{"user_name": "webhook-owner-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('c3100001-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'webhook-owner-b@example.com', '{"user_name": "webhook-owner-b"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('c3100002-0000-4000-8000-000000000001', 'Webhooks A', 'c3100001-0000-4000-8000-000000000001'),
  ('c3100002-0000-4000-8000-000000000002', 'Webhooks B', 'c3100001-0000-4000-8000-000000000002');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('c3100002-0000-4000-8000-000000000001', 'c3100001-0000-4000-8000-000000000001', 'owner'),
  ('c3100002-0000-4000-8000-000000000002', 'c3100001-0000-4000-8000-000000000002', 'owner');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values
  ('c3100003-0000-4000-8000-000000000001', 'c3100002-0000-4000-8000-000000000001', 'fake', 'active', 'Fake A', 3600),
  ('c3100003-0000-4000-8000-000000000002', 'c3100002-0000-4000-8000-000000000001', 'fake', 'revoked', 'Fake A revoked', 3600),
  ('c3100003-0000-4000-8000-000000000003', 'c3100002-0000-4000-8000-000000000002', 'fake', 'active', 'Fake B', 3600),
  ('c3100003-0000-4000-8000-000000000004', 'c3100002-0000-4000-8000-000000000002', 'fake', 'needs_attention', 'Fake B reconnect', 3600),
  ('c3100003-0000-4000-8000-000000000005', 'c3100002-0000-4000-8000-000000000002', 'github', 'active', 'GitHub B', 3600);

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind, included)
values
  ('c3100004-0000-4000-8000-000000000001', 'c3100002-0000-4000-8000-000000000001', 'c3100003-0000-4000-8000-000000000001', 'fake-acct-1', 'Account 1', 'team', true),
  ('c3100004-0000-4000-8000-000000000002', 'c3100002-0000-4000-8000-000000000001', 'c3100003-0000-4000-8000-000000000002', 'fake-acct-1', 'Account 1', 'team', true),
  ('c3100004-0000-4000-8000-000000000003', 'c3100002-0000-4000-8000-000000000001', 'c3100003-0000-4000-8000-000000000001', 'fake-acct-2', 'Account 2', 'team', false),
  ('c3100004-0000-4000-8000-000000000004', 'c3100002-0000-4000-8000-000000000002', 'c3100003-0000-4000-8000-000000000003', 'fake-acct-1', 'Account 1', 'team', true),
  ('c3100004-0000-4000-8000-000000000005', 'c3100002-0000-4000-8000-000000000002', 'c3100003-0000-4000-8000-000000000004', 'fake-acct-1', 'Account 1', 'team', true),
  ('c3100004-0000-4000-8000-000000000006', 'c3100002-0000-4000-8000-000000000002', 'c3100003-0000-4000-8000-000000000005', 'fake-acct-1', 'Account 1', 'team', true);

-- A per-connection endpoint on workspace B's active fake connection.
insert into public.webhook_endpoints (id, workspace_id, connection_id, provider, key_id, iv, ciphertext, auth_tag)
values ('c3100005-0000-4000-8000-000000000001', 'c3100002-0000-4000-8000-000000000002', 'c3100003-0000-4000-8000-000000000003',
        'fake', 'deadbeef', '\x00'::bytea, '\x01'::bytea, '\x02'::bytea);

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
   where c.oid in ('public.webhook_endpoints'::regclass, 'public.webhook_deliveries'::regclass)),
  'webhook tables: row level security is on');
select is_empty(
  $$
    select r.role || ' ' || t.tbl || ' ' || p.priv
    from unnest(array['anon', 'authenticated']) as r(role)
    cross join unnest(array['public.webhook_endpoints', 'public.webhook_deliveries']) as t(tbl)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
    where case
      when p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') then has_any_column_privilege(r.role, t.tbl, p.priv)
      else has_table_privilege(r.role, t.tbl, p.priv)
    end
  $$,
  'webhook tables: anon and authenticated hold no table or column privilege');
select is_empty(
  $$
    select r.role || ' ' || f.fn
    from unnest(array['anon', 'authenticated']) as r(role)
    cross join unnest(array[
      'public.record_webhook_delivery(public.provider_id, text, jsonb, uuid)',
      'public.list_webhook_targets(public.provider_id, text, uuid)',
      'public.purge_webhook_deliveries(timestamptz, integer)'
    ]) as f(fn)
    where has_function_privilege(r.role, f.fn, 'execute')
  $$,
  'webhook functions: anon and authenticated cannot execute any of them');
select ok(
  has_function_privilege('service_role', 'public.record_webhook_delivery(public.provider_id, text, jsonb, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.list_webhook_targets(public.provider_id, text, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.purge_webhook_deliveries(timestamptz, integer)', 'execute'),
  'webhook functions: the service role can execute all of them');

-- ---------------------------------------------------------------------------
-- record_webhook_delivery: one delivery, one job
-- ---------------------------------------------------------------------------
select is(
  public.record_webhook_delivery('fake', 'webhook-test-delivery-1', '{"kind": "ignored", "reason": "test"}'::jsonb),
  true,
  'record: a new delivery is stored and returns true');
select is(
  (select count(*)::int from public.sync_jobs j
   join public.webhook_deliveries d on d.id = j.webhook_delivery_id
   where d.provider = 'fake' and d.delivery_id = 'webhook-test-delivery-1'
     and j.kind = 'webhook' and j.status = 'queued' and j.workspace_id is null and j.connection_id is null),
  1,
  'record: the delivery queues one instance-wide webhook job that names it');
select is(
  (select d.status::text || ' ' || (d.outcome ->> 'kind') || ' ' || (d.endpoint_id is null)::text
   from public.webhook_deliveries d where d.provider = 'fake' and d.delivery_id = 'webhook-test-delivery-1'),
  'received ignored true',
  'record: the delivery is received, keeps its outcome, and has no endpoint (app-level URL)');

select is(
  public.record_webhook_delivery('fake', 'webhook-test-delivery-1', '{"kind": "ignored", "reason": "retry"}'::jsonb),
  false,
  'record: the same delivery again returns false (boundary: duplicate delivery)');
select is(
  (select count(*)::int from public.webhook_deliveries where provider = 'fake' and delivery_id = 'webhook-test-delivery-1'),
  1,
  'record: a duplicate delivery stores no second row');
select is(
  (select count(*)::int from public.sync_jobs j
   join public.webhook_deliveries d on d.id = j.webhook_delivery_id
   where d.provider = 'fake' and d.delivery_id = 'webhook-test-delivery-1'),
  1,
  'record: a duplicate delivery queues no second job');
select is(
  (select d.outcome ->> 'reason' from public.webhook_deliveries d where d.provider = 'fake' and d.delivery_id = 'webhook-test-delivery-1'),
  'test',
  'record: a duplicate delivery leaves the first outcome untouched');

select is(
  public.record_webhook_delivery('github', 'webhook-test-delivery-1', '{"kind": "ignored", "reason": "test"}'::jsonb),
  true,
  'record: the same delivery id from another provider is a different delivery (boundary: key is per provider)');

select is(
  public.record_webhook_delivery('fake', 'webhook-test-delivery-2', '{"kind": "ignored", "reason": "test"}'::jsonb,
    'c3100005-0000-4000-8000-000000000001'),
  true,
  'record: a delivery to a per-connection URL is stored with its endpoint');
select throws_ok(
  $$ select public.record_webhook_delivery('github', 'webhook-test-delivery-3', '{"kind": "ignored", "reason": "test"}'::jsonb,
       'c3100005-0000-4000-8000-000000000001') $$,
  '22023'::char(5), null::text,
  'record: an endpoint of another provider is refused (boundary: provider mismatch)');
select throws_ok(
  $$ select public.record_webhook_delivery('fake', '', '{"kind": "ignored", "reason": "test"}'::jsonb) $$,
  '23514'::char(5), null::text,
  'record: an empty delivery id is refused (boundary: length 0)');
select lives_ok(
  $$ select public.record_webhook_delivery('fake', repeat('d', 200), '{"kind": "ignored", "reason": "test"}'::jsonb) $$,
  'record: a delivery id of 200 characters is stored (boundary: maximum length)');
select throws_ok(
  $$ select public.record_webhook_delivery('fake', repeat('d', 201), '{"kind": "ignored", "reason": "test"}'::jsonb) $$,
  '23514'::char(5), null::text,
  'record: a delivery id of 201 characters is refused (boundary: one past the maximum)');
select throws_ok(
  $$ select public.record_webhook_delivery('fake', 'webhook-test-delivery-4', null) $$,
  '22023'::char(5), null::text,
  'record: a delivery without an outcome is refused (boundary: null outcome)');

-- ---------------------------------------------------------------------------
-- sync_jobs: a webhook job always names its delivery, and no other job does
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.sync_jobs (kind) values ('webhook') $$,
  '23514'::char(5), null::text,
  'sync_jobs: a webhook job without a delivery is refused (boundary: null webhook_delivery_id)');
select throws_ok(
  $$ insert into public.sync_jobs (kind, webhook_delivery_id)
     select 'retention', d.id from public.webhook_deliveries d where d.provider = 'fake' and d.delivery_id = 'webhook-test-delivery-1' $$,
  '23514'::char(5), null::text,
  'sync_jobs: a job of another kind cannot name a delivery');

-- claim_sync_jobs returns the delivery id with the job. The job runs first because it is the
-- oldest due job (run_after in the past).
update public.sync_jobs j set run_after = '2000-01-01T00:00:00Z'
from public.webhook_deliveries d
where d.id = j.webhook_delivery_id and d.provider = 'fake' and d.delivery_id = 'webhook-test-delivery-1';
select is(
  (select c.webhook_delivery_id from public.claim_sync_jobs(1, 60) c),
  (select d.id from public.webhook_deliveries d where d.provider = 'fake' and d.delivery_id = 'webhook-test-delivery-1'),
  'claim_sync_jobs: a claimed webhook job carries its delivery id');

-- ---------------------------------------------------------------------------
-- list_webhook_targets
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select account_id from public.list_webhook_targets('fake', 'fake-acct-1') order by account_id $$,
  $$ values ('c3100004-0000-4000-8000-000000000001'::uuid), ('c3100004-0000-4000-8000-000000000004'::uuid),
            ('c3100004-0000-4000-8000-000000000005'::uuid) $$,
  'targets: an app-level delivery reaches the account on every active or needs_attention connection of the provider, across workspaces');
select is(
  (select workspace_id::text || ' ' || connection_id::text from public.list_webhook_targets('fake', 'fake-acct-1')
   where account_id = 'c3100004-0000-4000-8000-000000000001'),
  'c3100002-0000-4000-8000-000000000001 c3100003-0000-4000-8000-000000000001',
  'targets: each target names its workspace and connection');
select is_empty(
  $$ select 1 from public.list_webhook_targets('fake', 'fake-acct-2') $$,
  'targets: an account that is not included is no target (boundary: included false)');
select is_empty(
  $$ select 1 from public.list_webhook_targets('fake', 'fake-acct-9') $$,
  'targets: an unknown account has no target (boundary: no match)');
select results_eq(
  $$ select account_id from public.list_webhook_targets('github', 'fake-acct-1') $$,
  $$ values ('c3100004-0000-4000-8000-000000000006'::uuid) $$,
  'targets: only connections of the delivery''s provider are targets');
select results_eq(
  $$ select account_id from public.list_webhook_targets('fake', 'fake-acct-1', 'c3100005-0000-4000-8000-000000000001') $$,
  $$ values ('c3100004-0000-4000-8000-000000000004'::uuid) $$,
  'targets: a per-connection delivery reaches only the endpoint''s own connection');
select is_empty(
  $$ select 1 from public.list_webhook_targets('fake', 'fake-acct-1', 'c3100005-0000-4000-8000-0000000000ff') $$,
  'targets: an unknown endpoint has no target (boundary: endpoint missing)');

-- ---------------------------------------------------------------------------
-- purge_webhook_deliveries
-- ---------------------------------------------------------------------------
select ok(public.record_webhook_delivery('fake', 'webhook-test-old', '{"kind": "ignored", "reason": "test"}'::jsonb),
  'purge fixture: a delivery to be received before the cutoff');
select ok(public.record_webhook_delivery('fake', 'webhook-test-cutoff', '{"kind": "ignored", "reason": "test"}'::jsonb),
  'purge fixture: a delivery to be received exactly at the cutoff');
update public.webhook_deliveries set received_at = '1999-12-31T23:59:59.999Z' where provider = 'fake' and delivery_id = 'webhook-test-old';
update public.webhook_deliveries set received_at = '2000-01-01T00:00:00Z' where provider = 'fake' and delivery_id = 'webhook-test-cutoff';
create temporary table purged_delivery on commit drop as
  select id from public.webhook_deliveries where provider = 'fake' and delivery_id = 'webhook-test-old';
select isnt_empty(
  $$ select 1 from public.sync_jobs j join purged_delivery p on p.id = j.webhook_delivery_id $$,
  'purge fixture: the delivery to be purged has its job');

select is(
  public.purge_webhook_deliveries('2000-01-01T00:00:00Z', 10),
  1,
  'purge: deletes the delivery received before the cutoff');
select is(
  (select array_agg(delivery_id order by delivery_id) from public.webhook_deliveries
   where provider = 'fake' and delivery_id in ('webhook-test-old', 'webhook-test-cutoff', 'webhook-test-delivery-1')),
  array['webhook-test-cutoff', 'webhook-test-delivery-1'],
  'purge: keeps a delivery received exactly at the cutoff and newer ones (boundary: cutoff instant)');
select is_empty(
  $$ select 1 from public.sync_jobs j join purged_delivery p on p.id = j.webhook_delivery_id $$,
  'purge: the purged delivery''s job goes with it');
select throws_ok(
  $$ select public.purge_webhook_deliveries('2000-01-01T00:00:00Z', 0) $$,
  '22023'::char(5), null::text,
  'purge: a limit below 1 is refused (boundary: limit 0)');

-- ---------------------------------------------------------------------------
-- Cascades: removing a connection removes its endpoint, deliveries, and jobs
-- ---------------------------------------------------------------------------
delete from public.connections where id = 'c3100003-0000-4000-8000-000000000003';

select is_empty(
  $$ select 1 from public.webhook_endpoints where id = 'c3100005-0000-4000-8000-000000000001' $$,
  'cascade: deleting a connection deletes its webhook endpoint');
select is_empty(
  $$ select 1 from public.webhook_deliveries where provider = 'fake' and delivery_id = 'webhook-test-delivery-2' $$,
  'cascade: deleting the endpoint deletes the deliveries it received');

-- ---------------------------------------------------------------------------
-- The Data API: anon and a signed in owner are refused
-- ---------------------------------------------------------------------------
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';

select throws_ok($$ select id from public.webhook_deliveries $$, '42501'::char(5), null::text,
  'service only: anon cannot select webhook_deliveries');
select throws_ok($$ select public.record_webhook_delivery('fake', 'anon-delivery', '{"kind": "ignored", "reason": "x"}'::jsonb) $$,
  '42501'::char(5), null::text,
  'service only: anon cannot execute record_webhook_delivery');

reset role;
reset request.jwt.claims;

set local role authenticated;
set local request.jwt.claims to '{"sub": "c3100001-0000-4000-8000-000000000001", "role": "authenticated"}';

select throws_ok($$ select id from public.webhook_endpoints $$, '42501'::char(5), null::text,
  'service only: an authenticated owner cannot select webhook_endpoints, even for their own connection');

reset role;
reset request.jwt.claims;

select * from finish();

rollback;
