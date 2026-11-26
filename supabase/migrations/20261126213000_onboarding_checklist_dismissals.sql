-- Who has hidden the Timeline's first-run setup checklist (#674). One row per member per
-- workspace; no row means the checklist shows. Grant model: see 20261031090000_tenancy.sql.
--
-- Shaped like notification_preferences (20261105120100_alert_delivery.sql), with two differences:
--
-- - Every member writes their own row, viewers included. Hiding a panel for yourself is not a
--   privileged action, unlike an alert email setting, so the insert policy asks only for the viewer
--   role. The select policy reads current_user_workspace_ids, as every select policy has since #283.
-- - Insert only, and only the key columns. The app hides the checklist with an insert that ignores a
--   row already there (ON CONFLICT DO NOTHING), so a second hide keeps the first time and needs no
--   update grant. dismissed_at comes from the database clock, never from the caller. Nothing shows
--   the checklist again, so there is no delete grant either.
--
-- Leaving the workspace removes the row with the membership, so a member who rejoins sees the
-- checklist again. The primary key serves the one read, by workspace and user, and the cascade.

create table public.onboarding_checklist_dismissals (
  workspace_id uuid not null,
  user_id uuid not null,
  dismissed_at timestamptz not null default now(),
  constraint onboarding_checklist_dismissals_pkey primary key (workspace_id, user_id),
  constraint onboarding_checklist_dismissals_member_fkey foreign key (workspace_id, user_id)
    references public.workspace_members (workspace_id, user_id) on delete cascade
);

alter table public.onboarding_checklist_dismissals enable row level security;
revoke all on table public.onboarding_checklist_dismissals from anon, authenticated;

grant select on table public.onboarding_checklist_dismissals to authenticated;
grant insert (workspace_id, user_id) on table public.onboarding_checklist_dismissals to authenticated;

create policy onboarding_checklist_dismissals_select on public.onboarding_checklist_dismissals for select to authenticated
  using (
    user_id = (select auth.uid())
    and workspace_id = any (array(select public.current_user_workspace_ids('viewer')))
  );
create policy onboarding_checklist_dismissals_insert on public.onboarding_checklist_dismissals for insert to authenticated
  with check (user_id = (select auth.uid()) and public.has_workspace_role(workspace_id, 'viewer'));
