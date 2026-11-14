-- Public metric engine (#148, epic #147): which metrics a workspace has published, per project.
-- Grant model: see 20261031090000_tenancy.sql.
--
-- * public_metric_id is the only list of publishable metrics. The definitions (label, unit,
--   formula, provenance, source) live in src/lib/public-metrics/definitions.ts, keyed by this enum
--   through the generated types, so the code cannot define a metric the database refuses, and the
--   database refuses any metric the code does not define. Spend, budgets, and alert thresholds
--   have no value here, so no row can ever publish them. Adding a metric is a migration:
--   `alter type public.public_metric_id add value '<id>';`.
-- * A self-reported value (#147: project page only, labelled Self-reported, never a badge that
--   claims Verified, never on a leaderboard) is a row with no metric_id and its own label, value,
--   and unit. Everything that reads engine metrics filters on metric_id, which a self-reported
--   row never has.
-- * Rows are never edited except to revoke them, so the table is also the publication history.
--   Members read through the Data API; every write goes through the functions below, run by the
--   server with the service role after it has checked the caller, and each function checks the
--   actor's role again and writes the timeline audit event in the same transaction.
-- * Public readers never touch the table: public_published_metrics() is the one definition of
--   "currently published", and only the service role may call it.

create type public.public_metric_id as enum (
  'github-stars',
  'github-stars-gained-7d',
  'github-stars-gained-30d',
  'vercel-deployments-7d',
  'vercel-deployments-30d',
  'vercel-deployment-streak',
  'supabase-signups-7d',
  'supabase-signups-30d',
  'resend-emails-month',
  'resend-quota-percent-month',
  'github-actions-minutes-month',
  'stripe-customers-30d',
  'stripe-payments-30d'
);

-- How a published value is coarsened before anyone sees it. Always rounded down, so a public number
-- never claims more than the stored data shows.
create type public.published_metric_rounding as enum ('exact', 'tens', 'hundreds', 'thousands');

create table public.published_metrics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null,
  metric_id public.public_metric_id,
  self_reported_label text,
  self_reported_value bigint,
  self_reported_unit text,
  rounding public.published_metric_rounding not null default 'exact',
  -- Show values as they were this many days ago (#150: "publish values 7 days late").
  delay_days smallint not null default 0 constraint published_metrics_delay_days check (delay_days in (0, 7)),
  published_at timestamptz not null default now(),
  -- Deleting an account (#42) removes every row its user published, revoked or not.
  published_by uuid not null references auth.users (id) on delete cascade,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  constraint published_metrics_project_fkey foreign key (workspace_id, project_id)
    references public.projects (workspace_id, id) on delete cascade,
  -- An engine metric, or a self-reported value with all three of its parts. Never both.
  constraint published_metrics_source check (
    (metric_id is not null and self_reported_label is null and self_reported_value is null and self_reported_unit is null)
    or (
      metric_id is null
      and self_reported_label is not null and char_length(btrim(self_reported_label)) between 1 and 60
      and self_reported_value is not null and self_reported_value >= 0
      and self_reported_unit is not null and char_length(btrim(self_reported_unit)) between 1 and 24
    )
  ),
  constraint published_metrics_revoked check (
    (revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_at >= published_at)
  )
);

-- One live publication per engine metric and per self-reported label in a project. They also serve
-- public_published_metrics(), which reads a project's live rows.
create unique index published_metrics_live_metric_key on public.published_metrics (project_id, metric_id)
  where revoked_at is null and metric_id is not null;
create unique index published_metrics_live_self_reported_key
  on public.published_metrics (project_id, lower(btrim(self_reported_label)))
  where revoked_at is null and metric_id is null;
-- The settings page lists a project's rows; unpublish_all_metrics scans a workspace's live rows.
create index published_metrics_workspace_project_idx on public.published_metrics (workspace_id, project_id);
create index published_metrics_workspace_live_idx on public.published_metrics (workspace_id) where revoked_at is null;
create index published_metrics_published_by_idx on public.published_metrics (published_by);
create index published_metrics_revoked_by_idx on public.published_metrics (revoked_by);

alter table public.published_metrics enable row level security;

revoke all on table public.published_metrics from anon, authenticated;

-- Members see what is published and by whom; nobody writes through the Data API.
grant select on table public.published_metrics to authenticated;

create policy published_metrics_select on public.published_metrics for select to authenticated
  using (public.has_workspace_role(workspace_id, 'viewer'));

-- ── Shared checks ───────────────────────────────────────────────────────────────
-- Publishing is an owner or admin action (#104). The server checks first so the user gets a clear
-- message; this check is the backstop, because the functions run as the service role.

create function public.require_published_metrics_admin(p_workspace_id uuid, p_actor_id uuid)
  returns void
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
begin
  if p_actor_id is null or not exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_actor_id
      and public.workspace_role_rank(m.role) >= public.workspace_role_rank('admin')
  ) then
    raise exception 'only owners and admins can publish or unpublish metrics' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke execute on function public.require_published_metrics_admin(uuid, uuid) from public, anon, authenticated;

-- The audit event every publication change writes to the timeline. StackDash's own event, so no
-- provider, connection, or account. The dedupe key names the row (or the batch), so a retry of the
-- same statement cannot write it twice.
create function public.record_publication_event(
  p_workspace_id uuid,
  p_type_id text,
  p_title text,
  p_body text,
  p_dedupe_key text
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
begin
  insert into public.activity_events (
    workspace_id, connection_id, external_account_id, provider, type_id, severity, title, body, occurred_at, dedupe_key
  )
  values (p_workspace_id, null, null, null, p_type_id, 'info', p_title, p_body, now(), p_dedupe_key)
  on conflict (workspace_id, dedupe_key) do nothing;
end;
$$;

revoke execute on function public.record_publication_event(uuid, text, text, text, text) from public, anon, authenticated;

-- ── publish_metric ──────────────────────────────────────────────────────────────
-- Publishes an engine metric for a project. Returns 'published', 'unchanged' (already published
-- with the same options, so no new row and no event), or 'not_found' (no such project in the
-- workspace). Changing the options revokes the live row and publishes a new one, so the history
-- shows what was public when. The project row is locked so two publishers take turns.

create function public.publish_metric(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_metric_id public.public_metric_id,
  p_rounding public.published_metric_rounding,
  p_delay_days smallint,
  p_title text,
  p_body text
)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_live public.published_metrics%rowtype;
  v_id uuid;
begin
  perform public.require_published_metrics_admin(p_workspace_id, p_actor_id);
  if p_metric_id is null or p_rounding is null or p_delay_days is null or p_title is null then
    raise exception 'p_metric_id, p_rounding, p_delay_days, and p_title are required' using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.projects p where p.id = p_project_id and p.workspace_id = p_workspace_id for no key update;
  if not found then
    return 'not_found';
  end if;

  select * into v_live
  from public.published_metrics pm
  where pm.project_id = p_project_id and pm.metric_id = p_metric_id and pm.revoked_at is null;

  if found then
    if v_live.rounding = p_rounding and v_live.delay_days = p_delay_days then
      return 'unchanged';
    end if;
    update public.published_metrics
    set revoked_at = now(), revoked_by = p_actor_id
    where id = v_live.id;
  end if;

  insert into public.published_metrics (workspace_id, project_id, metric_id, rounding, delay_days, published_by)
  values (p_workspace_id, p_project_id, p_metric_id, p_rounding, p_delay_days, p_actor_id)
  returning id into v_id;

  perform public.record_publication_event(
    p_workspace_id, 'stackdash.metric_published', p_title, p_body, 'metric_published:' || v_id::text
  );
  return 'published';
end;
$$;

revoke execute on function public.publish_metric(
  uuid, uuid, uuid, public.public_metric_id, public.published_metric_rounding, smallint, text, text
) from public, anon, authenticated;
grant execute on function public.publish_metric(
  uuid, uuid, uuid, public.public_metric_id, public.published_metric_rounding, smallint, text, text
) to service_role;

-- ── publish_self_reported_metric ────────────────────────────────────────────────
-- Publishes a value the user typed, for the project page only. Returns 'published', 'duplicate'
-- (a live value with the same label, ignoring case), or 'not_found'. `p_body` names the project
-- and the value in the audit event, as `publish_metric` does.

create function public.publish_self_reported_metric(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_label text,
  p_value bigint,
  p_unit text,
  p_title text,
  p_body text
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
  if p_title is null then
    raise exception 'p_title is required' using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.projects p where p.id = p_project_id and p.workspace_id = p_workspace_id for no key update;
  if not found then
    return 'not_found';
  end if;

  if exists (
    select 1 from public.published_metrics pm
    where pm.project_id = p_project_id
      and pm.metric_id is null
      and pm.revoked_at is null
      and lower(btrim(pm.self_reported_label)) = lower(btrim(p_label))
  ) then
    return 'duplicate';
  end if;

  insert into public.published_metrics (
    workspace_id, project_id, self_reported_label, self_reported_value, self_reported_unit, published_by
  )
  values (p_workspace_id, p_project_id, btrim(p_label), p_value, btrim(p_unit), p_actor_id)
  returning id into v_id;

  perform public.record_publication_event(
    p_workspace_id, 'stackdash.metric_published', p_title, p_body, 'metric_published:' || v_id::text
  );
  return 'published';
end;
$$;

revoke execute on function public.publish_self_reported_metric(uuid, uuid, uuid, text, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.publish_self_reported_metric(uuid, uuid, uuid, text, bigint, text, text, text)
  to service_role;

-- ── unpublish_metric ────────────────────────────────────────────────────────────
-- Revokes one live row. Returns 'unpublished', or 'not_found' for a row that is already revoked,
-- missing, or in another workspace (one answer for all three).

create function public.unpublish_metric(
  p_workspace_id uuid,
  p_published_metric_id uuid,
  p_actor_id uuid,
  p_title text
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
  if p_title is null then
    raise exception 'p_title is required' using errcode = 'invalid_parameter_value';
  end if;

  update public.published_metrics pm
  set revoked_at = now(), revoked_by = p_actor_id
  where pm.id = p_published_metric_id and pm.workspace_id = p_workspace_id and pm.revoked_at is null
  returning pm.id into v_id;

  if v_id is null then
    return 'not_found';
  end if;

  perform public.record_publication_event(
    p_workspace_id, 'stackdash.metric_unpublished', p_title, null, 'metric_unpublished:' || v_id::text
  );
  return 'unpublished';
end;
$$;

revoke execute on function public.unpublish_metric(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.unpublish_metric(uuid, uuid, uuid, text) to service_role;

-- ── unpublish_all_metrics ───────────────────────────────────────────────────────
-- "Unpublish everything" (#147): revokes every live row in the workspace, engine metrics and
-- self-reported values alike, in one statement. Returns how many rows it revoked; the audit event
-- is written only when that is more than zero.

create function public.unpublish_all_metrics(p_workspace_id uuid, p_actor_id uuid)
  returns int
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_count int;
begin
  perform public.require_published_metrics_admin(p_workspace_id, p_actor_id);

  update public.published_metrics pm
  set revoked_at = now(), revoked_by = p_actor_id
  where pm.workspace_id = p_workspace_id and pm.revoked_at is null;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    perform public.record_publication_event(
      p_workspace_id,
      'stackdash.metrics_unpublished_all',
      'Unpublished everything',
      case when v_count = 1 then '1 metric is no longer public.' else v_count::text || ' metrics are no longer public.' end,
      'metrics_unpublished_all:' || gen_random_uuid()::text
    );
  end if;
  return v_count;
end;
$$;

revoke execute on function public.unpublish_all_metrics(uuid, uuid) from public, anon, authenticated;
grant execute on function public.unpublish_all_metrics(uuid, uuid) to service_role;

-- ── public_published_metrics ────────────────────────────────────────────────────
-- What the public read route may show for a project: live rows only. The route computes each engine
-- metric's value from stored snapshots and events; nothing here calls a provider.

create function public.public_published_metrics(p_project_id uuid)
  returns table (
    id uuid,
    workspace_id uuid,
    project_id uuid,
    metric_id public.public_metric_id,
    self_reported_label text,
    self_reported_value bigint,
    self_reported_unit text,
    rounding public.published_metric_rounding,
    delay_days smallint,
    published_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    pm.id, pm.workspace_id, pm.project_id, pm.metric_id, pm.self_reported_label, pm.self_reported_value,
    pm.self_reported_unit, pm.rounding, pm.delay_days, pm.published_at
  from public.published_metrics pm
  where pm.project_id = p_project_id and pm.revoked_at is null
  order by pm.published_at, pm.id
$$;

revoke execute on function public.public_published_metrics(uuid) from public, anon, authenticated;
grant execute on function public.public_published_metrics(uuid) to service_role;
