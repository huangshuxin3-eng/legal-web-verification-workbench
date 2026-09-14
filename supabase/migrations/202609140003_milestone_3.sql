begin;
alter table public.queries add column last_capture_no integer not null default 0 check (last_capture_no >= 0);
-- Durable internal upload/deletion reservations; never Capture business columns.
alter table public.queries add column capture_operations jsonb not null default '{}'::jsonb;
update public.queries q set last_capture_no=coalesce((select max(c.capture_no) from public.captures c where c.query_id=q.id),0);
create unique index captures_storage_path_key on public.captures(storage_path);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('captures','captures',false,5242880,array['image/png','image/jpeg'])
on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['image/png','image/jpeg'];
revoke insert,update,delete on public.captures from public,anon,authenticated;
grant select on public.captures to authenticated;

-- Every RPC checks the real auth.uid(). Definer privileges only protect internal
-- counters/operations and prohibit direct Capture mutations; no service key.
create function public.reserve_capture_upload(p_query_id uuid,p_source_url text,p_extension text)
returns setof public.captures language plpgsql security definer set search_path='' as $$
declare qrow public.queries; trow public.tasks; item public.captures;
begin
 select q.* into qrow from public.queries q join public.tasks t on t.id=q.task_id
 join public.projects p on p.id=t.project_id
 where q.id=p_query_id and p.owner_id=(select auth.uid()) for update of q;
 if not found then raise exception 'Query not found or access denied' using errcode='42501'; end if;
 if p_extension is null or p_extension not in ('png','jpg') or p_source_url is null or p_source_url !~* '^https?://[^[:space:]]+$' then
  raise exception 'Invalid image extension or source URL' using errcode='23514'; end if;
 if (select count(*) from jsonb_object_keys(qrow.capture_operations))>=20 then
  raise exception 'Finish or cancel pending capture operations first' using errcode='23514'; end if;
 select t.* into trow from public.tasks t where t.id=qrow.task_id;
 item.id:=gen_random_uuid(); item.query_id:=qrow.id; item.capture_no:=qrow.last_capture_no+1;
 item.storage_path:=auth.uid()::text||'/'||trow.project_id::text||'/'||trow.id::text||'/'||qrow.id::text||'/'||item.id::text||'.'||p_extension;
 item.source_url:=btrim(p_source_url); item.created_at:=now();
 update public.queries set last_capture_no=item.capture_no,
  capture_operations=capture_operations||jsonb_build_object(item.id::text,to_jsonb(item)||'{"action":"upload"}'::jsonb) where id=qrow.id;
 return next item;
end;
$$;

create function public.finish_capture_upload(p_query_id uuid,p_capture_id uuid)
returns setof public.captures language plpgsql security definer set search_path='' as $$
declare qrow public.queries; item public.captures; operation jsonb;
begin
 select q.* into qrow from public.queries q join public.tasks t on t.id=q.task_id
 join public.projects p on p.id=t.project_id
 where q.id=p_query_id and p.owner_id=(select auth.uid()) for update of q;
 if not found then raise exception 'Query not found or access denied' using errcode='42501'; end if;
 select * into item from public.captures where id=p_capture_id and query_id=qrow.id;
 if found then return next item; return; end if;
 operation:=qrow.capture_operations->p_capture_id::text;
 if operation is null or operation->>'action'<>'upload' then
  raise exception 'Upload is absent or cancelled' using errcode='23514'; end if;
 select * into item from jsonb_populate_record(null::public.captures,operation);
 if not exists(select 1 from storage.objects where bucket_id='captures' and name=item.storage_path) then
  raise exception 'Upload the file first' using errcode='23514'; end if;
 insert into public.captures select item.*;
 update public.queries set capture_operations=capture_operations-p_capture_id::text where id=qrow.id;
 return next item;
end;
$$;

