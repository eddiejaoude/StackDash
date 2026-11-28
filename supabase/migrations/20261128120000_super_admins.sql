-- Super admins mirrored into the database (#680). Grant model: see 20261031090000_tenancy.sql.
--
-- Until now a super admin existed only in STACKDASH_SUPER_ADMIN_EMAILS (src/lib/auth/super-admin.ts
-- said "there is no database role"). Support chat needs Postgres itself to know who the operators
-- are: Realtime authorizes a private channel join through select policies on realtime.messages, and
-- Storage authorizes reads through policies on storage.objects, and a policy can only read the
-- database. BackTalk hit the same wall and moved its admins into a table (backtalk-sh README at
-- 274976f^1, "Who is an admin"). The decision and its options table are on issue #680, first comment.
--
-- The env list stays the one source of truth; this table is a mirror of it that is easy to empty:
--
-- * At every server start, src/instrumentation.ts calls reconcile_super_admins with the env list
--   and every row whose account email is not on it is deleted. An empty list empties the table, so
--   removing an address and redeploying revokes it.
-- * On every super admin check (requireSuperAdmin and showsAdminLink), the server calls
--   sync_super_admin for the signed-in user: a listed account with a confirmed email gets its row,
--   and an account that is no longer listed loses it, so removal also lands before the next start.
-- * is_super_admin() compares the row's email with the account's current email, so an account that
--   changes its address stops being an operator in the database at once, before either reconcile
--   runs again.
--
-- Nothing outside the service role reads or writes the table: row level security is on with no
-- policy, and anon and authenticated hold no grant. is_super_admin() is the only way a policy or a
-- signed-in caller learns anything from it, and it answers only for the caller.

create table public.super_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- The listed address the row was written for, lowercased, as STACKDASH_SUPER_ADMIN_EMAILS is
  -- matched (superAdminEmails in src/lib/env.ts). is_super_admin() requires it to still be the
  -- account's email.
  email text not null constraint super_admins_email_format check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'),
  created_at timestamptz not null default now()
);

alter table public.super_admins enable row level security;
revoke all on table public.super_admins from anon, authenticated;

-- ── is_super_admin_user ─────────────────────────────────────────────────────────
-- True when the user has a row and the row's email is still the account's email. The one
-- definition of "operator" in the database: is_super_admin() asks it about the caller, and the
-- support write functions ask it about the operator the server passes in. Not callable from the
-- Data API: with an argument it would tell anyone who the operators are.

create function public.is_super_admin_user(p_user_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1
    from public.super_admins s
    join auth.users u on u.id = s.user_id
    where s.user_id = p_user_id
      and lower(u.email) = s.email
  )
$$;

revoke execute on function public.is_super_admin_user(uuid) from public, anon, authenticated, service_role;

-- ── is_super_admin ──────────────────────────────────────────────────────────────
-- is_super_admin_user for the caller. Security definer so a policy evaluated as the caller can read
-- a table the caller cannot. No argument: it reports one bit about the caller and nothing about
-- anyone else, which is why authenticated may run it (every support policy on realtime.messages,
-- storage.objects, and the support tables calls it as the caller's own role). Policies wrap it in
-- `(select ...)` so it runs once per statement.

create function public.is_super_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select public.is_super_admin_user((select auth.uid()))
$$;

revoke execute on function public.is_super_admin() from public, anon, authenticated;
grant execute on function public.is_super_admin() to authenticated, service_role;

-- ── sync_super_admin ────────────────────────────────────────────────────────────
-- The request-time reconcile for one user. p_listed_emails is STACKDASH_SUPER_ADMIN_EMAILS,
-- lowercased by the caller. The decision reads the account's current email from auth.users rather
-- than trusting the session's copy: a listed address that GoTrue has confirmed gets (or refreshes)
-- the row, anything else loses it. Returns whether the user has a row afterwards.

create function public.sync_super_admin(p_user_id uuid, p_listed_emails text[])
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_email text;
begin
  select lower(u.email) into v_email
  from auth.users u
  where u.id = p_user_id
    and u.email_confirmed_at is not null
    and lower(u.email) = any (coalesce(p_listed_emails, '{}'::text[]));

  if v_email is null then
    delete from public.super_admins s where s.user_id = p_user_id;
    return false;
  end if;

  insert into public.super_admins as s (user_id, email)
  values (p_user_id, v_email)
  on conflict (user_id) do update set email = excluded.email
  where s.email is distinct from excluded.email;
  return true;
end;
$$;

revoke execute on function public.sync_super_admin(uuid, text[]) from public, anon, authenticated;
grant execute on function public.sync_super_admin(uuid, text[]) to service_role;

-- ── reconcile_super_admins ──────────────────────────────────────────────────────
-- The boot reconcile: deletes every row whose account email is not on the list (case-insensitive),
-- or no longer matches the row. Adds nothing: a row is only ever written for a signed-in user by
-- sync_super_admin. Returns how many rows it deleted. An empty list empties the table.

create function public.reconcile_super_admins(p_listed_emails text[])
  returns integer
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.super_admins s
  where not exists (
    select 1
    from auth.users u
    where u.id = s.user_id
      and lower(u.email) = s.email
      and s.email = any (coalesce(p_listed_emails, '{}'::text[]))
  );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.reconcile_super_admins(text[]) from public, anon, authenticated;
grant execute on function public.reconcile_super_admins(text[]) to service_role;
