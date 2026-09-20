import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Isolated PostgreSQL engine: these fixtures never reach the app or Supabase.
test("Milestone 1 migration, ownership, constraints and cascades", async (t) => {
  const db = new PGlite();
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";
  const pa = "10000000-0000-4000-8000-000000000001";
  const pb = "10000000-0000-4000-8000-000000000002";
  const ta = "20000000-0000-4000-8000-000000000001";
  const tb = "20000000-0000-4000-8000-000000000002";
  const qa = "30000000-0000-4000-8000-000000000001";
  const qb = "30000000-0000-4000-8000-000000000002";
  const ca = "40000000-0000-4000-8000-000000000001";
  const cb = "40000000-0000-4000-8000-000000000002";
  try {
    await db.exec(`create role anon; create role authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public to authenticated, anon;
      grant execute on function auth.uid() to authenticated, anon;
      insert into auth.users values ('${a}'), ('${b}');`);
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202609140001_milestone_1.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    // M5 adds analysis_draft jsonb to projects; isolation is delegated to the
    // existing projects_owner policy (for all to authenticated, owner_id = auth.uid()).
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202609140005_milestone_5.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    async function asUser(id: string) {
      await db.exec("reset role; set role authenticated;");
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
        id,
      ]);
    }
    for (const [user, project, task, query, capture] of [
      [a, pa, ta, qa, ca],
      [b, pb, tb, qb, cb],
    ]) {
      await asUser(user);
      await db.query(
        "insert into projects(id, owner_id, name) values ($1, $2, $3)",
        [project, user, "测试项目"],
      );
      await db.query(
        "insert into tasks(id, project_id, entity_name, topic, source_name, source_url) values ($1, $2, '对象', '事项', '网站', 'https://example.com')",
        [task, project],
      );
      await db.query(
        "insert into queries(id, task_id, query_no, query_text) values ($1, $2, 1, '测试查询')",
        [query, task],
      );
      await db.query(
        "insert into captures(id, query_id, capture_no, storage_path, source_url) values ($1, $2, 1, 'test.png', 'https://example.com')",
        [capture, query],
      );
    }
    await asUser(a);
    await t.test(
      "all four layers hide other users; foreign updates/deletes affect zero rows",
      async () => {
        for (const [table, own, foreign] of [
          ["projects", pa, pb],
          ["tasks", ta, tb],
          ["queries", qa, qb],
          ["captures", ca, cb],
        ]) {
          assert.deepEqual((await db.query(`select id from ${table}`)).rows, [
            { id: own },
          ]);
          assert.equal(
            (
              await db.query(
                `delete from ${table} where id = $1 returning id`,
                [foreign],
              )
            ).rows.length,
            0,
          );
          assert.equal(
            (
              await db.query(
                `update ${table} set created_at = now() where id = $1 returning id`,
                [foreign],
              )
            ).rows.length,
            0,
          );
        }
      },
    );
    await t.test(
      "forged ownership and foreign parent inserts are rejected",
      async () => {
        await assert.rejects(
          db.query(
            "insert into projects(owner_id, name) values ($1, 'forged')",
            [b],
          ),
          /row-level security/,
        );
        await assert.rejects(
          db.query(
            "insert into tasks(project_id, entity_name, topic, source_name, source_url) values ($1, 'x', 'x', 'x', 'https://example.com')",
            [pb],
          ),
          /row-level security/,
        );
        await assert.rejects(
          db.query(
            "insert into queries(task_id, query_no, query_text) values ($1, 2, 'x')",
            [tb],
          ),
          /row-level security/,
        );
        await assert.rejects(
          db.query(
            "insert into captures(query_id, capture_no, storage_path, source_url) values ($1, 2, 'x', 'x')",
            [qb],
          ),
          /row-level security/,
        );
      },
    );
    await t.test(
      "analysis_draft is owner-scoped: User B cannot read or write Project A's draft",
      async () => {
        await asUser(a);
        await db.query(
          "update projects set analysis_draft = $1::jsonb where id = $2",
          ['{"version":1,"sections":[{"title":"结论","body":"草稿"}]}', pa],
        );
        await asUser(b);
        // B cannot even see A's project row → the draft is invisible
        assert.equal(
          (
            await db.query(
              "select analysis_draft from projects where id = $1",
              [pa],
            )
          ).rows.length,
          0,
        );
        // B cannot overwrite A's draft (WITH CHECK on projects_owner fails)
        assert.equal(
          (
            await db.query(
              "update projects set analysis_draft = $1::jsonb where id = $2 returning id",
              ['{"version":9,"sections":[]}', pa],
            )
          ).rows.length,
          0,
        );
        // B can still read/confirm their own draft (RLS is per-row, not global)
        await db.query(
          "update projects set analysis_draft = $1::jsonb where id = $2",
          ['{"version":1,"sections":[{"title":"B","body":"x"}]}', pb],
        );
        const own = (
          await db.query<{ analysis_draft: unknown }>(
            "select analysis_draft from projects where id = $1",
            [pb],
          )
        ).rows[0];
        assert.ok(own && own.analysis_draft);
        await asUser(a);
        // A's draft is untouched by B's attempts
        const mine = (
          await db.query<{ analysis_draft: unknown }>(
            "select analysis_draft from projects where id = $1",
            [pa],
          )
        ).rows[0];
        assert.deepEqual(mine.analysis_draft, {
          version: 1,
          sections: [{ title: "结论", body: "草稿" }],
        });
      },
    );
    await t.test(
      "WITH CHECK prevents moving existing rows to foreign parents",
      async () => {
        for (const [table, column, foreign, own] of [
          ["projects", "owner_id", b, pa],
          ["tasks", "project_id", pb, ta],
          ["queries", "task_id", tb, qa],
          ["captures", "query_id", qb, ca],
        ]) {
          await assert.rejects(
            db.query(`update ${table} set ${column} = $1 where id = $2`, [
              foreign,
              own,
            ]),
            /row-level security/,
          );
        }
      },
    );
    await t.test(
      "completion timestamp is database-owned, preserved and cleared",
      async () => {
        const initial = (
          await db.query<{ status: string; completed_at: Date | null }>(
            "select status, completed_at from tasks where id = $1",
            [ta],
          )
        ).rows[0];
        assert.equal(initial.status, "not_started");
        assert.equal(initial.completed_at, null);
        const completed = (
          await db.query<{ completed_at: Date }>(
            "update tasks set status = 'completed' where id = $1 returning completed_at",
            [ta],
          )
        ).rows[0];
        assert.ok(completed.completed_at);
        const edited = (
          await db.query<{ completed_at: Date }>(
            "update tasks set note = 'edit', completed_at = '2000-01-01' where id = $1 returning completed_at",
            [ta],
          )
        ).rows[0];
        assert.deepEqual(edited.completed_at, completed.completed_at);
        for (const status of ["not_started", "in_progress", "blocked"]) {
          const row = (
            await db.query<{ completed_at: Date | null }>(
              "update tasks set status = $1 where id = $2 returning completed_at",
              [status, ta],
            )
          ).rows[0];
          assert.equal(row.completed_at, null);
          await db.query(
            "update tasks set status = 'completed' where id = $1",
            [ta],
          );
        }
      },
    );
    await t.test(
      "unique sequence numbers, required fields and statuses are enforced",
      async () => {
        await assert.rejects(
          db.query(
            "insert into queries(task_id, query_no, query_text) values ($1, 1, 'x')",
            [ta],
          ),
          /unique constraint/,
        );
        await assert.rejects(
          db.query(
            "insert into captures(query_id, capture_no, storage_path, source_url) values ($1, 1, 'x', 'x')",
            [qa],
          ),
          /unique constraint/,
        );
        await assert.rejects(
          db.query("update tasks set status = 'unknown' where id = $1", [ta]),
          /check constraint/,
        );
        await assert.rejects(
          db.query("update tasks set entity_name = '   ' where id = $1", [ta]),
          /check constraint/,
        );
        await assert.rejects(
          db.query(
            "update tasks set source_url = 'javascript:alert(1)' where id = $1",
            [ta],
          ),
          /check constraint/,
        );
      },
    );
    await t.test(
      "anonymous access and authenticated TRUNCATE are denied",
      async () => {
        for (const table of ["projects", "tasks", "queries", "captures"])
          await assert.rejects(
            db.query(`truncate ${table} cascade`),
            /permission denied/,
          );
        await db.exec("reset role; set role anon;");
        for (const table of ["projects", "tasks", "queries", "captures"])
          await assert.rejects(
            db.query(`select * from ${table}`),
            /permission denied/,
          );
        await asUser(a);
      },
    );
    await t.test(
      "Task deletion cascades to Query and Capture, retaining Project",
      async () => {
        await db.query("delete from tasks where id = $1", [ta]);
        assert.equal((await db.query("select * from queries")).rows.length, 0);
        assert.equal((await db.query("select * from captures")).rows.length, 0);
        assert.equal((await db.query("select * from projects")).rows.length, 1);
      },
    );
    await t.test(
      "Project deletion cascades through every descendant",
      async () => {
        await asUser(b);
        await db.query("delete from projects where id = $1", [pb]);
        for (const table of ["projects", "tasks", "queries", "captures"])
          assert.equal(
            (await db.query(`select * from ${table}`)).rows.length,
            0,
          );
        await asUser(a);
        assert.equal((await db.query("select * from projects")).rows.length, 1);
      },
    );
  } finally {
    await db.close();
  }
});
