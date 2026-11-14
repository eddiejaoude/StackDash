-- At most 100 live self-reported values per project (#220; SELF_REPORTED_LIVE_MAX in
-- src/components/public-metrics/self-reported-rules.ts).
--
-- public_published_metrics() returns every live publication of a project, and the public routes
-- read it in one request. PostgREST cuts a read at max_rows (1000, supabase/config.toml) without
-- an error, so an uncapped project would publish part of its list as if it were all of it. Engine
-- rows are capped at one per definition by published_metrics_live_metric_key; this caps the
-- self-reported rows, so a project holds at most 13 + 100 live rows: far below max_rows, and below
-- the settings page's read of 200 (LIVE_ROWS_LIMIT in src/lib/data/published-metrics.ts).
--
-- Enforced in the one function that writes a self-reported row, after the project row lock it
-- already takes, so two owners publishing at once cannot both pass the count. Reaching the cap is
-- an expected answer, so it is a status ('limit_reached') like 'duplicate', not an exception. The
-- count is served by published_metrics_live_self_reported_key, whose predicate it repeats.
-- Rows published before this migration are left as they are. Replacing the function keeps its
-- owner and grants (service role only); they are restated so this file reads on its own.

create or replace function public.publish_self_reported_metric(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_label text,
  p_value bigint,
  p_unit text,
  p_title text,
  p_body text
)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.require_published_metrics_admin(p_workspace_id, p_actor_id);
  if p_title is null then
    raise exception 'p_title is required' using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.projects p where p.id = p_project_id and p.workspace_id = p_workspace_id for no key update;
  if not found then
    return 'not_found';
  end if;

  if exists (
    select 1 from public.published_metrics pm
    where pm.project_id = p_project_id
      and pm.metric_id is null
      and pm.revoked_at is null
      and lower(btrim(pm.self_reported_label)) = lower(btrim(p_label))
  ) then
    return 'duplicate';
  end if;

  if (
    select count(*) from public.published_metrics pm
    where pm.project_id = p_project_id and pm.metric_id is null and pm.revoked_at is null
  ) >= 100 then
    return 'limit_reached';
  end if;

  insert into public.published_metrics (
    workspace_id, project_id, self_reported_label, self_reported_value, self_reported_unit, published_by
  )
  values (p_workspace_id, p_project_id, btrim(p_label), p_value, btrim(p_unit), p_actor_id)
  returning id into v_id;

  perform public.record_publication_event(
    p_workspace_id, 'stackdash.metric_published', p_title, p_body, 'metric_published:' || v_id::text
  );
  return 'published';
end;
$$;

revoke execute on function public.publish_self_reported_metric(uuid, uuid, uuid, text, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.publish_self_reported_metric(uuid, uuid, uuid, text, bigint, text, text, text)
  to service_role;
