-- Whether each webhook target is a simulated connection (#495).
-- Since #479 a simulated provider keeps its live adapter's webhooks, and an app-level delivery to it
-- is checked with STACKDASH_SIMULATED_WEBHOOK_SECRET, a value from the developer's .env.local or
-- the synthetic constant e2e signs with (e2e/fixtures/simulated-webhook.ts). The webhook job
-- applied a delivery to every target this function returned, so with provider simulation on, a
-- delivery signed with that secret reached a real connection that includes the same account. Each
-- row now says whether its connection is simulated, and the job keeps only the targets of the
-- kind its adapter verifies: simulated ones while the provider is simulated, real ones otherwise
-- (runWebhookJob, src/lib/jobs/webhook-delivery.ts).
--
-- Expand only: the parameters, the grants, the matching, the order, the bound, and the first four
-- result columns are those of 20261118130000_webhook_targets_installation_match.sql; the result
-- gains `simulated` as its last column. Adding a result column changes the return type, which
-- create or replace refuses, so the function is dropped and created again in this migration's one
-- transaction, as 20261118090000_contract_webhook_targets.sql did. Two mixed windows:
-- 1. The build before #495 against this function: its store reads workspace_id, connection_id,
--    account_id, and granted_at by name from each returned row and ignores the rest, and its calls
--    (named p_provider, p_external_id, p_installation_id, p_endpoint_id) resolve as before, so it
--    behaves exactly as it did.
-- 2. The build from #495 against the function before this one (promoted before
--    `supabase migration up` ran): rows carry no `simulated`, and the store reads a target the
--    database does not mark simulated as real. With simulation off, which a production deployment
--    always is (isProviderSimulationEnabled refuses it there), every target is kept, as before.
--    With simulation on, a local or e2e instance, deliveries reach no simulated connection until
--    the migration runs, and polling brings the same events meanwhile.

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
-- - simulated: whether the provider simulator made the connection, from its granted_scopes holding
--   'simulated:read' (SIMULATED_SCOPE, src/lib/adapters/simulated/marker.ts, the marker
--   isSimulatedConnection reads). A property of the connection recorded when it is granted, never
--   of the process flag. The bound applies before the job keeps one kind, so targets of the other
--   kind count toward it; a target of the kept kind past the bound gets its events from polling,
--   as any target past it does.
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
    simulated boolean
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
      select c.workspace_id, c.id, null::uuid, c.granted_at, c.granted_scopes @> array['simulated:read']
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
    select a.workspace_id, a.connection_id, a.id, c.granted_at, c.granted_scopes @> array['simulated:read']
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
