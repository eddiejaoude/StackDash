-- Support chat (#680): the functions every read and write goes through. Schema and policies:
-- 20261128120100_support_chat.sql and 20261128120200_support_attachments.sql.
--
-- Each write is one transaction that locks the thread row first, so a user's message, an operator's
-- reply, a status change, and the attachment bind cannot interleave (BackTalk 0083 found three such
-- interleavings in chained Data API calls). The server authorizes the caller before calling them,
-- so they take the actor as an argument and never read auth.uid(); they still re-check what they
-- can: a user writes only into their own thread, and an operator id must belong to a super admin
-- (is_super_admin_user), or the function raises. Security definer with an empty search_path, and
-- executable by the service role only.
--
-- Every write sends a Realtime hint (support_broadcast) from inside its transaction, as live
-- refresh does from its triggers (20261122210934_live_refresh_broadcast.sql), so a hint goes out
-- only for a write that committed. realtime.send turns its own failure into a warning, so a hint
-- never fails a write.
--
-- Times come from the database clock. A read marker never moves backwards and never past what the
-- reader vouches for having seen (p_seen_through, the newest activity their screen showed), so a
-- message that lands while a thread is open stays unread until it is on screen.

-- ── support_broadcast ───────────────────────────────────────────────────────────
-- One hint on the user's topic, the operators' topic, or both: { thread_id, kind, at }, where kind
-- is message, status, or read. A read on the operators' topic also carries the operator_id, so only
-- that operator's other tabs update their badge; the user's topic never carries an operator id.

create function public.support_broadcast(
  p_member_id uuid,
  p_thread_id uuid,
  p_kind text,
  p_to_member boolean,
  p_to_operators boolean,
  p_operator_id uuid
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_payload jsonb := jsonb_build_object('thread_id', p_thread_id, 'kind', p_kind, 'at', now());
begin
  if p_to_member then
    perform realtime.send(v_payload, 'activity', 'support-user:' || p_member_id::text, true);
  end if;
  if p_to_operators then
    perform realtime.send(
      v_payload || jsonb_strip_nulls(jsonb_build_object('operator_id', p_operator_id)),
      'activity',
      'support-operators',
      true
    );
  end if;
end;
$$;

revoke execute on function public.support_broadcast(uuid, uuid, text, boolean, boolean, uuid) from public, anon, authenticated, service_role;

-- ── support_start_thread ────────────────────────────────────────────────────────
-- A new conversation and its first message, with one clock reading for the thread and the message,
-- so the thread is read by its author from the start. The workspace context is kept only while the
-- user is still a member of that workspace; otherwise the conversation starts without it.

create function public.support_start_thread(
  p_user_id uuid,
  p_subject text,
  p_body text,
  p_from_page text,
  p_workspace_id uuid,
  p_workspace_name text,
  p_member_role public.workspace_role,
  p_attachment_ids uuid[]
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

revoke execute on function public.support_start_thread(uuid, text, text, text, uuid, text, public.workspace_role, uuid[]) from public, anon, authenticated;
grant execute on function public.support_start_thread(uuid, text, text, text, uuid, text, public.workspace_role, uuid[]) to service_role;

-- ── support_send_member_message ─────────────────────────────────────────────────
-- A user's message in one of their own threads; no row back when the thread is not theirs or does
-- not exist (the caller answers both alike). Writing reopens the thread. last_message_at takes the
-- later of the two clocks, so an operator reply that committed while this one waited for the lock
-- keeps its place, and stays unread for the user.

create function public.support_send_member_message(
  p_thread_id uuid,
  p_user_id uuid,
  p_body text,
  p_attachment_ids uuid[]
)
  returns table (message_id uuid, created_at timestamptz)
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz := now();
  v_last timestamptz;
  v_message uuid;
begin
  select t.last_message_at into v_last
  from public.support_threads t
  where t.id = p_thread_id and t.user_id = p_user_id
  for update;
  if not found then
    return;
  end if;

  insert into public.support_messages (thread_id, sender, author_id, body, created_at)
  values (p_thread_id, 'user', p_user_id, p_body, v_now)
  returning id into v_message;

  perform public.bind_support_attachments(v_message, p_thread_id, p_user_id, p_user_id, p_attachment_ids);

  update public.support_threads t
  set last_message_at = greatest(v_last, v_now),
      user_last_read_at = greatest(t.user_last_read_at, v_now),
      status = 'open'
  where t.id = p_thread_id;

  perform public.support_broadcast(p_user_id, p_thread_id, 'message', true, true, null);

  return query select v_message, v_now;
end;
$$;

revoke execute on function public.support_send_member_message(uuid, uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.support_send_member_message(uuid, uuid, text, uuid[]) to service_role;

-- ── support_operator_reply ──────────────────────────────────────────────────────
-- An operator's reply in any thread, which marks it replied (reopening a closed one) and read by
-- that operator up to the reply. No row back when the thread does not exist. Raises when the
-- operator is not a super admin: the server checked already, so reaching it is a bug or a revoke
-- that landed in between, and it must not write a message that renders as an operator's.

create function public.support_operator_reply(
  p_thread_id uuid,
  p_operator_id uuid,
  p_body text,
  p_attachment_ids uuid[]
)
  returns table (message_id uuid, created_at timestamptz, member_id uuid)
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz := now();
  v_last timestamptz;
  v_member uuid;
  v_message uuid;
begin
  if not public.is_super_admin_user(p_operator_id) then
    raise exception 'support_operator_reply: % is not a super admin', p_operator_id using errcode = '42501';
  end if;

  select t.last_message_at, t.user_id into v_last, v_member
  from public.support_threads t
  where t.id = p_thread_id
  for update;
  if not found then
    return;
  end if;

  insert into public.support_messages (thread_id, sender, author_id, body, created_at)
  values (p_thread_id, 'operator', p_operator_id, p_body, v_now)
  returning id into v_message;

  perform public.bind_support_attachments(v_message, p_thread_id, v_member, p_operator_id, p_attachment_ids);

  update public.support_threads t
  set last_message_at = greatest(v_last, v_now),
      status = 'replied'
  where t.id = p_thread_id;

  insert into public.support_thread_reads as r (thread_id, user_id, read_at)
  values (p_thread_id, p_operator_id, v_now)
  on conflict (thread_id, user_id) do update set read_at = greatest(r.read_at, excluded.read_at);

  perform public.support_broadcast(v_member, p_thread_id, 'message', true, true, null);

  return query select v_message, v_now, v_member;
end;
$$;

revoke execute on function public.support_operator_reply(uuid, uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.support_operator_reply(uuid, uuid, text, uuid[]) to service_role;

-- ── support_mark_read_by_member ─────────────────────────────────────────────────
-- Moves the owner's marker to what they saw (never later than now, never backwards). True only
-- when that covered activity that was unread, which is when the user's other tabs get a hint; false
-- also for a thread that is not theirs.

create function public.support_mark_read_by_member(p_thread_id uuid, p_user_id uuid, p_seen_through timestamptz)
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_last timestamptz;
  v_read timestamptz;
  v_mark timestamptz;
begin
  select t.last_message_at, t.user_last_read_at into v_last, v_read
  from public.support_threads t
  where t.id = p_thread_id and t.user_id = p_user_id
  for update;
  if not found then
    return false;
  end if;

  v_mark := greatest(v_read, least(coalesce(p_seen_through, now()), now()));
  if v_mark is not distinct from v_read then
    return false;
  end if;

  update public.support_threads t set user_last_read_at = v_mark where t.id = p_thread_id;

  if v_last > coalesce(v_read, '-infinity'::timestamptz) then
    perform public.support_broadcast(p_user_id, p_thread_id, 'read', true, false, null);
    return true;
  end if;
  return false;
end;
$$;

revoke execute on function public.support_mark_read_by_member(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.support_mark_read_by_member(uuid, uuid, timestamptz) to service_role;

-- ── support_mark_read_by_operator ───────────────────────────────────────────────
-- The same for one operator's own marker; other operators' markers are untouched.

create function public.support_mark_read_by_operator(p_thread_id uuid, p_operator_id uuid, p_seen_through timestamptz)
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_last timestamptz;
  v_member uuid;
  v_read timestamptz;
  v_mark timestamptz;
begin
  if not public.is_super_admin_user(p_operator_id) then
    raise exception 'support_mark_read_by_operator: % is not a super admin', p_operator_id using errcode = '42501';
  end if;

  select t.last_message_at, t.user_id into v_last, v_member
  from public.support_threads t
  where t.id = p_thread_id;
  if not found then
    return false;
  end if;

  select r.read_at into v_read
  from public.support_thread_reads r
  where r.thread_id = p_thread_id and r.user_id = p_operator_id
  for update;

  v_mark := greatest(v_read, least(coalesce(p_seen_through, now()), now()));
  if v_mark is not distinct from v_read then
    return false;
  end if;

  insert into public.support_thread_reads as r (thread_id, user_id, read_at)
  values (p_thread_id, p_operator_id, v_mark)
  on conflict (thread_id, user_id) do update set read_at = greatest(r.read_at, excluded.read_at);

  if v_last > coalesce(v_read, '-infinity'::timestamptz) then
    perform public.support_broadcast(v_member, p_thread_id, 'read', false, true, p_operator_id);
    return true;
  end if;
  return false;
end;
$$;

revoke execute on function public.support_mark_read_by_operator(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.support_mark_read_by_operator(uuid, uuid, timestamptz) to service_role;

-- ── support_set_thread_status ───────────────────────────────────────────────────
-- An operator opens or closes a thread. `replied` is set by replies only. Answers `updated`,
-- `unchanged`, or `newer_message`, or null for a thread that does not exist. A close is refused
-- (`newer_message`) when the user wrote after what the operator vouches for having seen: closing
-- would bury a question nobody read, since closed threads leave the active list and every badge.

create function public.support_set_thread_status(
  p_thread_id uuid,
  p_operator_id uuid,
  p_status public.support_thread_status,
  p_seen_through timestamptz
)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_member uuid;
  v_status public.support_thread_status;
begin
  if not public.is_super_admin_user(p_operator_id) then
    raise exception 'support_set_thread_status: % is not a super admin', p_operator_id using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('open', 'closed') then
    raise exception 'support_set_thread_status: status must be open or closed' using errcode = '22023';
  end if;

  select t.user_id, t.status into v_member, v_status
  from public.support_threads t
  where t.id = p_thread_id
  for update;
  if not found then
    return null;
  end if;

  if v_status = p_status then
    return 'unchanged';
  end if;

  if p_status = 'closed' and exists (
    select 1 from public.support_messages m
    where m.thread_id = p_thread_id
      and m.sender = 'user'
      and m.created_at > coalesce(p_seen_through, '-infinity'::timestamptz)
  ) then
    return 'newer_message';
  end if;

  update public.support_threads t set status = p_status where t.id = p_thread_id;
  perform public.support_broadcast(v_member, p_thread_id, 'status', true, true, null);
  return 'updated';
end;
$$;

revoke execute on function public.support_set_thread_status(uuid, uuid, public.support_thread_status, timestamptz) from public, anon, authenticated;
grant execute on function public.support_set_thread_status(uuid, uuid, public.support_thread_status, timestamptz) to service_role;

-- ── Lists ───────────────────────────────────────────────────────────────────────
-- Unread first, then newest activity, one page at a time: (p_after_unread, p_after_last_message_at,
-- p_after_id) is the last row of the previous page, all null for the first. Unread is the same
-- comparison isUnread makes in src/lib/support/unread.ts and the counts below make. The page size
-- is clamped to 1..100. Each row carries the newest message's sender and its first 200 characters.

create function public.support_member_threads(
  p_user_id uuid,
  p_limit integer,
  p_after_unread boolean default null,
  p_after_last_message_at timestamptz default null,
  p_after_id uuid default null
)
  returns table (
    id uuid,
    subject text,
    status public.support_thread_status,
    created_at timestamptz,
    last_message_at timestamptz,
    read_at timestamptz,
    last_sender public.support_sender,
    last_preview text
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select t.id, t.subject, t.status, t.created_at, t.last_message_at, t.user_last_read_at, m.sender, left(m.body, 200)
  from (
    select t.*, t.last_message_at > coalesce(t.user_last_read_at, '-infinity'::timestamptz) as unread
    from public.support_threads t
    where t.user_id = p_user_id
  ) t
  left join lateral (
    select m.sender, m.body
    from public.support_messages m
    where m.thread_id = t.id
    order by m.created_at desc, m.id desc
    limit 1
  ) m on true
  where p_after_id is null
    or (t.unread, t.last_message_at, t.id) < (p_after_unread, p_after_last_message_at, p_after_id)
  order by t.unread desc, t.last_message_at desc, t.id desc
  limit least(greatest(coalesce(p_limit, 1), 1), 100)
$$;

revoke execute on function public.support_member_threads(uuid, integer, boolean, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.support_member_threads(uuid, integer, boolean, timestamptz, uuid) to service_role;

-- The operators' list, active (open and replied) or closed, against this operator's own markers,
-- with who the user is: their current email and profile name, read here rather than copied onto
-- the thread, so they are never stale.
create function public.support_operator_threads(
  p_operator_id uuid,
  p_closed boolean,
  p_limit integer,
  p_after_unread boolean default null,
  p_after_last_message_at timestamptz default null,
  p_after_id uuid default null
)
  returns table (
    id uuid,
    user_id uuid,
    member_email text,
    member_name text,
    member_avatar_url text,
    subject text,
    status public.support_thread_status,
    from_page text,
    workspace_name text,
    member_role public.workspace_role,
    created_at timestamptz,
    last_message_at timestamptz,
    read_at timestamptz,
    last_sender public.support_sender,
    last_preview text
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select t.id, t.user_id, u.email::text, p.display_name, p.avatar_url, t.subject, t.status, t.from_page,
    t.workspace_name, t.member_role, t.created_at, t.last_message_at, t.read_at, m.sender, left(m.body, 200)
  from (
    select t.*, r.read_at, t.last_message_at > coalesce(r.read_at, '-infinity'::timestamptz) as unread
    from public.support_threads t
    left join public.support_thread_reads r on r.thread_id = t.id and r.user_id = p_operator_id
    where (p_closed and t.status = 'closed') or (not p_closed and t.status <> 'closed')
  ) t
  left join auth.users u on u.id = t.user_id
  left join public.profiles p on p.user_id = t.user_id
  left join lateral (
    select m.sender, m.body
    from public.support_messages m
    where m.thread_id = t.id
    order by m.created_at desc, m.id desc
    limit 1
  ) m on true
  where p_after_id is null
    or (t.unread, t.last_message_at, t.id) < (p_after_unread, p_after_last_message_at, p_after_id)
  order by t.unread desc, t.last_message_at desc, t.id desc
  limit least(greatest(coalesce(p_limit, 1), 1), 100)
$$;

revoke execute on function public.support_operator_threads(uuid, boolean, integer, boolean, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.support_operator_threads(uuid, boolean, integer, boolean, timestamptz, uuid) to service_role;

-- One thread with its owner's identity and p_reader_id's operator marker (null when they have none,
-- or are the owner). The server decides whether the reader may see it.
create function public.support_thread_detail(p_thread_id uuid, p_reader_id uuid)
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

-- A conversation, newest first, one page at a time: (p_before_created_at, p_before_id) is the oldest
-- message already shown, both null for the newest page. Each message carries its attachments (the
-- object name, never a URL: the server signs URLs per read). The page size is clamped to 1..200.
create function public.support_thread_messages(
  p_thread_id uuid,
  p_limit integer,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
)
  returns table (id uuid, sender public.support_sender, body text, created_at timestamptz, attachments jsonb)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select m.id, m.sender, m.body, m.created_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('id', a.id, 'object_name', a.object_name, 'filename', a.filename, 'mime', a.mime, 'bytes', a.bytes)
          order by a.created_at, a.id
        )
        from public.support_attachments a
        where a.message_id = m.id
      ),
      '[]'::jsonb
    )
  from public.support_messages m
  where m.thread_id = p_thread_id
    and (p_before_id is null or (m.created_at, m.id) < (p_before_created_at, p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 1), 1), 200)
$$;

revoke execute on function public.support_thread_messages(uuid, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.support_thread_messages(uuid, integer, timestamptz, uuid) to service_role;

-- ── Unread counts ───────────────────────────────────────────────────────────────
-- Threads with unread activity, counted up to 100: a badge shows "99+" past that, so counting
-- further is a scan nobody reads. The operator count leaves closed threads out, as the active list
-- does.

create function public.support_member_unread_count(p_user_id uuid)
  returns integer
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select count(*)::integer
  from (
    select 1
    from public.support_threads t
    where t.user_id = p_user_id
      and t.last_message_at > coalesce(t.user_last_read_at, '-infinity'::timestamptz)
    limit 100
  ) unread
$$;

revoke execute on function public.support_member_unread_count(uuid) from public, anon, authenticated;
grant execute on function public.support_member_unread_count(uuid) to service_role;

create function public.support_operator_unread_count(p_operator_id uuid)
  returns integer
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select count(*)::integer
  from (
    select 1
    from public.support_threads t
    left join public.support_thread_reads r on r.thread_id = t.id and r.user_id = p_operator_id
    where t.status <> 'closed'
      and t.last_message_at > coalesce(r.read_at, '-infinity'::timestamptz)
    limit 100
  ) unread
$$;

revoke execute on function public.support_operator_unread_count(uuid) from public, anon, authenticated;
grant execute on function public.support_operator_unread_count(uuid) to service_role;

-- ── bump_support_rate_limit ─────────────────────────────────────────────────────
-- Counts one attempt against a user key and an IP key in the current window (database clock,
-- windows of p_window_seconds from the Unix epoch) and returns both keys' counts for this window
-- and the one before, this attempt included. The caller compares the two windows together against
-- its limit (a sliding window approximation, BackTalk 0086), so a burst across a window boundary
-- cannot get twice the limit through. One transaction, each key bumped in one statement, so
-- concurrent attempts serialize on the counter row instead of racing a read. Keys are counted in
-- the same order every time, so two attempts never wait on each other in a cycle.

create function public.bump_support_rate_limit(p_user_key text, p_ip_key text, p_window_seconds integer)
  returns table (window_start timestamptz, user_current integer, user_previous integer, ip_current integer, ip_previous integer)
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
#variable_conflict use_column
declare
  v_width interval;
  v_start timestamptz;
  v_user_current integer;
  v_user_previous integer;
  v_ip_current integer;
  v_ip_previous integer;
begin
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'bump_support_rate_limit: the window must be 1 to 86400 seconds' using errcode = '22023';
  end if;
  v_width := make_interval(secs => p_window_seconds);
  v_start := date_bin(v_width, now(), 'epoch'::timestamptz);

  insert into public.support_rate_limit_counters as c (key, window_start, count)
  values (p_user_key, v_start, 1)
  on conflict (key, window_start) do update set count = c.count + 1
  returning c.count into v_user_current;

  insert into public.support_rate_limit_counters as c (key, window_start, count)
  values (p_ip_key, v_start, 1)
  on conflict (key, window_start) do update set count = c.count + 1
  returning c.count into v_ip_current;

  select coalesce(sum(c.count), 0)::integer into v_user_previous
  from public.support_rate_limit_counters c
  where c.key = p_user_key and c.window_start = v_start - v_width;

  select coalesce(sum(c.count), 0)::integer into v_ip_previous
  from public.support_rate_limit_counters c
  where c.key = p_ip_key and c.window_start = v_start - v_width;

  return query select v_start, v_user_current, v_user_previous, v_ip_current, v_ip_previous;
end;
$$;

revoke execute on function public.bump_support_rate_limit(text, text, integer) from public, anon, authenticated;
grant execute on function public.bump_support_rate_limit(text, text, integer) to service_role;

-- Retention: counters whose window started before p_before, a batch at a time.
create function public.purge_support_rate_limit_counters(p_before timestamptz, p_limit int)
  returns int
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_deleted int;
begin
  if p_before is null or p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'p_before is required and p_limit must be between 1 and 10000' using errcode = 'invalid_parameter_value';
  end if;

  with doomed as (
    select c.key, c.window_start from public.support_rate_limit_counters c
    where c.window_start < p_before
    order by c.window_start, c.key
    limit p_limit
    for update skip locked
  )
  delete from public.support_rate_limit_counters c using doomed
  where c.key = doomed.key and c.window_start = doomed.window_start;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.purge_support_rate_limit_counters(timestamptz, int) from public, anon, authenticated;
grant execute on function public.purge_support_rate_limit_counters(timestamptz, int) to service_role;
