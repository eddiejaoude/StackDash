-- The grant time fallback for the four-parameter list_webhook_targets (#476 review, carried to
-- #480). 20261116090000_connection_granted_at.sql returns the credential's last save as granted_at
-- for a live connection with no recorded grant (one the previous deployment made after the
-- backfill, or a row inserted as live), which is what the webhook job compared against before
-- granted_at existed. 20261116090200_webhook_uninstall_installation.sql replaced that function with
-- the four-parameter version and returned c.granted_at alone, so an unstamped live connection had a
-- null grant time and every uninstall revoked it, even a late one older than its last grant. A
-- follow-up migration, not an edit of 20261116090200, because that one is already applied.
--
-- Same parameters, result, rules, and grants as 20261116090200; only granted_at changes, on the
-- account and the installation match alike: coalesce(c.granted_at, cc.updated_at), so it is null
-- only for a live connection with neither a recorded grant nor a credential.

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
      select c.workspace_id, c.id, null::uuid, cc.updated_at, coalesce(c.granted_at, cc.updated_at)
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
end;
$$;

revoke execute on function public.list_webhook_targets(public.provider_id, text, uuid, text) from public, anon, authenticated;
grant execute on function public.list_webhook_targets(public.provider_id, text, uuid, text) to service_role;
