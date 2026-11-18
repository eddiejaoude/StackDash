-- Contract step of #481's expand then contract for connections.mode (#567), the second of two
-- migrations: the rows already there. 20261118150200_contract_connection_mode.sql added
-- connections_stripe_mode_required `not valid`, so since its commit no insert or update leaves a
-- Stripe connection past pending without a mode; its header names the window it opened.
--
-- In this order, in this migration's one transaction:
-- 1. backfill_connection_mode a last time, until it fills nothing: a connection a build before #481
--    made after that migration's backfill read the table and before its constraint was added.
-- 2. backfill_connection_mode is dropped. Nothing can need it again: the constraint refuses a
--    connection without a mode, so no build can leave one for it to fill. granted_at is the
--    opposite case: 20261118090000_contract_webhook_targets.sql kept backfill_connection_granted_at
--    as the remedy for a null that a build before #476 can still write.
-- 3. Any Stripe connection past pending still without a mode stops the migration, with the count
--    and the remedy. Every Stripe connection the app makes has a label the backfill reads, and
--    disconnecting keeps it, so one left here was written another way: by hand, by a script, or
--    by a test fixture. The transaction rolls back whole, so nothing here changes, the earlier
--    migrations stay applied, and the later ones wait until each such connection is reconnected,
--    given its mode, or deleted (docs/operations/self-hosting.md, "A migration stops at Stripe
--    connections with no mode"). Until then the constraint refuses every write to one that does
--    not record a mode.
-- 4. The constraint is validated. VALIDATE CONSTRAINT reads every row under a share update
--    exclusive lock, which blocks neither reads nor writes.

do $$
begin
  while public.backfill_connection_mode(1000) > 0 loop
  end loop;
end;
$$;

drop function public.backfill_connection_mode(int);

do $$
declare
  v_missing bigint;
begin
  select count(*) into v_missing
  from public.connections
  where provider = 'stripe' and status <> 'pending' and mode is null;

  if v_missing > 0 then
    raise exception using
      errcode = 'check_violation',
      message = format(
        '%s Stripe %s no mode (live or test), so connections_stripe_mode_required cannot be validated. '
        'Reconnect each one, give it its mode, or delete it, then run supabase migration up again: '
        'docs/operations/self-hosting.md, "A migration stops at Stripe connections with no mode", '
        'lists them and says how.',
        v_missing,
        case when v_missing = 1 then 'connection has' else 'connections have' end);
  end if;
end;
$$;

alter table public.connections validate constraint connections_stripe_mode_required;
