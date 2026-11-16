-- Webhooks per source (#428): an endpoint holds at most 100 sources, enforced by
-- webhook_sources_enforce_limit, while a source it already has can still be updated at the limit;
-- record_webhook_source keeps the newest arrival and the latest name; sources go with their
-- endpoint; a per-source automatic endpoint names no provider webhook of its own, while every other
-- automatic endpoint still must; save_created_webhook_source never overwrites a recorded webhook;
-- delete_webhook_endpoint returns the webhooks to delete and removes the endpoint in one call; only
-- the service role reaches the table and the functions.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS).
begin;

create extension if not exists pgtap with schema extensions;

select plan(23);

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('c3500001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'webhook-sources-owner@example.com', '{"user_name": "webhook-sources-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values ('c3500002-0000-4000-8000-000000000001', 'Webhook sources', 'c3500001-0000-4000-8000-000000000001');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values
  ('c3500003-0000-4000-8000-000000000001', 'c3500002-0000-4000-8000-000000000001', 'gitlab', 'active', 'GitLab 1', 3600),
  ('c3500003-0000-4000-8000-000000000002', 'c3500002-0000-4000-8000-000000000001', 'gitlab', 'active', 'GitLab 2', 3600);

insert into public.webhook_endpoints (id, workspace_id, connection_id, provider, key_id, iv, ciphertext, auth_tag, setup_mode, per_source)
values
  ('c3500004-0000-4000-8000-000000000001', 'c3500002-0000-4000-8000-000000000001', 'c3500003-0000-4000-8000-000000000001',
   'gitlab', 'k1', '\x00', '\x00', '\x00', 'automatic', true),
  ('c3500004-0000-4000-8000-000000000002', 'c3500002-0000-4000-8000-000000000001', 'c3500003-0000-4000-8000-000000000002',
   'gitlab', 'k1', '\x00', '\x00', '\x00', 'manual', false);

select lives_ok(
  $$ insert into public.webhook_sources (endpoint_id, source_id, source_name, provider_webhook_id)
     select 'c3500004-0000-4000-8000-000000000001', n::text, 'group/project-' || n, 'hook-' || n from generate_series(1, 99) as n $$,
  'ninety-nine sources fit on an endpoint'
);
select lives_ok(
  $$ insert into public.webhook_sources (endpoint_id, source_id, source_name) values ('c3500004-0000-4000-8000-000000000001', '100', 'group/project-100') $$,
  'the hundredth source fits (boundary: at the limit)'
);
select throws_ok(
  $$ insert into public.webhook_sources (endpoint_id, source_id, source_name) values ('c3500004-0000-4000-8000-000000000001', '101', 'group/project-101') $$,
  '54000',
  null,
  'a 101st source is refused (boundary: one over the limit)'
);
select throws_ok(
  $$ select public.record_webhook_source('c3500004-0000-4000-8000-000000000001', '102', 'group/project-102', now()) $$,
  '54000',
  null,
  'a delivery from a new source past the limit is refused'
);
select lives_ok(
  $$ select public.record_webhook_source('c3500004-0000-4000-8000-000000000001', '1', 'group/renamed-1', '2026-11-16T10:00:00Z') $$,
  'a delivery from a source the endpoint has is recorded at the limit'
);
select is(
  (select source_name || ' ' || provider_webhook_id || ' ' || last_delivery_at::text
   from public.webhook_sources where endpoint_id = 'c3500004-0000-4000-8000-000000000001' and source_id = '1'),
  'group/renamed-1 hook-1 2026-11-16 10:00:00+00',
  'recording a delivery keeps the webhook StackDash created and takes the latest name'
);
select lives_ok(
  $$ select public.record_webhook_source('c3500004-0000-4000-8000-000000000001', '1', 'group/renamed-1', '2026-11-16T09:00:00Z') $$,
  'an older delivery arriving late is recorded'
);
select is(
  (select last_delivery_at from public.webhook_sources where endpoint_id = 'c3500004-0000-4000-8000-000000000001' and source_id = '1'),
  '2026-11-16T10:00:00Z'::timestamptz,
  'the newest arrival is kept when an older one arrives late'
);
select lives_ok(
  $$ select public.record_webhook_source('c3500004-0000-4000-8000-000000000002', '7', 'other/project', now()) $$,
  'another endpoint is not affected by the first one''s limit'
);
select throws_ok(
  $$ insert into public.webhook_sources (endpoint_id, source_id, source_name) values ('c3500004-0000-4000-8000-000000000002', '', 'empty') $$,
  '23514',
  null,
  'a blank source id is refused'
);

select throws_ok(
  $$ update public.webhook_endpoints set per_source = false where id = 'c3500004-0000-4000-8000-000000000001' $$,
  '23514',
  null,
  'an automatic endpoint that is not per source must still name the provider''s webhook'
);
select throws_ok(
  $$ update public.webhook_endpoints set per_source = true where id = 'c3500004-0000-4000-8000-000000000002' $$,
  '23514',
  null,
  'only an automatic endpoint is per source'
);
select throws_ok(
  $$ update public.webhook_endpoints set provider_webhook_id = 'hook_1' where id = 'c3500004-0000-4000-8000-000000000001' $$,
  '23514',
  null,
  'a per-source endpoint names no provider webhook of its own'
);

select lives_ok(
  $$ delete from public.webhook_endpoints where id = 'c3500004-0000-4000-8000-000000000001' $$,
  'an endpoint with sources can be deleted'
);
select is(
  (select count(*)::int from public.webhook_sources where endpoint_id = 'c3500004-0000-4000-8000-000000000001'),
  0,
  'its sources go with it'
);

-- Endpoint 2 (connection 2) holds source 7, known from a delivery and without a webhook.
select is(
  public.save_created_webhook_source('c3500004-0000-4000-8000-000000000002', '7', 'other/project', 'hook-a'),
  true,
  'a source known only from its deliveries takes the webhook created on it'
);
select is(
  public.save_created_webhook_source('c3500004-0000-4000-8000-000000000002', '7', 'other/project', 'hook-b'),
  false,
  'a second webhook for a source that holds one is not recorded (boundary: racing setups)'
);
select is(
  (select provider_webhook_id from public.webhook_sources where endpoint_id = 'c3500004-0000-4000-8000-000000000002' and source_id = '7'),
  'hook-a',
  'the webhook recorded first is kept, so disconnect still deletes it'
);
select is(
  public.save_created_webhook_source('c3500004-0000-4000-8000-000000000002', '8', 'another/project', 'hook-c'),
  true,
  'a new source records its webhook'
);
select is(
  public.delete_webhook_endpoint('c3500002-0000-4000-8000-000000000001', 'c3500003-0000-4000-8000-000000000002'),
  jsonb_build_object(
    'setup_mode', 'manual',
    'provider_webhook_id', null,
    'sources', jsonb_build_array(
      jsonb_build_object('source_id', '8', 'source_name', 'another/project', 'provider_webhook_id', 'hook-c'),
      jsonb_build_object('source_id', '7', 'source_name', 'other/project', 'provider_webhook_id', 'hook-a')
    )
  ),
  'deleting an endpoint returns its setup and every webhook to delete, by name'
);
select is(
  (select count(*)::int from public.webhook_sources where endpoint_id = 'c3500004-0000-4000-8000-000000000002')
    + (select count(*)::int from public.webhook_endpoints where id = 'c3500004-0000-4000-8000-000000000002'),
  0,
  'the endpoint and its sources are gone in the same call'
);
select is(
  public.delete_webhook_endpoint('c3500002-0000-4000-8000-000000000001', 'c3500003-0000-4000-8000-000000000002'),
  null,
  'a connection without an endpoint returns null (boundary: none)'
);

select ok(
  not has_table_privilege('authenticated', 'public.webhook_sources', 'select')
    and not has_table_privilege('anon', 'public.webhook_sources', 'select')
    and not has_function_privilege('authenticated', 'public.record_webhook_source(uuid, text, text, timestamptz)', 'execute')
    and not has_function_privilege('anon', 'public.record_webhook_source(uuid, text, text, timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'public.save_created_webhook_source(uuid, text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.save_created_webhook_source(uuid, text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.delete_webhook_endpoint(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.delete_webhook_endpoint(uuid, uuid)', 'execute'),
  'neither anon nor authenticated can read sources or call the functions'
);

select * from finish();
rollback;
