-- Support chat (#680): conversations between a signed-in user and the instance's super admins.
-- Grant model: see 20261031090000_tenancy.sql. Operators: 20261128120000_super_admins.sql.
--
-- Shaped on BackTalk's support inbox (backtalk-sh at 274976f^1, migrations 0078 to 0093), with the
-- two limits its README records fixed from the start: read state is per operator
-- (support_thread_reads, not one shared column), and email threading is per recipient
-- (support_message_deliveries, not one Message-ID per message).
--
-- * A thread belongs to one user and to no workspace: it outlives the workspace it was opened from,
--   and a viewer, or a member whose workspace is gone, can still reach support. The context columns
--   are a snapshot of where the user was when they wrote (from_page, the workspace and their role
--   in it), taken by the server, so a later rename or role change does not rewrite it. The
--   workspace link nulls out when the workspace is deleted; workspace_name keeps the label.
-- * Unread is derived, never stored: a side has unread activity when last_message_at is after its
--   read marker (user_last_read_at for the owner, the operator's support_thread_reads row for each
--   operator). Operators read independently: opening a thread clears it for that operator only.
-- * Reads: the owner or a super admin (public.is_super_admin()) through row level security, which
--   is also what authorizes the Realtime topics below. Every write goes through the service role,
--   in the functions of 20261128120300_support_chat_functions.sql, so a user can never write a
--   message that renders as an operator's, or forge the context. Operator ids never reach a user:
--   support_messages.author_id and the read markers are not readable by authenticated.
-- * Rate limit: support_rate_limit_counters, keyed by HMACs of the user id and of the client IP
--   (src/lib/support/rate-limit.ts). Only a hash is stored, like public_rate_limit_counters
--   (20261105150000_public_share_surfaces.sql); the retention job deletes counters after a day.
-- * Retention: a thread, its messages, read markers, and delivery records are kept until the user
--   deletes their account (the cascade from auth.users removes them; src/lib/data/account.ts
--   removes the attachment objects first). Nothing ages out on its own.

create type public.support_thread_status as enum ('open', 'replied', 'closed');
create type public.support_sender as enum ('user', 'operator');

-- ── support_threads ─────────────────────────────────────────────────────────────

create table public.support_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The first line of the first message, single-lined and shortened by the server
  -- (supportSubject in src/lib/support/text.ts). It titles the roster row and the email subject, so
  -- it must never carry a line break (an email header injection).
  subject text not null constraint support_threads_subject_format
    check (char_length(subject) between 1 and 120 and subject !~ '[\r\n]'),
  -- open: waiting for an operator. replied: an operator answered last. closed: done. A user writing
  -- again reopens it.
  status public.support_thread_status not null default 'open',
  -- The path the user wrote from, validated by the server as a relative path of the signed-in app
  -- (supportFromPage in src/lib/support/from-page.ts); this check is only the backstop.
  from_page text constraint support_threads_from_page_format
    check (from_page like '/%' and from_page not like '//%' and char_length(from_page) <= 512),
  workspace_id uuid references public.workspaces (id) on delete set null,
  workspace_name text constraint support_threads_workspace_name_length check (char_length(workspace_name) <= 200),
  member_role public.workspace_role,
  created_at timestamptz not null default now(),
  -- Moved by every message, on the database clock.
  last_message_at timestamptz not null default now(),
  -- The owner's read marker; null means never opened by them.
  user_last_read_at timestamptz
);

-- The owner's list and unread count: their threads by recent activity.
create index support_threads_user_recent_idx on public.support_threads (user_id, last_message_at desc, id desc);
-- The operators' active list and unread count, which never include closed threads.
create index support_threads_active_recent_idx on public.support_threads (last_message_at desc, id desc)
  where status <> 'closed';
-- The operators' closed list.
create index support_threads_closed_recent_idx on public.support_threads (last_message_at desc, id desc)
  where status = 'closed';
-- The workspace foreign key nulls out on delete.
create index support_threads_workspace_id_idx on public.support_threads (workspace_id);

alter table public.support_threads enable row level security;
revoke all on table public.support_threads from anon, authenticated;
grant select on table public.support_threads to authenticated;

create policy support_threads_select on public.support_threads for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_super_admin()));

-- ── support_messages ────────────────────────────────────────────────────────────

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.support_threads (id) on delete cascade,
  -- Which side wrote it, set only by the write functions.
  sender public.support_sender not null,
  -- Who wrote it. Null once that account is deleted; the message stays in the conversation.
  author_id uuid references auth.users (id) on delete set null,
  -- Plain text, rendered as text. MESSAGE_MAX_CHARS in src/lib/support/limits.ts mirrors the cap.
  body text not null constraint support_messages_body_format check (char_length(body) between 1 and 4000 and body ~ '\S'),
  created_at timestamptz not null default now()
);

-- A conversation, newest first, one page at a time; also the newest message of each roster row.
create index support_messages_thread_recent_idx on public.support_messages (thread_id, created_at desc, id desc);
-- The author foreign key nulls out on account deletion.
create index support_messages_author_id_idx on public.support_messages (author_id);

alter table public.support_messages enable row level security;
revoke all on table public.support_messages from anon, authenticated;
-- Every column but author_id, which would hand an operator's user id to the user they answered.
grant select (id, thread_id, sender, body, created_at) on table public.support_messages to authenticated;

create policy support_messages_select on public.support_messages for select to authenticated
  using (
    exists (
      select 1
      from public.support_threads t
      where t.id = support_messages.thread_id
        and (t.user_id = (select auth.uid()) or (select public.is_super_admin()))
    )
  );

