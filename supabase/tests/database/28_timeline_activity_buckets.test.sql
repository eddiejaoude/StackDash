-- Timeline activity overview (20261112212026_timeline_activity_buckets.sql, with severities from
-- 20261113100000_timeline_activity_bucket_severities.sql): at most 12 equal slices of time counting
-- every event the timeline's filters match, across all of its pages, and how many of them are
-- critical and warning, with zero slices kept, half open slices in whole microseconds, UTC widths
-- across Europe/London clock changes, and members only.
begin;

create extension if not exists pgtap with schema extensions;

select plan(41);

-- Fixtures as postgres: a viewer of workspace W, an outsider, a Vercel connection A with account
-- XA, a GitHub connection B with account XB. The outsider owns a second workspace W2 with one
-- Stripe event, and the viewer belongs to W2 as well, so every count below proves it reads only
-- the workspace asked for. W's events sit on separate days, one day per group of tests, so each
-- group's window or title filter sees only its own events.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('d3770001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'buckets-owner@example.com', '{"user_name": "buckets-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('d3770002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'buckets-viewer@example.com', '{"user_name": "buckets-viewer"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('d3770003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'buckets-outsider@example.com', '{"user_name": "buckets-outsider"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('d37700a0-0000-4000-8000-000000000000', 'Buckets team', 'd3770001-0000-4000-8000-000000000000'),
  ('d37700c0-0000-4000-8000-000000000000', 'Other buckets team', 'd3770003-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('d37700a0-0000-4000-8000-000000000000', 'd3770001-0000-4000-8000-000000000000', 'owner'),
  ('d37700a0-0000-4000-8000-000000000000', 'd3770002-0000-4000-8000-000000000000', 'viewer'),
  ('d37700c0-0000-4000-8000-000000000000', 'd3770003-0000-4000-8000-000000000000', 'owner'),
  ('d37700c0-0000-4000-8000-000000000000', 'd3770002-0000-4000-8000-000000000000', 'viewer');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds, mode)
