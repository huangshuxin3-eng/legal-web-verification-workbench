begin;

-- Durable high-water mark; deleting queries must never reduce this value.
alter table public.tasks add column last_query_no integer not null default 0
  check (last_query_no >= 0);
update public.tasks t set last_query_no = coalesce(
  (select max(q.query_no) from public.queries q where q.task_id = t.id), 0
);

-- Preserve existing rows; enforce meaningful content on all future writes.
alter table public.queries add constraint queries_text_nonblank
  check (query_text ~ '[^[:space:]]') not valid;

-- Only the trigger may write the counter. Keep M1 business writes available.
revoke insert, update on public.tasks from public, anon, authenticated;
grant insert (id, project_id, entity_name, topic, source_name, source_url,
  note, status, created_at, completed_at) on public.tasks to authenticated;
grant update (project_id, entity_name, topic, source_name, source_url,
  note, status, completed_at) on public.tasks to authenticated;

revoke insert, update on public.queries from public, anon, authenticated;
grant insert (task_id, query_text) on public.queries to authenticated;
grant update (query_text) on public.queries to authenticated;

-- SECURITY DEFINER is needed only to update the protected counter.
-- Explicit owner check is mandatory because the function owner bypasses RLS.
create function public.allocate_query_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.tasks t
  set last_query_no = t.last_query_no + 1,
      status = case when t.last_query_no = 0 and t.status = 'not_started'
                    then 'in_progress' else t.status end
  where t.id = new.task_id and exists (
    select 1 from public.projects p
    where p.id = t.project_id and p.owner_id = (select auth.uid())
  )
  returning t.last_query_no into new.query_no;
  if not found then
    raise exception 'Task not found or access denied' using errcode = '42501';
  end if;
  new.query_text := btrim(new.query_text);
  return new;
end;
$$;
revoke all on function public.allocate_query_number() from public, anon, authenticated;
create trigger queries_allocate_number before insert on public.queries
for each row execute function public.allocate_query_number();

-- Identity/sequence are immutable, even for privileged maintenance updates.
create function public.preserve_query_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.id, new.task_id, new.query_no, new.created_at)
     is distinct from (old.id, old.task_id, old.query_no, old.created_at) then
    raise exception 'Query identity and number are immutable' using errcode = '23514';
  end if;
  new.query_text := btrim(new.query_text);
  return new;
end;
$$;
revoke all on function public.preserve_query_identity() from public, anon, authenticated;
create trigger queries_preserve_identity before update on public.queries
for each row execute function public.preserve_query_identity();

commit;
