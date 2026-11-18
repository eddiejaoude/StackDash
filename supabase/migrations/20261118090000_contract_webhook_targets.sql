-- Contract step of #476's expand then contract for list_webhook_targets (#502).
-- 20261116090000_connection_granted_at.sql added connections.granted_at and kept two things for the
-- deployment before it: credential_updated_at in the result of list_webhook_targets, and the
-- credential's last save as granted_at for a live connection with no recorded grant
-- (20261116090300_webhook_targets_grant_fallback.sql on the four-parameter function). That fallback
-- keeps the comparison #476 replaced: a token refresh after a removal hides the uninstall.
--
-- Precondition, confirmed before this migration ships: the deployment that writes granted_at
-- (completeConnection, src/lib/connections/connect.ts) is promoted everywhere, and no deployed code
-- reads credential_updated_at (src/lib/jobs/store.ts stopped in #476). From then on every grant is
-- stamped as it completes, so the only connections without a grant time are the ones below.
--
-- In this order, in this migration's one transaction:
-- 1. backfill_connection_granted_at again, until it fills nothing. It fills every non-pending
--    connection the previous deployment made after the first backfill
--    (20261116090100_connection_granted_at_backfill.sql), from its credential's last save, else
--    created_at, and never overwrites a recorded grant (the guard of
--    20261116090400_backfill_granted_at_guard.sql). A reconnect the previous deployment made in that
--    window keeps its earlier backfilled time; nothing recorded tells that save from a token refresh
--    (20261116090000 explains the cost).
-- 2. list_webhook_targets without credential_updated_at, and with granted_at the column alone.
--
-- After this, a live connection with no grant time is one inserted as live after the migrations
-- ran (supabase/seed.sql and test fixtures set granted_at for that reason): every uninstall
-- revokes it, because nothing is known to be newer than the removal.

do $$
begin
  while public.backfill_connection_granted_at(1000) > 0 loop
  end loop;
end;
$$;

-- ── list_webhook_targets ────────────────────────────────────────────────────────
-- Exactly one of p_external_id and p_installation_id names what the delivery is about.
-- - p_external_id: each included external account with that external id, ordered by account id.
-- - p_installation_id: each connection with that external_installation_id, one row per connection
--   and account_id null (an uninstall acts on connections, and a connection may have no included
--   account), ordered by connection id.
-- Both only on connections of p_provider that are active, failed, or needs_attention, only on the
-- endpoint's own connection when p_endpoint_id is set, and bounded at 100.
-- Each row carries:
-- - granted_at: connections.granted_at, when the connection was last granted (a connect or a
--   reconnect, never a token refresh). Null only for a live connection inserted without one.
-- Security invoker: only the service role may call it, and it already reads every row it needs.
-- Same parameters and grants as 20261116090300_webhook_targets_grant_fallback.sql; dropped and
-- created again because its result loses credential_updated_at.

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
    granted_at timestamptz
  )
  language plpgsql
  stable
  set search_path = ''
as $$
begin
  if (p_external_id is null) = (p_installation_id is null) then
    raise exception 'exactly one of p_external_id and p_installation_id is required' using errcode = 'invalid_parameter_value';
  end if;

  if p_installation_id is not null then
    return query
      select c.workspace_id, c.id, null::uuid, c.granted_at
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
    select a.workspace_id, a.connection_id, a.id, c.granted_at
    from public.external_accounts a
    join public.connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
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
end;
$$;

revoke execute on function public.list_webhook_targets(public.provider_id, text, uuid, text) from public, anon, authenticated;
grant execute on function public.list_webhook_targets(public.provider_id, text, uuid, text) to service_role;
