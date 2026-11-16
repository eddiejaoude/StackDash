-- The backfill's recheck guard (#476 review), carried forward for a database that applied
-- 20261116090100_connection_granted_at_backfill.sql before that review. Only the shared local
-- database did: no deployed environment has 20261116090100 or this migration's predecessors.
-- 20261116090100 was edited in place to add the guard, which a database that already applied it
-- never runs, so this migration states the same function again. On any other database it changes
-- nothing: the body below is the body 20261116090100 creates, and the contract step of #476
-- (#502) runs this function again, so every database must hold the guarded one.
--
-- The guard: the update repeats `granted_at is null`, so under read committed a row whose grant
-- commits after the batch was read is rechecked against its new version and skipped, instead of
-- getting a credential time from the older snapshot. 20261116090100 explains the rest.

create or replace function public.backfill_connection_granted_at(p_limit int)
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
