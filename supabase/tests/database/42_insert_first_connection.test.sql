-- A workspace's first connection (#287): insert_first_connection adds a pending connection only while
-- the workspace has none, of any status, and answers null, having written nothing, once it has one.
-- Sample data connects its first simulated provider through it, so of two submits that overlap only
-- one connects a set. The call keeps the workspace row locked until its transaction ends, so a
-- concurrent call for the same workspace waits for that commit and then finds the connection.
-- Another workspace's connections do not count, a workspace that does not exist is refused, and
-- only the service role reaches the function.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS).
begin;

create extension if not exists pgtap with schema extensions;
-- Row locks are visible only through pgrowlocks; created here, it goes with the rollback.
create extension if not exists pgrowlocks with schema extensions;

select plan(11);

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c4200001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'first-connection-owner@example.com', '{"user_name": "first-connection-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('c4200002-0000-4000-8000-000000000001', 'First connection A', 'c4200001-0000-4000-8000-000000000001'),
  ('c4200002-0000-4000-8000-000000000002', 'First connection B', 'c4200001-0000-4000-8000-000000000001'),
  ('c4200002-0000-4000-8000-000000000003', 'First connection C', 'c4200001-0000-4000-8000-000000000001'),
  ('c4200002-0000-4000-8000-000000000004', 'First connection D', 'c4200001-0000-4000-8000-000000000001');

-- C's one connection was disconnected long ago.
insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values
  ('c4200003-0000-4000-8000-000000000001', 'c4200002-0000-4000-8000-000000000003', 'github', 'revoked', 'GitHub C', 3600);

create temp table made (workspace text primary key, connection_id uuid);

insert into made
select 'A', public.insert_first_connection(
  'c4200002-0000-4000-8000-000000000001', 'vercel', 'Vercel (Example team)', 60, 'c4200001-0000-4000-8000-000000000001');
select isnt((select connection_id from made where workspace = 'A'), null, 'an empty workspace gets its first connection');

select results_eq(
  $$ select workspace_id, provider::text, status::text, display_name, poll_interval_seconds, created_by, updated_by
     from public.connections
     where id = (select connection_id from made where workspace = 'A') $$,
  $$ values ('c4200002-0000-4000-8000-000000000001'::uuid, 'vercel', 'pending', 'Vercel (Example team)', 60,
             'c4200001-0000-4000-8000-000000000001'::uuid, 'c4200001-0000-4000-8000-000000000001'::uuid) $$,
  'it is pending, as completeConnection inserts a new connection, and made by the given user'
);

-- The second of two overlapping submits: its first insert runs once the first one's has.
select is(
  public.insert_first_connection(
    'c4200002-0000-4000-8000-000000000001', 'github', 'GitHub (example-org)', 60, 'c4200001-0000-4000-8000-000000000001'),
  null,
  'a workspace with a connection gets none, even one still pending (boundary: one connection)'
);
select is(
  (select count(*)::int from public.connections where workspace_id = 'c4200002-0000-4000-8000-000000000001'),
  1,
  'and nothing is written for it'
);

select is(
  public.insert_first_connection(
    'c4200002-0000-4000-8000-000000000003', 'vercel', 'Vercel (Example team)', 60, 'c4200001-0000-4000-8000-000000000001'),
  null,
  'a disconnected connection counts too (boundary: status)'
);

insert into made
select 'B', public.insert_first_connection(
  'c4200002-0000-4000-8000-000000000002', 'vercel', 'Vercel (Example team)', 60, 'c4200001-0000-4000-8000-000000000001');
select isnt((select connection_id from made where workspace = 'B'), null, 'another workspace''s connections do not count');

select is(
  (select l.modes
   from extensions.pgrowlocks('public.workspaces') l
   where l.locked_row = (select w.ctid from public.workspaces w where w.id = 'c4200002-0000-4000-8000-000000000002')),
  array['For No Key Update'],
  'the workspace row stays locked until the transaction ends, so a concurrent call waits for its commit'
);

select throws_ok(
  $$ select public.insert_first_connection(
       'c4200002-0000-4000-8000-0000000000ff', 'vercel', 'Vercel (Example team)', 60, 'c4200001-0000-4000-8000-000000000001') $$,
  'P0002',
  'workspace not found',
  'a workspace that does not exist is refused'
);

set local role anon;
select throws_ok(
  $$ select public.insert_first_connection(
       'c4200002-0000-4000-8000-000000000004', 'vercel', 'Vercel (Example team)', 60, 'c4200001-0000-4000-8000-000000000001') $$,
  '42501',
  null,
  'a signed-out visitor cannot call it'
);
reset role;

set local role authenticated;
select throws_ok(
  $$ select public.insert_first_connection(
       'c4200002-0000-4000-8000-000000000004', 'vercel', 'Vercel (Example team)', 60, 'c4200001-0000-4000-8000-000000000001') $$,
  '42501',
  null,
  'a signed-in user cannot call it'
);
reset role;

set local role service_role;
select isnt(
  public.insert_first_connection(
    'c4200002-0000-4000-8000-000000000004', 'vercel', 'Vercel (Example team)', 60, 'c4200001-0000-4000-8000-000000000001'),
  null,
  'the service role makes a first connection'
);
reset role;

select * from finish();
rollback;
