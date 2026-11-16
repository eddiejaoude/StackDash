-- When a connection was last granted (#476). A webhook uninstall (#28) is skipped for a connection
-- that was granted again after the removal, so a late or redelivered uninstall never revokes a live
-- reconnect. #28 compared against connection_credentials.updated_at, which a token refresh also
-- writes, so a real uninstall followed by a refresh was left to the next sync, which then failed
-- and asked for a reconnect: what polling alone already did.
--
-- - connections.granted_at: written by the app when a grant completes, on connect and on reconnect
--   (completeConnection in src/lib/connections/connect.ts), and never by a token refresh. Null for
--   a connection whose grant never completed (pending). Existing connections are backfilled in the
--   next migration, 20261116090100_connection_granted_at_backfill.sql.
-- - list_webhook_targets returns granted_at, and the webhook job compares against it.
--
-- Expand step of expand then contract: list_webhook_targets keeps returning credential_updated_at,
-- in the same position, so code deployed before this migration keeps reading it. A later migration
-- drops that column once no deployed code reads it.
--
-- Members read granted_at with the rest of their connection row (connections_select, table-wide
-- select); nobody writes it through the Data API: authenticated keeps update (display_name,
-- last_sync_requested_at) and nothing else.

alter table public.connections add column granted_at timestamptz;

-- ── list_webhook_targets ────────────────────────────────────────────────────────
-- As in 20261115090200_webhook_delivery_review.sql, plus granted_at, the time the target's
-- connection was last granted (null when its grant never completed): an uninstall that happened
-- before it is stale. credential_updated_at stays for code deployed before this migration; nothing
-- in this branch reads it. Dropped and created again because its result gains a column.

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
  select a.workspace_id, a.connection_id, a.id, cc.updated_at, c.granted_at
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
