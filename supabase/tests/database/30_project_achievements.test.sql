-- Project achievements (#413): idempotent recording that never moves earned_at, one timeline event
-- per earned achievement, the owner or admin check on publishing, the public read returning
-- published achievements only and no private fields, tenant isolation through the Data API, and
-- the cascades on project, account, and workspace deletion.
-- Rows are seeded as postgres (the migration owner, which bypasses RLS); members are impersonated
-- through the same role and JWT claims PostgREST uses.
begin;

create extension if not exists pgtap with schema extensions;

select plan(47);

-- Users: an owner, an admin, and a viewer of workspace A, and the owner of workspace B.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('a9000001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ach-owner-a@example.com', '{"user_name": "ach-owner-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a9000001-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ach-admin-a@example.com', '{"user_name": "ach-admin-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('a9000001-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ach-viewer-a@example.com', '{"user_name": "ach-viewer-a"}', '{"provider": "github", "providers": ["github"]}', now(), now()),
  ('b9000001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ach-owner-b@example.com', '{"user_name": "ach-owner-b"}', '{"provider": "github", "providers": ["github"]}', now(), now());

insert into public.workspaces (id, name, created_by)
values
  ('a9000002-0000-4000-8000-000000000001', 'Achievements A', 'a9000001-0000-4000-8000-000000000001'),
  ('b9000002-0000-4000-8000-000000000001', 'Achievements B', 'b9000001-0000-4000-8000-000000000001');

insert into public.workspace_members (workspace_id, user_id, role)
values
  ('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000001', 'owner'),
  ('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000002', 'admin'),
  ('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000003', 'viewer'),
  ('b9000002-0000-4000-8000-000000000001', 'b9000001-0000-4000-8000-000000000001', 'owner');

insert into public.projects (id, workspace_id, name)
values
  ('a9000003-0000-4000-8000-000000000001', 'a9000002-0000-4000-8000-000000000001', 'Project A'),
  ('a9000003-0000-4000-8000-000000000002', 'a9000002-0000-4000-8000-000000000001', 'Project A2'),
  ('b9000003-0000-4000-8000-000000000001', 'b9000002-0000-4000-8000-000000000001', 'Project B');

-- ---------------------------------------------------------------------------
-- Schema and grants
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
   where c.oid in ('public.project_achievements'::regclass, 'public.project_achievement_publications'::regclass)),
  'achievement tables: row level security is on');
select ok(
  not has_table_privilege('anon', 'public.project_achievements', 'select')
  and not has_table_privilege('anon', 'public.project_achievement_publications', 'select'),
  'achievement tables: anon cannot select');
select ok(
  not has_table_privilege('authenticated', 'public.project_achievements', 'insert')
  and not has_table_privilege('authenticated', 'public.project_achievements', 'update')
  and not has_table_privilege('authenticated', 'public.project_achievements', 'delete')
  and not has_table_privilege('authenticated', 'public.project_achievement_publications', 'insert')
  and not has_table_privilege('authenticated', 'public.project_achievement_publications', 'delete'),
  'achievement tables: authenticated cannot write');

select is_empty(
  $$
    select p.oid::regprocedure::text || ': ' || v.problem
    from pg_catalog.pg_proc p
    cross join lateral (
      values
        (case when not p.prosecdef then 'not security definer' end),
        (case when not coalesce(p.proconfig && array['search_path=""', 'search_path='], false) then 'search_path not empty' end),
        (case when has_function_privilege('anon', p.oid, 'execute') then 'executable by anon' end),
        (case when has_function_privilege('authenticated', p.oid, 'execute') then 'executable by authenticated' end)
    ) as v(problem)
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any (array[
        'record_project_achievements', 'publish_achievement', 'unpublish_achievement',
        'public_published_achievements', 'delete_achievement_event'
      ])
      and v.problem is not null
  $$,
  'achievement functions: security definer, empty search_path, closed to anon and authenticated');

