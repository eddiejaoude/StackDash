-- Webhook setup panel (#426): how a connection's webhook was set up, a limit on webhook endpoints
-- per workspace, the last delivery for the panel, and the automatic setup choice through OAuth.
-- Expand only: every column is new and defaulted, so code that does not know them keeps working.
--
-- 1. webhook_endpoints.setup_mode: `manual` (the user added the webhook in the provider) or
--    `automatic` (StackDash created it through the provider's API and keeps provider_webhook_id to
--    delete it on disconnect). awaiting_provider_secret marks a manual endpoint whose provider
--    generates the signing secret, until the user pastes it: until then the endpoint holds a random
--    secret nobody knows, so every delivery to it is refused.
-- 2. webhook_endpoints_enforce_limit: at most 5 endpoints per workspace. Each endpoint may queue 50
--    deliveries a minute (WEBHOOK_ENDPOINT_DELIVERIES_PER_MINUTE) and the instance applies 50 a
--    minute (WEBHOOK_TICK_CLAIM_LIMIT, claim_webhook_jobs), oldest first across every workspace, so
--    the number of endpoints one workspace holds bounds how far it can push everyone else's
--    deliveries back. Five is one endpoint for each provider that needs a user-created webhook
--    (#424). src/lib/connections/webhook-copy.ts (WEBHOOK_ENDPOINTS_PER_WORKSPACE) holds the same
--    number for the panel's message.
-- 3. webhook_deliveries (endpoint_id, received_at desc): the panel's "last delivery" reads the
--    newest delivery of one endpoint from the index's first entry. It replaces the endpoint_id index,
--    which it covers for the endpoint delete cascade.
-- 4. oauth_states.webhook_setup: the user chose automatic setup, so the callback creates the
--    webhook once the grant with its write scopes is stored.

create type public.webhook_setup_mode as enum ('manual', 'automatic');

alter table public.webhook_endpoints
  add column setup_mode public.webhook_setup_mode not null default 'manual',
  add column provider_webhook_id text
    constraint webhook_endpoints_provider_webhook_id_length check (char_length(provider_webhook_id) between 1 and 200),
  add column awaiting_provider_secret boolean not null default false,
  add constraint webhook_endpoints_automatic_has_provider_webhook check ((setup_mode = 'automatic') = (provider_webhook_id is not null)),
  add constraint webhook_endpoints_awaiting_secret_is_manual check (not awaiting_provider_secret or setup_mode = 'manual');

-- ── webhook_endpoints_enforce_limit ─────────────────────────────────────────────
-- Refuses a sixth endpoint in a workspace. Two setups at once cannot both pass the count: locking
-- the workspace row serializes them, and FOR NO KEY UPDATE does not block the foreign key checks of
-- other inserts (as api_keys_enforce_limit, 20261105120320_api_keys.sql). The connection's own
-- endpoint is not counted, so an upsert that keeps it is never refused. The table is service role
-- only, so there is no member check before the lock.

create function public.webhook_endpoints_enforce_limit()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_others int;
begin
  perform 1 from public.workspaces w where w.id = new.workspace_id for no key update;
  select count(*) into v_others
  from public.webhook_endpoints e
  where e.workspace_id = new.workspace_id and e.connection_id <> new.connection_id;
  if v_others >= 5 then
    raise exception 'workspace % already has % webhook endpoints', new.workspace_id, v_others
      using errcode = 'program_limit_exceeded', hint = 'Disconnect a connection whose webhook is no longer needed.';
  end if;
  return new;
end;
$$;

revoke execute on function public.webhook_endpoints_enforce_limit() from public, anon, authenticated;

create trigger webhook_endpoints_enforce_limit
  before insert or update of workspace_id on public.webhook_endpoints
  for each row execute function public.webhook_endpoints_enforce_limit();

-- ── webhook_deliveries: newest delivery per endpoint ────────────────────────────

create index webhook_deliveries_endpoint_received_at_idx on public.webhook_deliveries (endpoint_id, received_at desc);
drop index public.webhook_deliveries_endpoint_id_idx;

-- ── oauth_states: automatic webhook setup chosen ────────────────────────────────

alter table public.oauth_states add column webhook_setup boolean not null default false;
