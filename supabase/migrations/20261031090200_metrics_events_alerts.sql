-- Metrics, activity, budgets, and alerts (#27, #33, #39, #53). Grant model: see
-- 20261031090000_tenancy.sql. Money is integer minor units plus an ISO 4217 code; nothing here
-- sums across currencies.

create type public.metric_kind as enum (
  'verified_spend', 'estimated_spend', 'included_allowance', 'remaining_allowance',
  'usage', 'credit_balance', 'revenue'
);
create type public.event_severity as enum ('info', 'success', 'warning', 'critical');
create type public.alert_rule_kind as enum ('allowance_percent', 'spend_amount', 'budget_percent');
create type public.alert_scope as enum ('workspace', 'provider', 'project', 'connection');

-- ── usage_snapshots ─────────────────────────────────────────────────────────────
-- One row per external account, metric, and UTC day. Each sync upserts today's row, so the latest
-- row per (external_account_id, metric_key) is the current value and older rows are the history.
-- Checks mirror the adapter metric model in src/lib/adapters/metrics.ts.

create table public.usage_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null,
  external_account_id uuid not null,
  metric_key text not null constraint usage_snapshots_metric_key_format
    check (metric_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  kind public.metric_kind not null,
  label text not null,
  snapshot_date date not null,
  value double precision,
  unit text,
  amount_minor bigint,
  currency char(3) constraint usage_snapshots_currency_format check (currency ~ '^[A-Z]{3}$'),
  period_start timestamptz,
  period_end timestamptz,
  point_at timestamptz,
  resets_at timestamptz,
  retrieved_at timestamptz not null,
  provenance_source text not null constraint usage_snapshots_provenance_source
    check (provenance_source in ('provider_api', 'derived')),
  provenance_endpoint text,
  pricing_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Ascending btree; an equality match on the first two columns scans it backwards for the
  -- "latest per metric" query (snapshot_date desc), so no second descending index is needed.
  constraint usage_snapshots_account_metric_date_key unique (external_account_id, metric_key, snapshot_date),
  constraint usage_snapshots_connection_fkey foreign key (workspace_id, connection_id)
    references public.connections (workspace_id, id) on delete cascade,
  constraint usage_snapshots_external_account_fkey foreign key (workspace_id, external_account_id)
    references public.external_accounts (workspace_id, id) on delete cascade,
  constraint usage_snapshots_value_shape check (
    case
      when kind in ('verified_spend', 'estimated_spend', 'credit_balance', 'revenue') then
        amount_minor is not null and currency is not null and value is null and unit is null
      else
        value is not null and unit is not null and amount_minor is null and currency is null
    end
  ),
  -- Spend is never negative; revenue and credit balance may be (refunds, money owed).
  constraint usage_snapshots_spend_nonnegative check (
    kind not in ('verified_spend', 'estimated_spend') or amount_minor >= 0
  ),
  constraint usage_snapshots_value_finite check (
    value is null or (value >= 0 and value < 'Infinity'::double precision)
  ),
  -- An estimate is calculated by StackDash and must name its price list.
  constraint usage_snapshots_estimate_provenance check (
    kind <> 'estimated_spend' or (pricing_source is not null and provenance_source = 'derived')
  ),
  -- Exactly one timeframe: a period with end after start, or a point in time.
  constraint usage_snapshots_timeframe check (
    (period_start is not null and period_end is not null and period_end > period_start and point_at is null)
    or (point_at is not null and period_start is null and period_end is null)
  )
);

create index usage_snapshots_workspace_date_idx on public.usage_snapshots (workspace_id, snapshot_date desc);
create index usage_snapshots_connection_id_idx on public.usage_snapshots (connection_id);
-- Retention deletes rows older than 13 months across all workspaces (#37).
create index usage_snapshots_snapshot_date_idx on public.usage_snapshots (snapshot_date);

create trigger usage_snapshots_set_updated_at before update on public.usage_snapshots
  for each row execute function public.set_updated_at();

-- ── activity_events ─────────────────────────────────────────────────────────────
-- Events StackDash generates itself (stackdash.daily_summary, stackdash.alert_triggered,
-- stackdash.sync_failed, stackdash.allowance_reset) have provider null.

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid,
  external_account_id uuid,
  provider public.provider_id,
  type_id text not null constraint activity_events_type_id_format
    check (type_id ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  severity public.event_severity not null,
  title text not null,
  body text,
  url text constraint activity_events_url_https check (url is null or url like 'https://%'),
  occurred_at timestamptz not null,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  constraint activity_events_workspace_dedupe_key unique (workspace_id, dedupe_key),
  constraint activity_events_connection_fkey foreign key (workspace_id, connection_id)
    references public.connections (workspace_id, id) on delete cascade,
  constraint activity_events_external_account_fkey foreign key (workspace_id, external_account_id)
    references public.external_accounts (workspace_id, id) on delete set null (external_account_id)
);

-- Timeline keyset pagination: (occurred_at, id) < (cursor) order by occurred_at desc, id desc.
create index activity_events_workspace_timeline_idx on public.activity_events (workspace_id, occurred_at desc, id desc);
create index activity_events_connection_id_idx on public.activity_events (connection_id);
create index activity_events_external_account_id_idx on public.activity_events (external_account_id);
-- Retention deletes rows older than 13 months across all workspaces (#37).
create index activity_events_occurred_at_idx on public.activity_events (occurred_at);

-- ── budgets ─────────────────────────────────────────────────────────────────────

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null constraint budgets_name_length check (char_length(btrim(name)) between 1 and 80),
  scope public.alert_scope not null,
  provider public.provider_id,
  project_id uuid,
  connection_id uuid,
  amount_minor bigint not null constraint budgets_amount_positive check (amount_minor > 0),
  currency char(3) not null constraint budgets_currency_format check (currency ~ '^[A-Z]{3}$'),
  period text not null default 'month' constraint budgets_period_month check (period = 'month'),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budgets_workspace_id_id_key unique (workspace_id, id),
  constraint budgets_project_fkey foreign key (workspace_id, project_id)
    references public.projects (workspace_id, id) on delete cascade,
  constraint budgets_connection_fkey foreign key (workspace_id, connection_id)
    references public.connections (workspace_id, id) on delete cascade,
  constraint budgets_scope_target check (
    case scope
      when 'workspace' then provider is null and project_id is null and connection_id is null
      when 'provider' then provider is not null and project_id is null and connection_id is null
      when 'project' then provider is null and project_id is not null and connection_id is null
      when 'connection' then provider is null and project_id is null and connection_id is not null
    end
  )
);

create index budgets_workspace_project_idx on public.budgets (workspace_id, project_id);
create index budgets_workspace_connection_idx on public.budgets (workspace_id, connection_id);
create index budgets_created_by_idx on public.budgets (created_by);
create index budgets_updated_by_idx on public.budgets (updated_by);

create trigger budgets_set_updated_at before update on public.budgets
  for each row execute function public.set_updated_at();
create trigger budgets_set_updated_by before update on public.budgets
  for each row execute function public.set_updated_by();

-- ── alert_rules ─────────────────────────────────────────────────────────────────

create table public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind public.alert_rule_kind not null,
  scope public.alert_scope not null,
  provider public.provider_id,
  project_id uuid,
  connection_id uuid,
  metric_key text constraint alert_rules_metric_key_format
    check (metric_key is null or metric_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  budget_id uuid,
  threshold_percent int constraint alert_rules_threshold_percent_range check (threshold_percent between 1 and 1000),
  threshold_amount_minor bigint constraint alert_rules_threshold_amount_positive check (threshold_amount_minor > 0),
  currency char(3) constraint alert_rules_currency_format check (currency ~ '^[A-Z]{3}$'),
  paused boolean not null default false,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alert_rules_workspace_id_id_key unique (workspace_id, id),
  constraint alert_rules_project_fkey foreign key (workspace_id, project_id)
    references public.projects (workspace_id, id) on delete cascade,
  constraint alert_rules_connection_fkey foreign key (workspace_id, connection_id)
    references public.connections (workspace_id, id) on delete cascade,
  constraint alert_rules_budget_fkey foreign key (workspace_id, budget_id)
    references public.budgets (workspace_id, id) on delete cascade,
  constraint alert_rules_scope_target check (
    case scope
      when 'workspace' then provider is null and project_id is null and connection_id is null
      when 'provider' then provider is not null and project_id is null and connection_id is null
      when 'project' then provider is null and project_id is not null and connection_id is null
      when 'connection' then provider is null and project_id is null and connection_id is not null
    end
  ),
  constraint alert_rules_kind_thresholds check (
    case kind
      when 'allowance_percent' then
        threshold_percent is not null and threshold_amount_minor is null and currency is null and budget_id is null
      when 'budget_percent' then
        threshold_percent is not null and budget_id is not null and threshold_amount_minor is null and currency is null
      when 'spend_amount' then
        threshold_amount_minor is not null and currency is not null and threshold_percent is null and budget_id is null
    end
  )
);

create index alert_rules_workspace_project_idx on public.alert_rules (workspace_id, project_id);
create index alert_rules_workspace_connection_idx on public.alert_rules (workspace_id, connection_id);
create index alert_rules_workspace_budget_idx on public.alert_rules (workspace_id, budget_id);
create index alert_rules_created_by_idx on public.alert_rules (created_by);
create index alert_rules_updated_by_idx on public.alert_rules (updated_by);

create trigger alert_rules_set_updated_at before update on public.alert_rules
  for each row execute function public.set_updated_at();
create trigger alert_rules_set_updated_by before update on public.alert_rules
  for each row execute function public.set_updated_by();

-- ── triggered_alerts ────────────────────────────────────────────────────────────
-- One row per rule per billing cycle (cycle_key = period start as an ISO date), so a rule fires at
-- most once per cycle. Kept while the rule exists (#37).

create table public.triggered_alerts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rule_id uuid not null,
  cycle_key text not null,
  triggered_at timestamptz not null default now(),
  observed_value double precision,
  observed_amount_minor bigint,
  currency char(3) constraint triggered_alerts_currency_format check (currency ~ '^[A-Z]{3}$'),
  threshold_label text not null,
  is_estimated boolean not null,
  message text not null,
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users (id) on delete set null,
  constraint triggered_alerts_rule_cycle_key unique (rule_id, cycle_key),
  constraint triggered_alerts_rule_fkey foreign key (workspace_id, rule_id)
    references public.alert_rules (workspace_id, id) on delete cascade,
  constraint triggered_alerts_money_pair check ((observed_amount_minor is null) = (currency is null))
);

create index triggered_alerts_workspace_triggered_at_idx on public.triggered_alerts (workspace_id, triggered_at desc);
create index triggered_alerts_acknowledged_by_idx on public.triggered_alerts (acknowledged_by);

-- ── Row level security and grants ───────────────────────────────────────────────

alter table public.usage_snapshots enable row level security;
alter table public.activity_events enable row level security;
alter table public.budgets enable row level security;
alter table public.alert_rules enable row level security;
alter table public.triggered_alerts enable row level security;

revoke all on table
  public.usage_snapshots, public.activity_events, public.budgets,
  public.alert_rules, public.triggered_alerts
from anon, authenticated;

-- Server-written history: members read, only the service role writes.
grant select on table public.usage_snapshots, public.activity_events to authenticated;

create policy usage_snapshots_select on public.usage_snapshots for select to authenticated
  using (public.has_workspace_role(workspace_id, 'viewer'));
create policy activity_events_select on public.activity_events for select to authenticated
  using (public.has_workspace_role(workspace_id, 'viewer'));

-- Configuration: read as viewer, write as admin. created_by/updated_by are never granted; they
-- default to auth.uid() and the updated_by trigger keeps them honest.
grant select, delete on table public.budgets, public.alert_rules to authenticated;
grant insert (workspace_id, name, scope, provider, project_id, connection_id, amount_minor, currency)
  on table public.budgets to authenticated;
grant update (name, scope, provider, project_id, connection_id, amount_minor, currency)
  on table public.budgets to authenticated;
grant insert (
  workspace_id, kind, scope, provider, project_id, connection_id, metric_key, budget_id,
  threshold_percent, threshold_amount_minor, currency, paused
) on table public.alert_rules to authenticated;
grant update (
  kind, scope, provider, project_id, connection_id, metric_key, budget_id,
  threshold_percent, threshold_amount_minor, currency, paused
) on table public.alert_rules to authenticated;

do $$
declare
  target text;
begin
  foreach target in array array['budgets', 'alert_rules']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_workspace_role(workspace_id, %L))',
      target || '_select', target, 'viewer');
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_workspace_role(workspace_id, %L))',
      target || '_insert', target, 'admin');
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_workspace_role(workspace_id, %L)) with check (public.has_workspace_role(workspace_id, %L))',
      target || '_update', target, 'admin', 'admin');
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.has_workspace_role(workspace_id, %L))',
      target || '_delete', target, 'admin');
  end loop;
end $$;

-- triggered_alerts: read as viewer; admins acknowledge (only the two acknowledge columns), and only
-- in their own name.
grant select on table public.triggered_alerts to authenticated;
grant update (acknowledged_at, acknowledged_by) on table public.triggered_alerts to authenticated;

create policy triggered_alerts_select on public.triggered_alerts for select to authenticated
  using (public.has_workspace_role(workspace_id, 'viewer'));
create policy triggered_alerts_update on public.triggered_alerts for update to authenticated
  using (public.has_workspace_role(workspace_id, 'admin'))
  with check (
    public.has_workspace_role(workspace_id, 'admin')
    and (acknowledged_by is null or acknowledged_by = (select auth.uid()))
  );