select ok(
  has_function_privilege('service_role', 'public.record_project_achievements(uuid, uuid, jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.publish_achievement(uuid, uuid, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.unpublish_achievement(uuid, uuid, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.public_published_achievements(uuid)', 'execute'),
  'achievement functions: the service role can call every one the server uses');

select ok(
  not has_function_privilege('anon', 'public.achievement_event_dedupe_key(uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.achievement_event_dedupe_key(uuid, text)', 'execute'),
  'achievement_event_dedupe_key: closed to anon and authenticated');

-- ---------------------------------------------------------------------------
-- Recording
-- ---------------------------------------------------------------------------
select results_eq(
  $$
    select * from public.record_project_achievements(
      'a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
      '[
        {"achievement_id": "vercel.deployments.10", "provider": "vercel", "title": "10 Vercel deployments recorded",
         "public_title": "10 Vercel deployments recorded", "description": "Earned at the 10th recorded deployment.",
         "earned_at": "2026-03-01T10:00:00Z", "earned_precision": "instant", "evidence": "crossed", "threshold": null, "simulated": false},
        {"achievement_id": "github.stars.1000", "provider": "github", "title": "1,000 GitHub stars",
         "public_title": "1,000 GitHub stars", "description": "Earned at the first reading of 1,000 stars.",
         "earned_at": "2026-02-01T09:00:00Z", "earned_precision": "instant", "evidence": "at_least", "threshold": 1000, "simulated": false},
        {"achievement_id": "posthog.signups.10", "provider": "posthog", "title": "10 PostHog signups recorded",
         "public_title": "10 PostHog signups recorded", "description": "Earned when daily signups add up to 10.",
         "earned_at": "2026-02-03T00:00:00Z", "earned_precision": "day", "evidence": "crossed", "threshold": null, "simulated": false}
      ]'::jsonb)
    order by 1
  $$,
  $$ values ('github.stars.1000'::text), ('posthog.signups.10'::text), ('vercel.deployments.10'::text) $$,
  'record_project_achievements: returns every newly earned id');

select is(
  (select count(*)::int from public.activity_events
   where workspace_id = 'a9000002-0000-4000-8000-000000000001' and type_id = 'stackdash.achievement_earned'
     and provider is null and connection_id is null and external_account_id is null and severity = 'success'),
  3,
  'record_project_achievements: one StackDash success event per earned achievement');

select results_eq(
  $$
    select title, occurred_at, dedupe_key from public.activity_events
    where workspace_id = 'a9000002-0000-4000-8000-000000000001' and type_id = 'stackdash.achievement_earned'
      and dedupe_key like '%vercel.deployments.10'
  $$,
  $$ values ('10 Vercel deployments recorded'::text, '2026-03-01T10:00:00Z'::timestamptz,
             'achievement:a9000003-0000-4000-8000-000000000001:vercel.deployments.10'::text) $$,
  'record_project_achievements: the event has the private title, earned_at, and the achievement dedupe key');

-- A later evaluation claims a different date and title: neither moves.
select is_empty(
  $$
    select * from public.record_project_achievements(
      'a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
      '[{"achievement_id": "vercel.deployments.10", "provider": "vercel", "title": "Renamed",
         "public_title": "Renamed", "description": "Renamed.", "earned_at": "2026-04-01T10:00:00Z",
         "earned_precision": "instant", "evidence": "crossed", "threshold": null, "simulated": false}]'::jsonb)
  $$,
  'record_project_achievements: an earned achievement is not earned again');

select results_eq(
  $$
    select earned_at, title from public.project_achievements
    where project_id = 'a9000003-0000-4000-8000-000000000001' and achievement_id = 'vercel.deployments.10'
  $$,
  $$ values ('2026-03-01T10:00:00Z'::timestamptz, '10 Vercel deployments recorded'::text) $$,
  'record_project_achievements: a repeat never moves earned_at or changes the title');

select is(
  (select count(*)::int from public.activity_events
   where workspace_id = 'a9000002-0000-4000-8000-000000000001' and type_id = 'stackdash.achievement_earned'),
  3,
  'record_project_achievements: a repeat writes no second event');