values
  ('d37700a1-0000-4000-8000-000000000000', 'd37700a0-0000-4000-8000-000000000000', 'vercel', 'active', 'Vercel buckets', 3600, null),
  ('d37700b1-0000-4000-8000-000000000000', 'd37700a0-0000-4000-8000-000000000000', 'github', 'active', 'GitHub buckets', 3600, null),
  ('d37700c1-0000-4000-8000-000000000000', 'd37700c0-0000-4000-8000-000000000000', 'stripe', 'active', 'Stripe buckets', 3600, 'live');

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind)
values
  ('d37700a2-0000-4000-8000-000000000000', 'd37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'xa', 'Acme team', 'team'),
  ('d37700b2-0000-4000-8000-000000000000', 'd37700a0-0000-4000-8000-000000000000', 'd37700b1-0000-4000-8000-000000000000', 'xb', 'Acme org', 'organization');

-- 2026-01-10: 60 events, one a minute from 00:00 UTC, more than one timeline page.
insert into public.activity_events (workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key)
select
  'd37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
  'vercel', 'vercel.deployment_ready', 'info', 'Bulk deploy',
  '2026-01-10T00:00:00Z'::timestamptz + n * interval '1 minute', 'buckets-bulk-' || n
from generate_series(0, 59) as n;

insert into public.activity_events (workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key)
values
  -- 2026-02-01: boundaries. On the hour, a microsecond before 00:05, exactly 00:05, a microsecond
  -- before 01:00, and exactly 01:00.
  ('d37700a0-0000-4000-8000-000000000000', 'd37700b1-0000-4000-8000-000000000000', 'd37700b2-0000-4000-8000-000000000000',
   'github', 'github.release_published', 'info', 'Boundary tick', '2026-02-01T00:00:00Z', 'buckets-edge-1'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700b1-0000-4000-8000-000000000000', 'd37700b2-0000-4000-8000-000000000000',
   'github', 'github.release_published', 'info', 'Boundary tick', '2026-02-01T00:04:59.999999Z', 'buckets-edge-2'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700b1-0000-4000-8000-000000000000', 'd37700b2-0000-4000-8000-000000000000',
   'github', 'github.release_published', 'info', 'Boundary tick', '2026-02-01T00:05:00Z', 'buckets-edge-3'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700b1-0000-4000-8000-000000000000', 'd37700b2-0000-4000-8000-000000000000',
   'github', 'github.release_published', 'info', 'Boundary tick', '2026-02-01T00:59:59.999999Z', 'buckets-edge-4'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700b1-0000-4000-8000-000000000000', 'd37700b2-0000-4000-8000-000000000000',
   'github', 'github.release_published', 'info', 'Boundary tick', '2026-02-01T01:00:00Z', 'buckets-edge-5'),
  -- 2026-03-29: London springs forward at 01:00 UTC. 00:30 GMT, 02:30 BST, and 11:59:59 BST.
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'info', 'Clock change deploy', '2026-03-29T00:30:00Z', 'buckets-spring-1'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'info', 'Clock change deploy', '2026-03-29T01:30:00Z', 'buckets-spring-2'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'info', 'Clock change deploy', '2026-03-29T10:59:59Z', 'buckets-spring-3'),
  -- 2026-04-01: one event per filter. A's ready and failed deploys, B's release and StackDash's
  -- sync failure about B (provider and account null), and a daily summary with no connection.
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'info', 'Deployed', '2026-04-01T08:00:00Z', 'buckets-filter-1'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_error', 'critical', 'Deploy failed', '2026-04-01T08:30:00Z', 'buckets-filter-2'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700b1-0000-4000-8000-000000000000', 'd37700b2-0000-4000-8000-000000000000',
   'github', 'github.release_published', 'info', 'Released', '2026-04-01T09:00:00Z', 'buckets-filter-3'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700b1-0000-4000-8000-000000000000', null,
   null, 'stackdash.sync_failed', 'warning', 'Sync failed', '2026-04-01T09:15:00Z', 'buckets-filter-4'),
  ('d37700a0-0000-4000-8000-000000000000', null, null,
   null, 'stackdash.daily_summary', 'info', 'Daily summary', '2026-04-01T10:00:00Z', 'buckets-filter-5'),
  -- 2026-05-01: mixed severities. 03:00 to 04:00 UTC holds 2 critical, 3 warning, 1 info, and 1
  -- success event; 07:00 to 08:00 holds 1 critical event.
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_error', 'critical', 'Mixed failure', '2026-05-01T03:10:00Z', 'buckets-mixed-1'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_error', 'critical', 'Mixed failure', '2026-05-01T03:20:00Z', 'buckets-mixed-2'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'warning', 'Mixed slow deploy', '2026-05-01T03:30:00Z', 'buckets-mixed-3'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'warning', 'Mixed slow deploy', '2026-05-01T03:40:00Z', 'buckets-mixed-4'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'warning', 'Mixed slow deploy', '2026-05-01T03:45:00Z', 'buckets-mixed-5'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'info', 'Mixed deploy', '2026-05-01T03:50:00Z', 'buckets-mixed-6'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'success', 'Mixed deploy', '2026-05-01T03:55:00Z', 'buckets-mixed-7'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_error', 'critical', 'Mixed failure', '2026-05-01T07:00:00Z', 'buckets-mixed-8'),
  -- 2026-10-25: London falls back at 01:00 UTC. 01:30 BST, then 01:30 GMT.
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'info', 'Clock change deploy', '2026-10-25T00:30:00Z', 'buckets-autumn-1'),
  ('d37700a0-0000-4000-8000-000000000000', 'd37700a1-0000-4000-8000-000000000000', 'd37700a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment_ready', 'info', 'Clock change deploy', '2026-10-25T01:30:00Z', 'buckets-autumn-2'),
  -- W2: one Stripe event at 2026-04-01T09:00Z, which no count for W may include.
  ('d37700c0-0000-4000-8000-000000000000', 'd37700c1-0000-4000-8000-000000000000', null,
   'stripe', 'stripe.payment_succeeded', 'success', 'Payment', '2026-04-01T09:00:00Z', 'buckets-other-1');

