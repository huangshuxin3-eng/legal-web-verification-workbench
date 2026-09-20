begin;

-- External Beta Security Gate · Step 1 (final alignment)
--
-- 背景（已核实的关键事实）：
--   * 真实远端数据库中存在 public.rls_auto_enable()（SECURITY DEFINER 的 event trigger 函数）
--     以及 event trigger ensure_rls（ON ddl_command_end，WHEN TAG IN
--     ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')，owner = postgres）。
--   * 该函数与 trigger 与 Supabase 官方文档 “Auto-enable RLS for new tables” 示例一致：
--     在 public schema 下新建表时自动 ENABLE ROW LEVEL SECURITY。
--   * 但二者都不在 Git migrations 中 —— 属于 schema drift。
--
-- 上一版 milestone_6 只执行了一条 REVOKE，隐含“函数已存在”的前提：
--   * 在真实远端能跑通；
--   * 但在一个仅按 repo migrations 重建的全新数据库上会失败（对象不存在）。
-- External Beta 要求数据库可由 Git migration 可复现，因此必须把这两个对象
-- 的正式定义纳入 migration，而不是依赖远端的历史 drift。
--
-- 本迁移同时完成（不新增 milestone_7）：
--   A. 将 public.rls_auto_enable() 的正式定义纳入 migration
--   B. 将 ensure_rls event trigger 正式纳入 migration
--   C. 收紧客户端 EXECUTE 权限至 desired ACL
--
-- 本轮 final alignment：public.rls_auto_enable() 的函数体已按真实远端
-- pg_get_functiondef() 逐字节对齐（含 RAISE LOG 措辞），不再自行重建或改写。
--
-- 范围与不动项（最小权限原则）：
--   * 仅 CREATE OR REPLACE 该函数、DROP/CREATE 该 trigger、REVOKE 客户端 EXECUTE
--   * 不删除函数、不重构函数逻辑、不动 trigger 触发语义
--   * 不动任何业务数据表 / RLS policy / Storage / auth
--   * 不改动任何 Capture RPC、不改动产品代码
--   * 不新增任何 GRANT（最小权限，desired ACL 为全角色 NO EXECUTE，仅 owner 保留）

-- (A) 将真实数据库中已存在但 Git migration 缺失的 rls_auto_enable() 正式纳入。
--     函数体忠实采用真实远端 pg_get_functiondef()（含 RAISE LOG 措辞与 EXCEPTION 行为）。
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to pg_catalog
as $$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name is not null
       and cmd.schema_name in ('public')
       and cmd.schema_name not in ('pg_catalog', 'information_schema')
       and cmd.schema_name not like 'pg_toast%'
       and cmd.schema_name not like 'pg_temp%'
    then
      begin
        execute format(
          'alter table if exists %s enable row level security',
          cmd.object_identity
        );

        raise log
          'rls_auto_enable: enabled RLS on %',
          cmd.object_identity;

      exception
        when others then
          raise log
            'rls_auto_enable: failed to enable RLS on %',
            cmd.object_identity;
      end;
    else
      raise log
        'rls_auto_enable: skip % (either system schema or not in enforced list: %.)',
        cmd.object_identity,
        cmd.schema_name;
    end if;
  end loop;
end;
$$;

-- (B) 将 ensure_rls event trigger 正式纳入 migration（先 DROP 保证可重跑幂等）
drop event trigger if exists ensure_rls;

create event trigger ensure_rls
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();

-- (C) 收紧客户端 EXECUTE 权限，明确 desired ACL：
--     PUBLIC        NO EXECUTE
--     anon          NO EXECUTE
--     authenticated NO EXECUTE
--     service_role  NO EXECUTE
--     postgres      EXECUTE（owner，默认保留）
--   event trigger 由系统自动触发（函数 SECURITY DEFINER 以 postgres/owner 身份执行），
--   不依赖任何角色直接 EXECUTE 该函数，故全部收回，不影响 trigger 正常工作。
revoke execute on function public.rls_auto_enable()
from public, anon, authenticated, service_role;

commit;
