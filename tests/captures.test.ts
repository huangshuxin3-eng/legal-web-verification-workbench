import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Capture } from "../src/lib/database.types.ts";

test("M3 real PostgreSQL RLS with authenticated A/B roles, no privileged client", async (t) => {
  const db = new PGlite();
  const a = randomUUID(),
    b = randomUUID();
  async function asUser(id: string) {
    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  }
  async function newTask(project: string) {
    const task = (
      await db.query<{ id: string }>(
        "insert into tasks(project_id,entity_name,topic,source_name,source_url) values ($1,'公司','知识产权','网站','https://example.com') returning id",
        [project],
      )
    ).rows[0].id;
    const query = (
      await db.query<{ id: string }>(
        "insert into queries(task_id,query_text) values ($1,'申请人=公司') returning id",
        [task],
      )
    ).rows[0].id;
    return { task, query };
  }
  async function reserve(query: string) {
    return (
      await db.query<Capture>(
        "select * from reserve_capture_upload($1,'https://example.com','png')",
        [query],
      )
    ).rows[0];
  }
  async function upload(row: Capture) {
    await db.query(
      "insert into storage.objects(bucket_id,name) values ('captures',$1)",
      [row.storage_path],
    );
  }
  async function finish(row: Capture) {
    return (
      await db.query<Capture>("select * from finish_capture_upload($1,$2)", [
        row.query_id,
        row.id,
      ])
    ).rows[0];
  }
  async function add(query: string) {
    const row = await reserve(query);
    await upload(row);
    return await finish(row);
  }
  async function remove(row: Capture) {
    await db.query("select * from prepare_capture_delete($1)", [row.id]);
    await db.query("delete from storage.objects where name=$1", [
      row.storage_path,
    ]);
    await db.query("select finish_capture_delete($1,$2)", [
      row.query_id,
      row.id,
    ]);
  }
  async function cancel(row: Capture) {
    await db.query("select * from cancel_capture_upload($1,$2)", [
      row.query_id,
      row.id,
    ]);
    await db.query("delete from storage.objects where name=$1", [
      row.storage_path,
    ]);
    await db.query("select finish_capture_delete($1,$2)", [
      row.query_id,
      row.id,
    ]);
  }
  try {
    // Only bootstrap uses table-owner privileges. Every operation below uses Auth roles.
    await db.exec(`create role anon; create role authenticated;
   create schema auth; create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   create function auth.role() returns text language sql stable as $$ select current_user::text $$;
   grant usage on schema public,auth to anon,authenticated;
   grant execute on all functions in schema auth to anon,authenticated;
   insert into auth.users values ('${a}'),('${b}');
   create schema storage;
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,unique(bucket_id,name));
   alter table storage.objects enable row level security;
   grant usage on schema storage to anon,authenticated;
   grant select on storage.buckets to authenticated;
   grant select,insert,update,delete on storage.objects to anon,authenticated;
   create policy unrelated_broad_policy on storage.objects for all to authenticated using(true) with check(true);`);
    for (const name of [
      "202609140001_milestone_1",
      "202609140002_milestone_2",
      "202609140003_milestone_3",
      "202609140004_milestone_4",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${name}.sql`, import.meta.url),
          "utf8",
        ),
      );
    await asUser(a);
    const pa = (
      await db.query<{ id: string }>(
        "insert into projects(owner_id,name) values ($1,$2) returning id",
        [a, "A"],
      )
    ).rows[0].id;
    const own = await newTask(pa);
    const one = await add(own.query);
    await asUser(b);
    const pb = (
      await db.query<{ id: string }>(
        "insert into projects(owner_id,name) values ($1,$2) returning id",
        [b, "B"],
      )
    ).rows[0].id;
    const other = await newTask(pb);
    const foreign = await add(other.query);
    await asUser(a);
    await t.test(
      "private PDF/PNG/JPEG bucket and Capture schema remain minimal",
      async () => {
        const bucket = (
          await db.query<{
            public: boolean;
            file_size_limit: number;
            allowed_mime_types: string[];
          }>("select * from storage.buckets where id='captures'")
        ).rows[0];
        assert.equal(bucket.public, false);
        assert.equal(Number(bucket.file_size_limit), 20971520);
        assert.deepEqual(bucket.allowed_mime_types, [
          "application/pdf",
          "image/png",
          "image/jpeg",
        ]);
        assert.deepEqual(
          Object.keys(one).sort(),
          [
            "id",
            "query_id",
            "capture_no",
            "storage_path",
            "source_url",
            "created_at",
          ].sort(),
        );
      },
    );
    await t.test(
      "PDF, optional URL and stable request id reuse the M3 allocator",
      async () => {
        const pdfQuery = (
          await db.query<{ id: string }>(
            "insert into queries(task_id,query_text) values ($1,'PDF 留痕测试') returning id",
            [own.task],
          )
        ).rows[0].id;
        const requestId = randomUUID();
        const first = (
          await db.query<Capture>(
            "select * from reserve_capture_upload($1,null,'pdf',$2)",
            [pdfQuery, requestId],
          )
        ).rows[0];
        const retry = (
          await db.query<Capture>(
            "select * from reserve_capture_upload($1,null,'pdf',$2)",
            [pdfQuery, requestId],
          )
        ).rows[0];
        assert.deepEqual(retry, first);
        assert.equal(first.source_url, null);
        assert.match(first.storage_path, new RegExp(`${requestId}\\.pdf$`));
        await upload(first);
        assert.deepEqual(await finish(first), first);
        assert.deepEqual(
          (
            await db.query<Capture>(
              "select * from reserve_capture_upload($1,null,'pdf',$2)",
              [pdfQuery, requestId],
            )
          ).rows[0],
          first,
        );
        await remove(first);
        await db.query("delete from queries where id=$1", [pdfQuery]);
      },
    );
    await t.test(
      "delete middle, highest and all; numbers never reused",
      async () => {
        const two = await add(own.query),
          three = await add(own.query);
        assert.equal(one.capture_no, 1);
        assert.equal(two.capture_no, 2);
        assert.equal(three.capture_no, 3);
        assert.equal(foreign.capture_no, 1);
        await remove(two);
        await remove(three);
        const four = await add(own.query);
        assert.equal(four.capture_no, 4);
        await remove(one);
        await remove(four);
        assert.equal((await add(own.query)).capture_no, 5);
      },
    );
    await t.test(
      "cancelled/failed upload reservations are durable and consume their number",
      async () => {
        const unused = await reserve(own.query);
        assert.equal(unused.capture_no, 6);
        await assert.rejects(finish(unused), /Upload the file first/);
        await cancel(unused);
        assert.equal((await add(own.query)).capture_no, 7);
        await assert.rejects(finish(unused), /absent or cancelled/);
      },
    );
    await t.test(
      "only reserved paths can be uploaded; cancelled upload cannot finalize",
      async () => {
        await assert.rejects(
          db.query(
            "insert into storage.objects(bucket_id,name) values ('captures',$1)",
            [`${a}/${pa}/${own.task}/${own.query}/forged.png`],
          ),
          /row-level security/,
        );
        const row = await reserve(own.query);
        await upload(row);
        await db.query("select * from cancel_capture_upload($1,$2)", [
          row.query_id,
          row.id,
        ]);
        await assert.rejects(finish(row), /absent or cancelled/);
        await cancel(row);
        await assert.rejects(upload(row), /row-level security/);
      },
    );
    await t.test(
      "finalization is idempotent, clears reservation and cannot revive deleted numbers",
      async () => {
        const row = await add(own.query);
        assert.deepEqual(await finish(row), row);
        const operations = (
          await db.query<{ capture_operations: Record<string, unknown> }>(
            "select capture_operations from queries where id=$1",
            [row.query_id],
          )
        ).rows[0].capture_operations;
        assert.equal(operations[row.id], undefined);
        // A cancellation request racing after successful finalization returns no work.
        assert.equal(
          (
            await db.query("select * from cancel_capture_upload($1,$2)", [
              row.query_id,
              row.id,
            ])
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await db.query(
              "delete from storage.objects where name=$1 returning id",
              [row.storage_path],
            )
          ).rows.length,
          0,
        );
        await remove(row);
        await assert.rejects(finish(row), /absent or cancelled/);
      },
    );
    await t.test(
      "A/B isolation covers rows, file reads, upload, RPCs and file deletion",
      async () => {
        const ours = (
          await db.query<Capture>("select * from captures where query_id=$1", [
            own.query,
          ])
        ).rows[0];
        await db.query("select * from prepare_capture_delete($1)", [ours.id]);
        await asUser(b);
        assert.equal(
          (
            await db.query("select * from captures where query_id=$1", [
              own.query,
            ])
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await db.query("select * from storage.objects where name=$1", [
              ours.storage_path,
            ])
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await db.query(
              "delete from storage.objects where name=$1 returning id",
              [ours.storage_path],
            )
          ).rows.length,
          0,
        );
        await assert.rejects(reserve(own.query), /access denied/);
        await assert.rejects(
          db.query("select * from prepare_capture_delete($1)", [ours.id]),
          /access denied/,
        );
        await assert.rejects(
          db.query("select finish_capture_delete($1,$2)", [own.query, ours.id]),
          /access denied/,
        );
        await assert.rejects(
          db.query("select * from cancel_capture_upload($1,$2)", [
            own.query,
            ours.id,
          ]),
          /access denied/,
        );
        await assert.rejects(
          db.query(
            "insert into storage.objects(bucket_id,name) values ('captures',$1)",
            [ours.storage_path.replace(".png", "x.png")],
          ),
          /row-level security/,
        );
        await asUser(a);
        assert.equal(
          (
            await db.query("select * from storage.objects where name=$1", [
              ours.storage_path,
            ])
          ).rows.length,
          1,
        );
        assert.equal(
          (await db.query("select * from captures where id=$1", [foreign.id]))
            .rows.length,
          0,
        );
      },
    );
    await t.test(
      "file removal must precede row deletion; restore is allowed during pending delete",
      async () => {
        const row = await add(own.query);
        await assert.rejects(
          db.query("select finish_capture_delete($1,$2)", [
            row.query_id,
            row.id,
          ]),
          /Prepare deletion/,
        );
        await db.query("select * from prepare_capture_delete($1)", [row.id]);
        await assert.rejects(
          db.query("select finish_capture_delete($1,$2)", [
            row.query_id,
            row.id,
          ]),
          /Delete the Storage file/,
        );
        await db.query("delete from storage.objects where name=$1", [
          row.storage_path,
        ]);
        await upload(row); // Compensation uses the same owner's INSERT policy.
        await remove(row);
      },
    );
    await t.test(
      "clients cannot forge counters/operations/records or overwrite object",
      async () => {
        await assert.rejects(
          db.query("update queries set last_capture_no=0 where id=$1", [
            own.query,
          ]),
          /permission denied/,
        );
        await assert.rejects(
          db.query("update queries set capture_operations='{}' where id=$1", [
            own.query,
          ]),
          /permission denied/,
        );
        await assert.rejects(
          db.query("delete from captures where query_id=$1", [own.query]),
          /permission denied/,
        );
        await assert.rejects(
          db.query(
            "insert into captures(query_id,capture_no,storage_path,source_url) values ($1,999,'fake.png','https://example.com')",
            [own.query],
          ),
          /permission denied/,
        );
        assert.equal(
          (
            await db.query(
              "update storage.objects set name='overwrite.png' where bucket_id='captures' returning id",
            )
          ).rows.length,
          0,
        );
      },
    );
    await t.test(
      "parent deletion with files or pending operations is blocked",
      async () => {
        await assert.rejects(
          db.query("delete from queries where id=$1", [own.query]),
          /capture operations/,
        );
        await assert.rejects(
          db.query("delete from tasks where id=$1", [own.task]),
          /capture operations/,
        );
        await assert.rejects(
          db.query("delete from projects where id=$1", [pa]),
          /capture operations/,
        );
      },
    );
    await t.test(
      "server aggregation is exact and respects caller RLS",
      async () => {
        assert.deepEqual(
          (
            await db.query("select * from task_capture_counts($1,$2)", [
              pa,
              own.task,
            ])
          ).rows,
          [{ task_id: own.task, capture_count: 2 }],
        );
        assert.equal(
          (await db.query("select * from task_capture_counts($1)", [pb])).rows
            .length,
          0,
        );
      },
    );
    await t.test(
      "Task count sums captures from multiple Query rows",
      async () => {
        const q2 = (
          await db.query<{ id: string }>(
            "insert into queries(task_id,query_text) values ($1,'第二次查询') returning id",
            [own.task],
          )
        ).rows[0].id;
        const extra = await add(q2);
        assert.deepEqual(
          (
            await db.query("select * from task_capture_counts($1,$2)", [
              pa,
              own.task,
            ])
          ).rows,
          [{ task_id: own.task, capture_count: 3 }],
        );
        await remove(extra);
        await db.query("delete from queries where id=$1", [q2]);
      },
    );
    await t.test(
      "anonymous cannot execute capture RPCs or read Storage",
      async () => {
        await db.exec("reset role; set role anon");
        await assert.rejects(reserve(own.query), /permission denied/);
        await assert.rejects(
          db.query("select * from captures"),
          /permission denied/,
        );
        try {
          assert.equal(
            (
              await db.query("select * from storage.objects where name=$1", [
                foreign.storage_path,
              ])
            ).rows.length,
            0,
          );
        } catch (error) {
          assert.match(String(error), /permission denied/);
        }
        await asUser(a);
      },
    );
    await t.test(
      "M1/M2 editing remains; parent deletion succeeds after coordinated cleanup",
      async () => {
        await db.query("update queries set query_text='新条件' where id=$1", [
          own.query,
        ]);
        await db.query(
          "update tasks set status='completed',note='备注' where id=$1",
          [own.task],
        );
        assert.ok(
          (
            await db.query<{ completed_at: Date }>(
              "select completed_at from tasks where id=$1",
              [own.task],
            )
          ).rows[0].completed_at,
        );
        const rows = (
          await db.query<Capture>("select * from captures where query_id=$1", [
            own.query,
          ])
        ).rows;
        for (const row of rows) await remove(row);
        await db.query("delete from queries where id=$1", [own.query]);
        await db.query("delete from projects where id=$1", [pa]);
        assert.equal((await db.query("select * from tasks")).rows.length, 0);
        assert.equal((await db.query("select * from captures")).rows.length, 0);
      },
    );
  } finally {
    await db.close();
  }
});