create function public.prepare_capture_delete(p_capture_id uuid)
returns setof public.captures language plpgsql security definer set search_path='' as $$
declare item public.captures;
begin
 select c.* into item from public.captures c join public.queries q on q.id=c.query_id
 join public.tasks t on t.id=q.task_id join public.projects p on p.id=t.project_id
 where c.id=p_capture_id and p.owner_id=(select auth.uid()) for update of q;
 if not found then raise exception 'Capture not found or access denied' using errcode='42501'; end if;
 update public.queries set capture_operations=capture_operations||jsonb_build_object(item.id::text,to_jsonb(item)||'{"action":"delete"}'::jsonb) where id=item.query_id;
 return next item;
end;
$$;

-- Cancel before deleting bytes: finalization and cancellation share a row lock.
create function public.cancel_capture_upload(p_query_id uuid,p_capture_id uuid)
returns setof public.captures language plpgsql security definer set search_path='' as $$
declare qrow public.queries; item public.captures; operation jsonb;
begin
 select q.* into qrow from public.queries q join public.tasks t on t.id=q.task_id
 join public.projects p on p.id=t.project_id
 where q.id=p_query_id and p.owner_id=(select auth.uid()) for update of q;
 if not found then raise exception 'Query not found or access denied' using errcode='42501'; end if;
 operation:=qrow.capture_operations->p_capture_id::text;
 if operation is null then return; end if;
 if operation->>'action'='delete' then
  raise exception 'Use capture deletion to resume this operation' using errcode='23514'; end if;
 operation:=jsonb_set(operation,'{action}','"cancel"');
 update public.queries set capture_operations=jsonb_set(capture_operations,array[p_capture_id::text],operation) where id=qrow.id;
 select * into item from jsonb_populate_record(null::public.captures,operation);
 return next item;
end;
$$;

create function public.finish_capture_delete(p_query_id uuid,p_capture_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare qrow public.queries; operation jsonb;
begin
 select q.* into qrow from public.queries q join public.tasks t on t.id=q.task_id
 join public.projects p on p.id=t.project_id
 where q.id=p_query_id and p.owner_id=(select auth.uid()) for update of q;
 if not found then raise exception 'Query not found or access denied' using errcode='42501'; end if;
 operation:=qrow.capture_operations->p_capture_id::text;
 if operation is null then
  if exists(select 1 from public.captures where id=p_capture_id and query_id=qrow.id) then
   raise exception 'Prepare deletion first' using errcode='23514'; end if;
  return true;
 end if;
 if operation->>'action' not in ('delete','cancel') then raise exception 'Prepare deletion first' using errcode='23514'; end if;
 if exists(select 1 from storage.objects where bucket_id='captures' and name=operation->>'storage_path') then
  raise exception 'Delete the Storage file first' using errcode='23514'; end if;
 if operation->>'action'='delete' then delete from public.captures where id=p_capture_id and query_id=qrow.id; end if;
 update public.queries set capture_operations=capture_operations-p_capture_id::text where id=qrow.id;
 return true;
end;
$$;

-- Invoker: Storage reads/writes must pass both caller RLS and exact reservation.
create function public.capture_object_allowed(object_path text,actions text[] default null)
returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.queries q join public.tasks t on t.id=q.task_id
 join public.projects p on p.id=t.project_id where p.owner_id=(select auth.uid())
 and split_part(object_path,'/',1)=p.owner_id::text and split_part(object_path,'/',2)=p.id::text
 and split_part(object_path,'/',3)=t.id::text and split_part(object_path,'/',4)=q.id::text
 and ((actions is null and exists(select 1 from public.captures c where c.query_id=q.id and c.storage_path=object_path))
 or exists(select 1 from jsonb_each(q.capture_operations) operation where operation.value->>'storage_path'=object_path
 and (actions is null or operation.value->>'action'=any(actions)))));
