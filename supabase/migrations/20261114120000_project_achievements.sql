-- Permanent project achievements (#413). Grant model: see 20261031090000_tenancy.sql.
--
-- * Each adapter declares its achievements in code (`ProviderAdapter.achievements`). The database
--   stores what a project has earned, never the definitions, so an achievement whose definition is
--   later removed from its adapter stays earned with the title it was earned under.
-- * A project earns an achievement once: (project_id, achievement_id) is unique and the only write
--   path, record_project_achievements(), inserts with on conflict do nothing. A repeated or
--   concurrent evaluation can neither duplicate an achievement nor move its earned_at.
-- * Earning one writes one devmacro.achievement_earned timeline event in the same transaction,
--   dated to earned_at, with the dedupe key achievement:<project id>:<achievement id>. DevMacro's
--   own event, so no provider, connection, or account (20261031090200_metrics_events_alerts.sql).
--   Deleting the achievement (with its project or workspace) deletes that event.
-- * Achievements are private. An owner or admin publishes one by adding a row to
--   project_achievement_publications and unpublishes it by deleting the row. Deleting the
--   publisher's account (#42) deletes their publications, as it does their published metrics.
-- * Public readers never touch either table: public_published_achievements() is the one
--   definition of "currently published", only the service role may call it, and it returns no
--   private title, description, account, or repository.

-- How precisely earned_at is known: an instant (an event, a snapshot), or only a day (a provider's
-- daily total, dated to its day and never shown with a time).
create type public.achievement_date_precision as enum ('instant', 'day');

-- What the stored evidence proves. 'crossed': DevMacro holds the event or reading that reached the
-- threshold. 'at_least': the first stored reading was already at or above it, so the achievement
-- says "Recorded at least <threshold>" rather than claiming the crossing happened then.
create type public.achievement_evidence as enum ('crossed', 'at_least');

create table public.project_achievements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null,
  provider public.provider_id not null,
  -- Adapter-scoped (`vercel.deployments.10`), the same shape as an event type id.
  achievement_id text not null constraint project_achievements_achievement_id_format
    check (char_length(achievement_id) <= 100 and achievement_id ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  -- Copied from the definition when earned (ACHIEVEMENT_TITLE_MAX in src/lib/adapters/achievements.ts).
  title text not null constraint project_achievements_title_length check (char_length(btrim(title)) between 1 and 80),
  public_title text not null
    constraint project_achievements_public_title_length check (char_length(btrim(public_title)) between 1 and 80),
  description text not null
    constraint project_achievements_description_length check (char_length(btrim(description)) between 1 and 200),
  earned_at timestamptz not null,
  earned_precision public.achievement_date_precision not null,
  evidence public.achievement_evidence not null,
  -- The threshold an 'at_least' achievement was recorded at, for "Recorded at least 1,000".
  threshold bigint constraint project_achievements_threshold_positive check (threshold is null or threshold > 0),
  created_at timestamptz not null default now(),
  constraint project_achievements_project_fkey foreign key (workspace_id, project_id)
    references public.projects (workspace_id, id) on delete cascade,
  constraint project_achievements_project_achievement_key unique (project_id, achievement_id),
  constraint project_achievements_at_least_threshold check (evidence <> 'at_least' or threshold is not null),
  -- A day-precision achievement is stored at the start of its UTC day.
  constraint project_achievements_day_start check (
    earned_precision <> 'day' or earned_at = date_trunc('day', earned_at at time zone 'UTC') at time zone 'UTC'
  )
);

-- The Achievements section lists a project's achievements oldest first, grouped by provider.
create index project_achievements_workspace_project_idx on public.project_achievements (workspace_id, project_id, earned_at);

create table public.project_achievement_publications (
  project_achievement_id uuid primary key references public.project_achievements (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  published_at timestamptz not null default now(),
  published_by uuid not null references auth.users (id) on delete cascade
);

create index project_achievement_publications_workspace_idx on public.project_achievement_publications (workspace_id);
create index project_achievement_publications_published_by_idx on public.project_achievement_publications (published_by);

alter table public.project_achievements enable row level security;
alter table public.project_achievement_publications enable row level security;

revoke all on table public.project_achievements from anon, authenticated;
revoke all on table public.project_achievement_publications from anon, authenticated;

-- Members see what their projects have earned and what is published; nobody writes through the
-- Data API.
grant select on table public.project_achievements to authenticated;
grant select on table public.project_achievement_publications to authenticated;

create policy project_achievements_select on public.project_achievements for select to authenticated
  using (workspace_id = any (array(select public.current_user_workspace_ids('viewer'))));

create policy project_achievement_publications_select on public.project_achievement_publications for select to authenticated
  using (workspace_id = any (array(select public.current_user_workspace_ids('viewer'))));

-- ── Timeline event ─────────────────────────────────────────────────────────────

create function public.achievement_event_dedupe_key(p_project_id uuid, p_achievement_id text)
  returns text
  language sql
  immutable
  set search_path = ''
as $$
  select 'achievement:' || p_project_id::text || ':' || p_achievement_id;
$$;

-- The timeline is private, so unpublishing keeps the event; deleting the achievement removes it.
create function public.delete_achievement_event()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  delete from public.activity_events e
  where e.workspace_id = old.workspace_id
    and e.dedupe_key = public.achievement_event_dedupe_key(old.project_id, old.achievement_id);
  return old;
end;
$$;

revoke execute on function public.delete_achievement_event() from public, anon, authenticated;

create trigger project_achievements_delete_event
  after delete on public.project_achievements
  for each row execute function public.delete_achievement_event();

-- ── record_project_achievements ────────────────────────────────────────────────
-- Stores what one evaluation found for one project and writes one timeline event for each
-- achievement it newly earned. p_achievements is a JSON array of objects with the keys
-- achievement_id, provider, title, public_title, description, earned_at, earned_precision,
-- evidence, and threshold (null unless evidence is 'at_least'). Already earned achievements are
-- left exactly as they are. Returns the ids newly earned; none when the project is not in the
-- workspace.

create function public.record_project_achievements(p_workspace_id uuid, p_project_id uuid, p_achievements jsonb)
  returns setof text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
begin
  if jsonb_typeof(p_achievements) is distinct from 'array' then
    raise exception 'p_achievements must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.projects p where p.id = p_project_id and p.workspace_id = p_workspace_id;
  if not found then
    return;
  end if;

  return query
  with incoming as (
    select *
    from jsonb_to_recordset(p_achievements) as a(
      achievement_id text,
      provider public.provider_id,
      title text,
      public_title text,
      description text,
      earned_at timestamptz,
      earned_precision public.achievement_date_precision,
      evidence public.achievement_evidence,
      threshold bigint
    )
  ),
  earned as (
    insert into public.project_achievements (
      workspace_id, project_id, provider, achievement_id, title, public_title, description,
      earned_at, earned_precision, evidence, threshold
    )
    select
      p_workspace_id, p_project_id, i.provider, i.achievement_id, btrim(i.title), btrim(i.public_title),
      btrim(i.description), i.earned_at, i.earned_precision, i.evidence, i.threshold
    from incoming i
    on conflict (project_id, achievement_id) do nothing
    returning achievement_id, title, description, earned_at
  ),
  events as (
    insert into public.activity_events (
      workspace_id, connection_id, external_account_id, provider, type_id, severity, title, body, occurred_at, dedupe_key
    )
    select
      p_workspace_id, null, null, null, 'devmacro.achievement_earned', 'success', e.title, e.description, e.earned_at,
      public.achievement_event_dedupe_key(p_project_id, e.achievement_id)
    from earned e
    on conflict (workspace_id, dedupe_key) do nothing
  )
  select e.achievement_id from earned e;
end;
$$;

revoke execute on function public.record_project_achievements(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_project_achievements(uuid, uuid, jsonb) to service_role;

-- ── publish_achievement / unpublish_achievement ────────────────────────────────
-- Owner or admin only, checked again here because the functions run as the service role
-- (require_published_metrics_admin, 20261105023129_published_metrics.sql). Publish returns
-- 'published', 'unchanged' (already published), or 'not_found' (the project has not earned it).
-- Unpublish returns 'unpublished', 'unchanged' (not published), or 'not_found'.

create function public.publish_achievement(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_achievement_id text
)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.require_published_metrics_admin(p_workspace_id, p_actor_id);

  select a.id into v_id
  from public.project_achievements a
  where a.workspace_id = p_workspace_id and a.project_id = p_project_id and a.achievement_id = p_achievement_id;
  if not found then
    return 'not_found';
  end if;

  insert into public.project_achievement_publications (project_achievement_id, workspace_id, published_by)
  values (v_id, p_workspace_id, p_actor_id)
  on conflict (project_achievement_id) do nothing;
  return case when found then 'published' else 'unchanged' end;
end;
$$;

revoke execute on function public.publish_achievement(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.publish_achievement(uuid, uuid, uuid, text) to service_role;

create function public.unpublish_achievement(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_achievement_id text
)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.require_published_metrics_admin(p_workspace_id, p_actor_id);

  select a.id into v_id
  from public.project_achievements a
  where a.workspace_id = p_workspace_id and a.project_id = p_project_id and a.achievement_id = p_achievement_id;
  if not found then
    return 'not_found';
  end if;

  delete from public.project_achievement_publications p where p.project_achievement_id = v_id;
  return case when found then 'unpublished' else 'unchanged' end;
end;
$$;

revoke execute on function public.unpublish_achievement(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.unpublish_achievement(uuid, uuid, uuid, text) to service_role;

-- ── public_published_achievements ──────────────────────────────────────────────
-- A project's published achievements, oldest first: only what a public surface may show.

create function public.public_published_achievements(p_project_id uuid)
  returns table (
    achievement_id text,
    provider public.provider_id,
    public_title text,
    earned_at timestamptz,
    earned_precision public.achievement_date_precision,
    evidence public.achievement_evidence,
    threshold bigint,
    published_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select a.achievement_id, a.provider, a.public_title, a.earned_at, a.earned_precision, a.evidence, a.threshold, p.published_at
  from public.project_achievements a
  join public.project_achievement_publications p on p.project_achievement_id = a.id
  where a.project_id = p_project_id
  order by a.earned_at, a.achievement_id;
$$;

revoke execute on function public.public_published_achievements(uuid) from public, anon, authenticated;
grant execute on function public.public_published_achievements(uuid) to service_role;
