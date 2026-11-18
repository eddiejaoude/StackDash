-- When a connection was last granted (#476): connections.granted_at is a nullable timestamptz that
-- members read and nobody writes through the Data API; the backfill fills a connection with no
-- grant time from its credential's last save, else from when it was created, leaves pending
-- connections and connections that already have one alone, works in batches, and is re-runnable;
-- list_webhook_targets returns granted_at, the column alone (#502): a live connection with no
-- recorded grant has none, whatever its credential, until the backfill fills it; and it no longer
-- returns credential_updated_at.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS); anon and authenticated
-- are impersonated through the same role and JWT claims PostgREST uses.
begin;

create extension if not exists pgtap with schema extensions;

select plan(23);

-- Every other connection in the local database already has its grant time inside this rolled-back
-- transaction, so the backfill below sees only this file's fixtures.
update public.connections set granted_at = created_at where granted_at is null;

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c3200001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'granted-owner@example.com', '{"user_name": "granted-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values ('c3200002-0000-4000-8000-000000000001', 'Granted', 'c3200001-0000-4000-8000-000000000001');

insert into public.workspace_members (workspace_id, user_id, role)
values ('c3200002-0000-4000-8000-000000000001', 'c3200001-0000-4000-8000-000000000001', 'owner');

-- 1: active with a credential refreshed later than it was made. 2: needs_attention with no
-- credential. 3: pending (grant never completed). 4: active, already granted (exact value). 5 and 6:
-- revoked and failed, no credential, for the batch boundary.
insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds, created_at, granted_at)
values
  ('c3200003-0000-4000-8000-000000000001', 'c3200002-0000-4000-8000-000000000001', 'fake', 'active', 'With credential', 3600, '2026-10-01T00:00:00Z', null),
  ('c3200003-0000-4000-8000-000000000002', 'c3200002-0000-4000-8000-000000000001', 'fake', 'needs_attention', 'No credential', 3600, '2026-10-02T00:00:00Z', null),
  ('c3200003-0000-4000-8000-000000000003', 'c3200002-0000-4000-8000-000000000001', 'fake', 'pending', 'Pending', 3600, '2026-10-03T00:00:00Z', null),
  ('c3200003-0000-4000-8000-000000000004', 'c3200002-0000-4000-8000-000000000001', 'fake', 'active', 'Granted', 3600, '2026-10-04T00:00:00Z', '2026-11-16T08:00:00Z'),
  ('c3200003-0000-4000-8000-000000000005', 'c3200002-0000-4000-8000-000000000001', 'fake', 'revoked', 'Revoked', 3600, '2026-10-05T00:00:00Z', null),
  ('c3200003-0000-4000-8000-000000000006', 'c3200002-0000-4000-8000-000000000001', 'fake', 'failed', 'Failed', 3600, '2026-10-06T00:00:00Z', null);

insert into public.connection_credentials (connection_id, workspace_id, key_id, iv, ciphertext, auth_tag, updated_at)
values
  ('c3200003-0000-4000-8000-000000000001', 'c3200002-0000-4000-8000-000000000001', 'deadbeef',
   '\x00'::bytea, '\x01'::bytea, '\x02'::bytea, '2026-11-10T12:00:00Z'),
  ('c3200003-0000-4000-8000-000000000004', 'c3200002-0000-4000-8000-000000000001', 'deadbeef',
   '\x00'::bytea, '\x01'::bytea, '\x02'::bytea, '2026-11-16T09:00:00Z');

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind, included)
values
  ('c3200004-0000-4000-8000-000000000001', 'c3200002-0000-4000-8000-000000000001', 'c3200003-0000-4000-8000-000000000004', 'granted-acct', 'Account', 'team', true),
  ('c3200004-0000-4000-8000-000000000002', 'c3200002-0000-4000-8000-000000000001', 'c3200003-0000-4000-8000-000000000001', 'unstamped-acct', 'Account', 'team', true),
  ('c3200004-0000-4000-8000-000000000003', 'c3200002-0000-4000-8000-000000000001', 'c3200003-0000-4000-8000-000000000002', 'bare-acct', 'Account', 'team', true);

-- ---------------------------------------------------------------------------
-- The column and who may touch it
-- ---------------------------------------------------------------------------
select col_type_is('public', 'connections', 'granted_at', 'timestamp with time zone', 'connections.granted_at: a timestamptz');
select col_is_null('public', 'connections', 'granted_at', 'connections.granted_at: nullable, null until a grant completes');
select ok(
  has_column_privilege('authenticated', 'public.connections', 'granted_at', 'select')
  and not has_column_privilege('authenticated', 'public.connections', 'granted_at', 'update')
  and not has_column_privilege('authenticated', 'public.connections', 'granted_at', 'insert'),
  'connections.granted_at: members read it; the Data API cannot write it');
