-- The mode of each connection, live or test, outside the sealed credential (#481).
-- A Stripe account id (`acct_...`) is the same in live mode and in test mode, and until now a
-- connection's mode lived only in its sealed credential's metadata (`livemode`, credentialFromToken
-- in src/lib/adapters/stripe/index.ts), which SQL cannot read. list_webhook_targets matched a
-- delivery on the account id alone, so a live delivery reached every connection of the account,
-- test mode ones included (live payments on a test mode timeline, a live uninstall marking a test
-- mode connection), and test mode deliveries had to be ignored outright, or a test mode uninstall
-- would have revoked the live connection.
--
-- - connections.mode (connection_mode, nullable): written by the app when a grant completes, on
--   connect and on reconnect (completeConnection, src/lib/connections/connect.ts, from the
--   adapter's `modeOf`), and corrected from the credential by every sync that finds it null or
--   different (src/lib/jobs/sync-connection.ts). Null for a provider with one environment per
--   account id (every provider but Stripe), a pending connection, and a Stripe connection the next
--   migration (20261118150100_connection_mode_backfill.sql) could not fill.
-- - list_webhook_targets returns `mode` as its last column. The webhook job keeps only the targets
--   whose mode is the one the delivery names (Stripe names one on every events and uninstalled
--   outcome, from the event's `livemode`), so a target with no recorded mode gets nothing from such
--   a delivery: an active or failed one until its next sync records the mode, within the hour,
--   with polling bringing its events meanwhile; a needs_attention one, which is not synced, until
--   the user reconnects it.
--
-- Expand step of expand then contract. The contract step (#567,
-- 20261118150200_contract_connection_mode.sql and
-- 20261118150300_contract_connection_mode_validate.sql) runs the backfill again for connections a
-- build before #481 made after it, then requires a mode on every non-pending Stripe connection, so
-- from then on only a pending Stripe connection and the other providers' connections have none.
--
-- Members read mode with the rest of their connection row (connections_select, table-wide select);
-- nobody writes it through the Data API: authenticated keeps update (display_name,
-- last_sync_requested_at) and insert of four other columns, and nothing else.
--
-- Expand only for list_webhook_targets: the parameters, the grants, the matching, the order, the
-- bound, and the first five result columns are those of
-- 20261118140000_webhook_targets_simulated.sql; the result gains `mode` as its last column. Adding a
-- result column changes the return type, which create or replace refuses, so the function is
-- dropped and created again in this migration's one transaction, as that migration did. Mixed
-- windows follow. Window 3 is bounded by the runner and covered by polling: a webhook job that
-- throws is retried while attempts < max_attempts (5) with backoff ceilings of 1, 2, 4, and 8
-- minutes (src/lib/jobs/backoff.ts), so it is failed for good within about 15 minutes, and the
-- hourly poll of an active or failed connection brings the same events. Window 2 has no poll to
-- cover it.
-- 1. The build before #481 against this schema. Compatible: its store reads the other columns by
--    name and ignores `mode`, its completeConnection leaves `mode` null (the contract step's
--    backfill fills those), and it still ignores test mode Stripe events and applies a live one to
--    every connection of the account, the fault #481 fixes, until the build from #481 serves.
-- 2. The build from #481 against the schema before this migration (promoted before
--    `supabase migration up` ran). Every provider fails, not only Stripe, until the migration runs:
--    completeConnection writes a column that does not exist, so every connect and reconnect fails;
--    and getConnection (src/lib/jobs/store.ts) selects `mode` by name, so the connection read that
--    runSyncJob and markConnectionRevoked (src/lib/jobs/sync-connection.ts) start with throws.
--    Every sync job of every connection is retried and then failed, and the scheduler queues the
--    next due one, which fails the same way; every uninstall job fails the same way, so an
--    uninstall received in this window shows only when a sync after the migration finds the grant
--    gone. Target rows carry no `mode`, so the store reads every target as having none, and a
--    Stripe delivery reaches no connection and is marked processed. Once the migration runs, syncs
--    resume. Run `supabase migration up` before the build from #481 serves
--    (docs/operations/deploy.md).
-- 3. The build before #481 reading an outcome the build from #481 stored, after an Instant
--    Rollback (docs/operations/self-hosting.md, Roll back): its strict stored outcome schema
--    refuses `mode`, loadWebhookDelivery throws, and each Stripe delivery received and not yet
--    applied fails its job that way; polling brings the same events, and a real uninstall shows at
--    the next sync, which finds the grant gone.

create type public.connection_mode as enum ('live', 'test');

alter table public.connections add column mode public.connection_mode;

-- ── list_webhook_targets ────────────────────────────────────────────────────────
-- p_external_id, p_installation_id, or both name what the delivery is about.
-- - p_external_id: each included external account with that external id, ordered by account id.
-- - p_installation_id: each connection with that external_installation_id, one row per connection
--   and account_id null (an uninstall acts on connections, and a connection may have no included
--   account), ordered by connection id.
-- - both: the p_external_id match, kept to connections whose external_installation_id is
--   p_installation_id (#497). A connection with no recorded installation is no match;
--   20261118130000_webhook_targets_installation_match.sql says when it records one.
-- All only on connections of p_provider that are active, failed, or needs_attention, only on the
-- endpoint's own connection when p_endpoint_id is set, and bounded at 100.
-- Each row carries:
-- - granted_at: connections.granted_at, when the connection was last granted (a connect or a
--   reconnect, never a token refresh). Null for a live connection with no recorded grant;
--   20261118090000_contract_webhook_targets.sql names the two kinds and the remedy.
-- - simulated: whether the provider simulator made the connection;
--   20261118140000_webhook_targets_simulated.sql says how it is read and what the job does with it.
-- - mode: connections.mode, the connection's live or test mode, or null where none is recorded.
--   The job keeps the targets of the delivery's mode when it names one. The bound applies before
--   that and before the kind filter, so it counts every target of the account, of either mode and
--   either kind (simulated connections included), and binds once 100 connections include the
--   account: nothing limits how many connections of one workspace include it. A target of the
--   delivery's kind and mode past the bound gets nothing from it: a real one gets the events from
--   its next poll and an uninstall when its next sync finds the grant gone; a simulated one never
--   gets them, since the simulator's sync makes up its own.
-- Security invoker: only the service role may call it, and it already reads every row it needs.

drop function public.list_webhook_targets(public.provider_id, text, uuid, text);

create function public.list_webhook_targets(
  p_provider public.provider_id,
  p_external_id text default null,
  p_endpoint_id uuid default null,
  p_installation_id text default null
)
  returns table (
    workspace_id uuid,
    connection_id uuid,
    account_id uuid,
    granted_at timestamptz,
    simulated boolean,
    mode public.connection_mode
  )
  language plpgsql
  stable
  set search_path = ''
as $$
begin
  if p_external_id is null and p_installation_id is null then
    raise exception 'p_external_id or p_installation_id is required' using errcode = 'invalid_parameter_value';
  end if;

  if p_external_id is null then
    return query
      select c.workspace_id, c.id, null::uuid, c.granted_at, c.granted_scopes @> array['simulated:read'], c.mode
      from public.connections c
      where c.provider = p_provider
        and c.external_installation_id = p_installation_id
        and c.status in ('active', 'failed', 'needs_attention')
        and (
          p_endpoint_id is null
          or exists (
            select 1 from public.webhook_endpoints e
            where e.id = p_endpoint_id and e.workspace_id = c.workspace_id and e.connection_id = c.id
          )
        )
      order by c.id
      limit 100;
    return;
  end if;

  return query
    select a.workspace_id, a.connection_id, a.id, c.granted_at, c.granted_scopes @> array['simulated:read'], c.mode
    from public.external_accounts a
    join public.connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
    where a.external_id = p_external_id
      and a.included
      and c.provider = p_provider
      and c.status in ('active', 'failed', 'needs_attention')
      and (p_installation_id is null or c.external_installation_id = p_installation_id)
      and (
        p_endpoint_id is null
        or exists (
          select 1 from public.webhook_endpoints e
          where e.id = p_endpoint_id and e.workspace_id = c.workspace_id and e.connection_id = c.id
        )
      )
    order by a.id
    limit 100;
end;
$$;

revoke execute on function public.list_webhook_targets(public.provider_id, text, uuid, text) from public, anon, authenticated;
grant execute on function public.list_webhook_targets(public.provider_id, text, uuid, text) to service_role;
