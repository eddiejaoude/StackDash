-- Workspace handles (#258): a readable name a workspace can claim for its public project page
-- addresses, /@<handle>/<page>, instead of its random id. Grant model: see
-- 20261031090000_tenancy.sql.
--
-- Expand step of expand then contract: a nullable column, nothing backfilled, and the public page
-- functions gain columns but keep their parameters, so code deployed before this migration keeps
-- calling them unchanged. Nothing is renamed or removed, so there is nothing to contract afterwards.
--
-- * Format and length match src/lib/workspaces/handles.ts. The reserved words are checked only
--   there: the only writes are set_workspace_handle() and remove_workspace_handle(), service role
--   only, which the settings Server Actions call after validating the handle.
-- * Unique case-insensitively, on lower(handle). The format check already refuses capitals; the
--   index keeps two workspaces apart even if that check is ever loosened.
-- * Members read the handle with the rest of their workspace row (workspaces_select). Nobody writes
--   it through the Data API: authenticated keeps update (name) and nothing else.
-- * A handle can change or be removed. The old one stops answering at once and any workspace may
--   claim it; no history is kept (decided on the issue).
-- * A handle may not equal another workspace's slug, so one address segment names one workspace.
--   A newly generated slug equal to an existing handle (50 random bits) is not prevented;
--   public_project_page() prefers the handle if it ever happens.

alter table public.workspaces
  add column handle text
    constraint workspaces_handle_format
      check (char_length(handle) between 3 and 32 and handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- Also serves public_project_page(), which looks a workspace up by handle.
create unique index workspaces_handle_key on public.workspaces (lower(handle));

-- ── Shared check ────────────────────────────────────────────────────────────────
-- The handle is in every public page address, so changing it is an owner or admin action, like
-- publishing (#104). The server checks first so the user gets a clear message; this check is the
-- backstop, because the functions below run as the service role.

create function public.require_workspace_handle_admin(p_workspace_id uuid, p_actor_id uuid)
  returns void
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
begin
  if p_actor_id is null or not exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_actor_id
      and public.workspace_role_rank(m.role) >= public.workspace_role_rank('admin')
  ) then
    raise exception 'only owners and admins can change the workspace handle' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke execute on function public.require_workspace_handle_admin(uuid, uuid) from public, anon, authenticated;

-- ── set_workspace_handle ────────────────────────────────────────────────────────
-- Claims or changes the workspace's handle. Returns 'saved', 'unchanged' (it already has this
-- handle), or 'taken' (another workspace holds it as its handle or as its slug). The old handle is
-- released by the same update. The workspace row is locked so two changes to one workspace take
-- turns; workspaces_handle_key decides between two workspaces claiming the same handle.

create function public.set_workspace_handle(p_workspace_id uuid, p_actor_id uuid, p_handle text)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_current text;
begin
  perform public.require_workspace_handle_admin(p_workspace_id, p_actor_id);
  if p_handle is null then
    raise exception 'p_handle is required; remove_workspace_handle removes it' using errcode = 'invalid_parameter_value';
  end if;

  select w.handle into v_current from public.workspaces w where w.id = p_workspace_id for no key update;
  if v_current is not distinct from p_handle then
    return 'unchanged';
  end if;

  if exists (select 1 from public.workspaces w where w.slug = p_handle and w.id <> p_workspace_id) then
    return 'taken';
  end if;

  begin
    update public.workspaces w set handle = p_handle where w.id = p_workspace_id;
  exception
    when unique_violation then
      return 'taken';
  end;
  return 'saved';
end;
$$;

revoke execute on function public.set_workspace_handle(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_workspace_handle(uuid, uuid, text) to service_role;

-- ── remove_workspace_handle ─────────────────────────────────────────────────────
-- Removes the handle: public pages answer at the slug address again, and the handle is free for
-- any workspace from this commit on. Returns 'removed', or 'unchanged' when there was none.

create function public.remove_workspace_handle(p_workspace_id uuid, p_actor_id uuid)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
begin
  perform public.require_workspace_handle_admin(p_workspace_id, p_actor_id);
  update public.workspaces w set handle = null where w.id = p_workspace_id and w.handle is not null;
  return case when found then 'removed' else 'unchanged' end;
end;
$$;

revoke execute on function public.remove_workspace_handle(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_workspace_handle(uuid, uuid) to service_role;

-- ── public_project_page ─────────────────────────────────────────────────────────
-- As in 20261105120500_project_pages.sql, plus: p_workspace_slug now takes either the workspace's
-- handle or its slug (the parameter keeps its name so code deployed before handles still calls
-- it), and the row says both, so the proxy sends a slug address to the handle address. An unknown
-- handle, a released handle, and another workspace's handle with this page slug all answer nothing.

drop function public.public_project_page(text, text);

create function public.public_project_page(p_workspace_slug text, p_page_slug text)
  returns table (
    project_id uuid,
    workspace_id uuid,
    project_name text,
    indexable boolean,
    workspace_slug text,
    workspace_handle text
  )
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select pp.project_id, pp.workspace_id, p.name, pp.indexable, w.slug, w.handle
  from public.workspaces w
  join public.project_pages pp on pp.workspace_id = w.id
  join public.projects p on p.workspace_id = pp.workspace_id and p.id = pp.project_id
  where (lower(w.handle) = p_workspace_slug or w.slug = p_workspace_slug)
    and pp.slug = p_page_slug
    and pp.enabled
    and exists (
      select 1 from public.published_metrics pm
      where pm.workspace_id = pp.workspace_id and pm.project_id = pp.project_id and pm.revoked_at is null
    )
  order by lower(w.handle) is not distinct from p_workspace_slug desc
  limit 1
$$;

revoke execute on function public.public_project_page(text, text) from public, anon, authenticated;
grant execute on function public.public_project_page(text, text) to service_role;

-- ── public_project_page_sitemap ─────────────────────────────────────────────────
-- As before, plus the workspace's handle, so the sitemap lists the address the page answers at.

drop function public.public_project_page_sitemap(int);

create function public.public_project_page_sitemap(p_limit int)
  returns table (workspace_slug text, page_slug text, updated_at timestamptz, workspace_handle text)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select w.slug, pp.slug, pp.updated_at, w.handle
  from public.project_pages pp
  join public.workspaces w on w.id = pp.workspace_id
  where pp.enabled
    and pp.indexable
    and exists (
      select 1 from public.published_metrics pm
      where pm.workspace_id = pp.workspace_id and pm.project_id = pp.project_id and pm.revoked_at is null
    )
  order by pp.updated_at desc, pp.project_id
  limit greatest(p_limit, 0)
$$;

revoke execute on function public.public_project_page_sitemap(int) from public, anon, authenticated;
grant execute on function public.public_project_page_sitemap(int) to service_role;

-- ── save_project_page ───────────────────────────────────────────────────────────
-- Unchanged from 20261105120500_project_pages.sql except the audit event: it names the address the
-- page answers at, the handle one while the workspace has a handle.

create or replace function public.save_project_page(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_slug text,
  p_indexable boolean
)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_project_name text;
  v_workspace_address text;
  v_existing public.project_pages%rowtype;
  v_was_enabled boolean;
begin
  perform public.require_published_metrics_admin(p_workspace_id, p_actor_id);
  if p_slug is null or p_indexable is null then
    raise exception 'p_slug and p_indexable are required' using errcode = 'invalid_parameter_value';
  end if;

  select p.name into v_project_name
  from public.projects p
  where p.id = p_project_id and p.workspace_id = p_workspace_id
  for no key update;
  if not found then
    return 'not_found';
  end if;

  if exists (
    select 1 from public.project_pages pp
    where pp.workspace_id = p_workspace_id and pp.slug = p_slug and pp.project_id <> p_project_id
  ) then
    return 'slug_taken';
  end if;

  select * into v_existing from public.project_pages pp where pp.project_id = p_project_id;
  v_was_enabled := found and v_existing.enabled;
  if v_was_enabled and v_existing.slug = p_slug and v_existing.indexable = p_indexable then
    return 'unchanged';
  end if;

  begin
    insert into public.project_pages (project_id, workspace_id, slug, enabled, indexable, updated_by)
    values (p_project_id, p_workspace_id, p_slug, true, p_indexable, p_actor_id)
    on conflict (project_id) do update
      set slug = excluded.slug, enabled = true, indexable = excluded.indexable, updated_by = excluded.updated_by;
  exception
    -- Another project took the slug between the check above and this write.
    when unique_violation then
      return 'slug_taken';
  end;

  select coalesce(w.handle, w.slug) into v_workspace_address from public.workspaces w where w.id = p_workspace_id;
  perform public.record_publication_event(
    p_workspace_id,
    case when v_was_enabled then 'stackdash.project_page_updated' else 'stackdash.project_page_enabled' end,
    case when v_was_enabled then 'Updated the public project page' else 'Turned on the public project page' end,
    'Project ' || v_project_name || '. Address /@' || v_workspace_address || '/' || p_slug || '. '
      || case when p_indexable then 'Search engines may index it.' else 'Search engines are asked not to index it.' end,
    'project_page:' || gen_random_uuid()::text
  );
  return case when v_was_enabled then 'updated' else 'enabled' end;
end;
$$;
