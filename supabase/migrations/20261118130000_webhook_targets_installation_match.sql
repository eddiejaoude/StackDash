-- Sentry issue deliveries matched on the installation as well as the project (#497).
-- A Sentry project outlives an uninstall: installation.deleted leaves a connection needs_attention
-- with its projects still included, so when the same organization installs StackDash again, for
-- another workspace or the same one, the project's issue deliveries from the new installation
-- reached the old connection too. The delivery names its installation (installation.uuid), and
-- the webhook job now passes it with the project, so only connections of that installation match.
--
-- Expand only: the parameters, the result, and the grants of
-- 20261118090000_contract_webhook_targets.sql are unchanged. A call naming one of p_external_id
-- and p_installation_id, which is every call the code before #497 makes, returns what it returned
-- before. Naming both, which that function refused, now narrows the account match.

-- ── list_webhook_targets ────────────────────────────────────────────────────────
-- p_external_id, p_installation_id, or both name what the delivery is about.
-- - p_external_id: each included external account with that external id, ordered by account id.
-- - p_installation_id: each connection with that external_installation_id, one row per connection
--   and account_id null (an uninstall acts on connections, and a connection may have no included
--   account), ordered by connection id.
-- - both: the p_external_id match, kept to connections whose external_installation_id is
--   p_installation_id (#497). A connection with no recorded installation is no match: nothing
--   says it belongs to the installation that sent the delivery, and its next sync records one
--   (installationIdOf, src/lib/adapters/types.ts) while polling still brings it its events.
-- All only on connections of p_provider that are active, failed, or needs_attention, only on the
-- endpoint's own connection when p_endpoint_id is set, and bounded at 100.
-- Each row carries:
-- - granted_at: connections.granted_at, when the connection was last granted (a connect or a
--   reconnect, never a token refresh). Null for a live connection with no recorded grant;
--   20261118090000_contract_webhook_targets.sql names the two kinds and the remedy.
-- Security invoker: only the service role may call it, and it already reads every row it needs.

create or replace function public.list_webhook_targets(
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
  if p_external_id is null and p_installation_id is null then
    raise exception 'p_external_id or p_installation_id is required' using errcode = 'invalid_parameter_value';
  end if;

  if p_external_id is null then
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

-- create or replace keeps the grants; stated again so this file reads whole.
revoke execute on function public.list_webhook_targets(public.provider_id, text, uuid, text) from public, anon, authenticated;
grant execute on function public.list_webhook_targets(public.provider_id, text, uuid, text) to service_role;
