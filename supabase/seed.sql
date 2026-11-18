-- Local development seed. Synthetic data only: example.com addresses, the fake provider, no
-- credentials. Fixed UUIDs so tests can reference rows:
--   users          owner@example.com   10000000-0000-4000-8000-000000000001
--                  viewer@example.com  10000000-0000-4000-8000-000000000002
--   workspace      Acme (slug acmeseedws)  20000000-0000-4000-8000-000000000001
--   project        Acme web            30000000-0000-4000-8000-000000000001
--   connection     fake                40000000-0000-4000-8000-000000000001
--   external acct  fake-team-1         50000000-0000-4000-8000-000000000001
--   snapshots      60000000-0000-4000-8000-0000000000NN
--   events         70000000-0000-4000-8000-0000000000NN
-- Each user's personal workspace is created by the on_auth_user_created trigger, so its id and
-- slug are random; find it by workspaces.created_by and is_personal.

-- Invites first, mirroring production where the before-user-created hook checks the allow list.
insert into public.access_invites (email, invited_by) values
  ('owner@example.com', 'seed'),
  ('viewer@example.com', 'seed');

-- Users as in the Supabase CLI seeding guide. No password: sign-in is GitHub only, and test
-- fixtures mint sessions through the admin API. Token columns are empty strings, not null,
-- because Supabase Auth reads them as strings.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
) values
  (
    '00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'owner@example.com', '', now(),
    '{"provider": "email", "providers": ["email"]}',
    '{"user_name": "acme-owner", "name": "Acme Owner"}',
    now(), now(), '', '', '', '', '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'viewer@example.com', '', now(),
    '{"provider": "email", "providers": ["email"]}',
    '{"user_name": "acme-viewer", "name": "Acme Viewer"}',
    now(), now(), '', '', '', '', '', '', '', ''
  );

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select
  u.id, u.id, u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email', now(), now(), now()
from auth.users u
where u.id in ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002');

-- Shared workspace: one owner, one viewer. Inserted directly (not via create_workspace) to keep a
-- fixed id and slug.
insert into public.workspaces (id, slug, name, is_personal, created_by) values
  ('20000000-0000-4000-8000-000000000001', 'acmeseedws', 'Acme', false, '10000000-0000-4000-8000-000000000001');

insert into public.workspace_members (workspace_id, user_id, role) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner'),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'viewer');

insert into public.projects (id, workspace_id, name, created_by, updated_by) values
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Acme web',
   '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');

-- Inserted as live, so it carries its grant time as completeConnection would stamp it: the seed runs
-- after every migration, so no backfill fills it, and without one every uninstall revokes it (#502).
insert into public.connections (
  id, workspace_id, provider, status, display_name, authorized_account_label,
  granted_scopes, poll_interval_seconds, next_sync_at, last_synced_at, granted_at, created_by, updated_by
) values (
  '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'fake', 'active',
  'Fake provider', 'acme-team', '{read}', 3600, now() + interval '50 minutes', now() - interval '10 minutes', now(),
  '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'
);

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind, project_id) values
  ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001', 'fake-team-1', 'Acme team', 'team',
   '30000000-0000-4000-8000-000000000001');

-- Three UTC days (today, yesterday, the day before) of three metrics: verified spend in USD, and an
-- included allowance with the usage counted against it. Periods are the UTC calendar month of each
-- snapshot day. Ids: 01..03 spend, 04..06 allowance, 07..09 usage (01, 04, 07 are today).
with days as (
  select
    d.offset_days,
    ((now() at time zone 'utc')::date - d.offset_days) as snapshot_date,
    (date_trunc('month', ((now() at time zone 'utc')::date - d.offset_days)::timestamp) at time zone 'utc') as period_start
  from generate_series(0, 2) as d(offset_days)
),
metrics as (
  select * from (values
    (0, 'fake.spend', 'verified_spend'::public.metric_kind, 'Spend this month'),
    (1, 'fake.emails_included', 'included_allowance'::public.metric_kind, 'Emails included'),
    (2, 'fake.emails_sent', 'usage'::public.metric_kind, 'Emails sent')
  ) as m(metric_index, metric_key, kind, label)
)
insert into public.usage_snapshots (
  id, workspace_id, connection_id, external_account_id, metric_key, kind, label, snapshot_date,
  value, unit, amount_minor, currency, period_start, period_end, retrieved_at,
  provenance_source, provenance_endpoint
)
select
  ('60000000-0000-4000-8000-' || lpad((m.metric_index * 3 + d.offset_days + 1)::text, 12, '0'))::uuid,
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  m.metric_key, m.kind, m.label, d.snapshot_date,
  case m.kind when 'included_allowance' then 3000 when 'usage' then 1200 - d.offset_days * 50 end,
  case when m.kind = 'verified_spend' then null else 'emails' end,
  case when m.kind = 'verified_spend' then 1250 - d.offset_days * 175 end,
  case when m.kind = 'verified_spend' then 'USD' end,
  d.period_start,
  d.period_start + interval '1 month',
  case when d.offset_days = 0 then now() - interval '10 minutes'
       else (d.snapshot_date::timestamp + interval '23 hours') at time zone 'utc' end,
  'provider_api',
  case when m.kind = 'verified_spend' then '/fake/billing' else '/fake/usage' end
from days d
cross join metrics m;

insert into public.activity_events (
  id, workspace_id, connection_id, external_account_id, provider, type_id, severity, title, body, url,
  occurred_at, dedupe_key
) values
  ('70000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'fake',
   'fake.deployment_succeeded', 'success', 'Deployment succeeded', 'Acme web deployed to production.',
   'https://example.com/deployments/1', now() - interval '2 hours', 'fake:deployment:1'),
  ('70000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'fake',
   'fake.usage_warning', 'warning', 'Email usage at 40 percent', '1,200 of 3,000 included emails sent.',
   null, now() - interval '5 hours', 'fake:usage_warning:1'),
  ('70000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'fake',
   'fake.deployment_failed', 'critical', 'Deployment failed', 'The build step exited with an error.',
   'https://example.com/deployments/0', now() - interval '1 day 3 hours', 'fake:deployment:0'),
  ('70000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001',
   null, null, null,
   'stackdash.daily_summary', 'info', 'Daily summary', 'Spend so far this month: 10.75 USD.',
   null, now() - interval '1 day', 'stackdash:daily_summary:seed');
