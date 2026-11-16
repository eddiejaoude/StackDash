-- A webhook uninstall that names an installation instead of an account (#480). Sentry's
-- `installation.deleted` delivery names only `installation.uuid`, and Sentry's accounts are projects,
-- so matching on external_accounts.external_id cannot find its connections.
--
-- - connections.external_installation_id (20261031090100_integrations.sql, unused until now) holds
--   the installation a connection's credential belongs to. The app writes it when a grant completes
--   (completeConnection asks the adapter, `installationIdOf`) and fills it on the next sync of a
--   connection made before this change: it lives in the sealed credential metadata, which SQL cannot
--   read, so there is no backfill here.
--   Members now read the installation id with the rest of their connection row (connections_select,
--   table-wide select, and every Realtime payload of the row): an identifier, not a credential, so
--   it is no more sensitive than the account ids members already see. Nobody writes it through the
--   Data API: authenticated keeps update (display_name, last_sync_requested_at) and nothing else,
--   which matters here because the column decides which connections an app-level uninstall marks.
-- - connections_provider_installation_idx serves the new lookup.
-- - record_webhook_delivery checks that an `uninstalled` outcome names an account
--   (`externalAccountId`, with `by` absent or `account`) or an installation (`by` = `installation`
--   and `installationId`). The account form without `by` is the shape code deployed before this
--   migration sends, so it is still accepted.
-- - list_webhook_targets gains p_installation_id. Given instead of p_external_id, it returns every
--   connection of the provider with that installation, by the same status and endpoint rules, with
--   no account. p_external_id now defaults to null, so code deployed before this migration, which
--   names p_provider, p_external_id, and optionally p_endpoint_id, keeps calling it unchanged.
--
-- Expand only: nothing is renamed or dropped. credential_updated_at stays in the result until the
-- contract step of #476.

create index connections_provider_installation_idx on public.connections (provider, external_installation_id)
  where external_installation_id is not null;

-- ── record_webhook_delivery ─────────────────────────────────────────────────────
-- As in 20261115090300_webhook_claim_allowance.sql, plus the uninstall shape check: an uninstall
-- that names neither a non-empty account id nor a non-empty installation id is refused, because its
-- job could match nothing and would fail every attempt.

create or replace function public.record_webhook_delivery(
  p_provider public.provider_id,
  p_delivery_id text,
  p_outcome jsonb,
  p_endpoint_id uuid default null
)
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_id uuid;
  v_ignored boolean;
begin
  if p_provider is null or p_outcome is null then
    raise exception 'p_provider and p_outcome are required' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(p_outcome ->> 'kind', '') not in ('events', 'uninstalled', 'ignored') then
    raise exception 'p_outcome kind must be events, uninstalled, or ignored' using errcode = 'invalid_parameter_value';
  end if;
  -- coalesce: a missing key makes its comparison null, which must refuse, not pass.
  if p_outcome ->> 'kind' = 'uninstalled' and not coalesce(
    (
      coalesce(p_outcome -> 'by', '"account"'::jsonb) = '"account"'::jsonb
      and jsonb_typeof(p_outcome -> 'externalAccountId') = 'string'
      and p_outcome ->> 'externalAccountId' <> ''
    )
    or (
      p_outcome -> 'by' = '"installation"'::jsonb
      and jsonb_typeof(p_outcome -> 'installationId') = 'string'
      and p_outcome ->> 'installationId' <> ''
    ),
    false
  ) then
    raise exception 'an uninstalled p_outcome must name an account or an installation' using errcode = 'invalid_parameter_value';
  end if;
  if p_endpoint_id is not null and not exists (
    select 1 from public.webhook_endpoints e where e.id = p_endpoint_id and e.provider = p_provider
  ) then
    raise exception 'p_endpoint_id must name an endpoint of p_provider' using errcode = 'invalid_parameter_value';
  end if;

  v_ignored := p_outcome ->> 'kind' = 'ignored';

  insert into public.webhook_deliveries (provider, delivery_id, endpoint_id, status, outcome, processed_at)
  values (
    p_provider,
    p_delivery_id,
    p_endpoint_id,
    case when v_ignored then 'processed' else 'received' end::public.webhook_delivery_status,
    case when v_ignored then null else p_outcome end,
    case when v_ignored then now() end
  )
  on conflict (provider, endpoint_id, delivery_id) do nothing
  returning id into v_id;

  if v_id is null then
    return false;
  end if;

  if not v_ignored then
    insert into public.sync_jobs (kind, webhook_delivery_id) values ('webhook', v_id);
  end if;
  return true;
end;
$$;

revoke execute on function public.record_webhook_delivery(public.provider_id, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.record_webhook_delivery(public.provider_id, text, jsonb, uuid) to service_role;

-- ── list_webhook_targets ────────────────────────────────────────────────────────
-- Exactly one of p_external_id and p_installation_id names what the delivery is about.
-- - p_external_id: each included external account with that external id, ordered by account id,
--   as in 20261116090000_connection_granted_at.sql except for granted_at (below).
-- - p_installation_id: each connection with that external_installation_id, one row per connection
--   and account_id null (an uninstall acts on connections, and a connection may have no included
--   account), ordered by connection id.
-- Both only on connections of p_provider that are active, failed, or needs_attention, only on the
-- endpoint's own connection when p_endpoint_id is set, bounded at 100, with credential_updated_at
-- and granted_at. granted_at is the column alone here;
-- 20261116090300_webhook_targets_grant_fallback.sql restores the credential fallback of
-- 20261116090000. Security invoker: only the service role may call it, and it already reads every
-- row it needs. Dropped and created again because its parameters change; a second overload beside
-- the old one would make a call naming only the first three parameters ambiguous.

drop function public.list_webhook_targets(public.provider_id, text, uuid);

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
    credential_updated_at timestamptz,
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
      select c.workspace_id, c.id, null::uuid, cc.updated_at, c.granted_at
      from public.connections c
      left join public.connection_credentials cc on cc.workspace_id = c.workspace_id and cc.connection_id = c.id
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
end;
$$;

revoke execute on function public.list_webhook_targets(public.provider_id, text, uuid, text) from public, anon, authenticated;
grant execute on function public.list_webhook_targets(public.provider_id, text, uuid, text) to service_role;
