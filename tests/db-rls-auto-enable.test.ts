import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Regression for External Beta Security Gate · Step 1 (revision)
//
// 关键事实：真实远端存在 public.rls_auto_enable() 与 event trigger ensure_rls，
// 但二者都不在 Git migrations 中（schema drift）。上一版 milestone_6 仅执行 REVOKE，
// 假设函数已存在 —— 在仅按 migrations 重建的全新数据库上会失败。
//
// 本修订把函数定义、event trigger、客户端 EXECUTE 收紧全部纳入 milestone_6，
// 使其可从「函数/trigger 均不存在」的状态可复现重建。
//
// 验证策略（不再使用预建同名 stub 掩盖 fresh-database 不可重建问题）：
//   * PGlite 0.3.14 支持 CREATE FUNCTION ... RETURNS EVENT_TRIGGER 与 CREATE EVENT TRIGGER，
//     因此直接在全新 PGlite 上跑完整 migration，动态验证函数/trigger 创建与 ACL。
//   * Capture RPC 与业务改动（policy / 业务表 / Storage）通过静态 guard 验证。
//
// Revision 2 调整：
//   * 应用 migration 前先建 anon / authenticated / service_role 三个角色，
//     因为 milestone_6 现在会 REVOKE ... FROM service_role（角色须存在）。
//   * 动态断言新增 service_role 无 EXECUTE，postgres 有 EXECUTE。

const MIGRATION = "202609200001_milestone_6.sql";

async function loadSql(): Promise<string> {
  return readFile(
    new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url),
    "utf8",
  );
}

// 去掉 -- 行注释，便于对“实际 DDL”做静态断言（避免命中注释里的 GRANT 等词）
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

test("migration is reproducible from a fresh DB: defines function + ensure_rls + hardens ACL", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `create role anon; create role authenticated; create role service_role;`,
    );

    // 全新库：迁移前函数与 trigger 都不存在
    assert.equal(
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.proname = 'rls_auto_enable' and n.nspname = 'public'`,
        )
      ).rows[0].n,
      0,
      "precondition: rls_auto_enable must not exist before migration",
    );
    assert.equal(
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from pg_event_trigger where evtname = 'ensure_rls'`,
        )
      ).rows[0].n,
      0,
      "precondition: ensure_rls must not exist before migration",
    );

    // 应用完整 migration（不预建任何 stub）
    const sql = await loadSql();
    await db.exec(sql);

    // (A) 函数已被正式定义
    assert.equal(
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.proname = 'rls_auto_enable' and n.nspname = 'public'`,
        )
      ).rows[0].n,
      1,
      "migration must define public.rls_auto_enable()",
    );

    // (B) event trigger ensure_rls 已被正式建立
    assert.equal(
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from pg_event_trigger where evtname = 'ensure_rls'`,
        )
      ).rows[0].n,
      1,
      "migration must create event trigger ensure_rls",
    );

    // 函数与 trigger 可重复应用（幂等）：再跑一次不应报错
    await db.exec(sql);
    assert.equal(
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from pg_event_trigger where evtname = 'ensure_rls'`,
        )
      ).rows[0].n,
      1,
      "re-applying migration must remain idempotent (single ensure_rls)",
    );

    // (C) 权限：PUBLIC / anon / authenticated / service_role 均无 EXECUTE
    for (const role of ["authenticated", "anon", "service_role"]) {
      assert.equal(
        (
          await db.query<{ p: boolean }>(
            `select has_function_privilege($1, 'public.rls_auto_enable()', 'EXECUTE') as p`,
            [role],
          )
        ).rows[0].p,
        false,
        `${role} must NOT have EXECUTE on rls_auto_enable()`,
      );
    }
    // proacl 中不得存在 PUBLIC('=...') / anon / authenticated / service_role 的显式 EXECUTE 授权
    const acl = (
      await db.query<{ proacl: string[] | null }>(
        `select proacl from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where p.proname = 'rls_auto_enable' and n.nspname = 'public'`,
      )
    ).rows[0].proacl;
    const bad = (acl ?? []).filter((e) =>
      /^(=|anon|authenticated|service_role)/.test(e),
    );
    assert.equal(
      bad.length,
      0,
      `unexpected ACL entries remain: ${JSON.stringify(bad)}`,
    );

    // postgres（owner / 超级用户）仍保留 EXECUTE，且仍可管理（重新授权）
    assert.equal(
      (
        await db.query<{ p: boolean }>(
          `select has_function_privilege(current_user, 'public.rls_auto_enable()', 'EXECUTE') as p`,
        )
      ).rows[0].p,
      true,
      "superuser must retain EXECUTE / management ability",
    );
    await assert.doesNotReject(
      db.query(
        `grant execute on function public.rls_auto_enable() to authenticated`,
      ),
      "superuser must still be able to manage (grant) the function",
    );
    // 还原为收紧状态，保证测试后状态一致
    await db.exec(
      `revoke execute on function public.rls_auto_enable() from authenticated;`,
    );

    // trigger 实际生效：在 public 下新建表应被自动 ENABLE RLS
    await db.exec(`create table public._rls_probe (id int);`);
    assert.equal(
      (
        await db.query<{ r: boolean }>(
          `select relrowsecurity as r from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relname = '_rls_probe' and n.nspname = 'public'`,
        )
      ).rows[0].r,
      true,
      "ensure_rls must auto-enable RLS for new public tables",
    );
    await db.exec(`drop table public._rls_probe;`);
  } finally {
    await db.close();
  }
});

test("migration does not touch Capture RPCs, business tables, policies or Storage", async () => {
  const sql = stripComments(await loadSql());

  // 必须包含本次迁移的四段正式定义
  assert.match(
    sql,
    /create\s+or\s+replace\s+function\s+public\.rls_auto_enable\(\)\s+returns\s+event_trigger/i,
    "migration must define the function",
  );
  assert.match(
    sql,
    /drop\s+event\s+trigger\s+if\s+exists\s+ensure_rls/i,
    "migration must drop ensure_rls idempotently",
  );
  assert.match(
    sql,
    /create\s+event\s+trigger\s+ensure_rls\s+on\s+ddl_command_end/i,
    "migration must create ensure_rls",
  );
  assert.match(
    sql,
    /revoke\s+execute\s+on\s+function\s+public\.rls_auto_enable\(\)\s+from\s+public,\s*anon,\s*authenticated,\s*service_role\s*;/i,
    "migration must contain the exact REVOKE (incl. service_role)",
  );

  // 不得引用任何 Capture RPC（列出真实 RPC 函数名，证明本次迁移不影响它们）
  for (const rpc of [
    "reserve_capture_upload",
    "finish_capture_upload",
    "prepare_capture_delete",
    "cancel_capture_upload",
    "finish_capture_delete",
    "capture_object_allowed",
    "validate_capture_record",
  ]) {
    assert.doesNotMatch(
      sql,
      new RegExp(rpc, "i"),
      `migration must not reference ${rpc}`,
    );
  }

  // 不得改动业务表 / RLS policy / Storage / 现有授权
  assert.doesNotMatch(
    sql,
    /create\s+policy/i,
    "migration must not create policies",
  );
  assert.doesNotMatch(
    sql,
    /revoke\s+.*\bon\s+table/i,
    "migration must not revoke on tables",
  );
  assert.doesNotMatch(sql, /grant\s+/i, "migration must not add any grant");
  assert.doesNotMatch(
    sql,
    /storage\s+bucket/i,
    "migration must not touch Storage buckets",
  );
  assert.doesNotMatch(
    sql,
    /insert\s+into\s+storage/i,
    "migration must not touch Storage objects",
  );
});