select ok(
  not has_function_privilege('anon',
    'public.timeline_activity_buckets(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)', 'execute'),
  'timeline_activity_buckets: anon cannot execute it');
select ok(
  not has_function_privilege('service_role',
    'public.timeline_activity_buckets(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)', 'execute'),
  'timeline_activity_buckets: service_role cannot execute it');
select ok(
  has_function_privilege('authenticated',
    'public.timeline_activity_buckets(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)', 'execute'),
  'timeline_activity_buckets: authenticated can execute it');

-- The deployed app selects bucket_start, bucket_end, and events by name, so those keep their names,
-- types, and order, and the severity counts come after them.
select is(
  pg_get_function_result('public.timeline_activity_buckets(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)'::regprocedure),
  'TABLE(bucket_start timestamp with time zone, bucket_end timestamp with time zone, events bigint, critical_events bigint, warning_events bigint)',
  'timeline_activity_buckets: returns the original three columns first, then critical_events and warning_events');
select ok(
  (select not p.prosecdef and p.proconfig = array['search_path=""', 'plan_cache_mode=force_custom_plan']::text[] collate "C"
   from pg_proc p
   where p.oid = 'public.timeline_activity_buckets(uuid, text[], text[], public.event_severity[], public.provider_id[], uuid[], timestamptz, timestamptz, text)'::regprocedure),
  'timeline_activity_buckets: still security invoker, with an empty search path and a plan per call');

-- ---------------------------------------------------------------------------
-- As a viewer of W (and of W2).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "d3770002-0000-4000-8000-000000000000", "role": "authenticated"}';

-- Counts, not a page.
select results_eq(
  $$
    select bucket_start, bucket_end, events from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000',
      p_from => '2026-01-10T00:00:00Z', p_until => '2026-01-10T01:00:00Z')
  $$,
  $$
    select '2026-01-10T00:00:00Z'::timestamptz + n * interval '5 minutes',
           '2026-01-10T00:00:00Z'::timestamptz + (n + 1) * interval '5 minutes',
           5::bigint
    from generate_series(0, 11) as n
  $$,
  'timeline_activity_buckets: an hour makes 12 five minute slices in order, each counting its events');

select is(
  (select sum(events)::int from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000',
     p_from => '2026-01-10T00:00:00Z', p_until => '2026-01-10T01:00:00Z')),
  60,
  'timeline_activity_buckets: counts every matching event, more than one timeline page');

select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000',
     p_from => '2026-01-10T00:00:00Z', p_until => '2026-01-10T02:00:00Z')),
  array[10, 10, 10, 10, 10, 10, 0, 0, 0, 0, 0, 0]::bigint[],
  'timeline_activity_buckets: slices with no events come back with 0');

select results_eq(
  $$
    select bucket_start, bucket_end, events from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_title_pattern => 'Bulk')
  $$,
  $$
    select '2026-01-10T00:00:00Z'::timestamptz + n * interval '5 minutes',
           '2026-01-10T00:00:00Z'::timestamptz + (n + 1) * interval '5 minutes',
           5::bigint
    from generate_series(0, 11) as n
  $$,
  'timeline_activity_buckets: with no window, bounds run from the first event''s UTC hour to the hour after the last');

-- Boundaries, in whole microseconds.
select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000', p_title_pattern => 'Boundary',
     p_from => '2026-02-01T00:00:00Z', p_until => '2026-02-01T01:00:00Z')),
  array[2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]::bigint[],
  'timeline_activity_buckets: a slice includes its start, and a microsecond before the next start, and excludes the window end');

