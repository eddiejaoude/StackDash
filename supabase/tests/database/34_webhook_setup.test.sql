-- Webhook setup (#426): a workspace holds at most 5 webhook endpoints, enforced by
-- webhook_endpoints_enforce_limit, while re-sealing an endpoint the workspace already has and other
-- workspaces are unaffected; an automatic endpoint names the provider's webhook and a manual one
-- does not; only a manual endpoint can wait for the provider's secret; new columns default so code
-- written before them keeps working; the last delivery is read through its own index.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS).
begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c3400001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'webhook-setup-owner@example.com', '{"user_name": "webhook-setup-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('c3400002-0000-4000-8000-000000000001', 'Webhook setup A', 'c3400001-0000-4000-8000-000000000001'),
  ('c3400002-0000-4000-8000-000000000002', 'Webhook setup B', 'c3400001-0000-4000-8000-000000000001');

-- Seven connections in A, one in B.
insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
select ('c3400003-0000-4000-8000-00000000000' || n)::uuid, 'c3400002-0000-4000-8000-000000000001', 'gitlab', 'active', 'GitLab ' || n, 3600
from generate_series(1, 7) as n;
insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values ('c3400003-0000-4000-8000-000000000009', 'c3400002-0000-4000-8000-000000000002', 'gitlab', 'active', 'GitLab B', 3600);

-- Inserts an endpoint for connection n of workspace A with a placeholder sealed secret.
create function pg_temp.add_endpoint(p_connection uuid, p_workspace uuid default 'c3400002-0000-4000-8000-000000000001')
  returns void
  language sql
as $$
  insert into public.webhook_endpoints (workspace_id, connection_id, provider, key_id, iv, ciphertext, auth_tag)
  values (p_workspace, p_connection, 'gitlab', 'k1', '\x00', '\x00', '\x00');
$$;

select lives_ok(
  $$ select pg_temp.add_endpoint(('c3400003-0000-4000-8000-00000000000' || n)::uuid) from generate_series(1, 4) as n $$,
  'four endpoints fit in a workspace'
);
select lives_ok(
  $$ select pg_temp.add_endpoint('c3400003-0000-4000-8000-000000000005') $$,
  'the fifth endpoint fits (boundary: at the limit)'
);
select throws_ok(
  $$ select pg_temp.add_endpoint('c3400003-0000-4000-8000-000000000006') $$,
  '54000',
  null,
  'a sixth endpoint in the workspace is refused (boundary: one over the limit)'
);
select is(
  (select count(*)::int from public.webhook_endpoints where workspace_id = 'c3400002-0000-4000-8000-000000000001'),
  5,
  'the refused endpoint was not stored'
);
select lives_ok(
  $$ insert into public.webhook_endpoints (workspace_id, connection_id, provider, key_id, iv, ciphertext, auth_tag)
     values ('c3400002-0000-4000-8000-000000000001', 'c3400003-0000-4000-8000-000000000001', 'gitlab', 'k2', '\x01', '\x01', '\x01')
     on conflict (connection_id) do update set key_id = excluded.key_id $$,
  're-sealing an endpoint the workspace already has is not counted against the limit'
);
select lives_ok(
  $$ select pg_temp.add_endpoint('c3400003-0000-4000-8000-000000000009', 'c3400002-0000-4000-8000-000000000002') $$,
  'another workspace is not affected by the first one''s limit'
);
select lives_ok(
  $$ delete from public.webhook_endpoints where connection_id = 'c3400003-0000-4000-8000-000000000005';
     select pg_temp.add_endpoint('c3400003-0000-4000-8000-000000000006') $$,
  'deleting an endpoint frees its place'
);

select is(
  (select setup_mode::text || ' ' || coalesce(provider_webhook_id, 'none') || ' ' || awaiting_provider_secret::text
   from public.webhook_endpoints where connection_id = 'c3400003-0000-4000-8000-000000000001'),
  'manual none false',
  'an endpoint stored without the setup columns is manual, names no provider webhook, and waits for nothing'
);
select throws_ok(
  $$ update public.webhook_endpoints set setup_mode = 'automatic' where connection_id = 'c3400003-0000-4000-8000-000000000001' $$,
  '23514',
  null,
  'an automatic endpoint must name the provider''s webhook'
);
select throws_ok(
  $$ update public.webhook_endpoints set provider_webhook_id = 'hook_1' where connection_id = 'c3400003-0000-4000-8000-000000000001' $$,
  '23514',
  null,
  'a manual endpoint names no provider webhook'
);
select throws_ok(
  $$ update public.webhook_endpoints set setup_mode = 'automatic', provider_webhook_id = 'hook_1', awaiting_provider_secret = true
     where connection_id = 'c3400003-0000-4000-8000-000000000001' $$,
  '23514',
  null,
  'only a manual endpoint waits for the provider''s secret'
);
select lives_ok(
  $$ update public.webhook_endpoints set setup_mode = 'automatic', provider_webhook_id = 'hook_1'
     where connection_id = 'c3400003-0000-4000-8000-000000000001' $$,
  'an automatic endpoint with its provider webhook is stored'
);

select has_index('public', 'webhook_deliveries', 'webhook_deliveries_endpoint_received_at_idx', array['endpoint_id', 'received_at'],
  'the last delivery of an endpoint is read through its own index');
select col_default_is('public', 'oauth_states', 'webhook_setup', 'false', 'an OAuth state chooses no webhook setup unless it says so');

select * from finish();
rollback;
