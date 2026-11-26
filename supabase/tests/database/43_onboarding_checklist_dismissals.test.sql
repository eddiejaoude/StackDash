-- Setup checklist dismissals (#674): every member, viewers included, hides the checklist for
-- themself only. A member reads and writes only their own row, a second hide keeps the first time,
-- the time comes from the database, nothing updates or deletes a row, and leaving the workspace
-- removes it.
begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

-- Rows touched, or -1 when Postgres refuses the statement (42501: missing
-- grant or RLS with check). Rolled back with the transaction.
create schema rls_test;
grant usage on schema rls_test to anon, authenticated;

create function rls_test.affected(p_sql text)
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

grant execute on function rls_test.affected(text) to anon, authenticated;

-- Fixtures as postgres: owner, admin, viewer of workspace A; an outsider who owns workspace B.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('67400001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'rls-checklist-owner@example.com', '{"user_name": "rls-checklist-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('67400002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'rls-checklist-admin@example.com', '{"user_name": "rls-checklist-admin"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('67400003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'rls-checklist-viewer@example.com', '{"user_name": "rls-checklist-viewer"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('67400004-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'rls-checklist-outsider@example.com', '{"user_name": "rls-checklist-outsider"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('674000a0-0000-4000-8000-000000000000', 'Checklist team', '67400001-0000-4000-8000-000000000000'),
  ('674000b0-0000-4000-8000-000000000000', 'Other team', '67400004-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('674000a0-0000-4000-8000-000000000000', '67400001-0000-4000-8000-000000000000', 'owner'),
  ('674000a0-0000-4000-8000-000000000000', '67400002-0000-4000-8000-000000000000', 'admin'),
  ('674000a0-0000-4000-8000-000000000000', '67400003-0000-4000-8000-000000000000', 'viewer'),
  ('674000b0-0000-4000-8000-000000000000', '67400004-0000-4000-8000-000000000000', 'owner');

-- ---------------------------------------------------------------------------
-- The owner hides it for themself, once.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "67400001-0000-4000-8000-000000000000", "role": "authenticated"}';

select is(rls_test.affected($$
    insert into public.onboarding_checklist_dismissals (workspace_id, user_id)
    values ('674000a0-0000-4000-8000-000000000000', '67400001-0000-4000-8000-000000000000')
    on conflict (workspace_id, user_id) do nothing
  $$), 1, 'dismissals: an owner hides the checklist for themself');
select is(rls_test.affected($$
    insert into public.onboarding_checklist_dismissals (workspace_id, user_id)
    values ('674000a0-0000-4000-8000-000000000000', '67400001-0000-4000-8000-000000000000')
    on conflict (workspace_id, user_id) do nothing
  $$), 0, 'dismissals: hiding it again changes nothing and is not refused');
select is(rls_test.affected($$
    insert into public.onboarding_checklist_dismissals (workspace_id, user_id)
    values ('674000a0-0000-4000-8000-000000000000', '67400002-0000-4000-8000-000000000000')
  $$), -1, 'dismissals: an owner cannot hide it for another member');
select is(rls_test.affected($$
    insert into public.onboarding_checklist_dismissals (workspace_id, user_id, dismissed_at)
    values ('674000a0-0000-4000-8000-000000000000', '67400001-0000-4000-8000-000000000000', now() - interval '1 year')
  $$), -1, 'dismissals: the caller never sets the time (no insert grant on dismissed_at)');
select is(rls_test.affected($$
    update public.onboarding_checklist_dismissals set dismissed_at = now()
    where workspace_id = '674000a0-0000-4000-8000-000000000000'
  $$), -1, 'dismissals: a member cannot change a row (no update grant)');
select is(rls_test.affected($$
    delete from public.onboarding_checklist_dismissals where workspace_id = '674000a0-0000-4000-8000-000000000000'
  $$), -1, 'dismissals: a member cannot delete a row (no delete grant; leaving the workspace removes it)');
select is(rls_test.affected($$
    insert into public.onboarding_checklist_dismissals (workspace_id, user_id)
    values ('674000b0-0000-4000-8000-000000000000', '67400001-0000-4000-8000-000000000000')
  $$), -1, 'dismissals: nobody hides it in a workspace they do not belong to');

-- ---------------------------------------------------------------------------
-- Another member still sees it, and a viewer may hide it too.
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "67400002-0000-4000-8000-000000000000", "role": "authenticated"}';

select is((select count(*)::int from public.onboarding_checklist_dismissals), 0,
  'dismissals: an admin does not read the owner''s row, so the checklist still shows for them');

set local request.jwt.claims to '{"sub": "67400003-0000-4000-8000-000000000000", "role": "authenticated"}';

select is(rls_test.affected($$
    insert into public.onboarding_checklist_dismissals (workspace_id, user_id)
    values ('674000a0-0000-4000-8000-000000000000', '67400003-0000-4000-8000-000000000000')
    on conflict (workspace_id, user_id) do nothing
  $$), 1, 'dismissals: a viewer hides the checklist for themself');
select results_eq(
  $$ select user_id from public.onboarding_checklist_dismissals $$,
  $$ values ('67400003-0000-4000-8000-000000000000'::uuid) $$,
  'dismissals: a viewer reads only their own row');

set local request.jwt.claims to '{"sub": "67400004-0000-4000-8000-000000000000", "role": "authenticated"}';

select is((select count(*)::int from public.onboarding_checklist_dismissals), 0,
  'dismissals: an outsider reads nothing of another workspace');

reset role;
reset request.jwt.claims;

set local role anon;
set local request.jwt.claims to '{"role": "anon"}';

select throws_ok($$ select user_id from public.onboarding_checklist_dismissals $$, '42501'::char(5), null::text,
  'dismissals: anon cannot read dismissals');

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- The time is the database's, and leaving the workspace removes the row.
-- ---------------------------------------------------------------------------
select ok(
  (select dismissed_at = now() from public.onboarding_checklist_dismissals
   where workspace_id = '674000a0-0000-4000-8000-000000000000' and user_id = '67400001-0000-4000-8000-000000000000'),
  'dismissals: the time is the database clock at the first hide');

delete from public.workspace_members
where workspace_id = '674000a0-0000-4000-8000-000000000000' and user_id = '67400003-0000-4000-8000-000000000000';

select is(
  (select count(*)::int from public.onboarding_checklist_dismissals where user_id = '67400003-0000-4000-8000-000000000000'), 0,
  'dismissals: leaving the workspace removes the member''s row');
select is(
  (select count(*)::int from public.onboarding_checklist_dismissals where user_id = '67400001-0000-4000-8000-000000000000'), 1,
  'dismissals: another member leaving keeps the owner''s row');

delete from public.workspaces where id = '674000a0-0000-4000-8000-000000000000';

select is((select count(*)::int from public.onboarding_checklist_dismissals), 0,
  'dismissals: deleting the workspace removes every row');

select * from finish();
rollback;