-- A session time zone 5:30 from UTC proves the floor is the UTC hour, not the session's.
set local timezone to 'Asia/Kolkata';
select results_eq(
  $$
    select min(bucket_start), max(bucket_end), count(*)::int, array_agg(events order by bucket_start)
    from public.timeline_activity_buckets('d37700a0-0000-4000-8000-000000000000', p_title_pattern => 'Boundary')
  $$,
  $$
    values ('2026-02-01T00:00:00Z'::timestamptz, '2026-02-01T02:00:00Z'::timestamptz, 12,
            array[3, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0]::bigint[])
  $$,
  'timeline_activity_buckets: a last event exactly on the hour stays inside the next UTC hour bound');
set local timezone to 'UTC';

select results_eq(
  $$
    select bucket_start, bucket_end, events from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_title_pattern => 'Boundary',
      p_from => '2026-02-01T00:00:00Z', p_until => '2026-02-01T00:13:00Z')
  $$,
  $$
    values
      ('2026-02-01T00:00:00Z'::timestamptz, '2026-02-01T00:02:00Z'::timestamptz, 1::bigint),
      ('2026-02-01T00:02:00Z'::timestamptz, '2026-02-01T00:04:00Z'::timestamptz, 0::bigint),
      ('2026-02-01T00:04:00Z'::timestamptz, '2026-02-01T00:06:00Z'::timestamptz, 2::bigint),
      ('2026-02-01T00:06:00Z'::timestamptz, '2026-02-01T00:08:00Z'::timestamptz, 0::bigint),
      ('2026-02-01T00:08:00Z'::timestamptz, '2026-02-01T00:10:00Z'::timestamptz, 0::bigint),
      ('2026-02-01T00:10:00Z'::timestamptz, '2026-02-01T00:12:00Z'::timestamptz, 0::bigint),
      ('2026-02-01T00:12:00Z'::timestamptz, '2026-02-01T00:13:00Z'::timestamptz, 0::bigint)
  $$,
  'timeline_activity_buckets: widths round up to whole minutes, so 13 minutes makes 7 slices and the last is clipped');

select results_eq(
  $$
    select bucket_start, bucket_end, events from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_title_pattern => 'Boundary',
      p_from => '2026-02-01T00:04:59.999999Z', p_until => '2026-02-01T00:05:00.000001Z')
  $$,
  $$ values ('2026-02-01T00:04:59.999999Z'::timestamptz, '2026-02-01T00:05:00.000001Z'::timestamptz, 2::bigint) $$,
  'timeline_activity_buckets: a window of two microseconds is one slice of at most a minute, clipped to the window');

select results_eq(
  $$
    select bucket_start, bucket_end, events from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_title_pattern => 'Boundary',
      p_from => '2026-02-01T00:00:00Z', p_until => '2026-02-01T00:02:00Z')
  $$,
  $$
    values
      ('2026-02-01T00:00:00Z'::timestamptz, '2026-02-01T00:01:00Z'::timestamptz, 1::bigint),
      ('2026-02-01T00:01:00Z'::timestamptz, '2026-02-01T00:02:00Z'::timestamptz, 0::bigint)
  $$,
  'timeline_activity_buckets: a slice is never narrower than one minute');

-- Europe/London clock changes: London calendar days of 23 and 25 hours, sliced in UTC seconds.
select results_eq(
  $$
    select count(*)::int, min(bucket_start), max(bucket_end), count(distinct bucket_end - bucket_start)::int,
           array_agg(events order by bucket_start)
    from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000',
      p_from => '2026-03-29 00:00:00 Europe/London', p_until => '2026-03-30 00:00:00 Europe/London')
  $$,
  $$
    values (12, '2026-03-29T00:00:00Z'::timestamptz, '2026-03-29T23:00:00Z'::timestamptz, 1,
            array[2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]::bigint[])
  $$,
  'timeline_activity_buckets: the 23 hour London day when clocks go forward makes 12 equal slices of 115 minutes');

