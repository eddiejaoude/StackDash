-- Share surfaces for published metrics (#149): the per IP rate limit of the public routes (badges,
-- cards, and the public JSON route of #148) and the per metric view counts an owner sees in the
-- share dialog. Grant model: see 20261031090000_tenancy.sql.
--
-- * public_rate_limit_counters holds one row per hashed client IP per minute. The server hashes
--   the IP with a key that only it holds before calling bump_public_rate_limit, and the check
--   constraint refuses anything that is not a SHA-256 hex digest, so a raw IP can never be stored.
--   Nobody reads it through the Data API; the retention job deletes rows older than a day.
-- * published_metric_views counts, per project, metric, surface, and UTC day, how many times
--   StackDash served the badge or card of a live publication. Counted per metric rather than per
--   publication row, so changing the rounding (which republishes) keeps the count. Members read it
--   through the Data API; only record_published_metric_view writes it, run by the server with the
--   service role. Deleting the project deletes its counts; the retention job keeps 13 months.

create type public.share_surface as enum ('badge', 'card');

-- ── public_rate_limit_counters ──────────────────────────────────────────────────

create table public.public_rate_limit_counters (
  ip_hash text not null constraint public_rate_limit_counters_ip_hash_format check (ip_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  count int not null default 1 constraint public_rate_limit_counters_count_positive check (count > 0),
  primary key (ip_hash, window_start)
);

-- The retention job deletes by age.
create index public_rate_limit_counters_window_start_idx on public.public_rate_limit_counters (window_start);

alter table public.public_rate_limit_counters enable row level security;
revoke all on table public.public_rate_limit_counters from anon, authenticated;

-- Counts one request from p_ip_hash in the current minute (database clock) and returns how many
-- that hash has made in it, this one included. One statement, so concurrent requests never lose a
-- count.
create function public.bump_public_rate_limit(p_ip_hash text)
  returns int
  language sql
  volatile
  security definer
  set search_path = ''
as $$
  insert into public.public_rate_limit_counters as c (ip_hash, window_start, count)
  values (p_ip_hash, date_trunc('minute', now()), 1)
  on conflict (ip_hash, window_start) do update set count = c.count + 1
  returning c.count
$$;

revoke execute on function public.bump_public_rate_limit(text) from public, anon, authenticated;
grant execute on function public.bump_public_rate_limit(text) to service_role;

-- ── published_metric_views ──────────────────────────────────────────────────────

create table public.published_metric_views (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null,
  metric_id public.public_metric_id not null,
  surface public.share_surface not null,
  view_date date not null,
  views int not null default 1 constraint published_metric_views_views_positive check (views > 0),
  primary key (project_id, metric_id, surface, view_date),
  constraint published_metric_views_project_fkey foreign key (workspace_id, project_id)
    references public.projects (workspace_id, id) on delete cascade
);

-- The project foreign key, and the retention job's delete by age.
create index published_metric_views_workspace_project_idx on public.published_metric_views (workspace_id, project_id);
create index published_metric_views_view_date_idx on public.published_metric_views (view_date);

alter table public.published_metric_views enable row level security;
revoke all on table public.published_metric_views from anon, authenticated;

-- Members see how often their published metrics were served; nobody writes through the Data API.
grant select on table public.published_metric_views to authenticated;

create policy published_metric_views_select on public.published_metric_views for select to authenticated
  using (public.has_workspace_role(workspace_id, 'viewer'));

-- Counts one serve of a metric's badge or card, today (UTC). Counts only while the metric is
-- published in the project: an unknown project, an unpublished metric, and a revoked one write
-- nothing, so the count can never name a project that has nothing public.
create function public.record_published_metric_view(
  p_project_id uuid,
  p_metric_id public.public_metric_id,
  p_surface public.share_surface
)
  returns void
  language sql
  volatile
  security definer
  set search_path = ''
as $$
  insert into public.published_metric_views as v (workspace_id, project_id, metric_id, surface, view_date, views)
  select pm.workspace_id, pm.project_id, pm.metric_id, p_surface, (now() at time zone 'utc')::date, 1
  from public.published_metrics pm
  where pm.project_id = p_project_id and pm.metric_id = p_metric_id and pm.revoked_at is null
  on conflict (project_id, metric_id, surface, view_date) do update set views = v.views + 1
$$;

revoke execute on function public.record_published_metric_view(uuid, public.public_metric_id, public.share_surface)
  from public, anon, authenticated;
grant execute on function public.record_published_metric_view(uuid, public.public_metric_id, public.share_surface)
  to service_role;

-- ── Retention ───────────────────────────────────────────────────────────────────
-- Same contract as the purge functions in 20261031100000_sync_engine.sql: at most p_limit rows per
-- call, oldest first, returns how many it deleted.

create function public.purge_public_rate_limit_counters(p_before timestamptz, p_limit int)
  returns int
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_deleted int;
begin
  if p_before is null or p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'p_before is required and p_limit must be between 1 and 10000' using errcode = 'invalid_parameter_value';
  end if;

  with doomed as (
    select c.ip_hash, c.window_start from public.public_rate_limit_counters c
    where c.window_start < p_before
    order by c.window_start, c.ip_hash
    limit p_limit
    for update skip locked
  )
  delete from public.public_rate_limit_counters c using doomed
  where c.ip_hash = doomed.ip_hash and c.window_start = doomed.window_start;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create function public.purge_published_metric_views(p_before date, p_limit int)
  returns int
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_deleted int;
begin
  if p_before is null or p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'p_before is required and p_limit must be between 1 and 10000' using errcode = 'invalid_parameter_value';
  end if;

  with doomed as (
    select v.project_id, v.metric_id, v.surface, v.view_date from public.published_metric_views v
    where v.view_date < p_before
    order by v.view_date, v.project_id, v.metric_id, v.surface
    limit p_limit
    for update skip locked
  )
  delete from public.published_metric_views v using doomed
  where v.project_id = doomed.project_id
    and v.metric_id = doomed.metric_id
    and v.surface = doomed.surface
    and v.view_date = doomed.view_date;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.purge_public_rate_limit_counters(timestamptz, int) from public, anon, authenticated;
revoke execute on function public.purge_published_metric_views(date, int) from public, anon, authenticated;
grant execute on function public.purge_public_rate_limit_counters(timestamptz, int) to service_role;
grant execute on function public.purge_published_metric_views(date, int) to service_role;