select is_empty(
  $$
    select * from public.record_project_achievements(
      'b9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
      '[{"achievement_id": "vercel.deployments.first", "provider": "vercel", "title": "t", "public_title": "t",
         "description": "d", "earned_at": "2026-03-01T10:00:00Z", "earned_precision": "instant",
         "evidence": "crossed", "threshold": null, "simulated": false}]'::jsonb)
  $$,
  'record_project_achievements: a project outside the workspace earns nothing');

select throws_ok(
  $$
    select * from public.record_project_achievements(
      'a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
      '[{"achievement_id": "github.stars.10", "provider": "github", "title": "10 GitHub stars", "public_title": "10 GitHub stars",
         "description": "d", "earned_at": "2026-03-01T10:00:00Z", "earned_precision": "instant",
         "evidence": "at_least", "threshold": null, "simulated": false}]'::jsonb)
  $$,
  '23514', null,
  'project_achievements: at_least evidence needs its threshold');

select throws_ok(
  $$
    select * from public.record_project_achievements(
      'a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
      '[{"achievement_id": "posthog.signups.100", "provider": "posthog", "title": "t", "public_title": "t",
         "description": "d", "earned_at": "2026-03-01T10:00:00Z", "earned_precision": "day",
         "evidence": "crossed", "threshold": null, "simulated": false}]'::jsonb)
  $$,
  '23514', null,
  'project_achievements: a day-precision achievement is stored at the start of its UTC day');

select throws_ok(
  $$
    select * from public.record_project_achievements(
      'a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
      '[{"achievement_id": "NotScoped", "provider": "vercel", "title": "t", "public_title": "t",
         "description": "d", "earned_at": "2026-03-01T10:00:00Z", "earned_precision": "instant",
         "evidence": "crossed", "threshold": null, "simulated": false}]'::jsonb)
  $$,
  '23514', null,
  'project_achievements: an id that is not adapter-scoped is refused');

select throws_ok(
  $$
    select * from public.record_project_achievements(
      'a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
      '[{"achievement_id": "vercel.deployments.100", "provider": "vercel", "title": "t", "public_title": "t",
         "description": "d", "earned_at": "2026-03-01T10:00:00Z", "earned_precision": "instant",
         "evidence": "crossed", "threshold": null}]'::jsonb)
  $$,
  '23502', null,
  'record_project_achievements: a payload that does not say whether it is simulated is refused, never stored as real');

-- ---------------------------------------------------------------------------
-- Publishing
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select * from public.public_published_achievements('a9000003-0000-4000-8000-000000000001') $$,
  'public_published_achievements: nothing is public before it is published');

select throws_ok(
  $$ select public.publish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
       'a9000001-0000-4000-8000-000000000003', 'vercel.deployments.10') $$,
  '42501', null,
  'publish_achievement: a viewer cannot publish');

select throws_ok(
  $$ select public.publish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
       'b9000001-0000-4000-8000-000000000001', 'vercel.deployments.10') $$,
  '42501', null,
  'publish_achievement: an owner of another workspace cannot publish');

select is(
  public.publish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000001', 'vercel.deployments.10'),
  'published',
  'publish_achievement: an owner publishes');

select is(
  public.publish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000002', 'vercel.deployments.10'),
  'unchanged',
  'publish_achievement: publishing again changes nothing');

select is(
  public.publish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000002', 'github.stars.1000'),
  'published',
  'publish_achievement: an admin publishes');

select is(
  public.publish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000002',
    'a9000001-0000-4000-8000-000000000001', 'vercel.deployments.10'),
  'not_found',
  'publish_achievement: an achievement the project has not earned is not found');

select results_eq(
  $$
    select achievement_id, provider::text, public_title, evidence::text, threshold
    from public.public_published_achievements('a9000003-0000-4000-8000-000000000001')
  $$,
  $$ values ('github.stars.1000'::text, 'github'::text, '1,000 GitHub stars'::text, 'at_least'::text, 1000::bigint),
            ('vercel.deployments.10'::text, 'vercel'::text, '10 Vercel deployments recorded'::text, 'crossed'::text, null::bigint) $$,
  'public_published_achievements: published achievements only, oldest first');

