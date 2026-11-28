-- Support chat (#680): the arguments a caller may leave out get defaults, so the generated types
-- (src/lib/supabase/database.types.ts) say they are optional and the server never has to pass a
-- null where a type promises a value. The convention of every other function here (`default null`
-- on the trailing arguments, as admin_workspace_stats has). Bodies are unchanged except for where
-- the arguments sit; the comments that explain them are in the migrations that created them.
--
-- * stage_support_attachment and staged_support_attachments (20261128120200): p_thread_id is null
--   for a user's new conversation.
-- * support_start_thread (20261128120300): the attachments, the page, and the workspace context are
--   each absent for some conversations.
-- * support_thread_detail (20261128120300): the reader is only needed for an operator's marker.
--
-- Nothing calls the old signatures yet (they shipped in this same change), so each is dropped
-- rather than kept beside its replacement.

drop function public.stage_support_attachment(uuid, uuid, text, text, bigint, integer);

create function public.stage_support_attachment(
  p_uploader_id uuid,
  p_filename text,
  p_mime text,
  p_bytes bigint,
  p_max_staged integer,
  p_thread_id uuid default null
)
  returns table (attachment_id uuid, object_name text, refusal text)
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_extension text;
  v_owner uuid;
  v_staged integer;
  v_id uuid := pg_catalog.gen_random_uuid();
  v_object text;
begin
  v_extension := case p_mime
    when 'image/png' then 'png'
    when 'image/jpeg' then 'jpg'
    when 'image/gif' then 'gif'
    when 'image/webp' then 'webp'
  end;
  if v_extension is null then
    return query select null::uuid, null::text, 'mime'::text;
    return;
  end if;

  if p_bytes is null or p_bytes <= 0 or p_bytes > 10485760 then
    return query select null::uuid, null::text, 'bytes'::text;
    return;
  end if;

  if p_thread_id is null then
    v_owner := p_uploader_id;
  else
    select t.user_id into v_owner
    from public.support_threads t
    where t.id = p_thread_id
      and (
        t.user_id = p_uploader_id
        or public.is_super_admin_user(p_uploader_id)
      );
    if v_owner is null then
      return query select null::uuid, null::text, 'thread'::text;
      return;
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stage_support_attachment:' || p_uploader_id::text, 0));

  select count(*) into v_staged
  from public.support_attachments a
  where a.uploader_id = p_uploader_id and a.message_id is null;
  if v_staged >= p_max_staged then
    return query select null::uuid, null::text, 'staged_cap'::text;
    return;
  end if;

  v_object := v_owner::text || '/' || v_id::text || '.' || v_extension;
  insert into public.support_attachments (id, object_name, filename, mime, bytes, owner_id, uploader_id, thread_id)
  values (v_id, v_object, p_filename, p_mime, p_bytes, v_owner, p_uploader_id, p_thread_id);

  return query select v_id, v_object, null::text;
end;
$$;

revoke execute on function public.stage_support_attachment(uuid, text, text, bigint, integer, uuid) from public, anon, authenticated;
grant execute on function public.stage_support_attachment(uuid, text, text, bigint, integer, uuid) to service_role;

drop function public.staged_support_attachments(uuid, uuid, uuid[]);

create function public.staged_support_attachments(p_uploader_id uuid, p_ids uuid[], p_thread_id uuid default null)
  returns table (id uuid, object_name text, mime text)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select a.id, a.object_name, a.mime
  from public.support_attachments a
  where a.id = any (coalesce(p_ids, '{}'::uuid[]))
    and a.uploader_id = p_uploader_id
    and a.message_id is null
    and (a.thread_id is null or a.thread_id is not distinct from p_thread_id)
  order by a.created_at, a.id
$$;

revoke execute on function public.staged_support_attachments(uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.staged_support_attachments(uuid, uuid[], uuid) to service_role;

drop function public.support_start_thread(uuid, text, text, text, uuid, text, public.workspace_role, uuid[]);

create function public.support_start_thread(
  p_user_id uuid,
  p_subject text,
  p_body text,
  p_attachment_ids uuid[] default '{}',
  p_from_page text default null,
  p_workspace_id uuid default null,
  p_workspace_name text default null,
  p_member_role public.workspace_role default null
)
  returns table (thread_id uuid, message_id uuid, created_at timestamptz)
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz := now();
  v_member boolean;
  v_thread uuid;
  v_message uuid;
begin
  v_member := p_workspace_id is not null and exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = p_user_id
  );

  insert into public.support_threads (
    user_id, subject, from_page, workspace_id, workspace_name, member_role,
    created_at, last_message_at, user_last_read_at
  )
  values (
    p_user_id, p_subject, p_from_page,
    case when v_member then p_workspace_id end,
    case when v_member then p_workspace_name end,
    case when v_member then p_member_role end,
    v_now, v_now, v_now
  )
  returning id into v_thread;

  insert into public.support_messages (thread_id, sender, author_id, body, created_at)
  values (v_thread, 'user', p_user_id, p_body, v_now)
  returning id into v_message;

  perform public.bind_support_attachments(v_message, v_thread, p_user_id, p_user_id, p_attachment_ids);
  perform public.support_broadcast(p_user_id, v_thread, 'message', true, true, null);

  return query select v_thread, v_message, v_now;
end;
$$;

revoke execute on function public.support_start_thread(uuid, text, text, uuid[], text, uuid, text, public.workspace_role) from public, anon, authenticated;
grant execute on function public.support_start_thread(uuid, text, text, uuid[], text, uuid, text, public.workspace_role) to service_role;

drop function public.support_thread_detail(uuid, uuid);

create function public.support_thread_detail(p_thread_id uuid, p_reader_id uuid default null)
  returns table (
    id uuid,
    user_id uuid,
    member_email text,
    member_name text,
    member_avatar_url text,
    subject text,
    status public.support_thread_status,
    from_page text,
    workspace_id uuid,
    workspace_name text,
    member_role public.workspace_role,
    created_at timestamptz,
    last_message_at timestamptz,
    user_last_read_at timestamptz,
    operator_read_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select t.id, t.user_id, u.email::text, p.display_name, p.avatar_url, t.subject, t.status, t.from_page,
    t.workspace_id, t.workspace_name, t.member_role, t.created_at, t.last_message_at, t.user_last_read_at, r.read_at
  from public.support_threads t
  left join auth.users u on u.id = t.user_id
  left join public.profiles p on p.user_id = t.user_id
  left join public.support_thread_reads r on r.thread_id = t.id and r.user_id = p_reader_id
  where t.id = p_thread_id
$$;

revoke execute on function public.support_thread_detail(uuid, uuid) from public, anon, authenticated;
grant execute on function public.support_thread_detail(uuid, uuid) to service_role;
