-- Filter picker options (20261112092000_filter_picker_options.sql, #319): every distinct value a
-- workspace holds, however old, members only, and the anomaly picker's rows bounded by series
-- rather than by days of history.
begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

-- Fixtures as postgres: an owner and a viewer of workspace W, and an outsider who owns W2. W holds
-- 1,000 recent events of one type and one older event of another, 5 recent spend series and 5
-- recent allowance series of 205 days each (2,050 rows), and one series of each reported only on
-- 2026-01-05, long before the newest 1,000 rows. W3 is empty.
insert into auth.users (
  id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change_token_current, email_change,
  phone_change, phone_change_token, reauthentication_token
)
select v.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v.email,
  jsonb_build_object('user_name', split_part(v.email, '@', 1)), '{"provider": "github", "providers": ["github"]}', now(), now(),
  '', '', '', '', '', '', '', ''
from (
  values
    ('d3190001-0000-4000-8000-000000000000'::uuid, 'picker-owner@example.com'),
    ('d3190002-0000-4000-8000-000000000000'::uuid, 'picker-viewer@example.com'),
    ('d3190003-0000-4000-8000-000000000000'::uuid, 'picker-outsider@example.com')
) as v(id, email);

insert into public.workspaces (id, name, created_by)
values
  ('d31900a0-0000-4000-8000-000000000000', 'Picker team', 'd3190001-0000-4000-8000-000000000000'),
  ('d31900c0-0000-4000-8000-000000000000', 'Other picker team', 'd3190003-0000-4000-8000-000000000000'),
  ('d31900e0-0000-4000-8000-000000000000', 'Empty picker team', 'd3190001-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('d31900a0-0000-4000-8000-000000000000', 'd3190001-0000-4000-8000-000000000000', 'owner'),
  ('d31900a0-0000-4000-8000-000000000000', 'd3190002-0000-4000-8000-000000000000', 'viewer'),
  ('d31900c0-0000-4000-8000-000000000000', 'd3190003-0000-4000-8000-000000000000', 'owner'),
  ('d31900e0-0000-4000-8000-000000000000', 'd3190001-0000-4000-8000-000000000000', 'owner'),
  ('d31900e0-0000-4000-8000-000000000000', 'd3190002-0000-4000-8000-000000000000', 'viewer');

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds, mode)
values
  ('d31900a1-0000-4000-8000-000000000000', 'd31900a0-0000-4000-8000-000000000000', 'fake', 'active', 'Fake picker', 3600, null),
  ('d31900b1-0000-4000-8000-000000000000', 'd31900a0-0000-4000-8000-000000000000', 'github', 'active', 'GitHub picker', 3600, null),
  ('d31900c1-0000-4000-8000-000000000000', 'd31900c0-0000-4000-8000-000000000000', 'stripe', 'active', 'Stripe picker', 3600, 'live');

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind)
values
  ('d31900a2-0000-4000-8000-000000000000', 'd31900a0-0000-4000-8000-000000000000', 'd31900a1-0000-4000-8000-000000000000', 'xa', 'Fake team', 'team'),
  ('d31900b2-0000-4000-8000-000000000000', 'd31900a0-0000-4000-8000-000000000000', 'd31900b1-0000-4000-8000-000000000000', 'xb', 'Acme org', 'organization'),
  ('d31900c2-0000-4000-8000-000000000000', 'd31900c0-0000-4000-8000-000000000000', 'd31900c1-0000-4000-8000-000000000000', 'xc', 'Stripe account', 'account');

insert into public.activity_events (workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key)
select 'd31900a0-0000-4000-8000-000000000000', 'd31900a1-0000-4000-8000-000000000000', 'd31900a2-0000-4000-8000-000000000000',
  'fake', 'fake.deployment.succeeded', 'success', 'Deployed', timestamptz '2026-11-10T00:00:00Z' - n * interval '1 hour', 'picker-' || n
from generate_series(0, 999) as n;

insert into public.activity_events (workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key)
values
  -- Older than every one of the 1,000 above.
  ('d31900a0-0000-4000-8000-000000000000', 'd31900a1-0000-4000-8000-000000000000', 'd31900a2-0000-4000-8000-000000000000',
   'fake', 'fake.incident.opened', 'critical', 'Incident', '2026-01-05T00:00:00Z', 'picker-rare'),
  ('d31900c0-0000-4000-8000-000000000000', 'd31900c1-0000-4000-8000-000000000000', null,
   'stripe', 'stripe.payment_succeeded', 'success', 'Payment', '2026-11-04T09:00:00Z', 'picker-other');