select is_empty(
  $$
    select a.attname from pg_catalog.pg_proc p
    cross join lateral unnest(p.proargnames) as a(attname)
    where p.oid = 'public.public_published_achievements(uuid)'::regprocedure
      and a.attname in ('title', 'description', 'workspace_id', 'published_by')
  $$,
  'public_published_achievements: returns no private title, description, workspace, or publisher');

-- Members read through the Data API; other workspaces see nothing.
set local role authenticated;
set local request.jwt.claims to '{"sub": "a9000001-0000-4000-8000-000000000003", "role": "authenticated"}';

select is(
  (select count(*)::int from public.project_achievements),
  3,
  'project_achievements: a viewer reads their workspace''s achievements');
select is(
  (select count(*)::int from public.project_achievement_publications),
  2,
  'project_achievement_publications: a viewer reads which are published');

set local request.jwt.claims to '{"sub": "b9000001-0000-4000-8000-000000000001", "role": "authenticated"}';

select is(
  (select count(*)::int from public.project_achievements),
  0,
  'project_achievements: another workspace reads none');
select is(
  (select count(*)::int from public.project_achievement_publications),
  0,
  'project_achievement_publications: another workspace reads none');

reset request.jwt.claims;
reset role;

select throws_ok(
  $$ select public.unpublish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
       'a9000001-0000-4000-8000-000000000003', 'vercel.deployments.10') $$,
  '42501', null,
  'unpublish_achievement: a viewer cannot unpublish');

select is(
  public.unpublish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000001', 'vercel.deployments.10'),
  'unpublished',
  'unpublish_achievement: an owner unpublishes');

select is(
  public.unpublish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
    'a9000001-0000-4000-8000-000000000001', 'vercel.deployments.10'),
  'unchanged',
  'unpublish_achievement: unpublishing again changes nothing');

select results_eq(
  $$ select achievement_id from public.public_published_achievements('a9000003-0000-4000-8000-000000000001') $$,
  $$ values ('github.stars.1000'::text) $$,
  'unpublish_achievement: removes it from the public read');

select ok(
  exists (select 1 from public.project_achievements
          where project_id = 'a9000003-0000-4000-8000-000000000001' and achievement_id = 'vercel.deployments.10')
  and exists (select 1 from public.activity_events
              where dedupe_key = 'achievement:a9000003-0000-4000-8000-000000000001:vercel.deployments.10'),
  'unpublish_achievement: the achievement and its private timeline event stay');

select results_eq(
  $$
    select type_id, title, body from public.activity_events
    where workspace_id = 'a9000002-0000-4000-8000-000000000001'
      and type_id in ('stackdash.achievement_published', 'stackdash.achievement_unpublished')
    order by type_id, title
  $$,
  $$ values ('stackdash.achievement_published'::text, 'Published 1,000 GitHub stars'::text, 'Project Project A.'::text),
            ('stackdash.achievement_published'::text, 'Published 10 Vercel deployments recorded'::text, 'Project Project A.'::text),
            ('stackdash.achievement_unpublished'::text, 'Unpublished 10 Vercel deployments recorded'::text, 'Project Project A.'::text) $$,
  'publish_achievement, unpublish_achievement: each change writes one audit event naming the project, an unchanged call none');

select throws_ok(
  $$ insert into public.project_achievement_publications (project_achievement_id, workspace_id, published_by)
     select a.id, 'b9000002-0000-4000-8000-000000000001', 'b9000001-0000-4000-8000-000000000001'
     from public.project_achievements a where a.achievement_id = 'vercel.deployments.10' $$,
  '23503', null,
  'project_achievement_publications: a publication cannot claim another workspace than its achievement''s');

-- An achievement earned from a provider simulator's data says so wherever it is public.
select public.record_project_achievements(
  'a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000002',
  '[{"achievement_id": "github.stars.10", "provider": "github", "title": "10 GitHub stars", "public_title": "10 GitHub stars",
     "description": "d", "earned_at": "2026-03-01T10:00:00Z", "earned_precision": "instant", "evidence": "crossed",
     "threshold": null, "simulated": true}]'::jsonb);
