-- Backfill of connections.granted_at (#476), in a migration of its own as expand then contract asks.
--
-- A connection made before 20261116090000_connection_granted_at.sql has no grant time. The closest
-- recorded one is when its credential was last saved (connection_credentials.updated_at): the grant
-- itself, or a later token refresh, which is never earlier than the grant. Without a credential it
-- is when the connection was created. Either way the value is at or after the real grant, so an
-- uninstall older than it stays skipped as it was before (#28 compared against the credential's
-- time); only grants from now on are exact. A pending connection never completed a grant and stays
-- null.
--
-- Batched and re-runnable: backfill_connection_granted_at fills at most p_limit connections that
-- still have none, in id order (random UUIDs, so not by age), and returns how many it filled, so
-- the loop below stops at zero and running it again changes nothing. A connection the app granted
-- meanwhile already has its exact value and is never overwritten: the update repeats the
-- `granted_at is null` test, so a row whose grant commits after the batch was read is rechecked
-- against its new version and skipped (read committed rechecks the update's own conditions, not
-- the batch's).
--
-- The limit bounds what one call locks only when each call commits on its own. The loop below runs
-- in this migration's single transaction, so it holds every filled row's lock until the migration
-- commits: a sync or a connect writing a connection row waits for it. That is acceptable for this
-- table, which holds a few connections per workspace. Filling a row also moves its updated_at
-- (connections_set_updated_at), which no reader relies on, and, because connections is in the
-- supabase_realtime publication (20261104090000_realtime_publication.sql), sends each filled row to
-- open workspace tabs, which refresh once (src/components/app/live-refresh.tsx).

create function public.backfill_connection_granted_at(p_limit int)
  returns int
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_filled int;
begin
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'p_limit must be between 1 and 10000' using errcode = 'invalid_parameter_value';
  end if;

  with batch as (
    select c.id
    from public.connections c
    where c.granted_at is null
      and c.status <> 'pending'
    order by c.id
    limit p_limit
  )
  update public.connections c
  set granted_at = coalesce(
    (select cc.updated_at from public.connection_credentials cc
     where cc.workspace_id = c.workspace_id and cc.connection_id = c.id),
    c.created_at
  )
  from batch
  where c.id = batch.id
    and c.granted_at is null;

  get diagnostics v_filled = row_count;
  return v_filled;
end;
$$;

revoke execute on function public.backfill_connection_granted_at(int) from public, anon, authenticated;
grant execute on function public.backfill_connection_granted_at(int) to service_role;

do $$
begin
  while public.backfill_connection_granted_at(1000) > 0 loop
  end loop;
end;
$$;