-- XA: 5 daily spend series and 5 allowance series, 205 days each, newest 2026-11-10.
insert into public.usage_snapshots (
  workspace_id, connection_id, external_account_id, metric_key, kind, label, snapshot_date, value, unit, amount_minor,
  currency, period_start, period_end, retrieved_at, provenance_source
)
select 'd31900a0-0000-4000-8000-000000000000', 'd31900a1-0000-4000-8000-000000000000', 'd31900a2-0000-4000-8000-000000000000',
  s.metric_key, s.kind, s.label, d::date, s.value, s.unit, s.amount_minor, s.currency,
  d, d + interval '1 day', d + interval '23 hours', 'provider_api'
from generate_series(timestamptz '2026-11-10T00:00:00Z' - interval '204 days', timestamptz '2026-11-10T00:00:00Z', interval '1 day') as d
cross join generate_series(1, 5) as m
cross join lateral (
  values
    ('fake.spend_' || m || '.daily', 'verified_spend'::public.metric_kind, 'Spend ' || m, null::float8, null::text, 100::bigint, 'USD'),
    ('fake.minutes_' || m || '.monthly', 'included_allowance'::public.metric_kind, 'Minutes ' || m, 6000::float8, 'minutes', null::bigint, null)
) as s(metric_key, kind, label, value, unit, amount_minor, currency);

insert into public.usage_snapshots (
  workspace_id, connection_id, external_account_id, metric_key, kind, label, snapshot_date, value, unit, amount_minor,
  currency, period_start, period_end, retrieved_at, provenance_source
)
values
  -- XA, reported only on 2026-01-05: a yen spend series and an allowance.
  ('d31900a0-0000-4000-8000-000000000000', 'd31900a1-0000-4000-8000-000000000000', 'd31900a2-0000-4000-8000-000000000000',
   'fake.old_spend.daily', 'verified_spend', 'Old yen spend', '2026-01-05', null, null, 500, 'JPY',
   '2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z', '2026-01-05T23:00:00Z', 'provider_api'),
  ('d31900a0-0000-4000-8000-000000000000', 'd31900a1-0000-4000-8000-000000000000', 'd31900a2-0000-4000-8000-000000000000',
   'fake.old_builds.monthly', 'included_allowance', 'Old build minutes', '2026-01-05', 3000, 'minutes', null, null,
   '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-01-05T23:00:00Z', 'provider_api'),
  -- XA and XB both report seats; XA renamed it, and XB's row is the newest.
  ('d31900a0-0000-4000-8000-000000000000', 'd31900a1-0000-4000-8000-000000000000', 'd31900a2-0000-4000-8000-000000000000',
   'fake.seats.monthly', 'included_allowance', 'Seats', '2026-10-01', 5, 'seats', null, null,
   '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-10-01T23:00:00Z', 'provider_api'),
  ('d31900a0-0000-4000-8000-000000000000', 'd31900b1-0000-4000-8000-000000000000', 'd31900b2-0000-4000-8000-000000000000',
   'fake.seats.monthly', 'included_allowance', 'Team seats', '2026-11-01', 5, 'seats', null, null,
   '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', '2026-11-01T23:00:00Z', 'provider_api'),
  -- XB: month to date spend on 10-30, 10-31, and 11-01, and a SKU of it that stopped on 10-31.
  ('d31900a0-0000-4000-8000-000000000000', 'd31900b1-0000-4000-8000-000000000000', 'd31900b2-0000-4000-8000-000000000000',
   'github.spend.actions', 'verified_spend', 'Actions', '2026-10-30', null, null, 3000, 'USD',
   '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-10-30T23:00:00Z', 'provider_api'),
  ('d31900a0-0000-4000-8000-000000000000', 'd31900b1-0000-4000-8000-000000000000', 'd31900b2-0000-4000-8000-000000000000',
   'github.spend.actions', 'verified_spend', 'Actions', '2026-10-31', null, null, 3100, 'USD',
   '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-10-31T23:00:00Z', 'provider_api'),
  ('d31900a0-0000-4000-8000-000000000000', 'd31900b1-0000-4000-8000-000000000000', 'd31900b2-0000-4000-8000-000000000000',
   'github.spend.actions', 'verified_spend', 'Actions', '2026-11-01', null, null, 100, 'USD',
   '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', '2026-11-01T23:00:00Z', 'provider_api'),
  ('d31900a0-0000-4000-8000-000000000000', 'd31900b1-0000-4000-8000-000000000000', 'd31900b2-0000-4000-8000-000000000000',
   'github.spend.actions.actions_linux', 'verified_spend', 'Linux runners', '2026-10-31', null, null, 3100, 'USD',
   '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-10-31T23:00:00Z', 'provider_api'),
  -- W2: a franc revenue series, which nothing for W may include.
  ('d31900c0-0000-4000-8000-000000000000', 'd31900c1-0000-4000-8000-000000000000', 'd31900c2-0000-4000-8000-000000000000',
   'stripe.revenue.month', 'revenue', 'Revenue', '2026-11-01', null, null, 9000, 'CHF',
   '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', '2026-11-01T23:00:00Z', 'provider_api');

