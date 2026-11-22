-- Backfill for 20261122090000_webhook_source_outdated.sql (#617): marks every GitLab project webhook
-- StackDash created, so the after-sync pass gives each a signing token and clears its secret token.
--
-- Every stored GitLab webhook is marked, not only those made before #616 shipped: when that build
-- went live is not known to the database, and updating a webhook #616 already signed sends the same
-- signing token again, so the cost of marking one too many is one idempotent call to GitLab.
--
-- Batched: backfill_webhook_source_outdated marks at most p_limit unmarked rows, in key order, and
-- returns how many it marked, so the loop below stops at zero. The update repeats
-- `not provider_webhook_outdated`, so a row another writer changed after the batch was read is
-- rechecked against its new version (read committed rechecks the update's own conditions, not the
-- batch's), as 20261118150100_connection_mode_backfill.sql does.
--
-- Re-running is safe but not free: within this migration the loop ends once nothing is left
-- unmarked. Run again after the after-sync pass has cleared marks, it marks those webhooks again,
-- and each gets one more `PUT`, which changes nothing at GitLab. Nothing runs it again: the function
-- is dropped at the end of this migration, since no contract step needs it.
--
-- The limit bounds what one call locks only when each call commits on its own. The loop runs in this
-- migration's single transaction, so it holds every marked row's lock until the migration commits:
-- record_webhook_source and save_created_webhook_source for a GitLab endpoint wait for it, so a
-- delivery or a sync landing meanwhile is delayed, not lost. Marking a row also moves its
-- updated_at (webhook_sources_set_updated_at), which nothing reads, and the table is not in the
-- supabase_realtime publication, so no open tab hears of it.

create function public.backfill_webhook_source_outdated(p_limit int)
  returns int
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_marked int;
begin
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'p_limit must be between 1 and 10000' using errcode = 'invalid_parameter_value';
  end if;

  with batch as (
    select source.endpoint_id, source.source_id
    from public.webhook_sources as source
    join public.webhook_endpoints as endpoint on endpoint.id = source.endpoint_id
    where endpoint.provider = 'gitlab'
      and source.provider_webhook_id is not null
      and not source.provider_webhook_outdated
    order by source.endpoint_id, source.source_id
    limit p_limit
  )
  update public.webhook_sources as source
  set provider_webhook_outdated = true
  from batch
  where source.endpoint_id = batch.endpoint_id
    and source.source_id = batch.source_id
    and source.provider_webhook_id is not null
    and not source.provider_webhook_outdated;

  get diagnostics v_marked = row_count;
  return v_marked;
end;
$$;

revoke execute on function public.backfill_webhook_source_outdated(int) from public, anon, authenticated;
grant execute on function public.backfill_webhook_source_outdated(int) to service_role;

do $$
begin
  while public.backfill_webhook_source_outdated(1000) > 0 loop
  end loop;
end;
$$;

drop function public.backfill_webhook_source_outdated(int);