$$;
create policy captures_files_read on storage.objects for select to authenticated
using(bucket_id='captures' and public.capture_object_allowed(name));
create policy captures_files_insert on storage.objects for insert to authenticated
with check(bucket_id='captures' and public.capture_object_allowed(name,array['upload','delete']));
create policy captures_files_delete on storage.objects for delete to authenticated
using(bucket_id='captures' and public.capture_object_allowed(name,array['cancel','delete']));
-- Restrictive guards win over unrelated broad policies already on the project.
create policy captures_files_read_guard on storage.objects as restrictive for select to public
using(bucket_id<>'captures' or (auth.role()='authenticated' and public.capture_object_allowed(name)));
create policy captures_files_insert_guard on storage.objects as restrictive for insert to public
with check(bucket_id<>'captures' or (auth.role()='authenticated' and public.capture_object_allowed(name,array['upload','delete'])));
create policy captures_files_delete_guard on storage.objects as restrictive for delete to public
using(bucket_id<>'captures' or (auth.role()='authenticated' and public.capture_object_allowed(name,array['cancel','delete'])));
create policy captures_files_update_guard on storage.objects as restrictive for update to public
using(bucket_id<>'captures') with check(bucket_id<>'captures');

create function public.validate_capture_record() returns trigger
language plpgsql security definer set search_path='' as $$
declare operation jsonb;
begin
 if TG_OP='UPDATE' then
  if new is distinct from old then raise exception 'Capture records are immutable' using errcode='23514'; end if;
  return new;
 end if;
 select capture_operations->new.id::text into operation from public.queries where id=new.query_id;
 if operation is null or operation->>'action'<>'upload' or operation->>'storage_path'<>new.storage_path
 or (operation->>'capture_no')::integer<>new.capture_no
 or not exists(select 1 from storage.objects where bucket_id='captures' and name=new.storage_path) then
  raise exception 'Capture reservation or file is invalid' using errcode='23514'; end if;
 return new;
end;
$$;
create trigger captures_validate before insert or update on public.captures for each row execute function public.validate_capture_record();
create function public.prevent_capture_orphans() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if TG_TABLE_NAME='captures' then
  if exists(select 1 from storage.objects where bucket_id='captures' and name=old.storage_path) then
   raise exception 'Delete the Storage file first' using errcode='23514'; end if;
 else
  if old.capture_operations<>'{}'::jsonb or exists(select 1 from storage.objects where bucket_id='captures' and split_part(name,'/',4)=old.id::text) then
   raise exception 'Finish capture operations before deleting Query' using errcode='23514'; end if;
 end if;
 return old;
end;
$$;
create trigger captures_delete_guard before delete on public.captures for each row execute function public.prevent_capture_orphans();
create trigger queries_files_delete_guard before delete on public.queries for each row execute function public.prevent_capture_orphans();
create function public.prevent_captured_task_move() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.project_id is distinct from old.project_id and exists(select 1 from public.queries q where q.task_id=old.id and q.last_capture_no>0) then
  raise exception 'A task with capture paths cannot change project' using errcode='23514'; end if;
 return new;
end;
$$;
create trigger tasks_capture_path_guard before update on public.tasks for each row execute function public.prevent_captured_task_move();
create function public.task_capture_counts(p_project_id uuid,p_task_id uuid default null)
returns table(task_id uuid,capture_count bigint) language sql stable security invoker set search_path='' as $$
 select t.id,count(c.id) from public.tasks t left join public.queries q on q.task_id=t.id
 left join public.captures c on c.query_id=q.id
 where t.project_id=p_project_id and (p_task_id is null or t.id=p_task_id) group by t.id order by t.id;
$$;
revoke all on function public.reserve_capture_upload(uuid,text,text),public.finish_capture_upload(uuid,uuid),
 public.prepare_capture_delete(uuid),public.cancel_capture_upload(uuid,uuid),public.finish_capture_delete(uuid,uuid),
 public.capture_object_allowed(text,text[]),public.task_capture_counts(uuid,uuid) from public,anon;
grant execute on function public.reserve_capture_upload(uuid,text,text),public.finish_capture_upload(uuid,uuid),
 public.prepare_capture_delete(uuid),public.cancel_capture_upload(uuid,uuid),public.finish_capture_delete(uuid,uuid),
 public.capture_object_allowed(text,text[]),public.task_capture_counts(uuid,uuid) to authenticated;
revoke all on function public.validate_capture_record(),public.prevent_capture_orphans(),public.prevent_captured_task_move() from public,anon,authenticated;
commit;