-- ---------------------------------------------------------------------------
-- Shape: the pickers are security definer with an empty search_path, run by authenticated only;
-- the series helper is internal.
-- ---------------------------------------------------------------------------
select is_empty(
  $$
    select f.signature || ': ' || v.problem
    from (
      values
        ('public.timeline_type_ids(uuid)'),
        ('public.snapshot_metric_options(uuid, public.metric_kind[])'),
        ('public.snapshot_currencies(uuid)'),
        ('public.snapshot_series_day_rows(uuid, public.metric_kind[])')
    ) as f(signature)
    cross join lateral (
      values
        (case when not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = f.signature::regprocedure)
          then 'security invoker' end),
        (case when not (select coalesce(p.proconfig && array['search_path=""', 'search_path='], false)
                        from pg_catalog.pg_proc p where p.oid = f.signature::regprocedure)
          then 'search_path not empty' end),
        (case when has_function_privilege('anon', f.signature, 'execute') then 'anon can execute' end),
        (case when has_function_privilege('service_role', f.signature, 'execute') then 'service_role can execute' end),
        (case when not has_function_privilege('authenticated', f.signature, 'execute') then 'authenticated cannot execute' end)
    ) as v(problem)
    where v.problem is not null
    union all
    select 'usage_snapshot_series_heads: ' || r.role || ' can execute'
    from (values ('anon'), ('authenticated'), ('service_role')) as r(role)
    where has_function_privilege(r.role, 'public.usage_snapshot_series_heads(uuid)', 'execute')
  $$,
  'picker functions: definer with an empty search_path for authenticated only; the series helper is internal');

-- ---------------------------------------------------------------------------
-- As a viewer of W.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "d3190002-0000-4000-8000-000000000000", "role": "authenticated"}';

select results_eq(
  $$ select type_id from public.timeline_type_ids('d31900a0-0000-4000-8000-000000000000') order by type_id $$,
  $$ values ('fake.deployment.succeeded'::text), ('fake.incident.opened'::text) $$,
  'timeline_type_ids: a type whose only event is older than the newest 1,000 is listed, once per type');

select is_empty(
  $$ select * from public.timeline_type_ids('d31900e0-0000-4000-8000-000000000000') $$,
  'timeline_type_ids: a workspace with no events lists no type');

select results_eq(
  $$
    select metric_key, label, cardinality(connection_ids)
    from public.snapshot_metric_options('d31900a0-0000-4000-8000-000000000000', array['included_allowance', 'remaining_allowance']::public.metric_kind[])
    order by metric_key
  $$,
  $$
    values
      ('fake.minutes_1.monthly'::text, 'Minutes 1'::text, 1), ('fake.minutes_2.monthly', 'Minutes 2', 1),
      ('fake.minutes_3.monthly', 'Minutes 3', 1), ('fake.minutes_4.monthly', 'Minutes 4', 1),
      ('fake.minutes_5.monthly', 'Minutes 5', 1), ('fake.old_builds.monthly', 'Old build minutes', 1),
      ('fake.seats.monthly', 'Team seats', 2)
  $$,
  'snapshot_metric_options: every allowance key, the one reported only months ago included, one row per key with the newest label');

select is(
  (select connection_ids from public.snapshot_metric_options('d31900a0-0000-4000-8000-000000000000', array['included_allowance']::public.metric_kind[])
   where metric_key = 'fake.seats.monthly'),
  array['d31900a1-0000-4000-8000-000000000000', 'd31900b1-0000-4000-8000-000000000000']::uuid[],
  'snapshot_metric_options: a key reported by two connections names both');

