-- Select policies read the caller's workspaces once per table reference, not per row (#283).
--
-- Every select policy compares workspace_id with current_user_workspace_ids(min_role) instead of
-- calling has_workspace_role per row. These tests pin that every caller still reads exactly what
-- has_workspace_role allowed: members at or above the policy's role, per workspace, nobody else.
-- Two workspaces, A and B, hold one row in every workspace table. Callers:
--   owner of A, admin of A, viewer of A,
--   viewer of A who is also admin of B (rank is per workspace, never the best of the two),
--   owner of B only, a signed in stranger, and a token with no user id.
begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

create schema rls283;
grant usage on schema rls283 to authenticated;

-- Token columns are '' rather than null, as GoTrue writes them, so the admin user list can read
-- these rows should one ever be committed.
insert into auth.users (
  id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change_token_current, email_change,
  phone_change, phone_change_token, reauthentication_token
)
select id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'rls-283-' || handle || '@example.com', jsonb_build_object('user_name', 'rls-283-' || handle),
       '{"provider": "github", "providers": ["github"]}', now(), now(),
       '', '', '', '', '', '', '', ''
from (values
  ('28300001-0000-4000-8000-000000000000', 'owner-a'),
  ('28300002-0000-4000-8000-000000000000', 'admin-a'),
  ('28300003-0000-4000-8000-000000000000', 'viewer-a'),
  ('28300004-0000-4000-8000-000000000000', 'viewer-a-admin-b'),
  ('28300005-0000-4000-8000-000000000000', 'owner-b'),
  ('28300006-0000-4000-8000-000000000000', 'stranger')
) as u (id, handle);