select results_eq(
  $$
    select count(*)::int, min(bucket_start), max(bucket_end), count(distinct bucket_end - bucket_start)::int,
           array_agg(events order by bucket_start)
    from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000',
      p_from => '2026-10-25 00:00:00 Europe/London', p_until => '2026-10-26 00:00:00 Europe/London')
  $$,
  $$
    values (12, '2026-10-24T23:00:00Z'::timestamptz, '2026-10-26T00:00:00Z'::timestamptz, 1,
            array[1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[])
  $$,
  'timeline_activity_buckets: the 25 hour London day when clocks go back makes 12 equal slices of 125 minutes, both 01:30s counted');

-- Filters, over 2026-04-01 00:00 to 12:00 UTC: 12 one hour slices.
select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000',
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  array[0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 1, 0]::bigint[],
  'timeline_activity_buckets: no filter counts every event, including events with no connection');

select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000', p_type_ids => array['vercel.deployment_ready'],
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  array[0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]::bigint[],
  'timeline_activity_buckets: a type filter counts only those types');

select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000', p_hidden_type_ids => array['vercel.deployment_ready', 'stackdash.sync_failed'],
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  array[0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0]::bigint[],
  'timeline_activity_buckets: hidden types are excluded');

select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000', p_severities => array['critical', 'warning']::public.event_severity[],
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  array[0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]::bigint[],
  'timeline_activity_buckets: a severity filter counts only those severities');

select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000', p_providers => array['github']::public.provider_id[],
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  array[0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]::bigint[],
  'timeline_activity_buckets: a provider filter matches the event provider, so a StackDash event drops out');

select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000', p_account_ids => array['d37700b2-0000-4000-8000-000000000000']::uuid[],
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  array[0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]::bigint[],
  'timeline_activity_buckets: an account filter counts only events of those accounts');

select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000', p_account_ids => array[]::uuid[],
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  array[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[],
  'timeline_activity_buckets: an empty account list counts nothing, and a window still gets its slices');

select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000', p_title_pattern => 'FAIL',
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  array[0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]::bigint[],
  'timeline_activity_buckets: a title pattern counts titles containing it, ignoring case');

-- The app escapes every metacharacter (titleSearchPattern), so "Deploy." is sent as "Deploy\.":
-- a literal dot, which no title has, where an unescaped dot would match "Deployed".
select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700a0-0000-4000-8000-000000000000', p_title_pattern => 'Deploy\.',
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  array[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[],
  'timeline_activity_buckets: an escaped metacharacter in the title pattern matches literally');