select is_empty(
  $$
    select r.role from unnest(array['anon', 'authenticated']) as r(role)
    where has_function_privilege(r.role, 'public.backfill_connection_granted_at(integer)', 'execute')
  $$,
  'backfill_connection_granted_at: anon and authenticated cannot execute it');
select ok(
  has_function_privilege('service_role', 'public.backfill_connection_granted_at(integer)', 'execute'),
  'backfill_connection_granted_at: the service role can execute it');

-- ---------------------------------------------------------------------------
-- list_webhook_targets before the backfill: a live connection with no recorded grant
-- ---------------------------------------------------------------------------
select is(
  (select granted_at from public.list_webhook_targets('fake', 'unstamped-acct')),
  null::timestamptz,
  'targets: a live connection with no recorded grant has no grant time, though it has a credential (boundary: fallback gone, #502)');
select results_eq(
  $$ select granted_at from public.list_webhook_targets('fake', 'bare-acct') $$,
  $$ values (null::timestamptz) $$,
  'targets: a live connection with neither a recorded grant nor a credential is a target with no grant time (boundary: no credential)');

-- ---------------------------------------------------------------------------
-- The backfill
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.backfill_connection_granted_at(0) $$, '22023'::char(5), null::text,
  'backfill: a limit below 1 is refused (boundary: limit 0)');
select throws_ok($$ select public.backfill_connection_granted_at(10001) $$, '22023'::char(5), null::text,
  'backfill: a limit above 10000 is refused (boundary: limit 10001)');
select throws_ok($$ select public.backfill_connection_granted_at(null) $$, '22023'::char(5), null::text,
  'backfill: a null limit is refused (boundary: null)');

select is(public.backfill_connection_granted_at(1), 1, 'backfill: fills at most p_limit connections (boundary: limit 1)');
select is(
  (select granted_at from public.connections where id = 'c3200003-0000-4000-8000-000000000001'),
  '2026-11-10T12:00:00Z'::timestamptz,
  'backfill: the first connection by id is filled first, from its credential''s last save');
select is(
  (select count(*)::int from public.connections where workspace_id = 'c3200002-0000-4000-8000-000000000001' and granted_at is null),
  4,
  'backfill: the batch left the rest for the next call (boundary: one past the limit)');

select is(public.backfill_connection_granted_at(1000), 3, 'backfill: the next call fills every remaining non-pending connection');
select is(
  (select granted_at from public.connections where id = 'c3200003-0000-4000-8000-000000000002'),
  '2026-10-02T00:00:00Z'::timestamptz,
  'backfill: a connection without a credential gets when it was created (boundary: no credential)');
select is(
  (select array_agg(status::text order by id) from public.connections
   where id in ('c3200003-0000-4000-8000-000000000005', 'c3200003-0000-4000-8000-000000000006') and granted_at = created_at),
  array['revoked', 'failed'],
  'backfill: revoked and failed connections are filled too: they were granted once');
select is(
  (select granted_at from public.connections where id = 'c3200003-0000-4000-8000-000000000003'),
  null::timestamptz,
  'backfill: a pending connection stays null: its grant never completed (boundary: pending)');
select is(
  (select granted_at from public.connections where id = 'c3200003-0000-4000-8000-000000000004'),
  '2026-11-16T08:00:00Z'::timestamptz,
  'backfill: a connection that already has a grant time keeps it, even with a newer credential save');
select is(public.backfill_connection_granted_at(1000), 0, 'backfill: running it again fills nothing (re-runnable)');

-- ---------------------------------------------------------------------------
-- list_webhook_targets
-- ---------------------------------------------------------------------------
select is(
  (select granted_at from public.list_webhook_targets('fake', 'granted-acct')),
  '2026-11-16T08:00:00Z'::timestamptz,
  'targets: a target carries when its connection was last granted, not when its credential was last saved');
select is(
  (select granted_at from public.list_webhook_targets('fake', 'unstamped-acct')),
  '2026-11-10T12:00:00Z'::timestamptz,
  'targets: a connection the backfill filled carries its credential''s last save, as the contract migration''s second backfill leaves it');
select is(
  pg_catalog.pg_get_function_result('public.list_webhook_targets(public.provider_id, text, uuid, text)'::regprocedure),
  'TABLE(workspace_id uuid, connection_id uuid, account_id uuid, granted_at timestamp with time zone)',
  'targets: credential_updated_at is no longer returned (contract, #502)');

-- ---------------------------------------------------------------------------
-- The Data API: a signed in owner cannot set the grant time
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "c3200001-0000-4000-8000-000000000001", "role": "authenticated"}';

select throws_ok(
  $$ update public.connections set granted_at = now() where id = 'c3200003-0000-4000-8000-000000000004' $$,
  '42501'::char(5), null::text,
  'service only: an owner cannot move their connection''s grant time');

reset role;
reset request.jwt.claims;

select * from finish();

rollback;
