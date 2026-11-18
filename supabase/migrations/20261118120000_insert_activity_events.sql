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
-- the insert waited on it is still filled in. The update locks the events it fills in key order.
--
-- A fill-in takes no rollup lock. The update fires activity_events_count_update, a statement-level
-- trigger, so it runs only when an `if exists` probe finds a body to fill in, and the rollup
-- function is replaced below to return at once for an update that moves no event to another
-- rollup key. Without that, the trigger took each filled event's activity_event_daily_counts row
-- through its update path (lock, decrement, increment again) after the insert's trigger had locked
-- the inserted rows' rollup rows, and with the filled events' row locks between the two passes, two
-- calls carrying a body for the same stored event deadlocked (#499 review: 155 of 200 rounds in a
-- throwaway database). Now a call's locks are its inserted rows' rollup rows in key order, then the
-- events it fills in key order, and nothing after. An update that does move a key (the
-- external_accounts set null action) still decrements and increments as before.
--
-- Expand only: a new function, and a rollup function that counts every change as before.

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

  -- Probed first: the update's statement-level rollup trigger would otherwise run on every call.
  -- The update's own row locks and `e.body is null` still decide under concurrency.
  if exists (
    select 1
    from unnest(v_rows) as i
    join public.activity_events e on e.workspace_id = i.workspace_id and e.dedupe_key = i.dedupe_key
    where e.body is null and i.body is not null
  ) then
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
  end if;

  return v_inserted;
end;
$$;

revoke execute on function public.insert_activity_events(jsonb) from public, anon, authenticated;
grant execute on function public.insert_activity_events(jsonb) to service_role;

-- ── activity_events_count_rollup ───────────────────────────────────────────────
-- Stated again with the body 20261106090000_activity_event_daily_counts.sql creates and one change:
-- an update whose old and new rows group to the same rollup keys with the same counts returns at
-- once, since it changes no count. That is a body fill-in; the set null update moves a key and
-- takes the usual path. Same signature, so the four triggers keep calling it.

create or replace function public.activity_events_count_rollup()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    truncate public.activity_event_daily_counts;
    return null;
  end if;

  -- An update that moves no event to another rollup key (a body fill-in, #499) changes no count.
  -- Nested: old_rows exists only for the update and delete triggers, and plpgsql plans a whole
  -- condition at once, so `tg_op = 'UPDATE' and not exists (...)` fails on insert. Both transition
  -- tables of an update hold the same number of rows, so one direction of `except` is enough.
  if tg_op = 'UPDATE' then
    if not exists (
      select o.workspace_id, (o.occurred_at at time zone 'UTC')::date, o.type_id, o.provider, o.external_account_id,
        count(*)
      from old_rows o
      group by 1, 2, 3, 4, 5
      except
      select n.workspace_id, (n.occurred_at at time zone 'UTC')::date, n.type_id, n.provider, n.external_account_id,
        count(*)
      from new_rows n
      group by 1, 2, 3, 4, 5
    ) then
      return null;
    end if;
  end if;

  if tg_op in ('DELETE', 'UPDATE') then
    perform 1
    from public.activity_event_daily_counts c
    join (
      select distinct o.workspace_id, (o.occurred_at at time zone 'UTC')::date as day, o.type_id, o.provider,
        o.external_account_id
      from old_rows o
    ) g
      on c.workspace_id = g.workspace_id
      and c.day = g.day
      and c.type_id = g.type_id
      and c.provider is not distinct from g.provider
      and c.external_account_id is not distinct from g.external_account_id
    order by c.workspace_id, c.day, c.type_id, c.provider, c.external_account_id
    for update of c;

    with gone as (
      select o.workspace_id, (o.occurred_at at time zone 'UTC')::date as day, o.type_id, o.provider,
        o.external_account_id, count(*)::int as n
      from old_rows o
      group by 1, 2, 3, 4, 5
    )
    update public.activity_event_daily_counts c
    set event_count = c.event_count - g.n
    from gone g
    where c.workspace_id = g.workspace_id
      and c.day = g.day
      and c.type_id = g.type_id
      and c.provider is not distinct from g.provider
      and c.external_account_id is not distinct from g.external_account_id;

    delete from public.activity_event_daily_counts c
    using (select distinct o.workspace_id, (o.occurred_at at time zone 'UTC')::date as day from old_rows o) t
    where c.workspace_id = t.workspace_id
      and c.day = t.day
      and c.event_count = 0;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    insert into public.activity_event_daily_counts as c (
      workspace_id, day, type_id, provider, external_account_id, event_count
    )
    select n.workspace_id, (n.occurred_at at time zone 'UTC')::date, n.type_id, n.provider,
      n.external_account_id, count(*)::int
    from new_rows n
    group by 1, 2, 3, 4, 5
    order by 1, 2, 3, 4, 5
    on conflict on constraint activity_event_daily_counts_key
      do update set event_count = c.event_count + excluded.event_count;
  end if;

  return null;
end;
$$;

revoke execute on function public.activity_events_count_rollup() from public, anon, authenticated, service_role;
