-- Public project pages (#150, epic #147): one opt-in page per project at /@<workspace slug>/<page
-- slug>, showing only what the project has published (20261105023129_published_metrics.sql).
-- Grant model: see 20261031090000_tenancy.sql.
--
-- * Nothing is public by default. A row exists only once an owner or admin turns the page on, and
--   turning it off keeps the row (enabled = false) so the slug stays reserved for this project.
-- * The workspace part of the address is the existing random, immutable workspace slug (#31), and
--   the page slug is unique within its workspace, so no tenant can ever take another's old address
--   (decision on #150).
-- * A page answers only while it is on and the project has at least one live publication, so
--   "Unpublish everything" also takes every page offline. public_project_page() is the one
--   definition of "this page is public"; the sitemap reads the same rule.
-- * Members read the row through the Data API; every write goes through the functions below, run by
--   the server with the service role after it has checked the caller. Each function checks the
--   actor's role again and writes the timeline audit event in the same transaction, like publishing.

create table public.project_pages (
  project_id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Lowercase words joined by single hyphens, so the address is readable and never needs encoding.
  slug text not null constraint project_pages_slug_format
    check (char_length(slug) between 1 and 40 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  enabled boolean not null default false,
  -- The page asks search engines not to index it, and stays out of the sitemap, unless this is on.
  indexable boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_pages_project_fkey foreign key (workspace_id, project_id)
    references public.projects (workspace_id, id) on delete cascade,
  -- Also serves public_project_page(), which looks a page up by workspace and slug.
  constraint project_pages_workspace_slug_key unique (workspace_id, slug)
);

create index project_pages_updated_by_idx on public.project_pages (updated_by);
-- The sitemap lists pages that are on and indexable, newest change first.
create index project_pages_sitemap_idx on public.project_pages (updated_at desc) where enabled and indexable;

create trigger project_pages_set_updated_at before update on public.project_pages
  for each row execute function public.set_updated_at();

alter table public.project_pages enable row level security;

revoke all on table public.project_pages from anon, authenticated;

-- Members see whether a project's page is on and where; nobody writes through the Data API.
grant select on table public.project_pages to authenticated;

create policy project_pages_select on public.project_pages for select to authenticated
  using (public.has_workspace_role(workspace_id, 'viewer'));

-- ── save_project_page ───────────────────────────────────────────────────────────
-- Turns the page on with this slug and indexing choice, or changes them while it is on. Returns
-- 'enabled' (it was off or never existed), 'updated', 'unchanged' (already on with the same
-- settings, so no event), 'slug_taken' (another project in the workspace has this slug), or
-- 'not_found' (no such project in the workspace). Owner or admin only, like publishing a metric.
-- The project row is locked so two saves for one project take turns.

create function public.save_project_page(
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
  v_workspace_slug text;
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

  select w.slug into v_workspace_slug from public.workspaces w where w.id = p_workspace_id;
  perform public.record_publication_event(
    p_workspace_id,
    case when v_was_enabled then 'stackdash.project_page_updated' else 'stackdash.project_page_enabled' end,
    case when v_was_enabled then 'Updated the public project page' else 'Turned on the public project page' end,
    'Project ' || v_project_name || '. Address /@' || v_workspace_slug || '/' || p_slug || '. '
      || case when p_indexable then 'Search engines may index it.' else 'Search engines are asked not to index it.' end,
    'project_page:' || gen_random_uuid()::text
  );
  return case when v_was_enabled then 'updated' else 'enabled' end;
end;
$$;

revoke execute on function public.save_project_page(uuid, uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.save_project_page(uuid, uuid, uuid, text, boolean) to service_role;

-- ── disable_project_page ────────────────────────────────────────────────────────
-- Turns the page off; it answers not found from the next request. Returns 'disabled', or
-- 'not_found' for a page that is already off, missing, or in another workspace (one answer for all
-- three). The row and its slug stay, so turning it on again keeps the same address.

create function public.disable_project_page(p_workspace_id uuid, p_project_id uuid, p_actor_id uuid)
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
as $$
declare
  v_project_name text;
begin
  perform public.require_published_metrics_admin(p_workspace_id, p_actor_id);

  update public.project_pages pp
  set enabled = false, updated_by = p_actor_id
  where pp.project_id = p_project_id and pp.workspace_id = p_workspace_id and pp.enabled
  returning (select p.name from public.projects p where p.id = pp.project_id) into v_project_name;

  if not found then
    return 'not_found';
  end if;

  perform public.record_publication_event(
    p_workspace_id,
    'stackdash.project_page_disabled',
    'Turned off the public project page',
    'Project ' || v_project_name || '. The page is no longer public.',
    'project_page:' || gen_random_uuid()::text
  );
  return 'disabled';
end;
$$;

revoke execute on function public.disable_project_page(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.disable_project_page(uuid, uuid, uuid) to service_role;

-- ── public_project_page ─────────────────────────────────────────────────────────
-- The page an address answers with: on, in that workspace, with at least one live publication.
-- No row for an unknown address, a page that is off, and a page with nothing published alike, so
-- the route answers the same 404 for all of them. Service role only; the route then reads the
-- published values through public_published_metrics().

create function public.public_project_page(p_workspace_slug text, p_page_slug text)
  returns table (project_id uuid, workspace_id uuid, project_name text, indexable boolean)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select pp.project_id, pp.workspace_id, p.name, pp.indexable
  from public.workspaces w
  join public.project_pages pp on pp.workspace_id = w.id
  join public.projects p on p.workspace_id = pp.workspace_id and p.id = pp.project_id
  where w.slug = p_workspace_slug
    and pp.slug = p_page_slug
    and pp.enabled
    and exists (
      select 1 from public.published_metrics pm
      where pm.workspace_id = pp.workspace_id and pm.project_id = pp.project_id and pm.revoked_at is null
    )
$$;

revoke execute on function public.public_project_page(text, text) from public, anon, authenticated;
grant execute on function public.public_project_page(text, text) to service_role;

-- ── public_project_page_sitemap ─────────────────────────────────────────────────
-- Pages the sitemap lists: public by the same rule as public_project_page(), and indexable. Newest
-- change first, at most p_limit rows.

create function public.public_project_page_sitemap(p_limit int)
  returns table (workspace_slug text, page_slug text, updated_at timestamptz)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select w.slug, pp.slug, pp.updated_at
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
