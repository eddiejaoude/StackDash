-- Support chat image attachments (#680): the private bucket, its policies, and the metadata table.
-- Grant model: see 20261031090000_tenancy.sql. BackTalk's design (0092 and 0093 at 274976f^1), with
-- object names under the conversation owner's folder.
--
-- The bytes never pass through the app: a server action claims a row (stage_support_attachment),
-- which validates the type and size, bounds how many unsent attachments one uploader may hold, and
-- names the object; the browser then uploads straight to Storage, and the insert policy admits only
-- an object whose name was claimed that way and is not yet sent. So every object has a row the
-- sweep can find, and the flood an upload could cause is bounded by the claim cap. Sending binds the
-- claimed rows to the message in the send's own transaction (bind_support_attachments, called by
-- the write functions in 20261128120300_support_chat_functions.sql), after the server has checked
-- each object's first bytes against its declared type (src/lib/support/attachment-store.ts).
--
-- Object names are `<conversation owner id>/<attachment id>.<extension>`, always generated here:
-- the user's filename is display text and never part of a path. The owner is the user whose
-- conversation it is, whoever uploaded it, so the owner can read every image in their own
-- conversations by prefix, and deleting an account removes everything under one folder.
--
-- Retention: an attachment lives as long as its message. A staged one (uploaded, never sent) and
-- an object no row points at are deleted by the daily retention job after 24 hours
-- (src/lib/jobs/retention.ts). No SQL statement can delete a Storage object, so the sweep lists
-- here and deletes through the Storage API.

-- The bucket. Private, 10 MiB a file, raster images only: no SVG, because an SVG is a script host
-- and this bucket holds files strangers send. Storage enforces both caps before it accepts a byte;
-- the table constraints and src/lib/support/limits.ts mirror them, and all three move together.
-- Re-running restores the declared settings on a bucket edited by hand, `public` above all.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('support-attachments', 'support-attachments', false, 10485760, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table public.support_attachments (
  id uuid primary key,
  object_name text not null constraint support_attachments_object_name_key unique,
  -- Display only, without any directory part; rendered as text.
  filename text not null constraint support_attachments_filename_length check (char_length(filename) between 1 and 255),
  mime text not null constraint support_attachments_mime_check
    check (mime in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  bytes bigint not null constraint support_attachments_bytes_check check (bytes > 0 and bytes <= 10485760),
  -- The conversation owner, whose folder holds the object.
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- Who uploaded it: the owner, or an operator replying. Null once that account is deleted; a sent
  -- image stays in the conversation.
  uploader_id uuid references auth.users (id) on delete set null,
  -- Null for a new conversation's first message until it is sent.
  thread_id uuid references public.support_threads (id) on delete cascade,
  -- Null while staged: uploaded (or about to be) and not yet sent.
  message_id uuid references public.support_messages (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- A message's attachments, and the message foreign key.
create index support_attachments_message_id_idx on public.support_attachments (message_id);
-- The thread foreign key.
create index support_attachments_thread_id_idx on public.support_attachments (thread_id);
-- The owner foreign key.
create index support_attachments_owner_id_idx on public.support_attachments (owner_id);
-- The uploader foreign key, and the per-uploader cap on staged rows.
create index support_attachments_uploader_staged_idx on public.support_attachments (uploader_id) where message_id is null;
create index support_attachments_uploader_id_idx on public.support_attachments (uploader_id);
-- The sweep of staged rows by age.
create index support_attachments_staged_created_at_idx on public.support_attachments (created_at) where message_id is null;

alter table public.support_attachments enable row level security;
revoke all on table public.support_attachments from anon, authenticated;
-- Every column but uploader_id, which would name the operator who attached an image.
grant select (id, object_name, filename, mime, bytes, owner_id, thread_id, message_id, created_at)
  on table public.support_attachments to authenticated;

-- The owner reads the sent images of their conversations and their own unsent ones; an operator
-- reads every row. An operator's unsent image is not the owner's to see yet.
create policy support_attachments_select on public.support_attachments for select to authenticated
  using (
    (owner_id = (select auth.uid()) and (message_id is not null or uploader_id = (select auth.uid())))
    or (select public.is_super_admin())
  );

-- ── The claim predicate ─────────────────────────────────────────────────────────
-- Has the caller claimed exactly this object name, and is it still unsent? Security definer because
-- the insert policy below runs as the caller, who cannot read uploader_id. It takes no user
-- argument and asks auth.uid() itself: a caller-supplied uploader would be the whole hole.

create function public.support_attachment_claimed(p_object_name text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1
    from public.support_attachments a
    where a.object_name = p_object_name
      and a.uploader_id = (select auth.uid())
      and a.message_id is null
  )
$$;

revoke execute on function public.support_attachment_claimed(text) from public, anon, authenticated;
grant execute on function public.support_attachment_claimed(text) to authenticated, service_role;

-- ── Storage policies ────────────────────────────────────────────────────────────
-- Upload: exactly one claimed, unsent object, one folder deep, in the caller's own folder or, for an
-- operator, the folder of the user they are answering. There is no update or delete policy: an
-- uploaded object is never overwritten, and only the service role deletes (a discarded attachment,
-- the sweep, account deletion).

create policy support_attachments_object_insert on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'support-attachments'
    and array_length(storage.foldername(name), 1) = 1
    and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_super_admin()))
    and (select public.support_attachment_claimed(name))
  );

-- Read: the caller's own folder (their conversations), or anything for an operator. The app signs
-- thumbnails with the service role and does not rely on this; it is what stands between a curious
-- user and someone else's image at the Storage API.
create policy support_attachments_object_select on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'support-attachments'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_super_admin()))
  );

