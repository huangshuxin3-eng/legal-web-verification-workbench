/**
 * AI 分析草稿的**持久化形状、确认门禁与 API 方法**（Slice 2）。
 *
 * 只测**契约**：落库形状是否严格、客户端能改什么 / 不能改什么、
 * 已确认的分析什么时候允许进报告。不读 PDF、不调 provider、不连真实 DB
 * （仓储逻辑用极简 Supabase 桩驱动，因此测的是**真实**实现而不是重写一遍）。
 *
 * provider 请求形状见 `zxgk-analysis-client.test.ts`；提示词 / 护栏 / 指纹
 * 见 `zxgk-analysis.test.ts`；DOCX 集成见 `zxgk-report-flow.test.ts`。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/database.types.ts";
import { CaptureOperationError } from "../src/lib/capture-workflow.ts";
import {
  ANALYSIS_DRAFT_INVALID_MESSAGE,
  ANALYSIS_DRAFT_MISSING_MESSAGE,
  ANALYSIS_DRAFT_VERSION,
  ANALYSIS_SAVE_INVALID_MESSAGE,
  ANALYSIS_SECTION_KEYS,
  ANALYSIS_STALE_MESSAGE,
  ANALYSIS_STATUS_LABELS,
  analysisDraftStatus,
  readAnalysisDraftRecord,
  type AnalysisDraft,
  type AnalysisDraftRecord,
} from "../src/lib/analysis-names.ts";
import {
  ANALYSIS_PROJECT_MISSING_MESSAGE,
  createAnalysisDraft,
  loadAnalysisDraft,
  readAnalysisWrite,
  resolveConfirmedAnalysis,
  writeAnalysisDraft,
} from "../src/lib/server/analysis-draft.ts";

const SECTIONS: AnalysisDraft = {
  overview: "本次核查共纳入 2 条记录。",
  keyRisks: "未发现需特别提示的事项",
  keyRecords: "原始序号1｜（2026）粤03执1234号｜被执行人",
  followUps: "现有核查信息不足以判断",
};

const EDITED: AnalysisDraft = {
  overview: "人工修改后的概览。",
  keyRisks: "人工修改后的重点事项。",
  keyRecords: "原始序号2｜（2026）粤03执1234号｜失信被执行人",
  followUps: "人工修改后的核实建议。",
};

const GENERATED_AT = "2026-09-19T01:00:00.000Z";
const HASH = "a".repeat(64);
const PROJECT_ID = "11111111-2222-3333-4444-555555555555";

function record(
  overrides: Partial<AnalysisDraftRecord> = {},
): AnalysisDraftRecord {
  return {
    version: ANALYSIS_DRAFT_VERSION,
    checkDate: "2026-09-17",
    sourceHash: HASH,
    generatedAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
    confirmedAt: null,
    sections: SECTIONS,
    ...overrides,
  };
}

/**
 * 极简 Supabase 桩：只实现本仓库用到的那条链
 * （`from().select().eq().maybeSingle()` / `from().update().eq().select().maybeSingle()`），
 * 方法顺序无关，`maybeSingle` 永远返回当前行。
 */
function fakeProjectsDb(row: { id: string; analysis_draft: unknown } | null) {
  const state = { row, lastUpdate: null as Record<string, unknown> | null };
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    select: chain,
    eq: chain,
    update: (payload: Record<string, unknown>) => {
      state.lastUpdate = payload;
      if (state.row) state.row = { ...state.row, ...payload };
      return builder;
    },
    maybeSingle: async () => ({ data: state.row, error: null }),
  });
  return {
    db: { from: () => builder } as unknown as SupabaseClient<Database>,
    state,
  };
}

// ── 1. 落库形状（非法 shape 一律 fail closed）──────────────────────────────

test("落库形状：合法记录被规整读回", () => {
  const parsed = readAnalysisDraftRecord(record());
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed!), [
    "version",
    "checkDate",
    "sourceHash",
    "generatedAt",
    "updatedAt",
    "confirmedAt",
    "sections",
  ]);
  assert.equal(parsed!.checkDate, "2026-09-17");
  assert.equal(parsed!.confirmedAt, null);
  assert.deepEqual(parsed!.sections, SECTIONS);
});

