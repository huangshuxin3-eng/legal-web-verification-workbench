begin;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  code text,
  status text not null default 'active' check (status in ('active', 'completed')),
  created_at timestamptz not null default now()
);
create index projects_owner_id_idx on public.projects(owner_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  entity_name text not null check (length(btrim(entity_name)) > 0),
  topic text not null check (length(btrim(topic)) > 0),
  source_name text not null check (length(btrim(source_name)) > 0),
  source_url text not null check (source_url ~* '^https?://[^[:space:]]+$'),
  note text,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'completed', 'blocked')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint tasks_completion_check check (
    (status = 'completed' and completed_at is not null) or
    (status <> 'completed' and completed_at is null)
  )
);
create index tasks_project_id_idx on public.tasks(project_id);

create table public.queries (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  query_no integer not null check (query_no > 0),
  query_text text not null,
  created_at timestamptz not null default now(),
  unique(task_id, query_no)
);

create table public.captures (
  id uuid primary key default gen_random_uuid(),
  query_id uuid not null references public.queries(id) on delete cascade,
  capture_no integer not null check (capture_no > 0),
  storage_path text not null,
  source_url text not null,
  created_at timestamptz not null default now(),
  unique(query_id, capture_no)
);

-- The database owns completion timestamps, including direct API writes.
create function public.set_task_completed_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status <> 'completed' then
    new.completed_at := null;
  elsif TG_OP = 'INSERT' then
    new.completed_at := now();
  elsif old.status <> 'completed' then
    new.completed_at := now();
  else
    new.completed_at := old.completed_at;
  end if;
  return new;
end;
$$;
create trigger tasks_completed_at before insert or update on public.tasks
for each row execute function public.set_task_completed_at();

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.queries enable row level security;
alter table public.captures enable row level security;

create policy projects_owner on public.projects for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy tasks_owner on public.tasks for all to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())))
with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));

create policy queries_owner on public.queries for all to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id))
with check (exists (select 1 from public.tasks t where t.id = task_id));

create policy captures_owner on public.captures for all to authenticated
using (exists (select 1 from public.queries q where q.id = query_id))
with check (exists (select 1 from public.queries q where q.id = query_id));

-- No anonymous access; authenticated access is always filtered by RLS.
revoke all on public.projects, public.tasks, public.queries, public.captures from public, anon, authenticated;
grant select, insert, update, delete on public.projects, public.tasks, public.queries, public.captures to authenticated;
revoke all on function public.set_task_completed_at() from public;
commit;