-- ── stage_support_attachment ────────────────────────────────────────────────────
-- Claims one attachment and names its object. Always one row back: `refusal` is null on success,
-- otherwise which rule said no (`mime`, `bytes`, `thread`, `staged_cap`), which the app turns into
-- a sentence the uploader can act on.
--
-- p_thread_id is the conversation being answered, or null for a user's new conversation. A user may
-- claim into their own thread; an operator (a super_admins row, checked here rather than taken from
-- the caller) into any. Operators never start conversations, so a null thread is the uploader's own.
-- The staged count and the insert are serialized per uploader with a transaction advisory lock, so
-- two concurrent claims cannot both pass the cap. The key hashes the uploader id under this
-- function's name, so it cannot collide with a lock taken for another purpose.

create function public.stage_support_attachment(
  p_uploader_id uuid,
  p_thread_id uuid,
  p_filename text,
  p_mime text,
  p_bytes bigint,
  p_max_staged integer
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

revoke execute on function public.stage_support_attachment(uuid, uuid, text, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.stage_support_attachment(uuid, uuid, text, text, bigint, integer) to service_role;

-- ── staged_support_attachments ──────────────────────────────────────────────────
-- The caller's own unsent attachments among p_ids, with the thread they may be sent to: what the
-- server checks the bytes of before a send. Rows of another uploader, sent rows, and rows staged
-- for another thread are left out, so a short answer means the send must be refused.

create function public.staged_support_attachments(p_uploader_id uuid, p_thread_id uuid, p_ids uuid[])
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

revoke execute on function public.staged_support_attachments(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.staged_support_attachments(uuid, uuid, uuid[]) to service_role;

-- ── bind_support_attachments ────────────────────────────────────────────────────
-- Binds staged rows to a message, inside the write function that inserted it, all or nothing: any
-- id that is not the uploader's own, still unsent, staged for this thread or for none, in this
-- owner's folder, and backed by an uploaded object raises, which rolls the message back with it.
-- Not callable from the Data API; only the write functions (as their owner) call it.

create function public.bind_support_attachments(
  p_message_id uuid,
  p_thread_id uuid,
  p_owner_id uuid,
  p_uploader_id uuid,
  p_attachment_ids uuid[]
)
  returns integer
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_wanted integer := coalesce(array_length(p_attachment_ids, 1), 0);
  v_bound integer;
begin
  if v_wanted = 0 then
    return 0;
  end if;

  update public.support_attachments a
  set message_id = p_message_id,
      thread_id = p_thread_id
  where a.id = any (p_attachment_ids)
    and a.uploader_id = p_uploader_id
    and a.owner_id = p_owner_id
    and a.message_id is null
    and (a.thread_id is null or a.thread_id = p_thread_id)
    and exists (
      select 1 from storage.objects o
      where o.bucket_id = 'support-attachments' and o.name = a.object_name
    );
  get diagnostics v_bound = row_count;

  if v_bound <> v_wanted then
    raise exception 'bind_support_attachments: % of % attachments cannot be sent with message %',
      v_wanted - v_bound, v_wanted, p_message_id
      using errcode = 'P0002';
  end if;
  return v_bound;
end;
$$;

revoke execute on function public.bind_support_attachments(uuid, uuid, uuid, uuid, uuid[]) from public, anon, authenticated, service_role;

-- ── discard_support_attachment ──────────────────────────────────────────────────
-- Removes one of the caller's unsent attachments and returns its object name, so the server can
-- delete the bytes; null when there was nothing to discard. A sent attachment is part of the
-- conversation and is never discarded.

create function public.discard_support_attachment(p_uploader_id uuid, p_attachment_id uuid)
  returns text
  language sql
  volatile
  security definer
  set search_path = ''
as $$
  delete from public.support_attachments a
  where a.id = p_attachment_id
    and a.uploader_id = p_uploader_id
    and a.message_id is null
  returning a.object_name
$$;

revoke execute on function public.discard_support_attachment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.discard_support_attachment(uuid, uuid) to service_role;

-- ── The sweep ───────────────────────────────────────────────────────────────────
-- List, then delete: the retention job deletes the objects through the Storage API first and the
-- rows second, so a run cut short leaves rows the next run finds again. Each list is bounded.

-- Staged rows created before p_before, oldest first.
create function public.list_stale_support_attachments(p_before timestamptz, p_limit integer)
  returns table (id uuid, object_name text)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select a.id, a.object_name
  from public.support_attachments a
  where a.message_id is null
    and a.created_at < p_before
  order by a.created_at, a.id
  limit least(greatest(coalesce(p_limit, 0), 0), 1000)
$$;

revoke execute on function public.list_stale_support_attachments(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.list_stale_support_attachments(timestamptz, integer) to service_role;

-- Deletes staged rows by id. A sent attachment is never deleted here, whatever the caller passes.
create function public.delete_staged_support_attachments(p_ids uuid[])
  returns integer
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.support_attachments a
  where a.id = any (coalesce(p_ids, '{}'::uuid[]))
    and a.message_id is null;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.delete_staged_support_attachments(uuid[]) from public, anon, authenticated;
grant execute on function public.delete_staged_support_attachments(uuid[]) to service_role;

-- Objects in the bucket created before p_before that no row names: what a cascade (an account, a
-- thread, or a message deleted) or a half-finished discard leaves behind. The age guard keeps an
-- upload racing its own claim safe.
create function public.list_orphaned_support_objects(p_before timestamptz, p_limit integer)
  returns table (object_name text)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'support-attachments'
    and o.created_at < p_before
    and not exists (select 1 from public.support_attachments a where a.object_name = o.name)
  order by o.created_at, o.name
  limit least(greatest(coalesce(p_limit, 0), 0), 1000)
$$;

revoke execute on function public.list_orphaned_support_objects(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.list_orphaned_support_objects(timestamptz, integer) to service_role;

-- Every object in one owner's folder, a page at a time: account deletion removes them through the
-- Storage API before the account (and with it every row) goes.
create function public.list_owner_support_objects(p_owner_id uuid, p_limit integer)
  returns table (object_name text)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'support-attachments'
    -- A uuid holds no LIKE wildcard, so this is a plain prefix match (name_prefix_search).
    and o.name like p_owner_id::text || '/%'
  order by o.name
  limit least(greatest(coalesce(p_limit, 0), 0), 1000)
$$;

revoke execute on function public.list_owner_support_objects(uuid, integer) from public, anon, authenticated;
grant execute on function public.list_owner_support_objects(uuid, integer) to service_role;
