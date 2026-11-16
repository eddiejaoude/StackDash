-- Credential refresh lock (#496): one refresh of a connection's credential at a time, whichever path
-- runs it. Providers that rotate refresh tokens invalidate one once it is used, so two refreshes
-- that read the same token race, and the loser spends a dead token and loses the connection.
-- Until now only sync_jobs_one_open_sync_per_connection kept refreshes apart, and only between
-- syncs; automatic webhook setup and its removal on disconnect also refresh, outside any sync job.
--
-- A lease rather than a Postgres lock: the refresh is an HTTP call to the provider, and the server
-- reaches the database through PostgREST, where neither a row lock nor an advisory lock outlives
-- the one statement that takes it. The lease expires, so a holder that dies frees it on its own.
-- It is its own table rather than a column of connection_credentials, whose updated_at (stamped by
-- a trigger) is the grant time fallback of list_webhook_targets.
--
-- Expand only: a new table and function, so code that does not know them keeps working.

create table public.credential_refresh_locks (
  connection_id uuid primary key,
  workspace_id uuid not null,
  lock_id uuid not null,
  locked_until timestamptz not null,
  constraint credential_refresh_locks_connection_fkey foreign key (workspace_id, connection_id)
    references public.connections (workspace_id, id) on delete cascade
);

-- Service role only, as connection_credentials: RLS on, no policies, no grants.
alter table public.credential_refresh_locks enable row level security;
revoke all on table public.credential_refresh_locks from anon, authenticated;

-- ── acquire_credential_refresh_lock ─────────────────────────────────────────────
-- Takes the connection's lock for p_lease_seconds and returns its id, or null while another holder's
-- lease is current. Two callers at once cannot both take it: the second insert waits on the first's
-- row and then finds an unexpired lease. Release by deleting the row with the returned id, so a
-- holder whose lease ran out never frees the next holder's lock.

create function public.acquire_credential_refresh_lock(p_workspace_id uuid, p_connection_id uuid, p_lease_seconds int)
  returns uuid
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_lock_id uuid;
begin
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 600 then
    raise exception 'p_lease_seconds must be between 1 and 600' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.connections c where c.id = p_connection_id and c.workspace_id = p_workspace_id) then
    raise exception 'connection not found in workspace' using errcode = 'no_data_found';
  end if;

  insert into public.credential_refresh_locks as l (connection_id, workspace_id, lock_id, locked_until)
  values (p_connection_id, p_workspace_id, gen_random_uuid(), now() + make_interval(secs => p_lease_seconds))
  on conflict (connection_id) do update
    set lock_id = excluded.lock_id, locked_until = excluded.locked_until
    where l.locked_until < now()
  returning l.lock_id into v_lock_id;

  return v_lock_id;
end;
$$;

revoke execute on function public.acquire_credential_refresh_lock(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.acquire_credential_refresh_lock(uuid, uuid, int) to service_role;
