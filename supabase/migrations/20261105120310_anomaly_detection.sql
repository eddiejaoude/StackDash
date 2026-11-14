-- Anomaly detection (#169): the per-workspace switch and the per-metric mutes. Detection itself
-- runs in the daily summary job (src/lib/alerts/anomaly.ts, src/lib/jobs/daily-summary.ts) with
-- the service role and writes stackdash.anomaly_detected events to activity_events.

-- On by default: detection needs no setup. Admins turn it off with the same update policy that
-- lets them rename the workspace (workspaces_update); the column grant is the only new access.
alter table public.workspaces
  add column anomaly_detection_enabled boolean not null default true;

grant update (anomaly_detection_enabled) on table public.workspaces to authenticated;

-- ── anomaly_mutes ───────────────────────────────────────────────────────────────
-- One row per muted metric. A mute covers every currency, unit, and source (verified and
-- estimated) the provider reports for the metric key. Configuration, so the alert_rules model
-- applies: members read, admins add and remove, and nothing is ever updated in place.

create table public.anomaly_mutes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider public.provider_id not null,
  metric_key text not null constraint anomaly_mutes_metric_key_format
    check (metric_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and char_length(metric_key) <= 100),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Also the index the job's per-workspace read and the alerts page list use.
  constraint anomaly_mutes_workspace_metric_key unique (workspace_id, provider, metric_key)
);

create index anomaly_mutes_created_by_idx on public.anomaly_mutes (created_by);

alter table public.anomaly_mutes enable row level security;

revoke all on table public.anomaly_mutes from anon, authenticated;

-- created_by is never granted; it defaults to auth.uid().
grant select, delete on table public.anomaly_mutes to authenticated;
grant insert (workspace_id, provider, metric_key) on table public.anomaly_mutes to authenticated;

create policy anomaly_mutes_select on public.anomaly_mutes for select to authenticated
  using (public.has_workspace_role(workspace_id, 'viewer'));
create policy anomaly_mutes_insert on public.anomaly_mutes for insert to authenticated
  with check (public.has_workspace_role(workspace_id, 'admin'));
create policy anomaly_mutes_delete on public.anomaly_mutes for delete to authenticated
  using (public.has_workspace_role(workspace_id, 'admin'));