insert into public.workspaces (id, name, created_by)
values
  ('283000a0-0000-4000-8000-000000000000', 'Membership set A', '28300001-0000-4000-8000-000000000000'),
  ('283000b0-0000-4000-8000-000000000000', 'Membership set B', '28300005-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('283000a0-0000-4000-8000-000000000000', '28300001-0000-4000-8000-000000000000', 'owner'),
  ('283000a0-0000-4000-8000-000000000000', '28300002-0000-4000-8000-000000000000', 'admin'),
  ('283000a0-0000-4000-8000-000000000000', '28300003-0000-4000-8000-000000000000', 'viewer'),
  ('283000a0-0000-4000-8000-000000000000', '28300004-0000-4000-8000-000000000000', 'viewer'),
  ('283000b0-0000-4000-8000-000000000000', '28300005-0000-4000-8000-000000000000', 'owner'),
  ('283000b0-0000-4000-8000-000000000000', '28300004-0000-4000-8000-000000000000', 'admin');

-- One row per workspace in every table with a select policy; ids end a* for A and b* for B.
create table rls283.ws (ws text, id uuid, owner_id uuid);
insert into rls283.ws values
  ('a', '283000a0-0000-4000-8000-000000000000', '28300001-0000-4000-8000-000000000000'),
  ('b', '283000b0-0000-4000-8000-000000000000', '28300005-0000-4000-8000-000000000000');

insert into public.projects (id, workspace_id, name)
select ('283000' || ws || '1-0000-4000-8000-000000000000')::uuid, id, 'Project ' || ws from rls283.ws;

insert into public.connections (id, workspace_id, provider, status, display_name, poll_interval_seconds)
select ('283000' || ws || '2-0000-4000-8000-000000000000')::uuid, id, 'fake', 'active', 'Connection ' || ws, 3600
from rls283.ws;

insert into public.external_accounts (id, workspace_id, connection_id, external_id, display_name, kind)
select ('283000' || ws || '3-0000-4000-8000-000000000000')::uuid, id,
       ('283000' || ws || '2-0000-4000-8000-000000000000')::uuid, 'rls-283-' || ws, 'Account ' || ws, 'team'
from rls283.ws;

insert into public.usage_snapshots (
  workspace_id, connection_id, external_account_id, metric_key, kind, label, snapshot_date,
  amount_minor, currency, period_start, period_end, retrieved_at, provenance_source
)
select id, ('283000' || ws || '2-0000-4000-8000-000000000000')::uuid, ('283000' || ws || '3-0000-4000-8000-000000000000')::uuid,
       'fake.spend', 'verified_spend', 'Spend', date '2026-10-01', 500, 'USD',
       timestamptz '2026-10-01 00:00:00+00', timestamptz '2026-11-01 00:00:00+00', now(), 'provider_api'
from rls283.ws;

-- The activity_events insert trigger also writes one activity_event_daily_counts row per workspace.
insert into public.activity_events (
  workspace_id, connection_id, external_account_id, provider, type_id, severity, title, occurred_at, dedupe_key
)
select id, ('283000' || ws || '2-0000-4000-8000-000000000000')::uuid, ('283000' || ws || '3-0000-4000-8000-000000000000')::uuid,
       'fake', 'fake.deployment', 'critical', 'Payment failed', timestamptz '2026-10-02 12:00:00+00', 'rls-283-' || ws
from rls283.ws;

insert into public.budgets (workspace_id, name, scope, amount_minor, currency)
select id, 'Budget ' || ws, 'workspace', 10000, 'USD' from rls283.ws;

insert into public.alert_rules (id, workspace_id, kind, scope, metric_key, threshold_percent)
select ('283000' || ws || '7-0000-4000-8000-000000000000')::uuid, id, 'allowance_percent', 'workspace', 'fake.minutes', 80
from rls283.ws;

insert into public.triggered_alerts (workspace_id, rule_id, cycle_key, threshold_label, is_estimated, message)
select id, ('283000' || ws || '7-0000-4000-8000-000000000000')::uuid, '2026-10-01', '80%', false, 'Alert ' || ws
from rls283.ws;

insert into public.sync_jobs (workspace_id, connection_id, kind, dedupe_key)
select id, ('283000' || ws || '2-0000-4000-8000-000000000000')::uuid, 'sync', 'rls-283-sync-' || ws from rls283.ws;
-- A job with no workspace (retention) is never visible to a signed in user.
insert into public.sync_jobs (workspace_id, connection_id, kind, dedupe_key)
values (null, null, 'retention', 'rls-283-retention');

insert into public.notification_destinations (id, workspace_id, kind, name, url_host)
select ('283000' || ws || 'c-0000-4000-8000-000000000000')::uuid, id, 'slack', 'Channel ' || ws, 'hooks.slack.com'
from rls283.ws;

insert into public.alert_rule_destinations (workspace_id, destination_id, rule_id)
select id, ('283000' || ws || 'c-0000-4000-8000-000000000000')::uuid, ('283000' || ws || '7-0000-4000-8000-000000000000')::uuid
from rls283.ws;

insert into public.anomaly_mutes (workspace_id, provider, metric_key)
select id, 'fake', 'fake.spend' from rls283.ws;

insert into public.published_metrics (workspace_id, project_id, metric_id, published_by)
select id, ('283000' || ws || '1-0000-4000-8000-000000000000')::uuid, 'github-stars', owner_id from rls283.ws;

insert into public.published_metric_views (workspace_id, project_id, metric_id, surface, view_date)
select id, ('283000' || ws || '1-0000-4000-8000-000000000000')::uuid, 'github-stars', 'badge', date '2026-10-01'
from rls283.ws;

insert into public.project_pages (project_id, workspace_id, slug, enabled)
select ('283000' || ws || '1-0000-4000-8000-000000000000')::uuid, id, 'page-' || ws, true from rls283.ws;

insert into public.api_keys (workspace_id, name, token_hash, token_prefix, scopes, created_by)
select id, 'Key ' || ws, encode(sha256(convert_to('rls-283-key-' || ws, 'UTF8')), 'hex'), 'sd_rls283k' || ws,
       '{usage:read}', owner_id
from rls283.ws;

insert into public.project_achievements (
  id, workspace_id, project_id, provider, achievement_id, title, public_title, description,
  earned_at, earned_precision, evidence
)
select ('283000' || ws || 'd-0000-4000-8000-000000000000')::uuid, id, ('283000' || ws || '1-0000-4000-8000-000000000000')::uuid,
       'fake', 'fake.deployments.first', 'First deployment', 'First deployment', 'Earned at the first deployment.',
       timestamptz '2026-10-02 12:00:00+00', 'instant', 'crossed'
from rls283.ws;

insert into public.project_achievement_publications (project_achievement_id, workspace_id, published_by)
select ('283000' || ws || 'd-0000-4000-8000-000000000000')::uuid, id, owner_id from rls283.ws;

-- Every member keeps a notification setting; a caller reads only their own.
insert into public.notification_preferences (workspace_id, user_id, email_frequency)
select workspace_id, user_id, 'daily' from public.workspace_members
where workspace_id in ('283000a0-0000-4000-8000-000000000000', '283000b0-0000-4000-8000-000000000000');

-- Every member has hidden the setup checklist (#674); a caller reads only their own row.
insert into public.onboarding_checklist_dismissals (workspace_id, user_id)
select workspace_id, user_id from public.workspace_members
where workspace_id in ('283000a0-0000-4000-8000-000000000000', '283000b0-0000-4000-8000-000000000000');

-- What the caller reads of A and B, table by table, through row level security.
create function rls283.visible_counts()
returns table (tbl text, row_count integer)
language sql
stable
as $$
  with ab (id) as (values ('283000a0-0000-4000-8000-000000000000'::uuid), ('283000b0-0000-4000-8000-000000000000'::uuid))
  select * from (
    select 'workspaces', (select count(*)::integer from public.workspaces where id in (select id from ab))
    union all select 'workspace_members', (select count(*)::integer from public.workspace_members where workspace_id in (select id from ab))
    union all select 'projects', (select count(*)::integer from public.projects where workspace_id in (select id from ab))
    union all select 'connections', (select count(*)::integer from public.connections where workspace_id in (select id from ab))
    union all select 'external_accounts', (select count(*)::integer from public.external_accounts where workspace_id in (select id from ab))
    union all select 'usage_snapshots', (select count(*)::integer from public.usage_snapshots where workspace_id in (select id from ab))
    union all select 'activity_events', (select count(*)::integer from public.activity_events where workspace_id in (select id from ab))
    union all select 'activity_event_daily_counts', (select count(*)::integer from public.activity_event_daily_counts where workspace_id in (select id from ab))
    union all select 'budgets', (select count(*)::integer from public.budgets where workspace_id in (select id from ab))
    union all select 'alert_rules', (select count(*)::integer from public.alert_rules where workspace_id in (select id from ab))
    union all select 'triggered_alerts', (select count(*)::integer from public.triggered_alerts where workspace_id in (select id from ab))
    union all select 'sync_jobs', (select count(*)::integer from public.sync_jobs where workspace_id in (select id from ab))
    union all select 'sync_jobs without a workspace', (select count(*)::integer from public.sync_jobs where workspace_id is null)
    union all select 'notification_destinations', (select count(*)::integer from public.notification_destinations where workspace_id in (select id from ab))
    union all select 'alert_rule_destinations', (select count(*)::integer from public.alert_rule_destinations where workspace_id in (select id from ab))
    union all select 'anomaly_mutes', (select count(*)::integer from public.anomaly_mutes where workspace_id in (select id from ab))
    union all select 'published_metrics', (select count(*)::integer from public.published_metrics where workspace_id in (select id from ab))
    union all select 'published_metric_views', (select count(*)::integer from public.published_metric_views where workspace_id in (select id from ab))
    union all select 'project_pages', (select count(*)::integer from public.project_pages where workspace_id in (select id from ab))
    union all select 'api_keys', (select count(*)::integer from public.api_keys where workspace_id in (select id from ab))
    union all select 'notification_preferences', (select count(*)::integer from public.notification_preferences where workspace_id in (select id from ab))
    union all select 'onboarding_checklist_dismissals', (select count(*)::integer from public.onboarding_checklist_dismissals where workspace_id in (select id from ab))
    union all select 'project_achievements', (select count(*)::integer from public.project_achievements where workspace_id in (select id from ab))
    union all select 'project_achievement_publications', (select count(*)::integer from public.project_achievement_publications where workspace_id in (select id from ab))
  ) as counts (tbl, row_count)
  order by tbl
$$;
grant execute on function rls283.visible_counts() to authenticated;

-- What has_workspace_role allowed each caller: one row per workspace they belong to at any role,
-- one per workspace they administer for api_keys, every member row of those workspaces for
-- workspace_members, their own rows for notification_preferences and
-- onboarding_checklist_dismissals, and no job without a workspace.
create table rls283.expected (who text, tbl text, row_count integer);
insert into rls283.expected
select u.who, t.tbl,
       case t.tbl
         when 'workspace_members' then u.members_seen
         when 'api_keys' then u.admin_of
         when 'sync_jobs without a workspace' then 0
         else u.member_of
       end
from (values
  ('owner of A', 1, 1, 4),
  ('admin of A', 1, 1, 4),
  ('viewer of A', 1, 0, 4),
  ('viewer of A, admin of B', 2, 1, 6),
  ('owner of B', 1, 1, 2),
  ('stranger', 0, 0, 0),
  ('no user id', 0, 0, 0)
) as u (who, member_of, admin_of, members_seen)
cross join unnest(array[
  'workspaces', 'workspace_members', 'projects', 'connections', 'external_accounts', 'usage_snapshots',
  'activity_events', 'activity_event_daily_counts', 'budgets', 'alert_rules', 'triggered_alerts', 'sync_jobs',
  'sync_jobs without a workspace', 'notification_destinations', 'alert_rule_destinations', 'anomaly_mutes',
  'published_metrics', 'published_metric_views', 'project_pages', 'api_keys', 'notification_preferences',
  'onboarding_checklist_dismissals', 'project_achievements', 'project_achievement_publications'
]) as t (tbl);
grant select on rls283.expected to authenticated;

-- The plan of a read, for the InitPlan check.
create function rls283.plan_of(p_sql text)
returns text
language plpgsql
as $$
declare
  v_line text;
  v_plan text := '';
begin
  for v_line in execute 'explain (verbose, costs off) ' || p_sql loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  return v_plan;
end;
$$;
grant execute on function rls283.plan_of(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The policies themselves.
-- ---------------------------------------------------------------------------
select is_empty(
  $$
    select tablename::text || ' ' || policyname::text
    from pg_catalog.pg_policies
    where schemaname = 'public' and cmd = 'SELECT' and qual like '%has_workspace_role%'
  $$,
  'membership set policies: no select policy calls has_workspace_role per row');

-- Every workspace table's select policy, and the role it requires: viewer, except api_keys (admin).
select results_eq(
  $$
    select tablename::text collate "default", substring(qual from 'current_user_workspace_ids\(''(\w+)''') collate "default"
    from pg_catalog.pg_policies
    where schemaname = 'public' and cmd = 'SELECT' and roles = array['authenticated']::name[]
      and qual like '%current_user_workspace_ids%'
    order by 1
  $$,
  $$
    values
      ('activity_event_daily_counts', 'viewer'), ('activity_events', 'viewer'), ('alert_rule_destinations', 'viewer'),
      ('alert_rules', 'viewer'), ('anomaly_mutes', 'viewer'), ('api_keys', 'admin'), ('budgets', 'viewer'),
      ('connections', 'viewer'), ('external_accounts', 'viewer'), ('notification_destinations', 'viewer'),
      ('notification_preferences', 'viewer'), ('onboarding_checklist_dismissals', 'viewer'),
      ('project_achievement_publications', 'viewer'),
      ('project_achievements', 'viewer'), ('project_pages', 'viewer'), ('projects', 'viewer'),
      ('published_metric_views', 'viewer'), ('published_metrics', 'viewer'), ('sync_jobs', 'viewer'),
      ('triggered_alerts', 'viewer'), ('usage_snapshots', 'viewer'), ('workspace_members', 'viewer'),
      ('workspaces', 'viewer')
  $$,
  'membership set policies: every workspace table reads through current_user_workspace_ids at its role');

select ok(
  has_function_privilege('authenticated', 'public.current_user_workspace_ids(public.workspace_role)', 'execute')
  and not has_function_privilege('anon', 'public.current_user_workspace_ids(public.workspace_role)', 'execute'),
  'membership set grants: authenticated can execute current_user_workspace_ids (policies call it), anon cannot');

-- ---------------------------------------------------------------------------
-- Each caller reads exactly what has_workspace_role allowed.
-- ---------------------------------------------------------------------------
set local role authenticated;

set local request.jwt.claims to '{"sub": "28300001-0000-4000-8000-000000000000", "role": "authenticated"}';
select results_eq('select tbl, row_count from rls283.visible_counts()',
  $$ select tbl, row_count from rls283.expected where who = 'owner of A' order by tbl $$,
  'membership set reads: the owner of A reads every row of A and nothing of B');

-- The InitPlan: membership is read once per table reference, never per row, on every table a member
-- reads by workspace (every select policy for authenticated but profiles, which is keyed by user).
select is_empty(
  $$
    select p.tablename::text
    from pg_catalog.pg_policies p
    cross join lateral (select rls283.plan_of(format('select count(*) from public.%I', p.tablename)) as plan) x
    where p.schemaname = 'public' and p.cmd = 'SELECT' and 'authenticated' = any (p.roles) and p.tablename <> 'profiles'
      and not (x.plan ~ 'InitPlan' and x.plan ~ 'Output: current_user_workspace_ids\(' and x.plan !~ 'SubPlan'
               and x.plan !~ 'has_workspace_role')
  $$,
  'membership set plans: every select policy reads current_user_workspace_ids once, as an InitPlan');

-- The filtered read: non-leakproof user quals (an enum comparison, a regex) beside the policy.
select ok(
  (select x.plan ~ 'InitPlan' and x.plan ~ 'Output: current_user_workspace_ids\(' and x.plan !~ 'SubPlan'
   from (select rls283.plan_of($$ select id from public.activity_events
                                  where workspace_id = '283000a0-0000-4000-8000-000000000000'
                                    and severity = 'critical' and title ~* 'payment' $$) as plan) x),
  'membership set plans: a filtered timeline read evaluates membership once, as an InitPlan');

set local request.jwt.claims to '{"sub": "28300002-0000-4000-8000-000000000000", "role": "authenticated"}';
select results_eq('select tbl, row_count from rls283.visible_counts()',
  $$ select tbl, row_count from rls283.expected where who = 'admin of A' order by tbl $$,
  'membership set reads: an admin of A reads every row of A, api keys included, and nothing of B');

set local request.jwt.claims to '{"sub": "28300003-0000-4000-8000-000000000000", "role": "authenticated"}';
select results_eq('select tbl, row_count from rls283.visible_counts()',
  $$ select tbl, row_count from rls283.expected where who = 'viewer of A' order by tbl $$,
  'membership set reads: a viewer of A reads A but no api key (admin and above)');

set local request.jwt.claims to '{"sub": "28300004-0000-4000-8000-000000000000", "role": "authenticated"}';
select results_eq('select tbl, row_count from rls283.visible_counts()',
  $$ select tbl, row_count from rls283.expected where who = 'viewer of A, admin of B' order by tbl $$,
  'membership set reads: a member of two workspaces reads both, and api keys only where they are admin');
select results_eq(
  $$ select array_agg(id order by id) from public.current_user_workspace_ids('admin') as ids (id)
     where id in ('283000a0-0000-4000-8000-000000000000', '283000b0-0000-4000-8000-000000000000') $$,
  $$ values (array['283000b0-0000-4000-8000-000000000000']::uuid[]) $$,
  'membership set function: rank is per workspace, so a viewer of A and admin of B is admin of B only');

set local request.jwt.claims to '{"sub": "28300005-0000-4000-8000-000000000000", "role": "authenticated"}';
select results_eq('select tbl, row_count from rls283.visible_counts()',
  $$ select tbl, row_count from rls283.expected where who = 'owner of B' order by tbl $$,
  'membership set reads: the owner of B reads B and nothing of A');

set local request.jwt.claims to '{"sub": "28300006-0000-4000-8000-000000000000", "role": "authenticated"}';
select results_eq('select tbl, row_count from rls283.visible_counts()',
  $$ select tbl, row_count from rls283.expected where who = 'stranger' order by tbl $$,
  'membership set reads: a signed in non-member reads nothing of A or B');

set local request.jwt.claims to '{"role": "authenticated"}';
select results_eq('select tbl, row_count from rls283.visible_counts()',
  $$ select tbl, row_count from rls283.expected where who = 'no user id' order by tbl $$,
  'membership set reads: a token with no user id reads nothing');
select is_empty($$ select public.current_user_workspace_ids('viewer') $$,
  'membership set function: a token with no user id belongs to no workspace');

-- ---------------------------------------------------------------------------
-- The role is read at query time: a change applies to the caller's next statement.
-- ---------------------------------------------------------------------------
reset role;
update public.workspace_members set role = 'viewer'
where workspace_id = '283000a0-0000-4000-8000-000000000000' and user_id = '28300002-0000-4000-8000-000000000000';
delete from public.workspace_members
where workspace_id = '283000a0-0000-4000-8000-000000000000' and user_id = '28300003-0000-4000-8000-000000000000';
set local role authenticated;

set local request.jwt.claims to '{"sub": "28300002-0000-4000-8000-000000000000", "role": "authenticated"}';
select results_eq(
  $$ select row_count from rls283.visible_counts() where tbl in ('api_keys', 'activity_events') order by tbl $$,
  $$ values (1), (0) $$,
  'membership set role change: an admin demoted to viewer still reads events but no longer reads api keys');

set local request.jwt.claims to '{"sub": "28300003-0000-4000-8000-000000000000", "role": "authenticated"}';
select is((select sum(row_count)::integer from rls283.visible_counts()), 0,
  'membership set role change: a removed member reads nothing of A on their next statement');

reset role;
reset request.jwt.claims;

select * from finish();

rollback;