select is_empty(
  $$ select * from public.snapshot_metric_options('d31900a0-0000-4000-8000-000000000000', array[]::public.metric_kind[]) $$,
  'snapshot_metric_options: no kinds list no metric');

select results_eq(
  $$ select currency from public.snapshot_currencies('d31900a0-0000-4000-8000-000000000000') order by currency $$,
  $$ values ('JPY'::text), ('USD'::text) $$,
  'snapshot_currencies: a currency reported only months ago is listed, another workspace''s is not');

select is_empty(
  $$ select * from public.snapshot_currencies('d31900e0-0000-4000-8000-000000000000') $$,
  'snapshot_currencies: a workspace with no snapshots lists no currency');

select results_eq(
  $$
    select provider, metric_key, snapshot_date, currency
    from public.snapshot_series_day_rows('d31900a0-0000-4000-8000-000000000000', array['verified_spend', 'estimated_spend', 'usage']::public.metric_kind[])
    where external_account_id = 'd31900a2-0000-4000-8000-000000000000'
    order by metric_key
  $$,
  $$
    values
      ('fake'::public.provider_id, 'fake.old_spend.daily'::text, '2026-01-05'::date, 'JPY'::text),
      ('fake', 'fake.spend_1.daily', '2026-11-10', 'USD'), ('fake', 'fake.spend_2.daily', '2026-11-10', 'USD'),
      ('fake', 'fake.spend_3.daily', '2026-11-10', 'USD'), ('fake', 'fake.spend_4.daily', '2026-11-10', 'USD'),
      ('fake', 'fake.spend_5.daily', '2026-11-10', 'USD')
  $$,
  'snapshot_series_day_rows: one row per series when each reports on one newest day, out of 1,026 spend rows, the old series included');

select results_eq(
  $$
    select metric_key, snapshot_date
    from public.snapshot_series_day_rows('d31900a0-0000-4000-8000-000000000000', array['verified_spend', 'estimated_spend', 'usage']::public.metric_kind[])
    where external_account_id = 'd31900b2-0000-4000-8000-000000000000'
    order by snapshot_date, metric_key
  $$,
  $$
    values
      ('github.spend.actions'::text, '2026-10-31'::date), ('github.spend.actions.actions_linux', '2026-10-31'),
      ('github.spend.actions', '2026-11-01')
  $$,
  'snapshot_series_day_rows: a stopped breakdown comes with its total of the same day, and no other day is read');

select is_empty(
  $$
    select * from public.snapshot_series_day_rows('d31900a0-0000-4000-8000-000000000000', array['verified_spend', 'estimated_spend', 'usage']::public.metric_kind[])
    where kind not in ('verified_spend', 'estimated_spend', 'usage')
  $$,
  'snapshot_series_day_rows: rows of other kinds (the allowances on the same days) are left out');

-- ---------------------------------------------------------------------------
-- As someone outside W: the membership check returns nothing from any picker.
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub": "d3190003-0000-4000-8000-000000000000", "role": "authenticated"}';

select is_empty(
  $$ select * from public.timeline_type_ids('d31900a0-0000-4000-8000-000000000000') $$,
  'timeline_type_ids: a non member reads nothing');
select is_empty(
  $$ select * from public.snapshot_metric_options('d31900a0-0000-4000-8000-000000000000', array['included_allowance']::public.metric_kind[]) $$,
  'snapshot_metric_options: a non member reads nothing');
select is_empty(
  $$ select * from public.snapshot_currencies('d31900a0-0000-4000-8000-000000000000') $$,
  'snapshot_currencies: a non member reads nothing');
select is_empty(
  $$ select * from public.snapshot_series_day_rows('d31900a0-0000-4000-8000-000000000000', array['verified_spend']::public.metric_kind[]) $$,
  'snapshot_series_day_rows: a non member reads nothing');
select results_eq(
  $$ select currency from public.snapshot_currencies('d31900c0-0000-4000-8000-000000000000') $$,
  $$ values ('CHF'::text) $$,
  'snapshot_currencies: the outsider reads its own workspace');

-- Signed out: no user, no membership.
reset request.jwt.claims;
select is_empty(
  $$ select * from public.snapshot_currencies('d31900a0-0000-4000-8000-000000000000') $$,
  'snapshot_currencies: a caller with no user reads nothing');

reset role;

select * from finish();
rollback;
