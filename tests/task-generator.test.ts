import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Task } from "../src/lib/database.types.ts";
import { TASK_SCOPE_PRESETS } from "../src/config/task-generator.ts";
import {
  buildCandidates,
  isScopeReady,
  parseEntities,
  reclassifyCandidates,
  scopesFromPresets,
  type ScopeInput,
} from "../src/lib/task-generator.ts";
import {
  createTasks,
  createTasksAfterRecheck,
  getProjectTasks,
  type TaskCreateInput,
} from "../src/lib/task-repository.ts";

const projectA = "10000000-0000-4000-8000-000000000001";
const projectB = "10000000-0000-4000-8000-000000000002";
const scopes: ScopeInput[] = [
  {
    id: "business",
    category: "基础信息",
    topic: "工商信息",
    sourceName: "公示系统",
    sourceUrl: "https://example.com/business",
  },
  {
    id: "enforcement",
    category: "司法风险",
    topic: "执行",
    sourceName: "执行信息网",
    sourceUrl: "https://example.com/enforcement",
  },
];

function createMemoryTaskDb() {
  const rows: Task[] = [];
  let sequence = 0;
  const db = {
    from: (table: string) => {
      assert.equal(table, "tasks");
      return {
        insert: (inputs: (TaskCreateInput & { project_id: string })[]) => {
          const created = inputs.map((input) => {
            sequence += 1;
            return {
              ...input,
              id: `20000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
              created_at: "2026-09-15T00:00:00.000Z",
              completed_at: null,
              last_query_no: 0,
            } satisfies Task;
          });
          rows.push(...created);
          return {
            select: async () => ({ data: created, error: null }),
          };
        },
        select: () => ({
          eq: (_column: string, projectId: string) => {
            const query = {
              order: () => query,
              range: async (from: number, to: number) => ({
                data: rows
                  .filter((task) => task.project_id === projectId)
                  .slice(from, to + 1),
                error: null,
              }),
            };
            return query;
          },
        }),
      };
    },
  } as unknown as SupabaseClient<Database>;
  return { db, rows };
}

test("主体文本解析会 trim、忽略空行、精确去重并保持首次顺序", () => {
  const parsed = parseEntities(
    "  北京木锐机器人有限公司  \n\n上海某某科技有限公司\r\n北京木锐机器人有限公司\n 深圳某某投资有限公司 \n",
  );
  assert.deepEqual(parsed.entities, [
    "北京木锐机器人有限公司",
    "上海某某科技有限公司",
    "深圳某某投资有限公司",
  ]);
  assert.equal(parsed.duplicateCount, 1);
});

test("选中的核查范围按主体笛卡尔积计算候选数量", () => {
  const entities = ["主体 A", "主体 B", "主体 C"];
  assert.equal(buildCandidates(projectA, entities, scopes, []).length, 6);
  assert.equal(
    buildCandidates(projectA, entities, scopes.slice(0, 1), []).length,
    3,
  );
});

test("同批完全相同组合只保留第一次", () => {
  const duplicateScope = { ...scopes[0], id: "same-combination" };
  const candidates = buildCandidates(
    projectA,
    ["主体 A"],
    [scopes[0], duplicateScope],
    [],
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].availability, "pending");
});

test("只在同一 Project 的五项完全一致时识别为已有 Task", () => {
  const existing = {
    project_id: projectA,
    entity_name: "主体 A",
    topic: scopes[0].topic,
    source_name: scopes[0].sourceName,
    source_url: scopes[0].sourceUrl,
  };
  assert.equal(
    buildCandidates(projectA, ["主体 A"], scopes.slice(0, 1), [existing])[0]
      .availability,
    "existing",
  );
  assert.equal(
    buildCandidates(projectB, ["主体 A"], scopes.slice(0, 1), [existing])[0]
      .availability,
    "pending",
  );
});

test("删除单条待创建候选后计数同步减少", () => {
  const candidates = buildCandidates(
    projectA,
    ["主体 A", "主体 B"],
    scopes,
    [],
  );
  const remaining = candidates.filter(
    (candidate) => candidate.key !== candidates[0].key,
  );
  assert.equal(
    candidates.filter((candidate) => candidate.availability === "pending")
      .length,
    4,
  );
  assert.equal(
    remaining.filter((candidate) => candidate.availability === "pending")
      .length,
    3,
  );
});

test("已确认预设加载各自配置 URL", () => {
  const configured = Object.fromEntries(
    TASK_SCOPE_PRESETS.map((preset) => [preset.id, preset]),
  );
  const defaultSelectedPresets = TASK_SCOPE_PRESETS.filter(
    (preset) => preset.defaultSelected,
  );

  assert.deepEqual(
    defaultSelectedPresets.map((preset) => preset.id),
    [
      "business",
      "enforcement",
      "dishonesty",
      "litigation",
      "court-notice",
      "trademark",
      "patent",
    ],
  );
  assert.equal(defaultSelectedPresets.length, 7);
  assert.equal(
    defaultSelectedPresets.filter((preset) => !preset.sourceUrl).length,
    0,
  );

  assert.equal(
    configured.business.sourceUrl,
    "https://www.gsxt.gov.cn/index.html",
  );
  for (const id of ["enforcement", "dishonesty", "consumption-limit"]) {
    assert.equal(configured[id].sourceUrl, "https://zxgk.court.gov.cn/");
  }
  assert.equal(configured.litigation.sourceUrl, "https://wenshu.court.gov.cn/");
  assert.equal(
    configured["court-notice"].sourceUrl,
    "https://rmfygg.court.gov.cn/",
  );
  assert.equal(configured.trademark.sourceUrl, "https://sbj.cnipa.gov.cn/");
  assert.equal(
    configured.patent.sourceUrl,
    "https://pss-system.cponline.cnipa.gov.cn/conventionalSearch",
  );
  assert.equal(
    configured.patent.sourceName,
    "国家知识产权局专利检索及分析系统",
  );
});

test("未配置 URL 的预设项保持为空", () => {
  const unconfigured = TASK_SCOPE_PRESETS.filter((preset) =>
    ["bankruptcy", "administrative", "securities", "news"].includes(preset.id),
  );
  assert.equal(unconfigured.length, 4);
  assert.ok(unconfigured.every((preset) => preset.sourceUrl === null));
  assert.ok(
    scopesFromPresets(unconfigured).every((scope) => scope.sourceUrl === ""),
  );
});

test("历史 Task 的错误 URL 不会覆盖应用层预设 URL", () => {
  const historicalTask = {
    source_name: "国家企业信用信息公示系统",
    source_url: "https://incorrect.example.com",
  };
  const business = TASK_SCOPE_PRESETS.find(
    (preset) => preset.id === "business",
  )!;
  const [scope] = scopesFromPresets([business]);
  assert.equal(historicalTask.source_name, scope.sourceName);
  assert.equal(scope.sourceUrl, "https://www.gsxt.gov.cn/index.html");
  assert.notEqual(scope.sourceUrl, historicalTask.source_url);
});

test("应用层预设 URL 正常显示且本次状态允许用户编辑", () => {
  const business = TASK_SCOPE_PRESETS.find(
    (preset) => preset.id === "business",
  )!;
  const [scope] = scopesFromPresets([business]);
  assert.equal(scope.sourceUrl, business.sourceUrl);
  const edited = { ...scope, sourceUrl: "https://example.com/manual-edit" };
  assert.equal(edited.sourceUrl, "https://example.com/manual-edit");
  assert.equal(isScopeReady(edited), true);
});

test("缺少 URL 的已选范围不可继续，手填有效 HTTP(S) URL 后可继续", () => {
  const [scope] = scopesFromPresets([{ ...scopes[0], sourceUrl: null }]);
  assert.equal(isScopeReady(scope), false);
  assert.equal(
    isScopeReady({ ...scope, sourceUrl: "ftp://example.com" }),
    false,
  );
  assert.equal(
    isScopeReady({ ...scope, sourceUrl: "https://example.com/manual" }),
    true,
  );
});

test("批量数据访问层进行单次插入并固定新 Task 状态", async () => {
  let inserted: unknown[] = [];
  let insertCalls = 0;
  const fakeDb = {
    from: (table: string) => {
      assert.equal(table, "tasks");
      return {
        insert: (rows: unknown[]) => {
          insertCalls += 1;
          inserted = rows;
          return {
            select: async () => ({ data: rows, error: null }),
          };
        },
      };
    },
  } as unknown as SupabaseClient<Database>;
  const pending = buildCandidates(
    projectA,
    ["主体 A", "主体 B"],
    scopes,
    [],
  ).map(({ key: _key, availability: _availability, ...task }) => task);
  await createTasks(fakeDb, projectA, pending);
  assert.equal(insertCalls, 1);
  assert.equal(inserted.length, 4);
  assert.ok(
    inserted.every(
      (row) =>
        (row as { project_id: string; status: string }).project_id ===
          projectA && (row as { status: string }).status === "not_started",
    ),
  );
});

test("首次创建后重新 fetch，第二次运行及提交前复检均不会重复创建", async () => {
  const { db, rows } = createMemoryTaskDb();
  const enforcement = scopesFromPresets([
    TASK_SCOPE_PRESETS.find((preset) => preset.id === "enforcement")!,
  ])[0];
  const original = buildCandidates(
    projectA,
    [" 北京术锐机器人有限公司 "],
    [enforcement, scopes[0]],
    [],
  );
  const removedByUser = original[1];
  const firstInputs = original
    .slice(0, 1)
    .map(({ key: _key, availability: _availability, ...task }) => task);

  const first = await createTasksAfterRecheck(db, projectA, firstInputs);
  assert.equal(first.created.length, 1);
  assert.equal(first.skipped, 0);

  const fetchedAfterReentry = await getProjectTasks(db, projectA);
  const secondPreview = buildCandidates(
    projectA,
    ["北京术锐机器人有限公司"],
    [enforcement, scopes[0]],
    fetchedAfterReentry,
  );
  const identityFields = [
    "project_id",
    "entity_name",
    "topic",
    "source_name",
    "source_url",
  ] as const;
  const exactIdentity = {
    project_id: projectA,
    entity_name: "北京术锐机器人有限公司",
    topic: "执行",
    source_name: "中国执行信息公开网",
    source_url: "https://zxgk.court.gov.cn/",
  };
  assert.deepEqual(
    Object.fromEntries(identityFields.map((field) => [field, rows[0][field]])),
    exactIdentity,
  );
  assert.deepEqual(
    Object.fromEntries(
      identityFields.map((field) => [
        field,
        field === "project_id" ? projectA : secondPreview[0][field],
      ]),
    ),
    exactIdentity,
  );
  assert.equal(
    secondPreview.filter((task) => task.availability === "existing").length,
    1,
  );
  assert.equal(
    secondPreview.filter((task) => task.availability === "pending").length,
    1,
  );
  assert.equal(secondPreview[1].key, removedByUser.key);

  // Even a stale caller submits the original pending input, the server-side
  // repository fetches current rows again before inserting.
  const repeatedSubmit = await createTasksAfterRecheck(
    db,
    projectA,
    firstInputs,
  );
  assert.equal(repeatedSubmit.created.length, 0);
  assert.equal(repeatedSubmit.skipped, 1);
  assert.equal(rows.length, 1);

  const createPreviouslyRemoved = await createTasksAfterRecheck(
    db,
    projectA,
    secondPreview.map(
      ({ key: _key, availability: _availability, ...task }) => task,
    ),
  );
  assert.equal(createPreviouslyRemoved.created.length, 1);
  assert.equal(createPreviouslyRemoved.skipped, 1);

  const allExisting = await createTasksAfterRecheck(
    db,
    projectA,
    original.map(({ key: _key, availability: _availability, ...task }) => task),
  );
  assert.equal(allExisting.created.length, 0);
  assert.equal(allExisting.skipped, 2);

  const otherProject = await createTasksAfterRecheck(
    db,
    projectB,
    original.map(({ key: _key, availability: _availability, ...task }) => task),
  );
  assert.equal(otherProject.created.length, 2);

  const differentUrl = {
    ...firstInputs[0],
    source_url: `${firstInputs[0].source_url}/different`,
  };
  const differentUrlResult = await createTasksAfterRecheck(db, projectA, [
    differentUrl,
  ]);
  assert.equal(differentUrlResult.created.length, 1);
});

test("M5 批量创建、重复运行和 owner isolation 在真实 PostgreSQL 约束下成立", async () => {
  const db = new PGlite();
  const userA = "00000000-0000-4000-8000-000000000001";
  const userB = "00000000-0000-4000-8000-000000000002";
  try {
    await db.exec(`create role anon; create role authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public to authenticated, anon;
      grant execute on function auth.uid() to authenticated, anon;
      insert into auth.users values ('${userA}'), ('${userB}');`);
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202609140001_milestone_1.sql",
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
    await asUser(userA);
    await db.query(
      "insert into projects(id, owner_id, name) values ($1, $2, 'M5 项目 A')",
      [projectA, userA],
    );
    const candidates = buildCandidates(
      projectA,
      ["主体 A", "主体 B"],
      scopes,
      [],
    );
    await db.query(
      `insert into tasks(project_id, entity_name, topic, source_name, source_url, note, status)
       values ($1,$2,$3,$4,$5,null,'not_started'), ($1,$6,$7,$8,$9,null,'not_started'),
              ($1,$10,$11,$12,$13,null,'not_started'), ($1,$14,$15,$16,$17,null,'not_started')`,
      [
        projectA,
        candidates[0].entity_name,
        candidates[0].topic,
        candidates[0].source_name,
        candidates[0].source_url,
        candidates[1].entity_name,
        candidates[1].topic,
        candidates[1].source_name,
        candidates[1].source_url,
        candidates[2].entity_name,
        candidates[2].topic,
        candidates[2].source_name,
        candidates[2].source_url,
        candidates[3].entity_name,
        candidates[3].topic,
        candidates[3].source_name,
        candidates[3].source_url,
      ],
    );
    const stored = (
      await db.query<Task>("select * from tasks order by entity_name, topic")
    ).rows;
    assert.equal(stored.length, 4);
    assert.ok(stored.every((task) => task.status === "not_started"));
    assert.equal((await db.query("select id from queries")).rows.length, 0);
    assert.equal((await db.query("select id from captures")).rows.length, 0);

    const rerun = reclassifyCandidates(projectA, candidates, stored);
    assert.equal(
      rerun.filter((candidate) => candidate.availability === "pending").length,
      0,
    );
    assert.equal(
      rerun.filter((candidate) => candidate.availability === "existing").length,
      4,
    );

    await asUser(userB);
    await db.query(
      "insert into projects(id, owner_id, name) values ($1, $2, 'M5 项目 B')",
      [projectB, userB],
    );
    assert.equal((await db.query("select id from tasks")).rows.length, 0);
    await assert.rejects(
      db.query(
        "insert into tasks(project_id, entity_name, topic, source_name, source_url) values ($1, '主体 B', '工商信息', '公示系统', 'https://example.com')",
        [projectA],
      ),
      /row-level security/,
    );
  } finally {
    await db.close();
  }
});
