-- Background jobs (#10) and the invite allow list (#23). Grant model: see 20261031090000_tenancy.sql.

-- pg_cron calls POST /api/jobs/tick every minute through pg_net. The extensions are created here;
-- the cron job itself carries the deployment URL and CRON_SECRET, so it is environment
-- configuration (#89), never a migration. Schemas follow the Supabase convention.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create type public.sync_job_kind as enum ('sync', 'daily_snapshot_rollover', 'daily_summary', 'retention');
create type public.sync_job_status as enum ('queued', 'running', 'succeeded', 'failed');

-- ── sync_jobs ───────────────────────────────────────────────────────────────────
-- Claimed with `for update skip locked` (claim_sync_jobs), so overlapping ticks never run the same
-- job twice. A running job whose lease expired is claimable again: the tick that held it died.

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Null for instance-wide jobs such as retention.
  workspace_id uuid references public.workspaces (id) on delete cascade,
  connection_id uuid,
  kind public.sync_job_kind not null,
  status public.sync_job_status not null default 'queued',
  run_after timestamptz not null default now(),
  attempts int not null default 0 constraint sync_jobs_attempts_nonnegative check (attempts >= 0),
  max_attempts int not null default 5 constraint sync_jobs_max_attempts_positive check (max_attempts >= 1),
  locked_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_reference text,
  dedupe_key text constraint sync_jobs_dedupe_key_key unique,
  created_at timestamptz not null default now(),
  constraint sync_jobs_connection_fkey foreign key (workspace_id, connection_id)
    references public.connections (workspace_id, id) on delete cascade,
  -- A composite foreign key is skipped when any column is null, so a connection job must name its
  -- workspace for the reference to be checked.
  constraint sync_jobs_connection_has_workspace check (connection_id is null or workspace_id is not null),
  constraint sync_jobs_sync_has_connection check (kind <> 'sync' or connection_id is not null)
);

create index sync_jobs_status_run_after_idx on public.sync_jobs (status, run_after);
create index sync_jobs_workspace_id_idx on public.sync_jobs (workspace_id);
create index sync_jobs_connection_id_idx on public.sync_jobs (connection_id);
-- Retention deletes rows older than 30 days (#37).
create index sync_jobs_created_at_idx on public.sync_jobs (created_at);

alter table public.sync_jobs enable row level security;
revoke all on table public.sync_jobs from anon, authenticated;

-- Members see their workspace's job history (sync status in the UI); writes are service role only.
-- Instance-wide jobs (workspace_id null) are visible to nobody but the service role.
grant select on table public.sync_jobs to authenticated;
create policy sync_jobs_select on public.sync_jobs for select to authenticated
  using (workspace_id is not null and public.has_workspace_role(workspace_id, 'viewer'));

-- ── claim_sync_jobs ─────────────────────────────────────────────────────────────
-- Security invoker: only the service role may call it, and the service role already owns every
-- write it makes. Jobs that have used all attempts are never claimed; one whose lease expired on
-- its final attempt is marked failed so it stops looking busy.

create function public.claim_sync_jobs(p_limit int, p_lease_seconds int)
  returns setof public.sync_jobs
  language plpgsql
  volatile
  set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'p_limit must be between 1 and 100' using errcode = 'invalid_parameter_value';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'p_lease_seconds must be between 1 and 3600' using errcode = 'invalid_parameter_value';
  end if;

  update public.sync_jobs j
  set status = 'failed',
      locked_until = null,
      finished_at = now(),
      error_code = coalesce(j.error_code, 'lease_expired')
  where j.status = 'running'
    and j.locked_until < now()
    and j.attempts >= j.max_attempts;

  return query
  with candidates as (
    select c.id
    from public.sync_jobs c
    where c.attempts < c.max_attempts
      and (
        (c.status = 'queued' and c.run_after <= now())
        or (c.status = 'running' and c.locked_until < now())
      )
    order by c.run_after, c.id
    limit p_limit
    for update skip locked
  )
  update public.sync_jobs j
  set status = 'running',
      locked_until = now() + make_interval(secs => p_lease_seconds),
      attempts = j.attempts + 1,
      started_at = now(),
      finished_at = null
  from candidates
  where j.id = candidates.id
  returning j.*;
end;
$$;

revoke execute on function public.claim_sync_jobs(int, int) from public, anon, authenticated;
grant execute on function public.claim_sync_jobs(int, int) to service_role;

-- ── access_invites ──────────────────────────────────────────────────────────────
-- Invite-only test (#23): the allow list the before-user-created hook checks. Managed by the
-- server-side `npm run invite` script with the service role.

create table public.access_invites (
  email text primary key constraint access_invites_email_lowercase check (email = lower(email)),
  invited_at timestamptz not null default now(),
  invited_by text not null
);

alter table public.access_invites enable row level security;
revoke all on table public.access_invites from anon, authenticated;

-- Supabase Auth runs the hook as supabase_auth_admin, which does not bypass RLS.
grant select on table public.access_invites to supabase_auth_admin;
create policy access_invites_select_auth_admin on public.access_invites for select to supabase_auth_admin
  using (true);

-- ── hook_before_user_created ────────────────────────────────────────────────────
-- Fires for every user creation, including GitHub OAuth sign-up and the admin API createUser used
-- by test fixtures, so both pass exactly when the email is invited. Returns '{}' to allow and an
-- error object to reject, per the Supabase before-user-created hook contract. A GitHub account
-- without an email cannot match an invite and is rejected.

create function public.hook_before_user_created(event jsonb)
  returns jsonb
  language plpgsql
  stable
  set search_path = ''
as $$
declare
  v_email text := lower(btrim(event -> 'user' ->> 'email'));
begin
  if v_email is not null and v_email <> ''
     and exists (select 1 from public.access_invites i where i.email = v_email)
  then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'This email has not been invited to the StackDash test.'
    )
  );
end;
$$;

grant usage on schema public to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
