-- Event writes that fill in a missing body (#499). Until now every event was written with
-- `insert ... on conflict (workspace_id, dedupe_key) do nothing`, so the first write of an event
-- was its last. A Vercel `deployment.error` delivery carries no error code while the deployments
-- list the hourly poll reads does, so a failure pushed by webhook first never showed its
-- "Error code" line; a GitLab deployment delivery likewise lacks the "Deployment #n of ref" line.
--
-- insert_activity_events keeps the insert as it was and then lets a later write of the same event
-- set `body` on the stored row when the stored body is null and the new one is not. Nothing else
-- of a stored row changes, and a stored body is never replaced or cleared, so the first write
-- still decides the type, title, severity, link, time, and connection, and a delivery keeps
-- putting the event on the timeline first. Every writer of these events was checked for relying on
-- the first write keeping a null body, and none does (the audit is on the pull request for #499).
--
-- Within one call the first row of each (workspace_id, dedupe_key) is the one written, as the
-- insert alone did: a later row with the same key is skipped, its body included.
--
-- Two statements rather than `on conflict do update`, so the count of new rows stays a plain row
-- count. Each statement reads committed rows afresh, so a row a concurrent writer committed while
-- the insert waited on it is still filled in. The update locks its rows in key order first, so two
-- writers filling the same events queue instead of deadlocking (the rollup triggers on
-- activity_events lock in key order for the same reason, #236).
--
-- Expand only: a new function, so code that does not call it keeps working.

create function public.insert_activity_events(p_rows jsonb)
  returns int
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_rows public.activity_events[];
  v_inserted int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  -- id and created_at are never read from the input: the table's defaults set them.
  v_rows := array(
    select distinct on (r.workspace_id, r.dedupe_key) r
    from jsonb_array_elements(p_rows) with ordinality as a(value, ord)
    cross join lateral jsonb_populate_record(null::public.activity_events, a.value) as r
    order by r.workspace_id, r.dedupe_key, a.ord
  );

  insert into public.activity_events (
    workspace_id, connection_id, external_account_id, provider, type_id, severity, title, body, url,
    occurred_at, dedupe_key
  )
  select i.workspace_id, i.connection_id, i.external_account_id, i.provider, i.type_id, i.severity, i.title,
    i.body, i.url, i.occurred_at, i.dedupe_key
  from unnest(v_rows) as i
  order by i.workspace_id, i.dedupe_key
  on conflict (workspace_id, dedupe_key) do nothing;

  get diagnostics v_inserted = row_count;

  update public.activity_events e
  set body = f.body
  from (
    select e2.id, i.body
    from unnest(v_rows) as i
    join public.activity_events e2 on e2.workspace_id = i.workspace_id and e2.dedupe_key = i.dedupe_key
    where e2.body is null and i.body is not null
    order by e2.workspace_id, e2.dedupe_key
    for update of e2
  ) f
  where e.id = f.id
    and e.body is null;

  return v_inserted;
end;
$$;

revoke execute on function public.insert_activity_events(jsonb) from public, anon, authenticated;
grant execute on function public.insert_activity_events(jsonb) to service_role;
