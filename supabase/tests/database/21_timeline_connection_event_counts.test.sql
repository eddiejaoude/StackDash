-- Timeline connection badges (20261107090000_timeline_connection_event_counts.sql, title search
-- from 20261110090000_timeline_title_search.sql): one row per connection under the same filters as
-- the event list, members only, half open windows, and events with no connection in no row.
begin;

create extension if not exists pgtap with schema extensions;

select plan(19);

-- Fixtures as postgres: a viewer of workspace W, an outsider, a Vercel connection A with account
-- XA, a GitHub connection B with account XB, and events on both sides of each filter. The outsider
-- owns a second workspace W2 with one Stripe event, and the viewer belongs to W2 as well, so the
-- viewer can see both workspaces and every count below proves it reads only the one asked for.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('d2450001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'badge-owner@example.com', '{"user_name": "badge-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('d2450002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'badge-viewer@example.com', '{"user_name": "badge-viewer"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('d2450003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'badge-outsider@example.com', '{"user_name": "badge-outsider"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('d24500a0-0000-4000-8000-000000000000', 'Badge team', 'd2450001-0000-4000-8000-000000000000'),
  ('d24500c0-0000-4000-8000-000000000000', 'Other badge team', 'd2450003-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('d24500a0-0000-4000-8000-000000000000', 'd2450001-0000-4000-8000-000000000000', 'owner'),
  ('d24500a0-0000-4000-8000-000000000000', 'd2450002-0000-4000-8000-000000000000', 'viewer'),
  ('d24500c0-0000-4000-8000-000000000000', 'd2450003-0000-4000-8000-000000000000', 'owner'),
  ('d24500c0-0000-4000-8000-000000000000', 'd2450002-0000-4000-8000-000000000000', 'viewer');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
values
  ('d24500a1-0000-4000-8000-000000000000', 'd24500a0-0000-4000-8000-000000000000', 'vercel', 'active', 'Vercel badge', 3600),
  ('d24500b1-0000-4000-8000-000000000000', 'd24500a0-0000-4000-8000-000000000000', 'github', 'active', 'GitHub badge', 3600),
  ('d24500c1-0000-4000-8000-000000000000', 'd24500c0-0000-4000-8000-000000000000', 'stripe', 'active', 'Stripe badge', 3600);

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind)
values
  ('d24500a2-0000-4000-8000-000000000000', 'd24500a0-0000-4000-8000-000000000000', 'd24500a1-0000-4000-8000-000000000000', 'xa', 'Acme team', 'team'),
  ('d24500b2-0000-4000-8000-000000000000', 'd24500a0-0000-4000-8000-000000000000', 'd24500b1-0000-4000-8000-000000000000', 'xb', 'Acme org', 'organization');

insert into public.activity_events (workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key)
values
  -- A: three events. The first sits exactly on the window start, the last just before its end.
  ('d24500a0-0000-4000-8000-000000000000', 'd24500a1-0000-4000-8000-000000000000', 'd24500a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'info', 'Deployed', '2026-11-02T00:00:00Z', 'badge-1'),
  ('d24500a0-0000-4000-8000-000000000000', 'd24500a1-0000-4000-8000-000000000000', 'd24500a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_error', 'critical', 'Deploy failed', '2026-11-03T00:00:00Z', 'badge-2'),
  ('d24500a0-0000-4000-8000-000000000000', 'd24500a1-0000-4000-8000-000000000000', 'd24500a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'info', 'Deployed', '2026-11-05T23:59:59.999Z', 'badge-3'),
  -- A: the instant the window ends, outside it.
  ('d24500a0-0000-4000-8000-000000000000', 'd24500a1-0000-4000-8000-000000000000', 'd24500a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'info', 'Deployed', '2026-11-06T00:00:00Z', 'badge-4'),
  -- B: a provider event, and StackDash's own sync failure about B (provider null, connection set).
  ('d24500a0-0000-4000-8000-000000000000', 'd24500b1-0000-4000-8000-000000000000', 'd24500b2-0000-4000-8000-000000000000',
   'github', 'github.release_published', 'info', 'Released', '2026-11-04T12:00:00Z', 'badge-5'),
  ('d24500a0-0000-4000-8000-000000000000', 'd24500b1-0000-4000-8000-000000000000', null,
   null, 'stackdash.sync_failed', 'warning', 'Sync failed', '2026-11-04T13:00:00Z', 'badge-6'),
  -- No connection: a daily summary belongs to no badge.
  ('d24500a0-0000-4000-8000-000000000000', null, null,
   null, 'stackdash.daily_summary', 'info', 'Daily summary', '2026-11-04T08:00:00Z', 'badge-7'),
  -- W2: one Stripe event, which no count for W may include.
  ('d24500c0-0000-4000-8000-000000000000', 'd24500c1-0000-4000-8000-000000000000', null,
   'stripe', 'stripe.payment_succeeded', 'success', 'Payment', '2026-11-04T09:00:00Z', 'badge-8');

-- ---------------------------------------------------------------------------
-- Shape: security definer, empty search_path, members only.
-- ---------------------------------------------------------------------------
select ok(
  (select p.prosecdef from pg_catalog.pg_proc p
   where p.oid = 'public.timeline_connection_event_counts(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)'::regprocedure),
  'timeline_connection_event_counts: security definer, gated by one membership check rather than per row policies');
select ok(
  (select coalesce(p.proconfig && array['search_path=""', 'search_path='], false)
   from pg_catalog.pg_proc p
   where p.oid = 'public.timeline_connection_event_counts(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)'::regprocedure),
  'timeline_connection_event_counts: sets search_path to empty');
select ok(
  not has_function_privilege('anon',
    'public.timeline_connection_event_counts(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)', 'execute'),
  'timeline_connection_event_counts: anon cannot execute it');
select ok(
  not has_function_privilege('service_role',
    'public.timeline_connection_event_counts(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)', 'execute'),
  'timeline_connection_event_counts: service_role cannot execute it');
select ok(
  has_function_privilege('authenticated',
    'public.timeline_connection_event_counts(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)', 'execute'),
  'timeline_connection_event_counts: authenticated can execute it');

-- ---------------------------------------------------------------------------
-- As a viewer of W.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "d2450002-0000-4000-8000-000000000000", "role": "authenticated"}';

select results_eq(
  $$
    select display_name, provider, events from public.timeline_connection_event_counts('d24500a0-0000-4000-8000-000000000000')
    order by display_name
  $$,
  $$ values ('GitHub badge'::text, 'github'::public.provider_id, 2::bigint), ('Vercel badge'::text, 'vercel'::public.provider_id, 4::bigint) $$,
  'timeline_connection_event_counts: no filters counts every event per connection, StackDash events about a connection included');

select is(
  (select sum(events)::int from public.timeline_connection_event_counts('d24500a0-0000-4000-8000-000000000000')),
  6,
  'timeline_connection_event_counts: an event with no connection is in no row');

select results_eq(
  $$
    select display_name, events from public.timeline_connection_event_counts(
      'd24500a0-0000-4000-8000-000000000000', p_type_ids => array['vercel.deployment_ready'])
  $$,
  $$ values ('Vercel badge'::text, 3::bigint) $$,
  'timeline_connection_event_counts: a type filter counts only those types and drops connections with none');

select results_eq(
  $$
    select display_name, events from public.timeline_connection_event_counts(
      'd24500a0-0000-4000-8000-000000000000', p_hidden_type_ids => array['vercel.deployment_ready', 'stackdash.sync_failed'])
    order by display_name
  $$,
  $$ values ('GitHub badge'::text, 1::bigint), ('Vercel badge'::text, 1::bigint) $$,
  'timeline_connection_event_counts: hidden types are excluded');

select results_eq(
  $$
    select display_name, events from public.timeline_connection_event_counts(
      'd24500a0-0000-4000-8000-000000000000', p_severities => array['critical', 'warning']::public.event_severity[])
    order by display_name
  $$,
  $$ values ('GitHub badge'::text, 1::bigint), ('Vercel badge'::text, 1::bigint) $$,
  'timeline_connection_event_counts: a severity filter counts only those severities');

select results_eq(
  $$
    select display_name, events from public.timeline_connection_event_counts(
      'd24500a0-0000-4000-8000-000000000000', p_providers => array['github']::public.provider_id[])
  $$,
  $$ values ('GitHub badge'::text, 1::bigint) $$,
  'timeline_connection_event_counts: a provider filter matches the event provider, as the list does, so a StackDash event drops out');

select results_eq(
  $$
    select display_name, events from public.timeline_connection_event_counts(
      'd24500a0-0000-4000-8000-000000000000', p_account_ids => array['d24500b2-0000-4000-8000-000000000000']::uuid[])
  $$,
  $$ values ('GitHub badge'::text, 1::bigint) $$,
  'timeline_connection_event_counts: an account filter counts only events of those accounts');

select is_empty(
  $$
    select * from public.timeline_connection_event_counts(
      'd24500a0-0000-4000-8000-000000000000', p_account_ids => array[]::uuid[])
  $$,
  'timeline_connection_event_counts: an empty account list counts nothing');

select results_eq(
  $$
    select display_name, events from public.timeline_connection_event_counts(
      'd24500a0-0000-4000-8000-000000000000',
      p_from => '2026-11-02T00:00:00Z', p_until => '2026-11-06T00:00:00Z')
    order by display_name
  $$,
  $$ values ('GitHub badge'::text, 2::bigint), ('Vercel badge'::text, 3::bigint) $$,
  'timeline_connection_event_counts: the window includes its start and excludes its end');

select is_empty(
  $$
    select * from public.timeline_connection_event_counts(
      'd24500a0-0000-4000-8000-000000000000',
      p_from => '2026-11-06T00:00:00Z', p_until => '2026-11-06T00:00:00Z')
  $$,
  'timeline_connection_event_counts: an empty window counts nothing');

select results_eq(
  $$
    select display_name, events from public.timeline_connection_event_counts(
      'd24500a0-0000-4000-8000-000000000000', p_title_pattern => 'FAIL')
    order by display_name
  $$,
  $$ values ('GitHub badge'::text, 1::bigint), ('Vercel badge'::text, 1::bigint) $$,
  'timeline_connection_event_counts: a title pattern counts titles containing it, ignoring case');

-- The app escapes every metacharacter (titleSearchPattern), so "Deploy." is sent as "Deploy\.":
-- a literal dot, which no title has, where an unescaped dot would match "Deployed".
select is_empty(
  $$
    select * from public.timeline_connection_event_counts(
      'd24500a0-0000-4000-8000-000000000000', p_title_pattern => 'Deploy\.')
  $$,
  'timeline_connection_event_counts: an escaped metacharacter in the title pattern matches literally');

select results_eq(
  $$
    select display_name, events from public.timeline_connection_event_counts('d24500c0-0000-4000-8000-000000000000')
  $$,
  $$ values ('Stripe badge'::text, 1::bigint) $$,
  'timeline_connection_event_counts: a member of two workspaces counts only the workspace asked for');

-- ---------------------------------------------------------------------------
-- As someone outside W: the membership check returns nothing.
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "d2450003-0000-4000-8000-000000000000", "role": "authenticated"}';

select is_empty(
  $$ select * from public.timeline_connection_event_counts('d24500a0-0000-4000-8000-000000000000') $$,
  'timeline_connection_event_counts: a non member counts nothing');

reset request.jwt.claims;
reset role;

select * from finish();
rollback;
