-- A workspace's first connection, inserted only while it has none (#287). "Explore with sample
-- data" (#257) connects every simulated provider to a workspace with no connections, so made-up
-- data never sits beside real data. exploreWithSampleData counted the workspace's connections, then
-- connected the providers one request at a time, so two submits that overlapped (two tabs, or a
-- double submit) both found the workspace empty and connected a set each.
--
-- The server reaches the database through PostgREST, which runs each request in its own
-- transaction, so no lock outlives the request that takes it and nothing can hold the workspace
-- across the requests that connect a set. The check moves into the insert instead: the first
-- connection of a set goes in through this function, which checks and inserts in one transaction,
-- and the rest of the set follows as before (completeConnection in src/lib/connections/connect.ts,
-- `onlyIntoEmptyWorkspace`). Once the first is in, the workspace has a connection, so another set's
-- first insert finds it and adds nothing.
--
-- Expand only: a new function, so code that does not know it keeps working.

-- ── insert_first_connection ─────────────────────────────────────────────────────
-- Inserts a pending connection, with the columns completeConnection's own insert writes, and
-- returns its id, but only while the workspace has no connection of any status; otherwise returns
-- null, having written nothing. The workspace row is locked first, so two calls for one workspace
-- take turns, as set_workspace_handle's do: under read committed, the second waits until the first
-- commits, then reads its connection. `for no key update` leaves the foreign key checks of other
-- writes to the workspace unblocked. A workspace that does not exist is refused. The caller
-- authorizes the user, as it does before completeConnection's own insert.

create function public.insert_first_connection(
  p_workspace_id uuid,
  p_provider public.provider_id,
  p_display_name text,
  p_poll_interval_seconds int,
  p_user_id uuid
)
  returns uuid
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_connection_id uuid;
begin
  perform 1 from public.workspaces w where w.id = p_workspace_id for no key update;
  if not found then
    raise exception 'workspace not found' using errcode = 'no_data_found';
  end if;

  if exists (select 1 from public.connections c where c.workspace_id = p_workspace_id) then
    return null;
  end if;

  insert into public.connections (workspace_id, provider, status, display_name, poll_interval_seconds, created_by, updated_by)
  values (p_workspace_id, p_provider, 'pending', p_display_name, p_poll_interval_seconds, p_user_id, p_user_id)
  returning id into v_connection_id;
  return v_connection_id;
end;
$$;

revoke execute on function public.insert_first_connection(uuid, public.provider_id, text, int, uuid) from public, anon, authenticated;
grant execute on function public.insert_first_connection(uuid, public.provider_id, text, int, uuid) to service_role;
