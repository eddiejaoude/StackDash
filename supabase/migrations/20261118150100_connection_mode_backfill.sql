-- Backfill of connections.mode (#481), in a migration of its own as expand then contract asks.
--
-- A Stripe connection made before 20261118150000_connection_mode.sql has no recorded mode. The
-- credential's `livemode` is sealed, so SQL reads the same fact where the app wrote it in the
-- clear: connections.authorized_account_label, which completeConnection
-- (src/lib/connections/connect.ts) builds from the adapter's listAccounts on every connect and
-- reconnect. Stripe's listAccounts has named a test mode account `Stripe account <id> (test mode)`
-- and a live one `Stripe account <id>` since the adapter's first version, from the credential's
-- `livemode` (src/lib/adapters/stripe/index.ts), and the simulated Stripe account is
-- `Example Stripe account (test mode)` (src/lib/adapters/simulated/stripe.ts), the mode the twin's
-- modeOf gives. Only the service role writes the label: authenticated may update display_name and
-- last_sync_requested_at and nothing else, so the user-editable display_name is not read. A label
-- ending in ` (test mode)` is test, any other label is live, and a connection with no label
-- (a grant that listed no account) keeps null, which its next sync fills from the credential.
-- That sync also corrects a mode that disagrees with the credential (src/lib/jobs/sync-connection.ts),
-- so the credential stays the source of truth and this backfill only bridges the hour until then.
--
-- Batched and re-runnable: backfill_connection_mode fills at most p_limit non-pending Stripe
-- connections that still have no mode, in id order, and returns how many it filled, so the loop
-- below stops at zero and running it again changes nothing. A connection the app granted meanwhile
-- already has its exact mode and is never overwritten: the update repeats `mode is null`, so a row
-- whose grant commits after the batch was read is rechecked against its new version and skipped
-- (read committed rechecks the update's own conditions, not the batch's), as
-- 20261116090400_backfill_granted_at_guard.sql does for granted_at.
--
-- The limit bounds what one call locks only when each call commits on its own. The loop below runs
-- in this migration's single transaction, so it holds every filled row's lock until the migration
-- commits: a sync or a connect writing a Stripe connection row waits for it, which is acceptable for
-- a table holding a few connections per workspace. Filling a row also moves its updated_at
-- (connections_set_updated_at), which no reader relies on, and, because connections is in the
-- supabase_realtime publication (20261104090000_realtime_publication.sql), sends each filled row to
-- open workspace tabs, which refresh once (src/components/app/live-refresh.tsx).
--
-- The contract step (its own issue) runs this function again, for Stripe connections a build before
-- #481 made after this migration, before it requires a mode.

create function public.backfill_connection_mode(p_limit int)
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
    where c.provider = 'stripe'
      and c.mode is null
      and c.status <> 'pending'
      and c.authorized_account_label is not null
    order by c.id
    limit p_limit
  )
  update public.connections c
  set mode = case
    when c.authorized_account_label like '% (test mode)' then 'test'::public.connection_mode
    else 'live'::public.connection_mode
  end
  from batch
  where c.id = batch.id
    and c.mode is null;

  get diagnostics v_filled = row_count;
  return v_filled;
end;
$$;

revoke execute on function public.backfill_connection_mode(int) from public, anon, authenticated;
grant execute on function public.backfill_connection_mode(int) to service_role;

do $$
begin
  while public.backfill_connection_mode(1000) > 0 loop
  end loop;
end;
$$;
