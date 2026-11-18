-- Year in review slides (20261111120000_year_review_slides.sql): events per Europe/London day and
-- per provider with the payment types left out, and the longest run of successful deployments,
-- members only, half open windows, only the accounts asked for, at most 366 days.
begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

-- Fixtures as postgres: a viewer of workspace W, an outsider, a Vercel connection with account XA,
-- a Stripe connection with account XS, and a second Vercel account XB that is never asked for.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('e2620001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'review-owner@example.com', '{"user_name": "review-owner"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('e2620002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'review-viewer@example.com', '{"user_name": "review-viewer"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('e2620003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'review-outsider@example.com', '{"user_name": "review-outsider"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values ('e26200a0-0000-4000-8000-000000000000', 'Review team', 'e2620001-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('e26200a0-0000-4000-8000-000000000000', 'e2620001-0000-4000-8000-000000000000', 'owner'),
  ('e26200a0-0000-4000-8000-000000000000', 'e2620002-0000-4000-8000-000000000000', 'viewer');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds, mode)
values
  ('e26200a1-0000-4000-8000-000000000000', 'e26200a0-0000-4000-8000-000000000000', 'vercel', 'active', 'Vercel review', 3600, null),
  ('e26200b1-0000-4000-8000-000000000000', 'e26200a0-0000-4000-8000-000000000000', 'stripe', 'active', 'Stripe review', 3600, 'live');

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind)
values
  ('e26200a2-0000-4000-8000-000000000000', 'e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'xa', 'Acme team', 'team'),
  ('e26200a3-0000-4000-8000-000000000000', 'e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'xb', 'Other team', 'team'),
  ('e26200b2-0000-4000-8000-000000000000', 'e26200a0-0000-4000-8000-000000000000', 'e26200b1-0000-4000-8000-000000000000', 'xs', 'Acme payments', 'account');

-- Vercel events of XA. In summer London is an hour ahead of UTC, so 23:30 UTC on 30 June is
-- already 1 July there; in winter London is UTC, so 23:30 UTC on 15 January stays 15 January.
-- In occurred_at order the deployments read S S F S S S, then a success and a failure at one instant.
insert into public.activity_events (workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key)
values
  ('e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'e26200a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2026-01-01T00:00:00Z', 'review-1'),
  ('e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'e26200a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2026-01-15T23:30:00Z', 'review-2'),
  ('e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'e26200a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.failed', 'critical', 'Deploy failed', '2026-03-01T12:00:00Z', 'review-3'),
  ('e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'e26200a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2026-06-30T23:30:00Z', 'review-4'),
  ('e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'e26200a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2026-07-01T00:30:00Z', 'review-5'),
  ('e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'e26200a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2026-07-02T10:00:00Z', 'review-6'),
  ('e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'e26200a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2026-08-01T09:00:00Z', 'review-7'),
  ('e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'e26200a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.failed', 'critical', 'Deploy failed', '2026-08-01T09:00:00Z', 'review-8'),
  -- The instant the window ends, outside it.
  ('e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'e26200a2-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2027-01-01T00:00:00Z', 'review-9'),
  -- An account that was not asked for.
  ('e26200a0-0000-4000-8000-000000000000', 'e26200a1-0000-4000-8000-000000000000', 'e26200a3-0000-4000-8000-000000000000',
   'vercel', 'vercel.deployment.succeeded', 'success', 'Deployed', '2026-07-01T12:00:00Z', 'review-10'),
  -- Stripe events of XS on 1 July: a payment, which is left out, and a new customer, which counts.
  ('e26200a0-0000-4000-8000-000000000000', 'e26200b1-0000-4000-8000-000000000000', 'e26200b2-0000-4000-8000-000000000000',
   'stripe', 'stripe.charge.succeeded', 'success', 'Payment succeeded', '2026-07-01T12:00:00Z', 'review-11'),
  ('e26200a0-0000-4000-8000-000000000000', 'e26200b1-0000-4000-8000-000000000000', 'e26200b2-0000-4000-8000-000000000000',
   'stripe', 'stripe.customer.created', 'info', 'New customer', '2026-07-01T13:00:00Z', 'review-12'),
  -- StackDash's own daily summary: no account, so it never counts.
  ('e26200a0-0000-4000-8000-000000000000', null, null,
   null, 'stackdash.daily_summary', 'info', 'Daily summary', '2026-07-01T08:00:00Z', 'review-13');

-- ---------------------------------------------------------------------------
-- Shape: security definer behind a membership check, empty search_path, members only.
-- ---------------------------------------------------------------------------
select ok(
  (select p.prosecdef from pg_catalog.pg_proc p where p.oid = 'public.year_review_event_counts(uuid, uuid[], text[], timestamptz, timestamptz)'::regprocedure),
  'year_review_event_counts: security definer, with the membership check inside');
select ok(
  (select coalesce(p.proconfig && array['search_path=""', 'search_path='], false)
   from pg_catalog.pg_proc p where p.oid = 'public.year_review_event_counts(uuid, uuid[], text[], timestamptz, timestamptz)'::regprocedure),
  'year_review_event_counts: sets search_path to empty');
select ok(not has_function_privilege('anon', 'public.year_review_event_counts(uuid, uuid[], text[], timestamptz, timestamptz)', 'execute'),
  'year_review_event_counts: anon cannot execute it');
select ok(not has_function_privilege('service_role', 'public.year_review_event_counts(uuid, uuid[], text[], timestamptz, timestamptz)', 'execute'),
  'year_review_event_counts: the service role cannot execute it');
select ok(has_function_privilege('authenticated', 'public.year_review_event_counts(uuid, uuid[], text[], timestamptz, timestamptz)', 'execute'),
  'year_review_event_counts: authenticated can execute it');
select ok(
  (select p.prosecdef from pg_catalog.pg_proc p where p.oid = 'public.year_review_longest_run(uuid, uuid[], text, text, timestamptz, timestamptz)'::regprocedure),
  'year_review_longest_run: security definer, with the membership check inside');
select ok(
  (select coalesce(p.proconfig && array['search_path=""', 'search_path='], false)
   from pg_catalog.pg_proc p where p.oid = 'public.year_review_longest_run(uuid, uuid[], text, text, timestamptz, timestamptz)'::regprocedure),
  'year_review_longest_run: sets search_path to empty');
select ok(not has_function_privilege('anon', 'public.year_review_longest_run(uuid, uuid[], text, text, timestamptz, timestamptz)', 'execute'),
  'year_review_longest_run: anon cannot execute it');
select ok(has_function_privilege('authenticated', 'public.year_review_longest_run(uuid, uuid[], text, text, timestamptz, timestamptz)', 'execute'),
  'year_review_longest_run: authenticated can execute it');
select has_index('public', 'activity_events', 'activity_events_workspace_type_time_idx', array['workspace_id', 'type_id', 'occurred_at'],
  'activity_events_workspace_type_time_idx serves the run''s two types');

-- ---------------------------------------------------------------------------
-- As a viewer of W.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "e2620002-0000-4000-8000-000000000000", "role": "authenticated"}';

select results_eq(
  $$
    select day, events from public.year_review_event_counts(
      'e26200a0-0000-4000-8000-000000000000',
      array['e26200a2-0000-4000-8000-000000000000', 'e26200b2-0000-4000-8000-000000000000']::uuid[],
      array['stripe.charge.succeeded'],
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
    where bucket = 'day'
    order by day
  $$,
  $$ values
    ('2026-01-01'::date, 1::bigint),
    ('2026-01-15'::date, 1::bigint),
    ('2026-03-01'::date, 1::bigint),
    ('2026-07-01'::date, 3::bigint),
    ('2026-07-02'::date, 1::bigint),
    ('2026-08-01'::date, 2::bigint) $$,
  'year_review_event_counts: London days (23:30 UTC in summer is the next day), payments, other accounts, and accountless events left out');

select results_eq(
  $$
    select provider, events from public.year_review_event_counts(
      'e26200a0-0000-4000-8000-000000000000',
      array['e26200a2-0000-4000-8000-000000000000', 'e26200b2-0000-4000-8000-000000000000']::uuid[],
      array['stripe.charge.succeeded'],
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
    where bucket = 'provider'
    order by provider
  $$,
  $$ values ('vercel'::public.provider_id, 8::bigint), ('stripe'::public.provider_id, 1::bigint) $$,
  'year_review_event_counts: one row per provider over the window, without the payment');

select results_eq(
  $$
    select sum(events)::bigint from public.year_review_event_counts(
      'e26200a0-0000-4000-8000-000000000000',
      array['e26200a2-0000-4000-8000-000000000000']::uuid[],
      array[]::text[],
      '2026-07-01T00:30:00Z', '2026-07-02T10:00:00Z')
    where bucket = 'day'
  $$,
  $$ values (1::bigint) $$,
  'year_review_event_counts: the window is half open, from included and until excluded');

select throws_ok(
  $$
    select * from public.year_review_event_counts(
      'e26200a0-0000-4000-8000-000000000000',
      array['e26200a2-0000-4000-8000-000000000000']::uuid[],
      array[]::text[],
      '2026-01-01T00:00:00Z', '2027-01-02T00:00:01Z')
  $$,
  '22023', null,
  'year_review_event_counts: a window longer than 366 days is refused');

select is(
  public.year_review_longest_run(
    'e26200a0-0000-4000-8000-000000000000',
    array['e26200a2-0000-4000-8000-000000000000']::uuid[],
    'vercel.deployment.succeeded', 'vercel.deployment.failed',
    '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'),
  3,
  'year_review_longest_run: S S F S S S [S F at one instant] is 3, since a failure resets the run and goes first at a shared instant');

select is(
  public.year_review_longest_run(
    'e26200a0-0000-4000-8000-000000000000',
    array['e26200a2-0000-4000-8000-000000000000']::uuid[],
    'vercel.deployment.succeeded', 'vercel.deployment.failed',
    '2026-01-01T00:00:00Z', '2026-03-01T12:00:00Z'),
  2,
  'year_review_longest_run: a window ending before the first failure counts the successes in it');

select is(
  public.year_review_longest_run(
    'e26200a0-0000-4000-8000-000000000000',
    array['e26200a2-0000-4000-8000-000000000000']::uuid[],
    'vercel.deployment.succeeded', 'vercel.deployment.failed',
    '2026-02-01T00:00:00Z', '2026-06-01T00:00:00Z'),
  0,
  'year_review_longest_run: a window with only a failure is 0');

select is(
  public.year_review_longest_run(
    'e26200a0-0000-4000-8000-000000000000',
    array[]::uuid[],
    'vercel.deployment.succeeded', 'vercel.deployment.failed',
    '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'),
  0,
  'year_review_longest_run: no accounts in scope is 0');

select throws_ok(
  $$
    select public.year_review_longest_run(
      'e26200a0-0000-4000-8000-000000000000',
      array['e26200a2-0000-4000-8000-000000000000']::uuid[],
      'vercel.deployment.succeeded', 'vercel.deployment.succeeded',
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
  $$,
  '22023', null,
  'year_review_longest_run: the same type as success and failure is refused');

select throws_ok(
  $$
    select public.year_review_longest_run(
      'e26200a0-0000-4000-8000-000000000000',
      array['e26200a2-0000-4000-8000-000000000000']::uuid[],
      'vercel.deployment.succeeded', 'vercel.deployment.failed',
      '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  $$,
  '22023', null,
  'year_review_longest_run: a window that ends before it starts is refused');

-- ---------------------------------------------------------------------------
-- As someone outside W: nothing counts.
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "e2620003-0000-4000-8000-000000000000", "role": "authenticated"}';

select is_empty(
  $$
    select * from public.year_review_event_counts(
      'e26200a0-0000-4000-8000-000000000000',
      array['e26200a2-0000-4000-8000-000000000000', 'e26200b2-0000-4000-8000-000000000000']::uuid[],
      array[]::text[],
      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
  $$,
  'year_review_event_counts: a non member counts nothing');

select is(
  public.year_review_longest_run(
    'e26200a0-0000-4000-8000-000000000000',
    array['e26200a2-0000-4000-8000-000000000000']::uuid[],
    'vercel.deployment.succeeded', 'vercel.deployment.failed',
    '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'),
  0,
  'year_review_longest_run: a non member counts nothing');

reset request.jwt.claims;
reset role;

select * from finish();
rollback;
