-- Contract step of #481's expand then contract for connections.mode (#567), the first of two
-- migrations. 20261118150000_connection_mode.sql added the column nullable, because the build
-- before #481 writes no mode, and 20261118150100_connection_mode_backfill.sql filled it in from the
-- authorized account label for the Stripe connections made until then.
--
-- From here on every Stripe connection past pending has a mode: connections_stripe_mode_required,
-- `provider <> 'stripe' or status = 'pending' or mode is not null`. A pending connection is exempt:
-- completeConnection (src/lib/connections/connect.ts) inserts a new connection as pending and
-- writes its mode with the rest of the grant, in the update that makes it active or
-- needs_attention. Every other provider has one environment per account id and records no mode.
--
-- Precondition, settled on #567: StackDash has no production deployment yet, so nothing waits for a
-- promote, or for a sync after one. Every Stripe grant writes a label the backfill reads
-- (20261118150100's header lists the shapes), so the backfill below fills every connection a build
-- before #481 made, and a sync still corrects a mode that disagrees with the credential
-- (src/lib/jobs/sync-connection.ts). Where a build before #481 still serves, the window below
-- applies.
--
-- In this order, in this migration's one transaction:
-- 1. backfill_connection_mode again, until it fills nothing: the Stripe connections a build before
--    #481 made after the first backfill. It reads only the label shapes the adapters write and
--    never overwrites a recorded mode; 20261118150100's header says what its loop locks.
-- 2. The constraint, added `not valid`: Postgres checks it on every insert and update from this
--    migration's commit on, without reading the rows already there. Adding it takes an access
--    exclusive lock on connections, held until the commit, so it is the last statement here.
-- 20261118150300_contract_connection_mode_validate.sql then runs the backfill a last time, for a
-- connection a build before #481 made after step 1 read the table and before step 2 took its lock,
-- drops backfill_connection_mode, stops with the count and the remedy if any Stripe connection
-- past pending still has no mode, and validates the constraint in a transaction of its own, under
-- a lock that blocks neither reads nor writes.
--
-- Mixed window: the build before #481 serving after this migration ran. That is a self-hosted
-- upgrade that applies 20261118150000 through this file in one `supabase migration up` and
-- promotes afterwards (docs/operations/self-hosting.md: "A jump across many commits can apply both
-- halves at once"), or an Instant Rollback to such a build. Its completeConnection writes no mode,
-- so the database refuses its last write, the update that makes a Stripe connection active or
-- needs_attention: every Stripe connect fails, and the pending connection it inserted is deleted
-- again, until the build from #481 or later serves. Its reconnect keeps the recorded mode, so it
-- still succeeds, and every other provider is unaffected.

do $$
begin
  while public.backfill_connection_mode(1000) > 0 loop
  end loop;
end;
$$;

alter table public.connections
  add constraint connections_stripe_mode_required
  check (provider <> 'stripe' or status = 'pending' or mode is not null)
  not valid;
