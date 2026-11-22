-- Live refresh through one Broadcast per statement (#628), the expand step. The contract step,
-- 20261122211518_live_refresh_broadcast_contract.sql, takes the four tables out of the
-- supabase_realtime publication.
--
-- LiveRefresh (src/components/app/live-refresh.tsx) listened to Postgres Changes on inserts and
-- updates of activity_events, usage_snapshots, connections, and triggered_alerts, so a write of N
-- rows sent N messages to every open tab of its workspace. Realtime counts every delivery against
-- the project's message limit and, once a minute's average reaches it, skips every change for every
-- subscriber in the project: a 20,000 row insert with one tab open stopped live updates in every
-- workspace for about a minute (measured on #627). Every published row also cost the Postgres
-- Changes poller one filter check per open tab in the project.
--
-- Now a statement level trigger on each of those tables sends one Broadcast for each workspace a
-- statement wrote, whatever its row count: the method Supabase recommends for database changes
-- (https://supabase.com/docs/guides/realtime/subscribing-to-database-changes, "Using Broadcast").
--
-- * Topic `workspace-live:<workspace id>`, event `change`, private (realtime.send's default), so
--   only a channel that joins with `private: true` and passes the select policy below receives it.
-- * Payload: `table`, `operation` (INSERT or UPDATE), `connection_ids`, and `changed_at`, plus the
--   `id` realtime.send adds. No row data. `connection_ids` are the connections the statement brought
--   provider data from, distinct and sorted: the connection of every usage snapshot, and of every
--   activity event with a provider. StackDash's own events (a sync failure carries its connection
--   with a null provider), connections rows, and triggered_alerts are not data received from a
--   connection, so they bring none (the live indicator's "Receiving", #392). `changed_at` is now(),
--   the start of the write's transaction on the database clock: the value its rows' created_at and
--   updated_at take, which the indicator shows as when data last arrived and which the e2e fixtures
--   (e2e/fixtures/realtime.ts) match a write's message by.
-- * Deletes send nothing, as before: no screen listened for them.
-- * An upsert fires the insert trigger for the rows it added and the update trigger for the rows it
--   changed. A statement that wrote no row (a dedupe conflict, an update that matched nothing) sends
--   nothing, because its transition table is empty.
-- * Security definer, so the message is written as the function's owner whoever wrote the rows: the
--   service role (syncs, jobs), an admin acknowledging an alert, or a migration. Only the triggers
--   run it.
-- * realtime.send inserts the message into realtime.messages, which Realtime streams to subscribers
--   from the WAL through a replication connection of its own (publication
--   supabase_realtime_messages_publication), not through the Postgres Changes poller. A failed
--   insert, such as no partition for today, is caught by realtime.send and raised as a warning, so
--   it never fails the write. Realtime drops message partitions after three days.
--
-- realtime.messages policy: a member of the workspace, at any role, receives its topic; nobody else
-- does. Realtime checks it when a channel joins and again whenever the client sends a new access
-- token, by inserting probe rows with the joined topic and reading them back as the user
-- (realtime.authorize), so the policy reads the row's own topic. It compares that text with the
-- caller's workspaces through current_user_workspace_ids (the select policy helper since
-- 20261112090000_select_policies_membership_set.sql), so a topic of any other shape matches nothing
-- and no client-chosen text is ever cast. There is no insert policy: no client can send a broadcast
-- or track presence on a private topic, and the realtime.messages grants stay Supabase's own.
create function public.broadcast_live_change()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_changes refcursor;
  v_workspace_id uuid;
  v_connection_ids uuid[];
begin
  -- One row per workspace the statement wrote. PL/pgSQL plans each branch for the table whose
  -- trigger runs it, so a branch reads only columns its table has.
  if tg_table_name = 'activity_events' then
    open v_changes for
      select n.workspace_id,
        coalesce(
          array_agg(distinct n.connection_id) filter (where n.provider is not null and n.connection_id is not null),
          '{}'
        )
      from new_rows n
      group by n.workspace_id;
  elsif tg_table_name = 'usage_snapshots' then
    open v_changes for
      select n.workspace_id, array_agg(distinct n.connection_id)
      from new_rows n
      group by n.workspace_id;
  else
    open v_changes for
      select distinct n.workspace_id, '{}'::uuid[]
      from new_rows n;
  end if;

  loop
    fetch v_changes into v_workspace_id, v_connection_ids;
    exit when not found;
    perform realtime.send(
      jsonb_build_object(
        'table', tg_table_name,
        'operation', tg_op,
        'connection_ids', to_jsonb(v_connection_ids),
        'changed_at', now()
      ),
      'change',
      'workspace-live:' || v_workspace_id,
      true
    );
  end loop;
  close v_changes;

  return null;
end;
$$;

revoke execute on function public.broadcast_live_change() from public, anon, authenticated, service_role;

-- Transition tables allow one event per trigger, so each table gets an insert and an update trigger.
do $$
declare
  v_table text;
  v_event text;
begin
  foreach v_table in array array['activity_events', 'usage_snapshots', 'connections', 'triggered_alerts']
  loop
    foreach v_event in array array['insert', 'update']
    loop
      execute format(
        'create trigger %I after %s on public.%I referencing new table as new_rows '
          'for each statement execute function public.broadcast_live_change()',
        v_table || '_live_' || v_event, v_event, v_table);
    end loop;
  end loop;
end;
$$;

create policy workspace_live_select on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.messages.topic = any (
      array(select 'workspace-live:' || w.id from public.current_user_workspace_ids('viewer') as w (id))
    )
  );
