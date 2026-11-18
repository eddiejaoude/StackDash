-- A mode on every Stripe connection past pending (#567, 20261118150200_contract_connection_mode.sql
-- and 20261118150300_contract_connection_mode_validate.sql): the backfill ran, so no Stripe
-- connection past pending is left without a mode, and backfill_connection_mode is gone;
-- connections_stripe_mode_required is validated, and refuses an insert or an update that leaves a
-- Stripe connection past pending without a mode, at every such status; a pending Stripe
-- connection, and a connection of any other provider at any status, may have none.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS).
begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- ---------------------------------------------------------------------------
-- The backfill run, read before this file adds any connection
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select id from public.connections where provider = 'stripe' and status <> 'pending' and mode is null $$,
  'the backfill run: no Stripe connection past pending is left without a mode');
select hasnt_function(
  'public', 'backfill_connection_mode',
  'the backfill run: backfill_connection_mode is dropped after its last loop, since the constraint leaves nothing for it to fill');
select ok(
  (select c.convalidated from pg_catalog.pg_constraint c
   where c.conrelid = 'public.connections'::regclass and c.conname = 'connections_stripe_mode_required'),
  'connections_stripe_mode_required is validated, so it holds for the rows written before it too');

-- Fixtures: one workspace with a live Stripe connection and a GitHub connection, which records
-- none.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c4000001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'mode-required@example.com', '{"user_name": "mode-required"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values ('c4000002-0000-4000-8000-000000000001', 'Required modes', 'c4000001-0000-4000-8000-000000000001');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds, mode)
values
  ('c4000003-0000-4000-8000-000000000001', 'c4000002-0000-4000-8000-000000000001', 'stripe', 'active', 'Live', 3600, 'live'),
  ('c4000003-0000-4000-8000-000000000004', 'c4000002-0000-4000-8000-000000000001', 'github', 'active', 'GitHub', 3600, null);

-- Whether connections_stripe_mode_required refuses a new connection of this provider, status, and
-- mode. Any other error is raised, so it cannot pass for a refusal.
create function pg_temp.refuses(p_provider public.provider_id, p_status public.connection_status, p_mode public.connection_mode)
  returns boolean
  language plpgsql
as $$
declare
  v_constraint text;
begin
  insert into public.connections (workspace_id, provider, status, display_name, poll_interval_seconds, mode)
  values ('c4000002-0000-4000-8000-000000000001', p_provider, p_status, 'Probe', 3600, p_mode);
  return false;
exception when check_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint <> 'connections_stripe_mode_required' then
    raise;
  end if;
  return true;
end;
$$;

-- Whether connections_stripe_mode_required refuses moving a new Stripe connection from one status
-- and mode to another. The starting row is inserted first, so it must be one the constraint
-- accepts; any other error is raised, so it cannot pass for a refusal.
create function pg_temp.update_refuses(
  p_from public.connection_status, p_from_mode public.connection_mode,
  p_to public.connection_status, p_to_mode public.connection_mode)
  returns boolean
  language plpgsql
as $$
declare
  v_id uuid;
  v_constraint text;
begin
  insert into public.connections (workspace_id, provider, status, display_name, poll_interval_seconds, mode)
  values ('c4000002-0000-4000-8000-000000000001', 'stripe', p_from, 'Probe', 3600, p_from_mode)
  returning id into v_id;
  begin
    update public.connections set status = p_to, mode = p_to_mode where id = v_id;
    return false;
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint <> 'connections_stripe_mode_required' then
      raise;
    end if;
    return true;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Insert
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select s, pg_temp.refuses('stripe', s, null) from unnest(enum_range(null::public.connection_status)) as s $$,
  $$ values ('pending'::public.connection_status, false), ('active', true), ('needs_attention', true), ('revoked', true), ('failed', true) $$,
  'insert: a Stripe connection with no mode is refused at every status but pending (boundary: pending)');
select is_empty(
  $$ select s, m from unnest(enum_range(null::public.connection_status)) as s, unnest(enum_range(null::public.connection_mode)) as m
     where pg_temp.refuses('stripe', s, m) $$,
  'insert: a Stripe connection with a mode, live or test, is accepted at every status');
select is_empty(
  $$ select p, s from unnest(enum_range(null::public.provider_id)) as p, unnest(enum_range(null::public.connection_status)) as s
     where p <> 'stripe' and pg_temp.refuses(p, s, null) $$,
  'insert: a connection of every other provider may have no mode, at every status');

-- ---------------------------------------------------------------------------
-- Update
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select s, pg_temp.update_refuses('pending', null, s, null) from unnest(enum_range(null::public.connection_status)) as s $$,
  $$ values ('pending'::public.connection_status, false), ('active', true), ('needs_attention', true), ('revoked', true), ('failed', true) $$,
  'update: a grant completed with no mode (a build before #481) is refused from pending to every other status (boundary: pending to pending)');
select is_empty(
  $$ select s, m from unnest(enum_range(null::public.connection_status)) as s, unnest(enum_range(null::public.connection_mode)) as m
     where pg_temp.update_refuses('pending', null, s, m) $$,
  'update: a grant completed with its mode, live or test (completeConnection), is accepted from pending to every status');
select results_eq(
  $$ select s, pg_temp.update_refuses(s, 'live', s, null) from unnest(enum_range(null::public.connection_status)) as s $$,
  $$ values ('pending'::public.connection_status, false), ('active', true), ('needs_attention', true), ('revoked', true), ('failed', true) $$,
  'update: clearing the mode is refused at every status but pending (boundary: pending)');
select is_empty(
  $$ select s from unnest(enum_range(null::public.connection_status)) as s
     where pg_temp.update_refuses(s, 'live', s, 'test') $$,
  'update: changing the mode (a reconnect that grants the other one) is accepted at every status');
select lives_ok(
  $$ update public.connections set status = 'revoked', next_sync_at = null where id = 'c4000003-0000-4000-8000-000000000001' $$,
  'update: a disconnect keeps the mode, so it is accepted');
select lives_ok(
  $$ update public.connections set status = 'needs_attention' where id = 'c4000003-0000-4000-8000-000000000004' $$,
  'update: a connection of another provider changes status with no mode');

select * from finish();

rollback;