select public.publish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000002',
  'a9000001-0000-4000-8000-000000000001', 'github.stars.10');

select results_eq(
  $$ select achievement_id, simulated from public.public_published_achievements('a9000003-0000-4000-8000-000000000002') $$,
  $$ values ('github.stars.10'::text, true) $$,
  'public_published_achievements: says when an achievement was earned from simulated data');

-- "Unpublish everything" leaves no achievement public either.
select results_eq(
  $$ select * from public.unpublish_all_metrics('a9000002-0000-4000-8000-000000000001', 'a9000001-0000-4000-8000-000000000001') $$,
  $$ values (0, 2) $$,
  'unpublish_all_metrics: counts the metrics and the achievements it unpublished, apart');

select is(
  (select count(*)::int from public.project_achievement_publications where workspace_id = 'a9000002-0000-4000-8000-000000000001'),
  0,
  'unpublish_all_metrics: deletes every achievement publication in the workspace');

select is(
  (select body from public.activity_events
   where workspace_id = 'a9000002-0000-4000-8000-000000000001' and type_id = 'stackdash.metrics_unpublished_all'),
  '2 achievements are no longer public.',
  'unpublish_all_metrics: the audit event names what it took down');

-- Published again by the admin, for the account deletion below.
select public.publish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
  'a9000001-0000-4000-8000-000000000002', 'github.stars.1000');

-- ---------------------------------------------------------------------------
-- Deletion
-- ---------------------------------------------------------------------------
-- Deleting the publisher's account unpublishes what they published (#42).
delete from auth.users where id = 'a9000001-0000-4000-8000-000000000002';

select is_empty(
  $$ select * from public.public_published_achievements('a9000003-0000-4000-8000-000000000001') $$,
  'account deletion: what the deleted account published is no longer public');

select is(
  (select count(*)::int from public.project_achievements where project_id = 'a9000003-0000-4000-8000-000000000001'),
  3,
  'account deletion: the project keeps its achievements');

-- Deleting the project deletes its achievements, publications, and achievement timeline events.
select public.publish_achievement('a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000001',
  'a9000001-0000-4000-8000-000000000001', 'vercel.deployments.10');
delete from public.projects where id = 'a9000003-0000-4000-8000-000000000001';

select is(
  (select count(*)::int from public.project_achievements where project_id = 'a9000003-0000-4000-8000-000000000001'),
  0,
  'project deletion: deletes its achievements');
select is(
  (select count(*)::int from public.project_achievement_publications
   where workspace_id = 'a9000002-0000-4000-8000-000000000001'),
  0,
  'project deletion: deletes their publications');
select results_eq(
  $$
    select split_part(dedupe_key, ':', 2) from public.activity_events
    where workspace_id = 'a9000002-0000-4000-8000-000000000001' and type_id = 'stackdash.achievement_earned'
  $$,
  $$ values ('a9000003-0000-4000-8000-000000000002'::text) $$,
  'project deletion: deletes its timeline events and leaves the other project''s');

-- Deleting a workspace leaves nothing behind.
select public.record_project_achievements(
  'a9000002-0000-4000-8000-000000000001', 'a9000003-0000-4000-8000-000000000002',
  '[{"achievement_id": "stripe.payments.first", "provider": "stripe", "title": "First Stripe payment recorded",
     "public_title": "First Stripe payment recorded", "description": "d", "earned_at": "2026-03-01T10:00:00Z",
     "earned_precision": "instant", "evidence": "crossed", "threshold": null, "simulated": false}]'::jsonb);
delete from public.workspaces where id = 'a9000002-0000-4000-8000-000000000001';

select is(
  (select count(*)::int from public.project_achievements where workspace_id = 'a9000002-0000-4000-8000-000000000001'),
  0,
  'workspace deletion: deletes its achievements');

select * from finish();
rollback;