test("落库形状：非法 jsonb shape 一律 fail closed（返回 null，不当草稿用）", () => {
  const cases: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["字符串", "analysis"],
    ["数字", 42],
    ["数组", [record()]],
    ["空对象", {}],
    ["版本缺失", { ...record(), version: undefined }],
    ["版本不匹配", { ...record(), version: ANALYSIS_DRAFT_VERSION + 1 }],
    ["版本非数字", { ...record(), version: "1" }],
    ["checkDate 缺失", { ...record(), checkDate: undefined }],
    ["checkDate 非法", { ...record(), checkDate: "2026/09/17" }],
    ["sourceHash 空", { ...record(), sourceHash: "   " }],
    ["sourceHash 缺失", { ...record(), sourceHash: undefined }],
    ["generatedAt 非时间", { ...record(), generatedAt: "刚刚" }],
    ["updatedAt 缺失", { ...record(), updatedAt: undefined }],
    ["confirmedAt 非时间", { ...record(), confirmedAt: "已确认" }],
    ["sections 缺失", { ...record(), sections: undefined }],
    ["sections 是数组", { ...record(), sections: [] }],
    [
      "sections 缺一段",
      { ...record(), sections: { ...SECTIONS, followUps: undefined } },
    ],
    [
      "sections 某段为空串",
      { ...record(), sections: { ...SECTIONS, overview: "  " } },
    ],
    [
      "sections 某段非字符串",
      { ...record(), sections: { ...SECTIONS, keyRisks: 7 } },
    ],
  ];
  for (const [label, value] of cases)
    assert.equal(readAnalysisDraftRecord(value), null, `必须拒绝：${label}`);
  // 额外键不影响解析（向后兼容：将来加字段不会让旧记录变成非法）
  assert.ok(readAnalysisDraftRecord({ ...record(), extra: 1 }));
});

test("落库形状：sections 四段被 trim，顺序与口径常量一致", () => {
  const parsed = readAnalysisDraftRecord({
    ...record(),
    sections: Object.fromEntries(
      ANALYSIS_SECTION_KEYS.map((key) => [key, `  ${key}-正文  `]),
    ),
  });
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed!.sections), [...ANALYSIS_SECTION_KEYS]);
  for (const key of ANALYSIS_SECTION_KEYS)
    assert.equal(parsed!.sections[key], `${key}-正文`);
});

// ── 2. 状态机 ─────────────────────────────────────────────────────────────

test("状态机：未保存 / 未确认 / 已确认 / 修改后需重新确认", () => {
  assert.equal(analysisDraftStatus(null, false), "none");
  assert.equal(analysisDraftStatus(record(), false), "unconfirmed");
  assert.equal(analysisDraftStatus(record(), true), "dirty");
  const confirmed = record({ confirmedAt: "2026-09-19T02:00:00.000Z" });
  assert.equal(analysisDraftStatus(confirmed, false), "confirmed");
  // 已确认后继续编辑 → 必须重新确认（后端 save 会清空 confirmedAt）
  assert.equal(analysisDraftStatus(confirmed, true), "dirty-confirmed");
  for (const status of [
    "unconfirmed",
    "confirmed",
    "dirty",
    "dirty-confirmed",
  ] as const)
    assert.ok(ANALYSIS_STATUS_LABELS[status].length > 0);
  assert.equal(ANALYSIS_STATUS_LABELS.none, "");
  assert.ok(ANALYSIS_STATUS_LABELS.confirmed.includes("已确认"));
  assert.ok(ANALYSIS_STATUS_LABELS.unconfirmed.includes("未确认"));
  assert.ok(ANALYSIS_STATUS_LABELS["dirty-confirmed"].includes("重新确认"));
});

// ── 3. 请求体：客户端只能改 sections ──────────────────────────────────────

test("请求体 schema：只接受 { action, sections }", () => {
  for (const action of ["save", "confirm"] as const)
    assert.deepEqual(readAnalysisWrite({ action, sections: SECTIONS }), {
      action,
      sections: SECTIONS,
    });
  // 四段内容被 trim
  const trimmed = readAnalysisWrite({
    action: "save",
    sections: { ...SECTIONS, overview: "  概览  " },
  });
  assert.equal(trimmed.sections.overview, "概览");
});

test("请求体 schema：非法形状一律 400，不部分写入", () => {
  const cases: [string, unknown][] = [
    ["null", null],
    ["字符串", "save"],
    ["数组", []],
    ["缺 action", { sections: SECTIONS }],
    ["缺 sections", { action: "save" }],
    ["action 非法", { action: "delete", sections: SECTIONS }],
    ["action 非字符串", { action: 1, sections: SECTIONS }],
    ["sections 非对象", { action: "save", sections: "四段" }],
    [
      "sections 缺一段",
      { action: "save", sections: { ...SECTIONS, overview: undefined } },
    ],
    [
      "sections 某段为空",
      { action: "save", sections: { ...SECTIONS, keyRisks: " " } },
    ],
    [
      "sections 某段非字符串",
      { action: "save", sections: { ...SECTIONS, keyRecords: 1 } },
    ],
  ];
  for (const [label, body] of cases)
    assert.throws(
      () => readAnalysisWrite(body),
      (error: unknown) =>
        error instanceof CaptureOperationError &&
        error.status === 400 &&
        error.message === ANALYSIS_SAVE_INVALID_MESSAGE,
      `必须拒绝：${label}`,
    );
});

