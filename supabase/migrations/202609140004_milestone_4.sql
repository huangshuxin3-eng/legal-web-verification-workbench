begin;

-- Capture remains the six-field MVP record. A null URL is allowed only for the
-- Web fallback upload; the extension always supplies a frozen HTTP(S) URL.
alter table public.captures alter column source_url drop not null;
alter table public.captures drop constraint if exists captures_source_url_check;
alter table public.captures add constraint captures_source_url_check
  check (source_url is null or source_url ~* '^https?://[^[:space:]]+$');

update storage.buckets
set public=false,
    file_size_limit=20971520,
    allowed_mime_types=array['application/pdf','image/png','image/jpeg']
where id='captures';

-- Reuse the M3 durable counter and reservation protocol. This is a replacement
-- of the existing function, not a second allocator.
drop function public.reserve_capture_upload(uuid,text,text);
create function public.reserve_capture_upload(
  p_query_id uuid,
  p_source_url text,
  p_extension text,
  p_capture_id uuid default gen_random_uuid()
)
returns setof public.captures language plpgsql security definer set search_path='' as $$
declare qrow public.queries; trow public.tasks; item public.captures;
begin
 select q.* into qrow from public.queries q join public.tasks t on t.id=q.task_id
 join public.projects p on p.id=t.project_id
 where q.id=p_query_id and p.owner_id=(select auth.uid()) for update of q;
 if not found then raise exception 'Query not found or access denied' using errcode='42501'; end if;
 if p_capture_id is null then raise exception 'Capture request id is required' using errcode='23514'; end if;
 if p_extension is null or p_extension not in ('pdf','png','jpg')
 or (p_source_url is not null and btrim(p_source_url) !~* '^https?://[^[:space:]]+$') then
  raise exception 'Invalid capture extension or source URL' using errcode='23514'; end if;
 if (select count(*) from jsonb_object_keys(qrow.capture_operations))>=20 then
  raise exception 'Finish or cancel pending capture operations first' using errcode='23514'; end if;
 select t.* into trow from public.tasks t where t.id=qrow.task_id;
 select * into item from public.captures where id=p_capture_id and query_id=qrow.id;
 if found then return next item; return; end if;
 if qrow.capture_operations ? p_capture_id::text then
  select * into item from jsonb_populate_record(null::public.captures,qrow.capture_operations->p_capture_id::text);
  if item.query_id<>qrow.id then raise exception 'Capture request conflict' using errcode='23514'; end if;
  return next item; return;
 end if;
 item.id:=p_capture_id; item.query_id:=qrow.id; item.capture_no:=qrow.last_capture_no+1;
 item.storage_path:=auth.uid()::text||'/'||trow.project_id::text||'/'||trow.id::text||'/'||qrow.id::text||'/'||item.id::text||'.'||p_extension;
 item.source_url:=nullif(btrim(p_source_url),''); item.created_at:=now();
 update public.queries set last_capture_no=item.capture_no,
  capture_operations=capture_operations||jsonb_build_object(item.id::text,to_jsonb(item)||'{"action":"upload"}'::jsonb) where id=qrow.id;
 return next item;
end;
$$;

revoke all on function public.reserve_capture_upload(uuid,text,text,uuid) from public,anon;
grant execute on function public.reserve_capture_upload(uuid,text,text,uuid) to authenticated;

commit;
