-- Support chat (#680): the operator mirror (20261128120000_super_admins.sql), the conversation
-- tables and their policies (20261128120100_support_chat.sql), attachments
-- (20261128120200_support_attachments.sql), and the functions every read and write goes through
-- (20261128120300_support_chat_functions.sql).
--
-- The owner reads their own thread, another user cannot, a super admin can, and a super admin whose
-- address left the env list (or whose account email changed) cannot. Operators read independently.
-- The rate limit counts per user and per IP in windows of the database clock. Realtime topics and
-- the attachment bucket answer to the same predicate.
--
-- Everything here runs in one transaction, so now() never moves: support_test.age() moves a
-- thread's timestamps into the past to stand for time passing between two writes.
begin;

create extension if not exists pgtap with schema extensions;

select plan(96);

create schema support_test;
grant usage on schema support_test to anon, authenticated;

-- Rows touched, or -1 when Postgres refuses the statement (42501: a missing grant or a policy).
create function support_test.affected(p_sql text)
returns integer
language plpgsql
as $fn$
declare
  v_count integer;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
exception
  when insufficient_privilege then
    return -1;
end;
$fn$;

grant execute on function support_test.affected(text) to anon, authenticated;

-- Moves every timestamp of a thread, its messages, and its read markers `p_by` into the past.
create function support_test.age(p_thread_id uuid, p_by interval)
returns void
language sql
as $fn$
  update public.support_threads
  set created_at = created_at - p_by, last_message_at = last_message_at - p_by, user_last_read_at = user_last_read_at - p_by
  where id = p_thread_id;
  update public.support_messages set created_at = created_at - p_by where thread_id = p_thread_id;
  update public.support_thread_reads set read_at = read_at - p_by where thread_id = p_thread_id;
$fn$;

-- Ids the functions under test return, kept for later statements. A statement cannot see rows a
-- function it calls wrote (its snapshot predates them), so each call and its check are two
-- statements.
create table support_test.ids (name text primary key, id uuid);
grant select on support_test.ids to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures as postgres: members A and B, operators O and P, R who stops being one, and U, listed
-- but with an email GoTrue never confirmed. O's address is stored in another case than the list.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, email_confirmed_at, created_at, updated_at)
values
  ('68000001-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'support-member-a@example.com', '{"user_name": "support-member-a"}', '{"provider": "github", "providers": ["github"]}', now(), now(), now()),
  ('68000002-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'support-member-b@example.com', '{"user_name": "support-member-b"}', '{"provider": "github", "providers": ["github"]}', now(), now(), now()),
  ('68000003-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'Support-Ops@Example.com', '{"user_name": "support-ops"}', '{"provider": "github", "providers": ["github"]}', now(), now(), now()),
  ('68000004-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'support-ops-two@example.com', '{"user_name": "support-ops-two"}', '{"provider": "github", "providers": ["github"]}', now(), now(), now()),
  ('68000005-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'support-ops-gone@example.com', '{"user_name": "support-ops-gone"}', '{"provider": "github", "providers": ["github"]}', now(), now(), now()),
  ('68000006-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'support-ops-unconfirmed@example.com', '{"user_name": "support-ops-unconfirmed"}', '{"provider": "email", "providers": ["email"]}', null, now(), now());

insert into public.workspaces (id, name, created_by)
values ('680000a0-0000-4000-8000-000000000000', 'Support Acme', '68000001-0000-4000-8000-000000000000');

insert into public.workspace_members (workspace_id, user_id, role)
values ('680000a0-0000-4000-8000-000000000000', '68000001-0000-4000-8000-000000000000', 'owner');

-- ---------------------------------------------------------------------------
-- The operator mirror.
-- ---------------------------------------------------------------------------
select ok(
  public.sync_super_admin('68000003-0000-4000-8000-000000000000',
    array['support-ops@example.com', 'support-ops-two@example.com', 'support-ops-gone@example.com', 'support-ops-unconfirmed@example.com']),
  'sync: a listed account with a confirmed email gets its row, whatever the case of its address');
select ok(
  public.sync_super_admin('68000004-0000-4000-8000-000000000000',
    array['support-ops@example.com', 'support-ops-two@example.com', 'support-ops-gone@example.com']),
  'sync: a second listed account gets its own row');
select ok(
  public.sync_super_admin('68000005-0000-4000-8000-000000000000',
    array['support-ops@example.com', 'support-ops-two@example.com', 'support-ops-gone@example.com']),
  'sync: a third listed account gets its own row');
select is(
  public.sync_super_admin('68000006-0000-4000-8000-000000000000', array['support-ops-unconfirmed@example.com']), false,
  'sync: a listed address GoTrue never confirmed gets no row');
select is(
  public.sync_super_admin('68000001-0000-4000-8000-000000000000', array['support-ops@example.com']), false,
  'sync: an account that is not listed gets no row');
select results_eq(
  $$ select user_id, email from public.super_admins where user_id::text like '6800000%' order by email $$,
  $$
    values
      ('68000005-0000-4000-8000-000000000000'::uuid, 'support-ops-gone@example.com'),
      ('68000004-0000-4000-8000-000000000000'::uuid, 'support-ops-two@example.com'),
      ('68000003-0000-4000-8000-000000000000'::uuid, 'support-ops@example.com')
  $$,
  'sync: rows hold the listed address, lowercased, for the listed accounts only');

select is(
  public.sync_super_admin('68000004-0000-4000-8000-000000000000', array['support-ops@example.com']), false,
  'sync: a user with a row who is no longer listed loses it on the next check');
select ok(
  not exists (select 1 from public.super_admins where user_id = '68000004-0000-4000-8000-000000000000'),
  'sync: the unlisted user''s row is gone');
select ok(
  public.sync_super_admin('68000004-0000-4000-8000-000000000000', array['support-ops@example.com', 'support-ops-two@example.com']),
  'sync: listing them again restores the row');

set local role authenticated;
set local request.jwt.claims to '{"sub": "68000005-0000-4000-8000-000000000000", "role": "authenticated"}';
select ok(public.is_super_admin(), 'is_super_admin: true for a caller with a row');
reset role;
reset request.jwt.claims;

update auth.users set email = 'support-ops-renamed@example.com' where id = '68000005-0000-4000-8000-000000000000';

set local role authenticated;
set local request.jwt.claims to '{"sub": "68000005-0000-4000-8000-000000000000", "role": "authenticated"}';
select is(public.is_super_admin(), false, 'is_super_admin: false at once when the account email no longer matches the row');
reset role;
reset request.jwt.claims;

select is(
  public.reconcile_super_admins(array['support-ops@example.com', 'support-ops-two@example.com', 'support-ops-gone@example.com']), 1,
  'reconcile: deletes the row whose account email is no longer the listed one');
select is(
  public.reconcile_super_admins(array['support-ops@example.com', 'support-ops-two@example.com']), 0,
  'reconcile: keeps every row whose account email is listed, and deletes nothing twice');

update auth.users set email = 'support-ops-gone@example.com' where id = '68000005-0000-4000-8000-000000000000';
select ok(
  public.sync_super_admin('68000005-0000-4000-8000-000000000000',
    array['support-ops@example.com', 'support-ops-two@example.com', 'support-ops-gone@example.com']),
  'reconcile: R is listed again for the next check');
select is(
  public.reconcile_super_admins(array['support-ops@example.com', 'support-ops-two@example.com']), 1,
  'reconcile: an address removed from the env list loses its row at boot');

set local role authenticated;
set local request.jwt.claims to '{"sub": "68000003-0000-4000-8000-000000000000", "role": "authenticated"}';
select ok(public.is_super_admin(), 'is_super_admin: true for a listed operator');
set local request.jwt.claims to '{"sub": "68000005-0000-4000-8000-000000000000", "role": "authenticated"}';
select is(public.is_super_admin(), false, 'is_super_admin: false for an operator removed from the list');
set local request.jwt.claims to '{"sub": "68000001-0000-4000-8000-000000000000", "role": "authenticated"}';
select is(public.is_super_admin(), false, 'is_super_admin: false for a user who was never listed');
select throws_ok($$ select user_id from public.super_admins $$, '42501'::char(5), null::text,
  'super_admins: a signed-in user cannot read the table');
select throws_ok($$ select public.is_super_admin_user('68000003-0000-4000-8000-000000000000') $$, '42501'::char(5), null::text,
  'is_super_admin_user: not callable from the Data API, so nobody can ask about another user');
reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- A starts a conversation from the workspace; B starts one with no workspace.
-- ---------------------------------------------------------------------------
insert into support_test.ids (name, id)
select 'thread_a', s.thread_id
from public.support_start_thread(
  '68000001-0000-4000-8000-000000000000', 'Why is the total zero', 'Why is the total zero on the dashboard?', '{}',
  '/w/acme/dashboard', '680000a0-0000-4000-8000-000000000000', 'Support Acme', 'owner'
) as s;

insert into support_test.ids (name, id)
select 'thread_b', s.thread_id
from public.support_start_thread(
  '68000002-0000-4000-8000-000000000000', 'Hello', 'Hello there', '{}', null,
  '680000a0-0000-4000-8000-000000000000', 'Support Acme', 'owner'
) as s;

select results_eq(
  $$
    select t.subject, t.status::text, t.from_page, t.workspace_name, t.member_role::text, t.user_last_read_at = t.last_message_at
    from public.support_threads t
    where t.id = (select id from support_test.ids where name = 'thread_a')
  $$,
  $$ values ('Why is the total zero', 'open', '/w/acme/dashboard', 'Support Acme', 'owner', true) $$,
  'start: the thread keeps the context snapshot and is read by its author from the start');
select results_eq(
  $$
    select t.workspace_id, t.workspace_name, t.member_role::text
    from public.support_threads t
    where t.id = (select id from support_test.ids where name = 'thread_b')
  $$,
  $$ values (null::uuid, null::text, null::text) $$,
  'start: a workspace the user is not a member of is left out of the snapshot');

select results_eq(
  $$
    select m.topic, m.payload ->> 'kind', m.payload - 'id' - 'at' - 'kind' - 'thread_id'
    from realtime.messages m
    where m.topic in ('support-user:68000001-0000-4000-8000-000000000000', 'support-operators')
      and m.payload ->> 'thread_id' = (select id::text from support_test.ids where name = 'thread_a')
    order by m.topic
  $$,
  $$
    values
      ('support-operators', 'message', '{}'::jsonb),
      ('support-user:68000001-0000-4000-8000-000000000000', 'message', '{}'::jsonb)
  $$,
  'start: one hint on the user''s topic and one on the operators'' topic, carrying no content');

-- ---------------------------------------------------------------------------
-- Reading: the owner, another user, an operator, a removed operator, anon.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub": "68000001-0000-4000-8000-000000000000", "role": "authenticated"}';

select results_eq(
  $$ select t.id from public.support_threads t where t.user_id::text like '6800000%' $$,
  $$ select id from support_test.ids where name = 'thread_a' $$,
  'rls: the owner reads their own thread, and only it');
select is(
  (select count(*)::int from public.support_messages m where m.thread_id = (select id from support_test.ids where name = 'thread_a')), 1,
  'rls: the owner reads the messages of their thread');
select throws_ok($$ select author_id from public.support_messages $$, '42501'::char(5), null::text,
  'rls: nobody reads author_id through the Data API, so an operator id never reaches a user');
select is((select count(*)::int from public.support_thread_reads), 0, 'rls: a user reads no operator read marker');
select is(support_test.affected($$
    insert into public.support_threads (user_id, subject) values ('68000001-0000-4000-8000-000000000000', 'Forged')
  $$), -1, 'rls: a user cannot insert a thread');
select is(support_test.affected($$
    insert into public.support_messages (thread_id, sender, body)
    values ((select id from support_test.ids where name = 'thread_a'), 'operator', 'Forged reply')
  $$), -1, 'rls: a user cannot insert a message, least of all one that renders as an operator''s');
select is(support_test.affected($$
    update public.support_threads set status = 'closed' where user_id = '68000001-0000-4000-8000-000000000000'
  $$), -1, 'rls: a user cannot change their thread');
select throws_ok(
  $$ select * from public.support_send_member_message((select id from support_test.ids where name = 'thread_a'), '68000001-0000-4000-8000-000000000000', 'x', '{}') $$,
  '42501'::char(5), null::text,
  'rls: a user cannot call the write functions');

set local request.jwt.claims to '{"sub": "68000002-0000-4000-8000-000000000000", "role": "authenticated"}';

select is_empty(
  $$ select t.id from public.support_threads t where t.id = (select id from support_test.ids where name = 'thread_a') $$,
  'rls: another user cannot read the thread');
select is_empty(
  $$ select m.id from public.support_messages m where m.thread_id = (select id from support_test.ids where name = 'thread_a') $$,
  'rls: another user cannot read its messages');

set local request.jwt.claims to '{"sub": "68000003-0000-4000-8000-000000000000", "role": "authenticated"}';

select results_eq(
  $$ select t.id from public.support_threads t where t.user_id::text like '6800000%' order by t.subject $$,
  $$ select id from support_test.ids where name in ('thread_b', 'thread_a') order by name desc $$,
  'rls: a super admin reads every user''s thread');
select is(
  (select count(*)::int from public.support_messages m where m.thread_id = (select id from support_test.ids where name = 'thread_a')), 1,
  'rls: a super admin reads the messages');

set local request.jwt.claims to '{"sub": "68000005-0000-4000-8000-000000000000", "role": "authenticated"}';

select is_empty(
  $$ select t.id from public.support_threads t where t.user_id::text like '6800000%' $$,
  'rls: a super admin removed from the list reads no other user''s thread');

reset role;
reset request.jwt.claims;

set local role anon;
set local request.jwt.claims to '{"role": "anon"}';
select throws_ok($$ select id from public.support_threads $$, '42501'::char(5), null::text, 'rls: anon cannot read threads');
reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Writing: ownership, operators, unread per reader, read markers, status.
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select * from public.support_send_member_message((select id from support_test.ids where name = 'thread_a'), '68000002-0000-4000-8000-000000000000', 'Not mine', '{}') $$,
  'send: a user cannot write into someone else''s thread (no row, the same answer as a missing thread)');
select throws_ok(
  $$ select * from public.support_operator_reply((select id from support_test.ids where name = 'thread_a'), '68000005-0000-4000-8000-000000000000', 'Hi', '{}') $$,
  '42501'::char(5), null::text,
  'reply: an operator removed from the list cannot reply');

select support_test.age((select id from support_test.ids where name = 'thread_a'), interval '10 minutes');

select results_eq(
  $$
    select r.member_id
    from public.support_operator_reply((select id from support_test.ids where name = 'thread_a'), '68000003-0000-4000-8000-000000000000', 'Looking now.', '{}') as r
  $$,
  $$ values ('68000001-0000-4000-8000-000000000000'::uuid) $$,
  'reply: an operator replies and learns whose thread it is');
select results_eq(
  $$ select t.status::text, t.last_message_at = now() from public.support_threads t where t.id = (select id from support_test.ids where name = 'thread_a') $$,
  $$ values ('replied', true) $$,
  'reply: the thread is replied and its last activity is the reply');

select is(public.support_member_unread_count('68000001-0000-4000-8000-000000000000'), 1, 'unread: the reply is unread for the owner');
select results_eq(
  $$
    select t.subject, t.last_message_at > coalesce(t.read_at, '-infinity'::timestamptz)
    from public.support_operator_threads('68000003-0000-4000-8000-000000000000', false, 100) as t
    where t.user_id::text like '6800000%'
    order by t.subject
  $$,
  $$ values ('Hello', true), ('Why is the total zero', false) $$,
  'unread: the reply is read for the operator who wrote it; the untouched thread is unread for them');
select results_eq(
  $$
    select t.subject, t.last_message_at > coalesce(t.read_at, '-infinity'::timestamptz)
    from public.support_operator_threads('68000004-0000-4000-8000-000000000000', false, 100) as t
    where t.user_id::text like '6800000%'
    order by t.subject
  $$,
  $$ values ('Hello', true), ('Why is the total zero', true) $$,
  'unread: a second operator has both threads unread, independently of the first');

select ok(
  public.support_mark_read_by_member((select id from support_test.ids where name = 'thread_a'), '68000001-0000-4000-8000-000000000000', now()),
  'read: the owner reading through the reply advances their marker');
select is(public.support_member_unread_count('68000001-0000-4000-8000-000000000000'), 0, 'read: the owner has nothing unread');
select is(
  public.support_mark_read_by_member((select id from support_test.ids where name = 'thread_a'), '68000001-0000-4000-8000-000000000000', now()), false,
  'read: reading again advances nothing');
select is(
  public.support_mark_read_by_member((select id from support_test.ids where name = 'thread_a'), '68000002-0000-4000-8000-000000000000', now()), false,
  'read: another user cannot move the owner''s marker');

select ok(
  public.support_mark_read_by_operator((select id from support_test.ids where name = 'thread_a'), '68000004-0000-4000-8000-000000000000', now()),
  'read: the second operator reads the thread');
select results_eq(
  $$
    select r.user_id from public.support_thread_reads r
    where r.thread_id = (select id from support_test.ids where name = 'thread_a') order by r.user_id
  $$,
  $$ values ('68000003-0000-4000-8000-000000000000'::uuid), ('68000004-0000-4000-8000-000000000000'::uuid) $$,
  'read: each operator has their own marker');
select results_eq(
  $$
    select m.payload ->> 'kind', m.payload ->> 'operator_id'
    from realtime.messages m
    where m.topic = 'support-operators' and m.payload ->> 'kind' = 'read'
      and m.payload ->> 'thread_id' = (select id::text from support_test.ids where name = 'thread_a')
  $$,
  $$ values ('read', '68000004-0000-4000-8000-000000000000') $$,
  'read: the operators'' topic names the operator who read, so only their tabs update');
select is_empty(
  $$ select 1 from realtime.messages m where m.topic like 'support-user:6800000%' and m.payload ? 'operator_id' $$,
  'read: the user''s topic never carries an operator id');

-- The user writes again later. The second operator vouches only for what they saw before it.
select support_test.age((select id from support_test.ids where name = 'thread_a'), interval '5 minutes');
select results_eq(
  $$
    select s.created_at = now()
    from public.support_send_member_message((select id from support_test.ids where name = 'thread_a'), '68000001-0000-4000-8000-000000000000', 'Still zero.', '{}') as s
  $$,
  $$ values (true) $$,
  'send: the owner writes into their own thread');
select results_eq(
  $$ select t.status::text from public.support_threads t where t.id = (select id from support_test.ids where name = 'thread_a') $$,
  $$ values ('open') $$,
  'send: writing reopens the thread for the operators');
select ok(
  public.support_mark_read_by_operator((select id from support_test.ids where name = 'thread_a'), '68000004-0000-4000-8000-000000000000', now() - interval '1 minute'),
  'read: an operator marks what their screen showed, a minute before the new message');
select ok(
  public.support_operator_unread_count('68000004-0000-4000-8000-000000000000') >= 1
    and (select r.read_at < t.last_message_at from public.support_thread_reads r join public.support_threads t on t.id = r.thread_id
         where r.thread_id = (select id from support_test.ids where name = 'thread_a') and r.user_id = '68000004-0000-4000-8000-000000000000'),
  'read: a marker never covers a message newer than what the reader saw');

select is(
  public.support_set_thread_status((select id from support_test.ids where name = 'thread_a'), '68000004-0000-4000-8000-000000000000', 'closed', now() - interval '1 minute'),
  'newer_message',
  'status: closing over a message the operator has not seen is refused');
select is(
  public.support_set_thread_status((select id from support_test.ids where name = 'thread_a'), '68000004-0000-4000-8000-000000000000', 'closed', now()),
  'updated',
  'status: closing after seeing everything closes it');
select is(
  public.support_set_thread_status((select id from support_test.ids where name = 'thread_a'), '68000004-0000-4000-8000-000000000000', 'closed', now()),
  'unchanged',
  'status: closing a closed thread changes nothing');
select is(
  public.support_set_thread_status('00000000-0000-4000-8000-000000000000', '68000004-0000-4000-8000-000000000000', 'closed', now()),
  null,
  'status: a thread that does not exist answers null');
select throws_ok(
  $$ select public.support_set_thread_status((select id from support_test.ids where name = 'thread_a'), '68000004-0000-4000-8000-000000000000', 'replied', now()) $$,
  '22023'::char(5), null::text,
  'status: replied is set by a reply, never directly');
select results_eq(
  $$
    select t.subject, t.status::text
    from public.support_operator_threads('68000003-0000-4000-8000-000000000000', false, 100) as t
    where t.user_id::text like '6800000%'
  $$,
  $$ values ('Hello', 'open') $$,
  'lists: a closed thread leaves the operators'' active list, which every unread count follows');
select results_eq(
  $$
    select t.subject, t.status::text
    from public.support_operator_threads('68000003-0000-4000-8000-000000000000', true, 100) as t
    where t.user_id::text like '6800000%'
  $$,
  $$ values ('Why is the total zero', 'closed') $$,
  'lists: and joins the closed list');

-- ---------------------------------------------------------------------------
-- Rate limit: windows of the database clock, per user key and per IP key.
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select r.window_start = date_bin(interval '60 seconds', now(), 'epoch'::timestamptz), r.user_current, r.user_previous, r.ip_current, r.ip_previous
     from public.bump_support_rate_limit(repeat('a', 64), repeat('b', 64), 60) as r $$,
  $$ values (true, 1, 0, 1, 0) $$,
  'rate limit: the first attempt counts one for the user and one for the IP, in the window that holds now');
select results_eq(
  $$ select r.user_current, r.user_previous, r.ip_current, r.ip_previous from public.bump_support_rate_limit(repeat('a', 64), repeat('b', 64), 60) as r $$,
  $$ values (2, 0, 2, 0) $$,
  'rate limit: the second attempt in the same window counts two');
select results_eq(
  $$ select r.user_current, r.ip_current from public.bump_support_rate_limit(repeat('c', 64), repeat('b', 64), 60) as r $$,
  $$ values (1, 3) $$,
  'rate limit: another user behind the same IP starts their own count and adds to the IP''s');

insert into public.support_rate_limit_counters (key, window_start, count)
values (repeat('a', 64), date_bin(interval '60 seconds', now(), 'epoch'::timestamptz) - interval '60 seconds', 4),
       (repeat('a', 64), date_bin(interval '60 seconds', now(), 'epoch'::timestamptz) - interval '120 seconds', 9);

select results_eq(
  $$ select r.user_current, r.user_previous, r.ip_previous from public.bump_support_rate_limit(repeat('a', 64), repeat('b', 64), 60) as r $$,
  $$ values (3, 4, 0) $$,
  'rate limit: the window before counts, the one before that does not');
select ok(
  (select extract(epoch from r.window_start)::bigint % 300 = 0 and r.window_start <= now() and now() < r.window_start + interval '300 seconds'
   from public.bump_support_rate_limit(repeat('d', 64), repeat('e', 64), 300) as r),
  'rate limit: a window starts on a multiple of its width since the epoch and holds now');
select throws_ok($$ select * from public.bump_support_rate_limit(repeat('a', 64), repeat('b', 64), 0) $$, '22023'::char(5), null::text,
  'rate limit: a window of zero seconds is refused');
select throws_ok($$ select * from public.bump_support_rate_limit('not-a-hash', repeat('b', 64), 60) $$, '23514'::char(5), null::text,
  'rate limit: a key that is not a hash is refused, so no raw IP or user id is ever stored');
select ok(
  public.purge_support_rate_limit_counters(date_bin(interval '60 seconds', now(), 'epoch'::timestamptz) - interval '60 seconds', 100) >= 1,
  'rate limit: retention deletes counters');
select ok(
  not exists (
    select 1 from public.support_rate_limit_counters c
    where c.key = repeat('a', 64) and c.window_start < date_bin(interval '60 seconds', now(), 'epoch'::timestamptz) - interval '60 seconds'
  )
  and exists (
    select 1 from public.support_rate_limit_counters c
    where c.key = repeat('a', 64) and c.window_start = date_bin(interval '60 seconds', now(), 'epoch'::timestamptz) - interval '60 seconds'
  ),
  'rate limit: retention deletes the windows that started before the cutoff and keeps the rest');

-- ---------------------------------------------------------------------------
-- Realtime: realtime.authorize is what Realtime runs on a join (see 41_live_refresh_broadcast).
-- Arrays are (broadcast, presence).
-- ---------------------------------------------------------------------------
select results_eq(
  $$
    select read_allowed, write_allowed
    from realtime.authorize('authenticated', 'support-user:68000001-0000-4000-8000-000000000000',
      '{"sub": "68000001-0000-4000-8000-000000000000", "role": "authenticated"}', '68000001-0000-4000-8000-000000000000', '{}',
      array['broadcast', 'presence'], array['broadcast', 'presence'])
  $$,
  $$ values (array[true, true], array[false, true]) $$,
  'realtime: a user receives their own topic and tracks presence there, and sends no broadcast');
select results_eq(
  $$
    select read_allowed, write_allowed
    from realtime.authorize('authenticated', 'support-user:68000001-0000-4000-8000-000000000000',
      '{"sub": "68000002-0000-4000-8000-000000000000", "role": "authenticated"}', '68000002-0000-4000-8000-000000000000', '{}',
      array['broadcast', 'presence'], array['broadcast', 'presence'])
  $$,
  $$ values (array[false, false], array[false, false]) $$,
  'realtime: another user can neither join nor track on a user''s topic');
select results_eq(
  $$
    select read_allowed, write_allowed
    from realtime.authorize('authenticated', 'support-operators',
      '{"sub": "68000001-0000-4000-8000-000000000000", "role": "authenticated"}', '68000001-0000-4000-8000-000000000000', '{}',
      array['broadcast', 'presence'], array['broadcast', 'presence'])
  $$,
  $$ values (array[false, false], array[false, false]) $$,
  'realtime: a user cannot join the operators'' topic, so never learns who the operators are');
select results_eq(
  $$
    select read_allowed, write_allowed
    from realtime.authorize('authenticated', 'support-user:68000001-0000-4000-8000-000000000000',
      '{"sub": "68000003-0000-4000-8000-000000000000", "role": "authenticated"}', '68000003-0000-4000-8000-000000000000', '{}',
      array['broadcast', 'presence'], array['broadcast', 'presence'])
  $$,
  $$ values (array[true, true], array[false, false]) $$,
  'realtime: an operator reads a user''s topic and presence, and never tracks there');
select results_eq(
  $$
    select read_allowed, write_allowed
    from realtime.authorize('authenticated', 'support-operators',
      '{"sub": "68000003-0000-4000-8000-000000000000", "role": "authenticated"}', '68000003-0000-4000-8000-000000000000', '{}',
      array['broadcast', 'presence'], array['broadcast', 'presence'])
  $$,
  $$ values (array[true, true], array[false, true]) $$,
  'realtime: an operator joins the operators'' topic and tracks presence there, and sends no broadcast');
select results_eq(
  $$
    select read_allowed, write_allowed
    from realtime.authorize('authenticated', 'support-operators',
      '{"sub": "68000005-0000-4000-8000-000000000000", "role": "authenticated"}', '68000005-0000-4000-8000-000000000000', '{}',
      array['broadcast', 'presence'], array['broadcast', 'presence'])
  $$,
  $$ values (array[false, false], array[false, false]) $$,
  'realtime: an operator removed from the list is refused the operators'' topic');
select results_eq(
  $$
    select read_allowed
    from realtime.authorize('anon', 'support-user:68000001-0000-4000-8000-000000000000', '{"role": "anon"}', '', '{}',
      array['broadcast', 'presence'], '{}')
  $$,
  $$ values (array[false, false]) $$,
  'realtime: anon receives nothing');

-- ---------------------------------------------------------------------------
-- Attachments: claims, the bucket's policies, and the bind.
-- ---------------------------------------------------------------------------
insert into support_test.ids (name, id)
select 'claim_a', s.attachment_id
from public.stage_support_attachment('68000001-0000-4000-8000-000000000000', 'screen.png', 'image/png', 2048, 20,
  (select id from support_test.ids where name = 'thread_a')) as s;

select results_eq(
  $$
    select s.refusal
    from (
      values
        (1, '68000001-0000-4000-8000-000000000000'::uuid, 'thread_a', 'image/svg+xml', 10::bigint),
        (2, '68000001-0000-4000-8000-000000000000'::uuid, 'thread_a', 'image/png', 0::bigint),
        (3, '68000001-0000-4000-8000-000000000000'::uuid, 'thread_a', 'image/png', 10485761::bigint),
        (4, '68000002-0000-4000-8000-000000000000'::uuid, 'thread_a', 'image/png', 10::bigint),
        (5, '68000005-0000-4000-8000-000000000000'::uuid, 'thread_a', 'image/png', 10::bigint)
    ) as c(n, uploader, thread, mime, bytes)
    cross join lateral public.stage_support_attachment(c.uploader, 'x.png', c.mime, c.bytes, 20,
      (select id from support_test.ids where name = c.thread)) as s
    order by c.n
  $$,
  $$ values ('mime'), ('bytes'), ('bytes'), ('thread'), ('thread') $$,
  'claim: refuses SVG, an empty file, one byte over 10 MiB, another user''s thread, and a removed operator');
select results_eq(
  $$
    select a.object_name ~ ('^68000001-0000-4000-8000-000000000000/' || a.id || '\.png$'), a.owner_id, a.uploader_id, a.message_id
    from public.support_attachments a where a.id = (select id from support_test.ids where name = 'claim_a')
  $$,
  $$ values (true, '68000001-0000-4000-8000-000000000000'::uuid, '68000001-0000-4000-8000-000000000000'::uuid, null::uuid) $$,
  'claim: the object is named in the owner''s folder by the server, with the extension of its type');
insert into support_test.ids (name, id)
select 'claim_o', s.attachment_id
from public.stage_support_attachment('68000003-0000-4000-8000-000000000000', 'reply.webp', 'image/webp', 100, 20,
  (select id from support_test.ids where name = 'thread_a')) as s;
select results_eq(
  $$
    select a.owner_id, a.uploader_id, a.object_name like '68000001-0000-4000-8000-000000000000/%.webp'
    from public.support_attachments a where a.id = (select id from support_test.ids where name = 'claim_o')
  $$,
  $$ values ('68000001-0000-4000-8000-000000000000'::uuid, '68000003-0000-4000-8000-000000000000'::uuid, true) $$,
  'claim: an operator answering a user claims into that user''s folder');
select is(
  (select s.refusal from public.stage_support_attachment('68000001-0000-4000-8000-000000000000', 'x.png', 'image/png', 10, 1) as s),
  'staged_cap',
  'claim: the per-uploader cap on unsent attachments refuses one more');

set local role authenticated;
set local request.jwt.claims to '{"sub": "68000001-0000-4000-8000-000000000000", "role": "authenticated"}';

select is(support_test.affected(format(
    $$ insert into storage.objects (bucket_id, name) values ('support-attachments', %L) $$,
    (select a.object_name from public.support_attachments a where a.id = (select id from support_test.ids where name = 'claim_a'))
  )), 1, 'bucket: the uploader stores the object they claimed');
select is(support_test.affected(
    $$ insert into storage.objects (bucket_id, name) values ('support-attachments', '68000001-0000-4000-8000-000000000000/unclaimed.png') $$
  ), -1, 'bucket: an unclaimed name is refused, even in the uploader''s own folder');

set local request.jwt.claims to '{"sub": "68000002-0000-4000-8000-000000000000", "role": "authenticated"}';

select is(support_test.affected(
    $$ insert into storage.objects (bucket_id, name) values ('support-attachments', '68000002-0000-4000-8000-000000000000/' || gen_random_uuid() || '.png') $$
  ), -1, 'bucket: another user cannot upload a name they did not claim');
select is_empty(
  $$ select o.name from storage.objects o where o.bucket_id = 'support-attachments' and o.name like '68000001-0000-4000-8000-000000000000/%' $$,
  'bucket: another user cannot read the owner''s folder');

reset role;
reset request.jwt.claims;

select throws_ok(
  $$ select * from public.support_send_member_message((select id from support_test.ids where name = 'thread_b'), '68000002-0000-4000-8000-000000000000', 'With an image', array[(select id from support_test.ids where name = 'claim_a')]) $$,
  'P0002'::char(5), null::text,
  'bind: another user''s attachment cannot be sent, and the message is not written');
insert into support_test.ids (name, id)
select 'message_with_image', s.message_id
from public.support_send_member_message((select id from support_test.ids where name = 'thread_a'), '68000001-0000-4000-8000-000000000000',
  'Here is the screen.', array[(select id from support_test.ids where name = 'claim_a')]) as s;
select results_eq(
  $$ select a.message_id from public.support_attachments a where a.id = (select id from support_test.ids where name = 'claim_a') $$,
  $$ select id from support_test.ids where name = 'message_with_image' $$,
  'bind: the uploader sends the attachment with their message');
select throws_ok(
  $$ select * from public.support_send_member_message((select id from support_test.ids where name = 'thread_a'), '68000001-0000-4000-8000-000000000000', 'Again',
       array[(select id from support_test.ids where name = 'claim_a')]) $$,
  'P0002'::char(5), null::text,
  'bind: a sent attachment cannot be sent twice');
select results_eq(
  $$
    select m.body, jsonb_array_length(m.attachments), m.attachments -> 0 ->> 'mime'
    from public.support_thread_messages((select id from support_test.ids where name = 'thread_a'), 200) as m
    where m.id = (select id from support_test.ids where name = 'message_with_image')
  $$,
  $$ values ('Here is the screen.', 1, 'image/png') $$,
  'messages: a message carries its attachment, with its type');

select ok(
  exists (select 1 from public.list_stale_support_attachments(now() + interval '1 hour', 100) s
          join public.support_attachments a on a.id = s.id where a.uploader_id = '68000003-0000-4000-8000-000000000000'),
  'sweep: an unsent attachment is listed once it is older than the cutoff');
select ok(
  not exists (select 1 from public.list_stale_support_attachments(now() + interval '1 hour', 100) s
              where s.id = (select id from support_test.ids where name = 'claim_a')),
  'sweep: a sent attachment is never listed');

-- An object no row names, as a cascade leaves behind.
insert into storage.objects (bucket_id, name) values ('support-attachments', '68000001-0000-4000-8000-000000000000/orphan.png');
select ok(
  exists (select 1 from public.list_orphaned_support_objects(now() + interval '1 hour', 1000) o
          where o.object_name = '68000001-0000-4000-8000-000000000000/orphan.png'),
  'sweep: an object no row names is listed as an orphan');
select results_eq(
  $$ select o.object_name like '68000001-0000-4000-8000-000000000000/%' from public.list_owner_support_objects('68000001-0000-4000-8000-000000000000', 1000) o $$,
  $$ values (true), (true) $$,
  'account deletion: every object in the owner''s folder is listed, theirs and the orphan alike');

-- ---------------------------------------------------------------------------
-- Deleting the account removes its threads, messages, markers, and attachment rows.
-- ---------------------------------------------------------------------------
delete from auth.users where id = '68000001-0000-4000-8000-000000000000';

select is(
  (select count(*)::int from public.support_threads where id = (select id from support_test.ids where name = 'thread_a'))
  + (select count(*)::int from public.support_messages where thread_id = (select id from support_test.ids where name = 'thread_a'))
  + (select count(*)::int from public.support_thread_reads where thread_id = (select id from support_test.ids where name = 'thread_a'))
  + (select count(*)::int from public.support_attachments where owner_id = '68000001-0000-4000-8000-000000000000'),
  0,
  'account deletion: the cascade removes the thread, its messages, read markers, and attachment rows');

select * from finish();
rollback;
