-- Read-only public REST API with scoped keys (#162). Grant model: see 20261031090000_tenancy.sql.
--
-- A key belongs to one workspace and carries one or more read scopes. The plaintext key
-- ("sd_" + 43 base64url characters) is shown once when it is created and never stored: the table
-- keeps its SHA-256 hex digest (token_hash, the lookup key) and a short display prefix. This follows
-- BackTalk's api_keys (its migration 0034): hash only, display prefix, revoke instead of delete,
-- last_used_at, and a key that stops working once the member who created it leaves the workspace.
--
-- Two surfaces, kept apart:
--   * Management (Settings, owners and admins, #104): the Data API as the signed-in user. Admins
--     read key metadata, never token_hash (column grants omit it), insert keys in their own name
--     (created_by defaults to auth.uid() and is not granted), and revoke them. A trigger makes a
--     revoke final.
--   * The API itself (/api/v1/*): the server calls the functions below with the service role and
--     the hash of the presented key. Every read function resolves the workspace from the key inside
--     the database, so a key can only ever read its own workspace, whatever the caller passes.
--     supabase/tests/database/13_api_keys.test.sql proves that per function.

create type public.api_key_scope as enum ('usage:read', 'events:read', 'alerts:read', 'connections:read');

-- ── api_keys ────────────────────────────────────────────────────────────────────

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null constraint api_keys_name_length check (char_length(btrim(name)) between 1 and 80),
  -- SHA-256 hex of the full key. Unique: the authentication lookup is an equality match on it.
  token_hash text not null
    constraint api_keys_token_hash_key unique
    constraint api_keys_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  -- "sd_" plus the first 8 characters of the secret part: enough to tell keys apart, useless to
  -- authenticate with.
  token_prefix text not null constraint api_keys_token_prefix_format check (token_prefix ~ '^sd_[A-Za-z0-9_-]{8}$'),
  -- At least one scope and no nulls. No upper bound: adding a value to api_key_scope must not make
  -- a key holding every scope invalid. Duplicates are harmless to `= any (scopes)`.
  scopes public.api_key_scope[] not null constraint api_keys_scopes_valid
    check (cardinality(scopes) >= 1 and array_position(scopes, null) is null),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  constraint api_keys_workspace_id_id_key unique (workspace_id, id)
);

-- Settings lists a workspace's keys newest first.
create index api_keys_workspace_created_at_idx on public.api_keys (workspace_id, created_at desc);
create index api_keys_created_by_idx on public.api_keys (created_by);
create index api_keys_revoked_by_idx on public.api_keys (revoked_by);

-- A revoke is final and is stamped by the database: revoked_at becomes now() whatever the caller
-- sent, revoked_by the signed-in user, and a revoked key can never be revived. Only fires when the
-- update names revoked_at, so the service role's last_used_at writes pass untouched.
create function public.api_keys_guard_revoke()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if old.revoked_at is not null then
    raise exception 'API key % is already revoked', old.id
      using errcode = 'check_violation', hint = 'Create a new key instead.';
  end if;
  if new.revoked_at is not null then
    new.revoked_at := now();
    new.revoked_by := coalesce(auth.uid(), new.revoked_by);
  end if;
  return new;
end;
$$;

revoke execute on function public.api_keys_guard_revoke() from public, anon, authenticated;

create trigger api_keys_guard_revoke
  before update of revoked_at on public.api_keys
  for each row execute function public.api_keys_guard_revoke();

-- A workspace holds at most 20 keys that are not revoked (MAX_ACTIVE_API_KEYS in
-- src/lib/data/api-keys.ts). Enforced here rather than in the server action so two admins creating
-- keys at once cannot both pass a count. Locking the workspace row serializes concurrent creates in
-- one workspace; FOR NO KEY UPDATE does not block the foreign key checks of other inserts. Runs as
-- definer so the count sees every key in the workspace whoever inserts. A signed-in caller who is not
-- an admin of the workspace is not counted at all: the row trigger runs before the insert policy, so
-- returning early lets row level security answer insufficient_privilege (42501) for them, as it does
-- for any other workspace, instead of the limit error and a lock on a workspace they cannot write.
-- The service role (no auth.uid()) is always counted. A key whose creator left still counts until
-- it is revoked, which is the next step settings gives for it.
create function public.api_keys_enforce_limit()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_active int;
begin
  if auth.uid() is not null and not public.has_workspace_role(new.workspace_id, 'admin') then
    return new;
  end if;
  perform 1 from public.workspaces w where w.id = new.workspace_id for no key update;
  select count(*) into v_active
  from public.api_keys k
  where k.workspace_id = new.workspace_id and k.revoked_at is null;
  if v_active >= 20 then
    raise exception 'workspace % already has % keys that are not revoked', new.workspace_id, v_active
      using errcode = 'program_limit_exceeded', hint = 'Revoke a key before creating another.';
  end if;
  return new;
end;
$$;

revoke execute on function public.api_keys_enforce_limit() from public, anon, authenticated;

create trigger api_keys_enforce_limit
  before insert on public.api_keys
  for each row execute function public.api_keys_enforce_limit();

-- ── api_key_request_windows (service role only) ─────────────────────────────────
-- Per key, per minute request counter for the fixed window rate limit. Kept in Postgres rather than
-- in memory so the limit holds across every server instance (BackTalk 0034 and 0035).

create table public.api_key_request_windows (
  key_id uuid not null references public.api_keys (id) on delete cascade,
  window_start timestamptz not null,
  request_count int not null default 0 constraint api_key_request_windows_count_nonnegative check (request_count >= 0),
  constraint api_key_request_windows_pkey primary key (key_id, window_start)
);

-- ── Row level security and grants ───────────────────────────────────────────────

alter table public.api_keys enable row level security;
alter table public.api_key_request_windows enable row level security;

revoke all on table public.api_keys, public.api_key_request_windows from anon, authenticated;

-- api_key_request_windows: RLS on, no policies, no grants. Service role only.

-- api_keys: owners and admins manage keys (#104). token_hash is writable on insert, so the server
-- can store the digest of the key it just generated, but never readable through the Data API.
grant select (
  id, workspace_id, name, token_prefix, scopes, created_by, created_at, last_used_at, revoked_at, revoked_by
) on table public.api_keys to authenticated;
grant insert (workspace_id, name, token_hash, token_prefix, scopes) on table public.api_keys to authenticated;
grant update (revoked_at) on table public.api_keys to authenticated;

create policy api_keys_select on public.api_keys for select to authenticated
  using (public.has_workspace_role(workspace_id, 'admin'));
create policy api_keys_insert on public.api_keys for insert to authenticated
  with check (public.has_workspace_role(workspace_id, 'admin'));
create policy api_keys_update on public.api_keys for update to authenticated
  using (public.has_workspace_role(workspace_id, 'admin'))
  with check (public.has_workspace_role(workspace_id, 'admin'));

-- ── Keyset pagination indexes for the API's project and connection lists ────────
-- Both lists page oldest first on (created_at, id) within a workspace; the connections page in the
-- app already reads in that order.

create index projects_workspace_created_at_idx on public.projects (workspace_id, created_at, id);
create index connections_workspace_created_at_idx on public.connections (workspace_id, created_at, id);

-- ── authenticate_api_key ────────────────────────────────────────────────────────
-- The one key check, used by every /api/v1 request (and by the MCP server, #163). Looks the key up
-- by hash and answers in one round trip:
--   * no row: no key has this hash.
--   * status 'revoked' or 'creator_left': the key exists but must not work. The caller answers
--     exactly as for an unknown key, and logs the status against a reference id.
--   * status 'valid': counts the request in this minute's window, returns the count, and refreshes
--     last_used_at at most once a minute so a busy key does not write on every request.

create function public.authenticate_api_key(p_token_hash text)
  returns table (
    status text,
    key_id uuid,
    workspace_id uuid,
    scopes public.api_key_scope[],
    request_count int,
    window_resets_at timestamptz
  )
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_key public.api_keys;
  v_window timestamptz := date_trunc('minute', now());
  v_count int;
begin
  select k.* into v_key from public.api_keys k where k.token_hash = p_token_hash;
  if not found then
    return;
  end if;

  if v_key.revoked_at is not null then
    return query select 'revoked'::text, v_key.id, v_key.workspace_id, v_key.scopes, 0, v_window + interval '1 minute';
    return;
  end if;

  if not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = v_key.workspace_id and m.user_id = v_key.created_by
  ) then
    return query select 'creator_left'::text, v_key.id, v_key.workspace_id, v_key.scopes, 0, v_window + interval '1 minute';
    return;
  end if;

  insert into public.api_key_request_windows as w (key_id, window_start, request_count)
  values (v_key.id, v_window, 1)
  -- Named constraint, not a column list: the output columns key_id and request_count are plpgsql
  -- variables here, and a bare column list would be ambiguous.
  on conflict on constraint api_key_request_windows_pkey do update set request_count = w.request_count + 1
  returning w.request_count into v_count;

  -- Past windows are never read again; dropping them here keeps the table at a few rows per key
  -- without a scheduled job. The delete walks the primary key.
  delete from public.api_key_request_windows w
  where w.key_id = v_key.id and w.window_start < v_window - interval '5 minutes';

  update public.api_keys k
  set last_used_at = now()
  where k.id = v_key.id and (k.last_used_at is null or k.last_used_at < now() - interval '1 minute');

  return query select 'valid'::text, v_key.id, v_key.workspace_id, v_key.scopes, v_count, v_window + interval '1 minute';
end;
$$;

revoke execute on function public.authenticate_api_key(text) from public, anon, authenticated;
grant execute on function public.authenticate_api_key(text) to service_role;

-- ── api_key_workspace ───────────────────────────────────────────────────────────
-- The workspace a working key may read with `p_scope` (null: any scope), or null. Every read
-- function below filters on it, so isolation and scope do not depend on the caller.

create function public.api_key_workspace(p_token_hash text, p_scope public.api_key_scope)
  returns uuid
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select k.workspace_id
  from public.api_keys k
  where k.token_hash = p_token_hash
    and k.revoked_at is null
    and (p_scope is null or p_scope = any (k.scopes))
    and exists (
      select 1 from public.workspace_members m
      where m.workspace_id = k.workspace_id and m.user_id = k.created_by
    )
$$;

revoke execute on function public.api_key_workspace(text, public.api_key_scope) from public, anon, authenticated;
grant execute on function public.api_key_workspace(text, public.api_key_scope) to service_role;

-- ── Read functions, one per endpoint ────────────────────────────────────────────
-- Each takes the key hash first; every filter defaults to null, meaning "no filter". Lists are
-- keyset paginated: the caller passes the last row's sort key and id from the previous page (left
-- out for the first page) and asks for one row more than it shows, to know whether another page
-- exists. p_limit is capped at 101 here as well.

create function public.api_workspaces(p_token_hash text)
  returns table (id uuid, slug text, name text, is_personal boolean, created_at timestamptz)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select w.id, w.slug, w.name, w.is_personal, w.created_at
  from public.workspaces w
  where w.id = public.api_key_workspace(p_token_hash, null)
$$;

create function public.api_projects(
  p_token_hash text,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_limit int default 51
)
  returns table (id uuid, name text, created_at timestamptz)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select p.id, p.name, p.created_at
  from public.projects p
  where p.workspace_id = public.api_key_workspace(p_token_hash, null)
    and (p_after_created_at is null or (p.created_at, p.id) > (p_after_created_at, p_after_id))
  order by p.created_at, p.id
  limit least(greatest(p_limit, 1), 101)
$$;

-- Status only: never credentials, OAuth state, error references, or the sync schedule. granted_scopes
-- is returned so the server can tell a simulated connection (#131) apart; it is not sent to clients.
create function public.api_connections(
  p_token_hash text,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_limit int default 51
)
  returns table (
    id uuid,
    provider public.provider_id,
    display_name text,
    authorized_account_label text,
    status public.connection_status,
    last_synced_at timestamptz,
    granted_scopes text[],
    created_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select c.id, c.provider, c.display_name, c.authorized_account_label, c.status, c.last_synced_at,
    c.granted_scopes, c.created_at
  from public.connections c
  where c.workspace_id = public.api_key_workspace(p_token_hash, 'connections:read')
    and (p_after_created_at is null or (c.created_at, c.id) > (p_after_created_at, p_after_id))
  order by c.created_at, c.id
  limit least(greatest(p_limit, 1), 101)
$$;

-- Newest UTC day first, through usage_snapshots_workspace_date_idx.
create function public.api_usage_snapshots(
  p_token_hash text,
  p_from date default null,
  p_to date default null,
  p_metric_key text default null,
  p_kind public.metric_kind default null,
  p_provider public.provider_id default null,
  p_connection_id uuid default null,
  p_project_id uuid default null,
  p_after_date date default null,
  p_after_id uuid default null,
  p_limit int default 51
)
  returns table (
    id uuid,
    connection_id uuid,
    provider public.provider_id,
    granted_scopes text[],
    external_account_id uuid,
    account_name text,
    project_id uuid,
    metric_key text,
    kind public.metric_kind,
    label text,
    snapshot_date date,
    value double precision,
    unit text,
    amount_minor bigint,
    currency char(3),
    period_start timestamptz,
    period_end timestamptz,
    point_at timestamptz,
    resets_at timestamptz,
    retrieved_at timestamptz,
    provenance_source text,
    pricing_source text
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select s.id, s.connection_id, c.provider, c.granted_scopes, s.external_account_id, a.display_name,
    a.project_id, s.metric_key, s.kind, s.label, s.snapshot_date, s.value, s.unit, s.amount_minor,
    s.currency, s.period_start, s.period_end, s.point_at, s.resets_at, s.retrieved_at,
    s.provenance_source, s.pricing_source
  from public.usage_snapshots s
  join public.connections c on c.workspace_id = s.workspace_id and c.id = s.connection_id
  join public.external_accounts a on a.workspace_id = s.workspace_id and a.id = s.external_account_id
  where s.workspace_id = public.api_key_workspace(p_token_hash, 'usage:read')
    and (p_from is null or s.snapshot_date >= p_from)
    and (p_to is null or s.snapshot_date <= p_to)
    and (p_metric_key is null or s.metric_key = p_metric_key)
    and (p_kind is null or s.kind = p_kind)
    and (p_provider is null or c.provider = p_provider)
    and (p_connection_id is null or s.connection_id = p_connection_id)
    and (p_project_id is null or a.project_id = p_project_id)
    and (p_after_date is null or (s.snapshot_date, s.id) < (p_after_date, p_after_id))
  order by s.snapshot_date desc, s.id desc
  limit least(greatest(p_limit, 1), 101)
$$;

-- Newest first, through activity_events_workspace_timeline_idx, the timeline's own order.
create function public.api_activity_events(
  p_token_hash text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_type_id text default null,
  p_severity public.event_severity default null,
  p_provider public.provider_id default null,
  p_after_occurred_at timestamptz default null,
  p_after_id uuid default null,
  p_limit int default 51
)
  returns table (
    id uuid,
    type_id text,
    severity public.event_severity,
    title text,
    body text,
    url text,
    occurred_at timestamptz,
    provider public.provider_id,
    connection_id uuid,
    granted_scopes text[],
    external_account_id uuid,
    account_name text
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select e.id, e.type_id, e.severity, e.title, e.body, e.url, e.occurred_at, e.provider,
    e.connection_id, coalesce(c.granted_scopes, '{}'), e.external_account_id, a.display_name
  from public.activity_events e
  left join public.connections c on c.workspace_id = e.workspace_id and c.id = e.connection_id
  left join public.external_accounts a on a.workspace_id = e.workspace_id and a.id = e.external_account_id
  where e.workspace_id = public.api_key_workspace(p_token_hash, 'events:read')
    and (p_from is null or e.occurred_at >= p_from)
    and (p_to is null or e.occurred_at < p_to)
    and (p_type_id is null or e.type_id = p_type_id)
    and (p_severity is null or e.severity = p_severity)
    and (p_provider is null or e.provider = p_provider)
    and (p_after_occurred_at is null or (e.occurred_at, e.id) < (p_after_occurred_at, p_after_id))
  order by e.occurred_at desc, e.id desc
  limit least(greatest(p_limit, 1), 101)
$$;

-- Newest first, through triggered_alerts_workspace_triggered_at_idx. threshold_percent is the
-- rule's, so the server derives the same severity the alerts page shows.
create function public.api_triggered_alerts(
  p_token_hash text,
  p_acknowledged boolean default null,
  p_after_triggered_at timestamptz default null,
  p_after_id uuid default null,
  p_limit int default 51
)
  returns table (
    id uuid,
    rule_id uuid,
    cycle_key text,
    triggered_at timestamptz,
    observed_value double precision,
    observed_amount_minor bigint,
    currency char(3),
    threshold_label text,
    threshold_percent int,
    is_estimated boolean,
    message text,
    acknowledged_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select t.id, t.rule_id, t.cycle_key, t.triggered_at, t.observed_value, t.observed_amount_minor,
    t.currency, t.threshold_label, r.threshold_percent, t.is_estimated, t.message, t.acknowledged_at
  from public.triggered_alerts t
  join public.alert_rules r on r.workspace_id = t.workspace_id and r.id = t.rule_id
  where t.workspace_id = public.api_key_workspace(p_token_hash, 'alerts:read')
    and (p_acknowledged is null or (t.acknowledged_at is not null) = p_acknowledged)
    and (p_after_triggered_at is null or (t.triggered_at, t.id) < (p_after_triggered_at, p_after_id))
  order by t.triggered_at desc, t.id desc
  limit least(greatest(p_limit, 1), 101)
$$;

revoke execute on function public.api_workspaces(text) from public, anon, authenticated;
revoke execute on function public.api_projects(text, timestamptz, uuid, int) from public, anon, authenticated;
revoke execute on function public.api_connections(text, timestamptz, uuid, int) from public, anon, authenticated;
revoke execute on function public.api_usage_snapshots(
  text, date, date, text, public.metric_kind, public.provider_id, uuid, uuid, date, uuid, int
) from public, anon, authenticated;
revoke execute on function public.api_activity_events(
  text, timestamptz, timestamptz, text, public.event_severity, public.provider_id, timestamptz, uuid, int
) from public, anon, authenticated;
revoke execute on function public.api_triggered_alerts(text, boolean, timestamptz, uuid, int)
  from public, anon, authenticated;

grant execute on function public.api_workspaces(text) to service_role;
grant execute on function public.api_projects(text, timestamptz, uuid, int) to service_role;
grant execute on function public.api_connections(text, timestamptz, uuid, int) to service_role;
grant execute on function public.api_usage_snapshots(
  text, date, date, text, public.metric_kind, public.provider_id, uuid, uuid, date, uuid, int
) to service_role;
grant execute on function public.api_activity_events(
  text, timestamptz, timestamptz, text, public.event_severity, public.provider_id, timestamptz, uuid, int
) to service_role;
grant execute on function public.api_triggered_alerts(text, boolean, timestamptz, uuid, int) to service_role;