test("请求体 schema：客户端提交服务端拥有的字段 → 直接拒绝（不是静默忽略）", () => {
  for (const key of [
    "checkDate",
    "sourceHash",
    "generatedAt",
    "confirmedAt",
    "updatedAt",
  ]) {
    assert.throws(
      () =>
        readAnalysisWrite({
          action: "confirm",
          sections: SECTIONS,
          [key]: "伪造",
        }),
      (error: unknown) =>
        error instanceof CaptureOperationError && error.status === 400,
      `客户端不得改写：${key}`,
    );
  }
  // 多一段 / 少一段也不行（schema 固定）
  assert.throws(() =>
    readAnalysisWrite({
      action: "save",
      sections: { ...SECTIONS, extra: "x" },
    }),
  );
});

// ── 4. 仓储：真实读写（Supabase 桩）───────────────────────────────────────

test("仓储：没有草稿时返回 null；项目不存在时 404；坏形状 502", async () => {
  const empty = fakeProjectsDb({ id: PROJECT_ID, analysis_draft: null });
  assert.equal(await loadAnalysisDraft(empty.db, PROJECT_ID), null);

  const missing = fakeProjectsDb(null);
  await assert.rejects(
    () => loadAnalysisDraft(missing.db, PROJECT_ID),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 404 &&
      error.message === ANALYSIS_PROJECT_MISSING_MESSAGE,
  );

  const corrupt = fakeProjectsDb({
    id: PROJECT_ID,
    analysis_draft: { 乱码: true },
  });
  await assert.rejects(
    () => loadAnalysisDraft(corrupt.db, PROJECT_ID),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 502 &&
      error.message === ANALYSIS_DRAFT_INVALID_MESSAGE,
  );
});

test("仓储：生成即落库，服务端写死 checkDate / sourceHash / generatedAt，confirmedAt 为 null", async () => {
  const { db, state } = fakeProjectsDb({
    id: PROJECT_ID,
    analysis_draft: null,
  });
  const now = new Date("2026-09-19T03:00:00.000Z");
  const saved = await createAnalysisDraft({
    db,
    projectId: PROJECT_ID,
    sections: SECTIONS,
    checkDate: "2026-09-17",
    sourceHash: HASH,
    now,
  });
  assert.equal(saved.checkDate, "2026-09-17");
  assert.equal(saved.sourceHash, HASH);
  assert.equal(saved.generatedAt, now.toISOString());
  assert.equal(saved.updatedAt, now.toISOString());
  assert.equal(saved.confirmedAt, null);
  assert.equal(saved.version, ANALYSIS_DRAFT_VERSION);
  assert.deepEqual(saved.sections, SECTIONS);
  // 真的写进了那一行（而不是只在返回值里）
  assert.deepEqual(state.lastUpdate?.analysis_draft, saved);
});

test("仓储：save 保存四段并清空 confirmedAt；confirm 写入服务端时间戳", async () => {
  const confirmed = record({ confirmedAt: "2026-09-19T02:00:00.000Z" });
  const { db, state } = fakeProjectsDb({
    id: PROJECT_ID,
    analysis_draft: confirmed,
  });

  const saveAt = new Date("2026-09-19T04:00:00.000Z");
  const saved = await writeAnalysisDraft({
    db,
    projectId: PROJECT_ID,
    write: { action: "save", sections: EDITED },
    now: saveAt,
  });
  assert.deepEqual(saved.sections, EDITED);
  assert.equal(saved.confirmedAt, null, "任何人工修改后都必须重新确认");
  assert.equal(saved.updatedAt, saveAt.toISOString());
  // 服务端拥有的字段原样保留，客户端无从改写
  assert.equal(saved.checkDate, confirmed.checkDate);
  assert.equal(saved.sourceHash, confirmed.sourceHash);
  assert.equal(saved.generatedAt, confirmed.generatedAt);

  const confirmAt = new Date("2026-09-19T05:00:00.000Z");
  const ok = await writeAnalysisDraft({
    db,
    projectId: PROJECT_ID,
    write: { action: "confirm", sections: EDITED },
    currentSourceHash: confirmed.sourceHash,
    now: confirmAt,
  });
  assert.equal(ok.confirmedAt, confirmAt.toISOString());
  assert.equal(ok.sections.overview, EDITED.overview);
  assert.deepEqual(state.lastUpdate?.analysis_draft, ok);
});

test("仓储：confirm 指纹不一致 → 409，且不写 confirmedAt", async () => {
  const existing = record();
  const { db, state } = fakeProjectsDb({
    id: PROJECT_ID,
    analysis_draft: existing,
  });
  await assert.rejects(
    () =>
      writeAnalysisDraft({
        db,
        projectId: PROJECT_ID,
        write: { action: "confirm", sections: EDITED },
        currentSourceHash: "b".repeat(64),
      }),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 409 &&
      error.message === ANALYSIS_STALE_MESSAGE,
  );
  assert.equal(state.lastUpdate, null, "stale confirm 不得发生任何写入");
});