-- ── support_thread_reads ────────────────────────────────────────────────────────
-- One read marker per operator per thread. Readable by operators only: a row names an operator.

create table public.support_thread_reads (
  thread_id uuid not null references public.support_threads (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  read_at timestamptz not null,
  primary key (thread_id, user_id)
);

-- The user foreign key cascades on account deletion.
create index support_thread_reads_user_id_idx on public.support_thread_reads (user_id);

alter table public.support_thread_reads enable row level security;
revoke all on table public.support_thread_reads from anon, authenticated;
grant select on table public.support_thread_reads to authenticated;

create policy support_thread_reads_select on public.support_thread_reads for select to authenticated
  using ((select public.is_super_admin()));

-- ── support_message_deliveries ──────────────────────────────────────────────────
-- One row per email sent about a message, per recipient. The next email to the same recipient in
-- the same thread answers the last one they received (In-Reply-To) and lists their chain
-- (References), so each operator's copy threads in their own mail client: one Message-ID per
-- message could not, because every recipient's copy has its own. email_provider_id is Resend's id
-- for the send; email_message_id is the RFC 5322 Message-ID Resend gave it, filled in once Resend
-- reports it (src/lib/support/notify.ts), and null until then or when it never does. Service role
-- only. Kept as long as the message.

create table public.support_message_deliveries (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.support_messages (id) on delete cascade,
  thread_id uuid not null references public.support_threads (id) on delete cascade,
  recipient text not null constraint support_message_deliveries_recipient_format
    check (recipient = lower(recipient) and recipient ~ '^[^@\s]+@[^@\s]+$'),
  email_provider_id text constraint support_message_deliveries_provider_id_length check (char_length(email_provider_id) <= 200),
  email_message_id text constraint support_message_deliveries_message_id_format
    check (char_length(email_message_id) <= 998 and email_message_id !~ '[\s]'),
  created_at timestamptz not null default now(),
  constraint support_message_deliveries_message_recipient_key unique (message_id, recipient)
);

-- A recipient's chain in a thread, newest first.
create index support_message_deliveries_chain_idx
  on public.support_message_deliveries (thread_id, recipient, created_at desc);

alter table public.support_message_deliveries enable row level security;
revoke all on table public.support_message_deliveries from anon, authenticated;

-- ── support_rate_limit_counters ─────────────────────────────────────────────────
-- One row per key per window. A key is the lowercase hex HMAC-SHA-256 of a scope and a user id or
-- a client IP, under a key derived from the encryption key, so no IP address or user id is stored.

create table public.support_rate_limit_counters (
  key text not null constraint support_rate_limit_counters_key_format check (key ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  count integer not null default 1 constraint support_rate_limit_counters_count_positive check (count > 0),
  primary key (key, window_start)
);

-- The retention job deletes by age.
create index support_rate_limit_counters_window_start_idx on public.support_rate_limit_counters (window_start);

alter table public.support_rate_limit_counters enable row level security;
revoke all on table public.support_rate_limit_counters from anon, authenticated;

-- ── Realtime ────────────────────────────────────────────────────────────────────
-- Private Broadcast topics, as live refresh uses (20261122210934_live_refresh_broadcast.sql):
--
-- * `support-user:<user id>`, the user's own topic. The user receives it, and so does every
--   operator: an operator joins it to see whether that user is online.
-- * `support-operators`, received by operators only.
--
-- The write functions send on both with realtime.send, inside the write's transaction, so a message
-- goes out only for a write that committed. Event `activity`, payload { thread_id, kind, at } (and
-- operator_id on the operators' topic when an operator read a thread): a hint, never content. A
-- listener reads the thread again through the server on receipt and after every reconnect.
--
-- Presence, one way. Operators must see whether a user is online, and the server checks it before
-- emailing (src/lib/support/presence.ts); a user must never receive the list of operator ids. So:
--
-- * A user tracks presence on their own topic only. Realtime authorizes a track with an insert
--   policy, and this one admits extension `presence` on exactly `support-user:<the caller's id>`:
--   the topic itself names who is online, so a user cannot appear online as somebody else (the
--   presence key is chosen by the client and proves nothing), and cannot track anywhere else.
--   Operators may join that topic to read it, but they never track on it (no policy lets them), so
--   the presence state a user receives on their own topic only ever holds their own tabs.
-- * Operators track on `support-operators`, which only operators can join, so the server can email
--   just the operators who are not online. Users cannot join it at all.
--
-- Neither insert policy admits extension `broadcast`, so no client can send a broadcast on either
-- topic, through Realtime or otherwise. Realtime checks these policies when a channel joins and
-- again when the client sends a new access token, by writing probe rows with the joined topic and
-- reading them back as the user, so the policies read the row's own topic. An operator removed from
-- the env list keeps a joined channel until then: at most the access token lifetime (jwt_expiry in
-- supabase/config.toml).

create policy support_user_topic_select on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and (
      realtime.messages.topic = 'support-user:' || (select auth.uid())::text
      or (realtime.messages.topic like 'support-user:%' and (select public.is_super_admin()))
    )
  );

create policy support_user_topic_track on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and realtime.messages.topic = 'support-user:' || (select auth.uid())::text
  );

create policy support_operators_topic_select on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and realtime.messages.topic = 'support-operators'
    and (select public.is_super_admin())
  );

create policy support_operators_topic_track on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and realtime.messages.topic = 'support-operators'
    and (select public.is_super_admin())
  );
