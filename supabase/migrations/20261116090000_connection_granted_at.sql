-- When a connection was last granted (#476). A webhook uninstall (#28) is skipped for a connection
-- that was granted again after the removal, so a late or redelivered uninstall never revokes a live
-- reconnect. #28 compared against connection_credentials.updated_at, which a token refresh also
-- writes, so a real uninstall followed by a refresh was left to the next sync, which then failed
-- and asked for a reconnect: what polling alone already did.
--
-- - connections.granted_at: written by the app when a grant completes, on connect and on reconnect
--   (completeConnection in src/lib/connections/connect.ts), and never by a token refresh. Null for
--   a pending connection (its grant has not completed), and for a live connection whose grant
--   completed without the stamp: one made by the previous deployment between this migration and
--   the promote of the code that writes it, or a row inserted as live directly (seed, fixtures).
--   Existing connections are backfilled in the next migration,
--   20261116090100_connection_granted_at_backfill.sql.
-- - list_webhook_targets returns granted_at, and the webhook job compares against it. Where the
--   column is null it returns the credential's last save instead, which is what the job compared
--   against before this migration: an unstamped live connection keeps that behavior, and one with
--   no credential either has no grant time and is revoked by an uninstall.
--
-- Expand step of expand then contract: list_webhook_targets keeps returning credential_updated_at,
-- in the same position, so code deployed before this migration keeps reading it. The contract
-- migration (#502), once no deployed code reads that column, runs backfill_connection_granted_at
-- again (it fills connections the previous deployment made after the first backfill), then drops
-- the column and the credential fallback above. A reconnect made by the previous deployment between
-- the backfill and the promote keeps its backfilled time from before it and cannot be repaired
-- afterwards: nothing recorded tells that save from a token refresh. A late uninstall from between
-- its old grant and that reconnect then revokes it, and the user reconnects once more.
--
-- Members read granted_at with the rest of their connection row (connections_select, table-wide
-- select); nobody writes it through the Data API: authenticated keeps update (display_name,
-- last_sync_requested_at) and nothing else.

alter table public.connections add column granted_at timestamptz;

-- ── list_webhook_targets ────────────────────────────────────────────────────────
-- As in 20261115090200_webhook_delivery_review.sql, plus granted_at, the time the target's
-- connection was last granted, or its credential's last save where the connection has no grant
-- time, or null without either: an uninstall that happened before it is stale. A target is never
-- pending, so a null here is a live connection with no recorded grant and no credential.
-- credential_updated_at stays for code deployed before this migration; nothing in this branch
-- reads it. Dropped and created again because its result gains a column.

drop function public.list_webhook_targets(public.provider_id, text, uuid);

create function public.list_webhook_targets(
  p_provider public.provider_id,
  p_external_id text,
  p_endpoint_id uuid default null
)
  returns table (
    workspace_id uuid,
    connection_id uuid,
    account_id uuid,
    credential_updated_at timestamptz,
    granted_at timestamptz
  )
  language sql
  stable
  set search_path = ''
as $$
  select a.workspace_id, a.connection_id, a.id, cc.updated_at, coalesce(c.granted_at, cc.updated_at)
  from public.external_accounts a
  join public.connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
  left join public.connection_credentials cc on cc.workspace_id = c.workspace_id and cc.connection_id = c.id
  where a.external_id = p_external_id
    and a.included
    and c.provider = p_provider
    and c.status in ('active', 'failed', 'needs_attention')
    and (
      p_endpoint_id is null
      or exists (
        select 1 from public.webhook_endpoints e
        where e.id = p_endpoint_id and e.workspace_id = c.workspace_id and e.connection_id = c.id
      )
    )
  order by a.id
  limit 100;
$$;

revoke execute on function public.list_webhook_targets(public.provider_id, text, uuid) from public, anon, authenticated;
grant execute on function public.list_webhook_targets(public.provider_id, text, uuid) to service_role;