test("仓储：没有草稿就 save / confirm → 409，不凭空造一份", async () => {
  const { db } = fakeProjectsDb({ id: PROJECT_ID, analysis_draft: null });
  for (const action of ["save", "confirm"] as const)
    await assert.rejects(
      () =>
        writeAnalysisDraft({
          db,
          projectId: PROJECT_ID,
          write: { action, sections: EDITED },
        }),
      (error: unknown) =>
        error instanceof CaptureOperationError &&
        error.status === 409 &&
        error.message === ANALYSIS_DRAFT_MISSING_MESSAGE,
      `${action} 在没有草稿时必须拒绝`,
    );
});

// ── 5. 确认门禁：已确认的分析何时可以进报告 ───────────────────────────────

test("门禁：没有草稿 / 未确认 → 报告不带 AI 章节（既有语义不变）", () => {
  assert.equal(
    resolveConfirmedAnalysis({ record: null, currentHash: HASH }),
    null,
  );
  assert.equal(
    resolveConfirmedAnalysis({ record: record(), currentHash: HASH }),
    null,
    "confirmedAt = null 的草稿不得进入报告",
  );
});

test("门禁：已确认且指纹相同 → 返回四段正文", () => {
  const confirmed = record({ confirmedAt: "2026-09-19T02:00:00.000Z" });
  const resolved = resolveConfirmedAnalysis({
    record: confirmed,
    currentHash: HASH,
  });
  assert.deepEqual(resolved, SECTIONS);
  // 必须返回**人工最终保存的版本**（不是重新调用模型）
  assert.equal(resolved!.overview, SECTIONS.overview);
});

test("门禁：已确认但事实已变 → 409，不允许旧分析静默进入新报告", () => {
  const confirmed = record({ confirmedAt: "2026-09-19T02:00:00.000Z" });
  assert.throws(
    () =>
      resolveConfirmedAnalysis({
        record: confirmed,
        currentHash: "b".repeat(64),
      }),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 409 &&
      error.message === ANALYSIS_STALE_MESSAGE,
  );
  assert.ok(ANALYSIS_STALE_MESSAGE.includes("重新生成并确认"));
});

// ── 6. 接线：报告侧必须真的用上这道门禁 ───────────────────────────────────

test("接线：报告路由把草稿作为可选输入交给生成流程", async () => {
  const [reportRoute, reportLib] = await Promise.all([
    readFile(
      new URL(
        "../src/app/api/projects/[projectId]/report/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/server/zxgk-report.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(reportRoute, /loadAnalysisDraft\(userDb, projectId\)/);
  assert.match(reportRoute, /analysisDraft,/);
  // 门禁必须接在生成流程里，且只在不通过时拒绝
  assert.match(reportLib, /resolveConfirmedAnalysis\(/);
  assert.match(reportLib, /buildAnalysisSourceHash\(/);
  assert.match(
    reportLib,
    /analysis: confirmed \? analysisSections\(confirmed\) : null/,
  );
});

test("接线：DOCX 只有已确认时才可能出现 AI 章节（未确认 = 不传 analysis）", async () => {
  const [dialog, docx] = await Promise.all([
    readFile(
      new URL("../src/components/project-report-dialog.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../scripts/zxgk-report-docx.ts", import.meta.url),
      "utf8",
    ),
  ]);
  // 渲染层把「有没有 AI 章节」完全交给 meta.analysis —— 它自己不做确认判断
  assert.match(
    docx,
    /const analysis = meta\.analysis\?\.length \? meta\.analysis : null/,
  );
  assert.match(docx, /if \(analysis\) \{/);
  // UI 侧的三个动作各自对应一个 API 方法
  assert.match(dialog, /method: "POST"/);
  assert.match(dialog, /method: "PUT"/);
  assert.match(dialog, /JSON\.stringify\(\{ action, sections \}\)/);
  assert.match(dialog, /writeAnalysis\("save"\)|writeAnalysis\("confirm"\)/);
  // UI 只能提交四段正文：内部字段（指纹 / 生成时间 / 确认时间）不参与请求体。
  // 断言的是**代码访问**（`record.confirmedAt` 之类的读/写），不是全文出现 ——
  // 注释里解释「save 之后服务端清空 confirmedAt」是合理的，不该被判为违规。
  assert.doesNotMatch(dialog, /\.(sourceHash|generatedAt|confirmedAt)\b/);
  // 不做自动保存：没有定时器、没有静默提交
  assert.doesNotMatch(dialog, /setInterval|autoSave/);
});
