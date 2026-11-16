-- Credential refresh lock (#496): one holder per connection at a time, a lease that runs out frees
-- the lock for the next caller, a connection outside the workspace is refused, the lock goes with
-- its connection, and only the service role reaches the table and the function.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS).
begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c3600001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'refresh-lock-owner@example.com', '{"user_name": "refresh-lock-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('c3600002-0000-4000-8000-000000000001', 'Refresh lock A', 'c3600001-0000-4000-8000-000000000001'),
  ('c3600002-0000-4000-8000-000000000002', 'Refresh lock B', 'c3600001-0000-4000-8000-000000000001');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values
  ('c3600003-0000-4000-8000-000000000001', 'c3600002-0000-4000-8000-000000000001', 'gitlab', 'active', 'GitLab A', 3600),
  ('c3600003-0000-4000-8000-000000000002', 'c3600002-0000-4000-8000-000000000001', 'gitlab', 'active', 'GitLab A2', 3600);

create temp table taken (holder text primary key, lock_id uuid);

insert into taken
select 'first', public.acquire_credential_refresh_lock(
  'c3600002-0000-4000-8000-000000000001', 'c3600003-0000-4000-8000-000000000001', 60);
select isnt((select lock_id from taken where holder = 'first'), null, 'a free connection''s lock is taken');

select is(
  public.acquire_credential_refresh_lock('c3600002-0000-4000-8000-000000000001', 'c3600003-0000-4000-8000-000000000001', 60),
  null,
  'a second caller is refused while the lease is current'
);

select isnt(
  public.acquire_credential_refresh_lock('c3600002-0000-4000-8000-000000000001', 'c3600003-0000-4000-8000-000000000002', 60),
  null,
  'another connection of the workspace has its own lock'
);

-- The first holder died: its lease ran out a second ago.
update public.credential_refresh_locks set locked_until = now() - interval '1 second'
where connection_id = 'c3600003-0000-4000-8000-000000000001';
insert into taken
select 'second', public.acquire_credential_refresh_lock(
  'c3600002-0000-4000-8000-000000000001', 'c3600003-0000-4000-8000-000000000001', 60);
select ok(
  (select lock_id from taken where holder = 'second') is not null
    and (select lock_id from taken where holder = 'second') <> (select lock_id from taken where holder = 'first'),
  'a lock whose lease ran out is taken over with a new id'
);

select is(
  (select locked_until from public.credential_refresh_locks where connection_id = 'c3600003-0000-4000-8000-000000000001'),
  now() + interval '60 seconds',
  'the lease runs for the seconds asked for'
);

select throws_ok(
  $$ select public.acquire_credential_refresh_lock('c3600002-0000-4000-8000-000000000002', 'c3600003-0000-4000-8000-000000000001', 60) $$,
  'P0002',
  'connection not found in workspace',
  'a connection outside the workspace is refused'
);

select throws_ok(
  $$ select public.acquire_credential_refresh_lock('c3600002-0000-4000-8000-000000000001', 'c3600003-0000-4000-8000-000000000001', 0) $$,
  '22023',
  'p_lease_seconds must be between 1 and 600',
  'a lease shorter than a second is refused (boundary)'
);

delete from public.connections where id = 'c3600003-0000-4000-8000-000000000002';
select is(
  (select count(*)::int from public.credential_refresh_locks where connection_id = 'c3600003-0000-4000-8000-000000000002'),
  0,
  'the lock goes with its connection'
);

set local role authenticated;
select throws_ok(
  $$ select public.acquire_credential_refresh_lock('c3600002-0000-4000-8000-000000000001', 'c3600003-0000-4000-8000-000000000001', 60) $$,
  '42501',
  null,
  'a signed-in user cannot take a lock'
);
select throws_ok(
  $$ select * from public.credential_refresh_locks $$,
  '42501',
  null,
  'a signed-in user cannot read the locks'
);
reset role;

select * from finish();
rollback;
