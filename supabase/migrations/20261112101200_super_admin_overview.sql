-- Instance-wide figures for the super admin page (#250). Grant model: see 20261031090000_tenancy.sql.
--
-- Every function here reads across all workspaces and auth.users, so each is security definer,
-- pins an empty search_path, and is executable by the service role only. The app calls them from
-- src/lib/data/admin.ts after requireSuperAdmin() (src/lib/auth/super-admin.ts) has checked the
-- signed-in user against STACKDASH_SUPER_ADMIN_EMAILS; the database never learns who the super
-- admins are. Nothing here returns personal data: counts, workspace names, and job error codes only.
--
-- Event counts sum activity_event_daily_counts (20261106090000), which the triggers keep equal to
-- activity_events, so a total costs one row per workspace, day, type, provider, and account rather
-- than one per event.

-- ── Totals ──────────────────────────────────────────────────────────────────────

create function public.admin_instance_totals()
  returns table (
    users bigint,
    users_new_7d bigint,
    users_new_30d bigint,
    users_signed_in_30d bigint,
    workspaces bigint,
    workspaces_new_7d bigint,
    workspaces_new_30d bigint,
    memberships bigint,
    connections bigint,
    events bigint
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    (select count(*) from auth.users),
    (select count(*) from auth.users u where u.created_at >= now() - interval '7 days'),
    (select count(*) from auth.users u where u.created_at >= now() - interval '30 days'),
    (select count(*) from auth.users u where u.last_sign_in_at >= now() - interval '30 days'),
    (select count(*) from public.workspaces),
    (select count(*) from public.workspaces w where w.created_at >= now() - interval '7 days'),
    (select count(*) from public.workspaces w where w.created_at >= now() - interval '30 days'),
    (select count(*) from public.workspace_members),
    (select count(*) from public.connections c where c.status <> 'revoked'),
    (select coalesce(sum(d.event_count), 0)::bigint from public.activity_event_daily_counts d);
$$;

-- ── Per workspace ───────────────────────────────────────────────────────────────
-- Newest first, one page at a time: (p_after_created_at, p_after_id) is the last row of the previous
-- page, both null for the first. The page size is clamped to 1..100 so no caller can ask for every
-- workspace at once. A missing cursor becomes one past every row rather than an `or`, so the one row
-- comparison stays a condition on workspaces_created_at_id_idx below.

create index workspaces_created_at_id_idx on public.workspaces (created_at desc, id desc);

create function public.admin_workspace_stats(
  p_limit integer,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null
)
  returns table (
    workspace_id uuid,
    slug text,
    name text,
    is_personal boolean,
    created_at timestamptz,
    members bigint,
    connections bigint,
    events bigint
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    w.id,
    w.slug,
    w.name,
    w.is_personal,
    w.created_at,
    (select count(*) from public.workspace_members m where m.workspace_id = w.id),
    (select count(*) from public.connections c where c.workspace_id = w.id and c.status <> 'revoked'),
    (select coalesce(sum(d.event_count), 0)::bigint from public.activity_event_daily_counts d where d.workspace_id = w.id)
  from public.workspaces w
  where (w.created_at, w.id) < (
    coalesce(p_after_created_at, 'infinity'::timestamptz),
    coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
  )
  order by w.created_at desc, w.id desc
  limit least(greatest(coalesce(p_limit, 1), 1), 100);
$$;

-- ── Providers ───────────────────────────────────────────────────────────────────
-- One row per provider with any connection. `workspaces` counts workspaces with at least one
-- connection that is not revoked: the workspaces using the provider now.

create function public.admin_provider_usage()
  returns table (
    provider public.provider_id,
    workspaces bigint,
    active bigint,
    pending bigint,
    needs_attention bigint,
    failed bigint,
    revoked bigint
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    c.provider,
    count(distinct c.workspace_id) filter (where c.status <> 'revoked'),
    count(*) filter (where c.status = 'active'),
    count(*) filter (where c.status = 'pending'),
    count(*) filter (where c.status = 'needs_attention'),
    count(*) filter (where c.status = 'failed'),
    count(*) filter (where c.status = 'revoked')
  from public.connections c
  group by c.provider
  order by c.provider;
$$;

-- ── Background jobs ─────────────────────────────────────────────────────────────
-- One row per job kind present in sync_jobs, which retention keeps to 30 days of finished rows plus
-- every open one (docs/operations/jobs.md). `due` is queued and runnable now; `stale` is running past
-- its lease, which means the tick that claimed it died. `retrying` is queued after a failed attempt.

create function public.admin_job_health()
  returns table (
    kind public.sync_job_kind,
    queued bigint,
    due bigint,
    retrying bigint,
    running bigint,
    stale bigint,
    succeeded_24h bigint,
    failed_24h bigint,
    oldest_due_at timestamptz,
    last_finished_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select
    j.kind,
    count(*) filter (where j.status = 'queued'),
    count(*) filter (where j.status = 'queued' and j.run_after <= now()),
    count(*) filter (where j.status = 'queued' and j.error_code is not null),
    count(*) filter (where j.status = 'running'),
    count(*) filter (where j.status = 'running' and j.locked_until < now()),
    count(*) filter (where j.status = 'succeeded' and j.finished_at >= now() - interval '24 hours'),
    count(*) filter (where j.status = 'failed' and j.finished_at >= now() - interval '24 hours'),
    min(j.run_after) filter (where j.status = 'queued' and j.run_after <= now()),
    max(j.finished_at)
  from public.sync_jobs j
  group by j.kind
  order by j.kind;
$$;

-- Jobs that used every attempt in the last 24 hours, by kind and error code, most frequent first.
-- Error codes are the app's own short codes (src/lib/adapters/errors.ts), never provider messages.
-- At most 20 rows.

create function public.admin_job_failures()
  returns table (
    kind public.sync_job_kind,
    error_code text,
    failures bigint,
    last_failed_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select j.kind, coalesce(j.error_code, 'unknown'), count(*), max(j.finished_at)
  from public.sync_jobs j
  where j.status = 'failed' and j.finished_at >= now() - interval '24 hours'
  group by j.kind, coalesce(j.error_code, 'unknown')
  order by count(*) desc, max(j.finished_at) desc
  limit 20;
$$;

-- ── Deployment ──────────────────────────────────────────────────────────────────
-- The newest migration version the Supabase CLI recorded, or null when this database was not
-- migrated by the CLI (no supabase_migrations schema), so the page can say it cannot tell. plpgsql
-- with dynamic SQL so the function can be created on a database without that table.

create function public.admin_latest_migration()
  returns text
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
declare
  v_version text;
begin
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then
    return null;
  end if;
  execute 'select max(version) from supabase_migrations.schema_migrations' into v_version;
  return v_version;
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────────

revoke execute on function public.admin_instance_totals() from public, anon, authenticated;
revoke execute on function public.admin_workspace_stats(integer, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.admin_provider_usage() from public, anon, authenticated;
revoke execute on function public.admin_job_health() from public, anon, authenticated;
revoke execute on function public.admin_job_failures() from public, anon, authenticated;
revoke execute on function public.admin_latest_migration() from public, anon, authenticated;

grant execute on function public.admin_instance_totals() to service_role;
grant execute on function public.admin_workspace_stats(integer, timestamptz, uuid) to service_role;
grant execute on function public.admin_provider_usage() to service_role;
grant execute on function public.admin_job_health() to service_role;
grant execute on function public.admin_job_failures() to service_role;
grant execute on function public.admin_latest_migration() to service_role;