select is(
  (select array_agg(events order by bucket_start) from public.timeline_activity_buckets(
     'd37700c0-0000-4000-8000-000000000000',
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  array[0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]::bigint[],
  'timeline_activity_buckets: a member of two workspaces counts only the workspace asked for');

-- Severities, over 2026-05-01 00:00 to 12:00 UTC: 12 one hour slices.
select results_eq(
  $$
    select array_agg(events order by bucket_start), array_agg(critical_events order by bucket_start),
           array_agg(warning_events order by bucket_start)
    from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000',
      p_from => '2026-05-01T00:00:00Z', p_until => '2026-05-01T12:00:00Z')
  $$,
  $$
    values (array[0, 0, 0, 7, 0, 0, 0, 1, 0, 0, 0, 0]::bigint[],
            array[0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0]::bigint[],
            array[0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[])
  $$,
  'timeline_activity_buckets: a slice with mixed severities counts its critical and warning events beside the total');

select results_eq(
  $$
    select array_agg(events order by bucket_start), array_agg(critical_events order by bucket_start),
           array_agg(warning_events order by bucket_start)
    from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_severities => array['critical']::public.event_severity[],
      p_from => '2026-05-01T00:00:00Z', p_until => '2026-05-01T12:00:00Z')
  $$,
  $$
    values (array[0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0]::bigint[],
            array[0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0]::bigint[],
            array[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[])
  $$,
  'timeline_activity_buckets: with a critical severity filter, every counted event is critical and none is a warning');

select results_eq(
  $$
    select array_agg(events order by bucket_start), array_agg(critical_events order by bucket_start),
           array_agg(warning_events order by bucket_start)
    from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_severities => array['warning']::public.event_severity[],
      p_from => '2026-05-01T00:00:00Z', p_until => '2026-05-01T12:00:00Z')
  $$,
  $$
    values (array[0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[],
            array[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[],
            array[0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[])
  $$,
  'timeline_activity_buckets: with a warning severity filter, the critical events drop out of every count');

select results_eq(
  $$
    select array_agg(events order by bucket_start), array_agg(critical_events order by bucket_start),
           array_agg(warning_events order by bucket_start)
    from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_severities => array['info', 'success']::public.event_severity[],
      p_from => '2026-05-01T00:00:00Z', p_until => '2026-05-01T12:00:00Z')
  $$,
  $$
    values (array[0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[],
            array[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[],
            array[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[])
  $$,
  'timeline_activity_buckets: with an info and success severity filter, the slices count no critical or warning events');

select results_eq(
  $$
    select count(*)::int, sum(events)::int, sum(critical_events)::int, sum(warning_events)::int
    from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_title_pattern => 'no title has this',
      p_from => '2026-05-01T00:00:00Z', p_until => '2026-05-01T12:00:00Z')
  $$,
  $$ values (12, 0, 0, 0) $$,
  'timeline_activity_buckets: a window with no matching event returns 12 zero slices, with 0 critical and 0 warning');

-- No bounds, no rows.
select is_empty(
  $$
    select * from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_title_pattern => 'no title has this')
  $$,
  'timeline_activity_buckets: no window and no matching event returns no slices');

select is_empty(
  $$
    select * from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_from => '2027-01-01T00:00:00Z')
  $$,
  'timeline_activity_buckets: a window start with no matching event after it returns no slices');

select is_empty(
  $$
    select * from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000',
      p_from => '2026-04-01T12:00:00Z', p_until => '2026-04-01T00:00:00Z')
  $$,
  'timeline_activity_buckets: a window ending before it starts returns no slices');

select is_empty(
  $$
    select * from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000',
      p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T00:00:00Z')
  $$,
  'timeline_activity_buckets: an empty window returns no slices');

select is_empty(
  $$
    select * from public.timeline_activity_buckets(
      'd37700ff-0000-4000-8000-000000000000',
      p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')
  $$,
  'timeline_activity_buckets: a workspace that does not exist returns no slices, not even zero ones');

-- ---------------------------------------------------------------------------
-- As someone outside W: the membership check returns nothing before any bound is worked out.
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "d3770003-0000-4000-8000-000000000000", "role": "authenticated"}';

select is_empty(
  $$
    select * from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000',
      p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')
  $$,
  'timeline_activity_buckets: a non member gets no slices for a window, not even zero ones');

select is_empty(
  $$ select * from public.timeline_activity_buckets('d37700a0-0000-4000-8000-000000000000') $$,
  'timeline_activity_buckets: a non member gets no slices without a window');

select is_empty(
  $$
    select * from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000', p_severities => array['critical']::public.event_severity[],
      p_from => '2026-05-01T00:00:00Z', p_until => '2026-05-01T12:00:00Z')
  $$,
  'timeline_activity_buckets: a non member gets no severity counts for a window with critical events');

select is(
  (select sum(events)::int from public.timeline_activity_buckets(
     'd37700c0-0000-4000-8000-000000000000',
     p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')),
  1,
  'timeline_activity_buckets: the outsider still counts their own workspace');

-- ---------------------------------------------------------------------------
-- Signed out: no execute grant.
-- ---------------------------------------------------------------------------
reset request.jwt.claims;
set local role anon;

select throws_ok(
  $$
    select * from public.timeline_activity_buckets(
      'd37700a0-0000-4000-8000-000000000000',
      p_from => '2026-04-01T00:00:00Z', p_until => '2026-04-01T12:00:00Z')
  $$,
  '42501',
  null,
  'timeline_activity_buckets: anon is denied');

reset role;

select * from finish();
rollback;
