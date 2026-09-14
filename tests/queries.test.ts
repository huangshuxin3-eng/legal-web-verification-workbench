import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("M2 upgrade, Query CRUD, numbering and permissions", async (t) => {
  const db = new PGlite();
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";
  async function asUser(id: string) {
    await db.exec("reset role; set role authenticated;");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      id,
    ]);
  }
  async function migration(name: string) {
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${name}.sql`, import.meta.url),
        "utf8",
      ),
    );
  }
  async function makeTask(projectId: string, status = "not_started") {
    return (
      await db.query<{ id: string }>(
        "insert into tasks(project_id, entity_name, topic, source_name, source_url, status) values ($1, '对象', '事项', '网站', 'https://example.com', $2) returning id",
        [projectId, status],
      )
    ).rows[0].id;
  }
  async function create(taskId: string, text = "申请人 = XX科技有限公司") {
    return (
      await db.query<{
        id: string;
        query_no: number;
        query_text: string;
        created_at: Date;
      }>(
        "insert into queries(task_id, query_text) values ($1, $2) returning *",
        [taskId, text],
      )
    ).rows[0];
  }
  async function taskState(taskId: string) {
    return (
      await db.query<{
        status: string;
        last_query_no: number;
        completed_at: Date | null;
      }>(
        "select status, last_query_no, completed_at from tasks where id = $1",
        [taskId],
      )
    ).rows[0];
  }
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
      insert into auth.users values ('${a}'), ('${b}');`);
    await migration("202609140001_milestone_1");
    await asUser(a);
    const pa = (
      await db.query<{ id: string }>(
        "insert into projects(owner_id, name) values ($1, $2) returning id",
        [a, "A 项目"],
      )
    ).rows[0].id;
    const legacy = await makeTask(pa);
    await db.query(
      "insert into queries(task_id, query_no, query_text) values ($1, 7, '已有查询')",
      [legacy],
    );
    await db.exec("reset role");
    await migration("202609140002_milestone_2");
    await asUser(b);
    const pb = (
      await db.query<{ id: string }>(
        "insert into projects(owner_id, name) values ($1, $2) returning id",
        [b, "B 项目"],
      )
    ).rows[0].id;
    const foreignTask = await makeTask(pb);
    const foreignQuery = await create(foreignTask);
    await asUser(a);
    const task = await makeTask(pa);

    await t.test(
      "upgrade preserves existing queries and continues numbering",
      async () => {
        assert.equal((await create(legacy)).query_no, 8);
        assert.equal((await taskState(legacy)).status, "not_started");
      },
    );
    await t.test("first Query transitions not_started atomically", async () => {
      assert.equal((await create(task)).query_no, 1);
      assert.equal((await taskState(task)).status, "in_progress");
    });
    await t.test(
      "delete middle, highest and all rows never reuses committed numbers",
      async () => {
        const second = await create(task);
        const third = await create(task);
        assert.equal(second.query_no, 2);
        assert.equal(third.query_no, 3);
        await db.query("delete from queries where id = $1", [second.id]);
        assert.equal((await create(task)).query_no, 4);
        await db.query(
          "delete from queries where task_id = $1 and query_no = 4",
          [task],
        );
        assert.equal((await create(task)).query_no, 5);
        await db.query("delete from queries where task_id = $1", [task]);
        assert.equal((await taskState(task)).status, "in_progress");
        assert.equal((await create(task)).query_no, 6);
      },
    );
    await t.test(
      "parallel queued requests have unique increasing numbers",
      async () => {
        // PGlite serializes requests; real separate-connection lock test is documented separately.
        const rows = await Promise.all(
          Array.from({ length: 20 }, () => create(task)),
        );
        assert.deepEqual(
          rows.map((q) => q.query_no).sort((a, b) => a - b),
          Array.from({ length: 20 }, (_, i) => i + 7),
        );
      },
    );
    await t.test(
      "edit changes only content; query count remains exact",
      async () => {
        const row = await create(task);
        const before = (
          await db.query<{ count: number }>(
            "select count(*)::int as count from queries where task_id = $1",
            [task],
          )
        ).rows[0].count;
        const after = (
          await db.query<{
            query_no: number;
            query_text: string;
            created_at: Date;
          }>(
            "update queries set query_text = '  商标名称 = ABC  ' where id = $1 returning *",
            [row.id],
          )
        ).rows[0];
        assert.equal(after.query_no, row.query_no);
        assert.deepEqual(after.created_at, row.created_at);
        assert.equal(after.query_text, "商标名称 = ABC");
        await db.query("delete from queries where id = $1", [row.id]);
        assert.equal(
          (
            await db.query<{ count: number }>(
              "select count(*)::int as count from queries where task_id = $1",
              [task],
            )
          ).rows[0].count,
          before - 1,
        );
      },
    );
    await t.test(
      "other statuses and completion timestamps are preserved",
      async () => {
        for (const status of ["in_progress", "completed", "blocked"]) {
          const id = await makeTask(pa, status);
          const before = await taskState(id);
          await create(id);
          const after = await taskState(id);
          assert.equal(after.status, status);
          assert.deepEqual(after.completed_at, before.completed_at);
        }
        await db.query(
          "update tasks set status = 'not_started' where id = $1",
          [task],
        );
        await create(task);
        assert.equal((await taskState(task)).status, "not_started");
      },
    );
    await t.test("failed inserts roll back counter and status", async () => {
      const id = await makeTask(pa);
      await assert.rejects(create(id, " \n\t "), /check constraint/);
      assert.equal((await taskState(id)).last_query_no, 0);
      assert.equal((await taskState(id)).status, "not_started");
      assert.equal((await create(id)).query_no, 1);
    });
    await t.test(
      "owners cannot forge counters, numbers, timestamps or parent links",
      async () => {
        const row = await create(task);
        await assert.rejects(
          db.query("update tasks set last_query_no = 0 where id = $1", [task]),
          /permission denied/,
        );
        await assert.rejects(
          db.query(
            "insert into tasks(project_id, entity_name, topic, source_name, source_url, last_query_no) values ($1, 'x','x','x','https://example.com',0)",
            [pa],
          ),
          /permission denied/,
        );
        await assert.rejects(
          db.query(
            "insert into queries(task_id, query_text, query_no) values ($1, 'x', 1)",
            [task],
          ),
          /permission denied/,
        );
        for (const [column, value] of [
          ["query_no", 1],
          ["task_id", foreignTask],
          ["created_at", "2000-01-01"],
        ]) {
          await assert.rejects(
            db.query(`update queries set ${column} = $1 where id = $2`, [
              value,
              row.id,
            ]),
            /permission denied/,
          );
        }
      },
    );
    await t.test(
      "RLS isolates queries and foreign writes leave Task untouched",
      async () => {
        assert.equal(
          (
            await db.query("select * from queries where id = $1", [
              foreignQuery.id,
            ])
          ).rows.length,
          0,
        );
        await assert.rejects(create(foreignTask), /access denied/);
        assert.equal(
          (
            await db.query(
              "update queries set query_text = 'attack' where id = $1 returning id",
              [foreignQuery.id],
            )
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await db.query("delete from queries where id = $1 returning id", [
              foreignQuery.id,
            ])
          ).rows.length,
          0,
        );
        await asUser(b);
        assert.equal((await taskState(foreignTask)).last_query_no, 1);
        assert.equal(
          (await db.query("select * from queries where task_id = $1", [task]))
            .rows.length,
          0,
        );
        await asUser(a);
      },
    );
    await t.test(
      "anonymous access and direct trigger execution are denied",
      async () => {
        await assert.rejects(
          db.query("select public.allocate_query_number()"),
          /permission denied/,
        );
        await db.exec("reset role; set role anon;");
        await assert.rejects(
          db.query("select * from queries"),
          /permission denied/,
        );
        await assert.rejects(create(task), /permission denied/);
        await asUser(a);
      },
    );
    await t.test(
      "M1 edit/status/cascade behavior remains available after upgrade",
      async () => {
        await db.query(
          "update tasks set entity_name = '新对象', note = '备注', status = 'completed' where id = $1",
          [task],
        );
        assert.ok((await taskState(task)).completed_at);
        await db.query("update tasks set status = 'blocked' where id = $1", [
          task,
        ]);
        assert.equal((await taskState(task)).completed_at, null);
        const row = await create(task);
        await db.query(
          "insert into captures(query_id, capture_no, storage_path, source_url) values ($1, 1, 'fixture.png', 'https://example.com')",
          [row.id],
        );
        await db.query("delete from queries where id = $1", [row.id]);
        assert.equal((await db.query("select * from captures")).rows.length, 0);
        await db.query("delete from tasks where id = $1", [task]);
        assert.equal(
          (await db.query("select * from queries where task_id = $1", [task]))
            .rows.length,
          0,
        );
        await db.query("delete from projects where id = $1", [pa]);
        assert.equal((await db.query("select * from tasks")).rows.length, 0);
        assert.equal((await db.query("select * from queries")).rows.length, 0);
      },
    );
  } finally {
    await db.close();
  }
});
