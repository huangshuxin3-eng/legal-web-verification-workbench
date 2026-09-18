/**
 * 「生成尽调报告」服务端流程测试。
 *
 * 只测**业务逻辑**：范围筛选、canonical Query、稳定顺序、核查日仲裁、错误语义、
 * 文件名与 draft 口径。不读真实 PDF（真实留痕与 Word 版式由本地 E2E 验收），
 * 不断言页数或任何排版结果。
 *
 * 依赖注入沿用导出能力的既有模式（`loadCapture`）：本文件不连 DB、不读 Storage。
 * 需要看 docx 内部时只取 `word/document.xml` 做内容断言（不涉及版式）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import type { Capture } from "../src/lib/database.types.ts";
import type {
  DetailRow,
  ParseResult,
} from "../scripts/zxgk-execution-parse.ts";
import { DRAFT_MARK_LINE, TITLE_TAIL } from "../scripts/zxgk-report-docx.ts";
import { CaptureOperationError } from "../src/lib/capture-workflow.ts";
import {
  REPORT_MIME_TYPE,
  REPORT_SOURCE_NAME,
  REPORT_TITLE_TAIL,
  REPORT_TOPIC,
  checkDateLabel,
  compactDay,
  isReportTask,
  reportFileName,
  shanghaiDay,
} from "../src/lib/report-names.ts";
import {
  MIXED_CHECK_DATE_MESSAGE,
  NO_DETAIL_MESSAGE,
  NO_TASK_MESSAGE,
  PROJECT_MISSING_MESSAGE,
  REPORT_DRAFT,
  STORAGE_READ_MESSAGE,
  generateZxgkReportDocx,
  normalizeQueryText,
  renderZxgkReportDocx,
  resolveCheckDate,
  selectCanonicalQuery,
  selectReportCaptures,
  unresolvedQueryMessage,
  unparsableMessage,
  type ReportQueryRow,
  type ZxgkReportTask,
} from "../src/lib/server/zxgk-report.ts";

const SAME_DAY = "2026-09-17T02:00:00.000Z";
const NEXT_DAY = "2026-09-18T02:00:00.000Z";
/** UTC 16:30 属于次日北京时间（Asia/Shanghai）。 */
const SHANGHAI_ROLLOVER = "2026-09-16T16:30:00.000Z";

function query(
  id: string,
  queryNo: number,
  queryText: string,
  createdAt = SAME_DAY,
): ReportQueryRow {
  return {
    id,
    task_id: "task",
    query_no: queryNo,
    query_text: queryText,
    created_at: createdAt,
  };
}

function capture(
  id: string,
  queryId: string,
  captureNo: number,
  extension = "pdf",
  createdAt = SAME_DAY,
): Capture {
  return {
    id,
    query_id: queryId,
    capture_no: captureNo,
    storage_path: `owner/project/task/${queryId}/${id}.${extension}`,
    source_url: null,
    created_at: createdAt,
  };
}

function task(
  overrides: Partial<ZxgkReportTask> & { id: string },
): ZxgkReportTask {
  return {
    entity_name: "恒大集团有限公司",
    topic: REPORT_TOPIC,
    source_name: REPORT_SOURCE_NAME,
    queries: [query(`q-${overrides.id}`, 1, "恒大集团有限公司")],
    captures: [],
    ...overrides,
  };
}

/** 从 .docx（ZIP）取部件文本：走中央目录 + inflate，避免为测试引入新依赖。 */
function zipEntry(buffer: Buffer, name: string): string {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, "应能找到 ZIP 中央目录结束记录");
  const entryCount = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const entryName = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (entryName === name) {
      assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataOffset, dataOffset + size);
      return (method === 0 ? data : inflateRawSync(data)).toString("utf8");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return "";
}

function row(index: number): DetailRow {
  return {
    index,
    captureNo: index,
    publicTypes: "失信被执行人",
    remarks: "",
    evidenceFile: `恒大集团有限公司_执行_中国执行信息公开网_Q01_${String(index).padStart(3, "0")}_20260917.pdf`,
    fields: { 案号: `（2026）粤03执${index}号` },
  };
}

function parsed(rows: DetailRow[], excluded: ParseResult["excluded"] = []) {
  return { rows, excluded, problems: [] };
}

async function documentXml(buffer: Buffer) {
  return zipEntry(buffer, "word/document.xml");
}

// ── 1. 范围筛选 ──────────────────────────────────────────────────────────

test("范围口径与扩展适配器同判据，只纳入「执行 + 中国执行信息公开网」", () => {
  assert.equal(
    isReportTask({ topic: "执行", source_name: REPORT_SOURCE_NAME }),
    true,
  );
  assert.equal(
    isReportTask({ topic: "执行", source_name: "全国法院信息综合查询" }),
    false,
  );
  assert.equal(
    isReportTask({ topic: "商标", source_name: REPORT_SOURCE_NAME }),
    false,
  );
});

test("没有范围内的 Task 时 fail closed，不生成空报告", () => {
  const outOfScope = task({ id: "t-1", topic: "商标" });
  assert.throws(
    () => selectReportCaptures([outOfScope]),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 409 &&
      error.message === NO_TASK_MESSAGE,
  );
});

test("范围内 Task 但没有任何留痕时 fail closed", () => {
  assert.throws(
    () => selectReportCaptures([task({ id: "t-1" })]),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 409 &&
      error.message === NO_DETAIL_MESSAGE,
  );
});

// ── 2. 项目名称 ≠ 查询对象 ───────────────────────────────────────────────

test("项目名称不需要等于查询对象：标题用项目名称，报告正常生成", async () => {
  const report = await renderZxgkReportDocx({
    projectName: "北京术锐机器人有限公司",
    result: parsed([row(1)]),
    checkDate: "2026-09-17",
  });
  const xml = await documentXml(report.buffer);
  assert.ok(xml.includes("北京术锐机器人有限公司"), "标题应使用项目名称");
  assert.ok(
    !xml.includes("北京术锐机器人有限公司执行及失信公开信息核查报告》"),
    "标题不得含草稿后缀",
  );
  assert.equal(
    report.fileName,
    "北京术锐机器人有限公司_执行及失信公开信息核查报告_20260917.docx",
  );
});

// ── 3. canonical Query 选择 ──────────────────────────────────────────────

test("canonical Query 取 query_no 最小者，历史同文本 Query 不参与", () => {
  const rows = [
    query("q-3", 3, "恒大集团有限公司"),
    query("q-1", 1, "恒大集团有限公司"),
    query("q-2", 2, "恒大集团有限公司"),
  ];
  assert.equal(selectCanonicalQuery(rows, "恒大集团有限公司")?.id, "q-1");
  assert.equal(
    selectCanonicalQuery([...rows].reverse(), "恒大集团有限公司")?.id,
    "q-1",
  );
});

test("canonical Query 平局时按 created_at 再按 id 稳定打破", () => {
  const sameNo = [
    query("q-b", 1, "恒大集团有限公司", "2026-09-17T03:00:00.000Z"),
    query("q-a", 1, "恒大集团有限公司", "2026-09-17T02:00:00.000Z"),
  ];
  assert.equal(selectCanonicalQuery(sameNo, "恒大集团有限公司")?.id, "q-a");
  const sameTime = [
    query("q-b", 1, "恒大集团有限公司"),
    query("q-a", 1, "恒大集团有限公司"),
  ];
  assert.equal(selectCanonicalQuery(sameTime, "恒大集团有限公司")?.id, "q-a");
});

test("检索词身份只做 trim：不做法律意义上的合并，空检索词不选", () => {
  const rows = [query("q-1", 1, "恒大集团有限公司")];
  assert.equal(selectCanonicalQuery(rows, " 恒大集团有限公司 ")?.id, "q-1");
  assert.equal(normalizeQueryText("恒大 集团有限公司"), "恒大 集团有限公司");
  assert.equal(selectCanonicalQuery(rows, "恒大 集团有限公司"), null);
  assert.equal(selectCanonicalQuery(rows, ""), null);
  assert.equal(selectCanonicalQuery(rows, "不存在的主体"), null);
});

// ── 4. 历史 / 非 canonical Query 不进入报告 ──────────────────────────────

test("只取 canonical Query 名下的留痕，历史与其他 Query 一律不进报告", () => {
  const selection = selectReportCaptures([
    task({
      id: "t-1",
      queries: [
        query("q-1", 1, "恒大集团有限公司"),
        query("q-2", 2, "恒大集团有限公司"),
        query("q-manual", 3, "恒大集团"),
      ],
      captures: [
        capture("c-q1", "q-1", 1),
        capture("c-q1-b", "q-1", 2),
        capture("c-q2", "q-2", 1),
        capture("c-manual", "q-manual", 1),
      ],
    }),
  ]);
  assert.deepEqual(
    selection.captures.map((item) => item.storagePath),
    ["owner/project/task/q-1/c-q1.pdf", "owner/project/task/q-1/c-q1-b.pdf"],
  );
});

test("Task 下没有检索词等于核查对象的 Query 时 fail closed，不静默取别的 Query", () => {
  assert.throws(
    () =>
      selectReportCaptures([
        task({
          id: "t-1",
          entity_name: "恒大集团有限公司",
          queries: [query("q-manual", 1, "恒大集团")],
          captures: [capture("c-1", "q-manual", 1)],
        }),
      ]),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 409 &&
      error.message ===
        unresolvedQueryMessage("恒大集团有限公司", REPORT_TOPIC),
  );
});

// ── 5 / 6. 多 Task 与 capture_no 稳定顺序 ────────────────────────────────

test("多 Task 顺序跟随入参顺序，不做跨 Task 的 capture_no 交叉排序", () => {
  const first = task({
    id: "t-a",
    entity_name: "主体 A",
    queries: [query("q-a", 1, "主体 A")],
    captures: [capture("c-a2", "q-a", 2), capture("c-a1", "q-a", 1)],
  });
  const second = task({
    id: "t-b",
    entity_name: "主体 B",
    queries: [query("q-b", 1, "主体 B")],
    captures: [capture("c-b1", "q-b", 1)],
  });
  const forward = selectReportCaptures([first, second]);
  assert.deepEqual(
    forward.captures.map((item) => item.taskId),
    ["t-a", "t-a", "t-b"],
  );
  assert.ok(forward.captures[2].fileName.startsWith("主体 B_执行_"));
  assert.ok(forward.captures[0].fileName.endsWith("_Q01_001_20260917.pdf"));
  const reversed = selectReportCaptures([second, first]);
  assert.deepEqual(
    reversed.captures.map((item) => item.taskId),
    ["t-b", "t-a", "t-a"],
  );
});

test("同一 Query 内按 capture_no 再按 id 稳定排序，且业务文件名与导出同源", () => {
  const selection = selectReportCaptures([
    task({
      id: "t-1",
      queries: [query("q-1", 1, "恒大集团有限公司")],
      captures: [
        capture("c-2", "q-1", 2),
        capture("c-1-b", "q-1", 1),
        capture("c-1-a", "q-1", 1),
      ],
    }),
  ]);
  assert.deepEqual(
    selection.captures.map((item) => item.storagePath.split("/").pop()),
    ["c-1-a.pdf", "c-1-b.pdf", "c-2.pdf"],
  );
  assert.equal(
    selection.captures[0].fileName,
    "恒大集团有限公司_执行_中国执行信息公开网_Q01_001_20260917.pdf",
  );
});

// ── 7. 非 PDF / 列表页正常排除 ───────────────────────────────────────────

test("非 PDF 留痕正常排除并计数，不阻断报告", () => {
  const selection = selectReportCaptures([
    task({
      id: "t-1",
      queries: [query("q-1", 1, "恒大集团有限公司")],
      captures: [
        capture("c-pdf", "q-1", 1),
        capture("c-png", "q-1", 2, "png"),
        capture("c-jpg", "q-1", 3, "jpg"),
      ],
    }),
  ]);
  assert.equal(selection.captures.length, 1);
  assert.equal(selection.skippedNonPdf, 2);
});

test("列表页进入 excluded 不算错误：报告照常生成且 excluded 原样上报", async () => {
  const report = await renderZxgkReportDocx({
    projectName: "北京术锐机器人有限公司",
    result: {
      rows: [row(1)],
      excluded: [
        { index: 1, captureNo: 31, reason: "列表页", evidenceFile: "x.pdf" },
      ],
      problems: [],
    },
    checkDate: "2026-09-17",
  });
  assert.equal(report.records, 1);
  assert.equal(report.excludedCaptures, 1);
});

// ── 8. problems 阻断 ─────────────────────────────────────────────────────

test("解析异常必须阻断报告生成，并给出前 3 条原因", async () => {
  const problems = ["a", "b", "c", "d"];
  await assert.rejects(
    renderZxgkReportDocx({
      projectName: "北京术锐机器人有限公司",
      result: { rows: [row(1)], excluded: [], problems },
      checkDate: "2026-09-17",
    }),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 409 &&
      error.message === unparsableMessage(problems) &&
      error.message.includes("有 4 份留痕无法完整解析") &&
      error.message.includes("（a）") &&
      !error.message.includes("（d）"),
  );
});

test("Storage 读取失败原样抛出，不静默跳过该留痕后继续生成", async () => {
  await assert.rejects(
    generateZxgkReportDocx({
      projectName: "北京术锐机器人有限公司",
      tasks: [
        task({
          id: "t-1",
          queries: [query("q-1", 1, "恒大集团有限公司")],
          captures: [capture("c-1", "q-1", 1)],
        }),
      ],
      loadCapture: async () => {
        throw new CaptureOperationError(STORAGE_READ_MESSAGE, 502);
      },
    }),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 502 &&
      error.message === STORAGE_READ_MESSAGE,
  );
});

test("完整流程在读取 PDF 之前就执行范围与留痕校验", async () => {
  let loaded = 0;
  await assert.rejects(
    generateZxgkReportDocx({
      projectName: "北京术锐机器人有限公司",
      tasks: [task({ id: "t-1", topic: "商标" })],
      loadCapture: async () => {
        loaded += 1;
        return new Blob();
      },
    }),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.message === NO_TASK_MESSAGE,
  );
  assert.equal(loaded, 0);
  await assert.rejects(
    generateZxgkReportDocx({
      projectName: "北京术锐机器人有限公司",
      tasks: [
        task({
          id: "t-1",
          queries: [query("q-1", 1, "恒大集团有限公司")],
          captures: [capture("c-png", "q-1", 1, "png")],
        }),
      ],
      loadCapture: async () => {
        loaded += 1;
        return new Blob();
      },
    }),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.message === NO_DETAIL_MESSAGE,
  );
  assert.equal(loaded, 0);
});

// ── 9 / 10. 核查日派生与跨日阻断 ─────────────────────────────────────────

test("核查日从留痕的 Asia/Shanghai 自然日派生，不用生成日", () => {
  assert.equal(shanghaiDay(SAME_DAY), "2026-09-17");
  assert.equal(shanghaiDay(SHANGHAI_ROLLOVER), "2026-09-17");
  const selection = selectReportCaptures([
    task({
      id: "t-1",
      queries: [query("q-1", 1, "恒大集团有限公司")],
      captures: [
        capture("c-1", "q-1", 1, "pdf", SAME_DAY),
        capture("c-2", "q-1", 2, "pdf", SHANGHAI_ROLLOVER),
      ],
    }),
  ]);
  assert.deepEqual(
    selection.captures.map((item) => item.day),
    ["2026-09-17", "2026-09-17"],
  );
  assert.equal(resolveCheckDate(["2026-09-17", "2026-09-17"]), "2026-09-17");
  assert.equal(checkDateLabel("2026-09-17"), "2026年9月17日");
});

test("留痕跨核查日时 fail closed，不取 latest、不用生成日", () => {
  assert.throws(
    () => resolveCheckDate(["2026-09-17", "2026-09-18"]),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 409 &&
      error.message === MIXED_CHECK_DATE_MESSAGE,
  );
  assert.throws(
    () => resolveCheckDate([]),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 409 &&
      error.message === NO_DETAIL_MESSAGE,
  );
});

// ── 11 / 12. 文件名与 draft 口径 ─────────────────────────────────────────

test("报告文件名使用安全项目名 + 核查日，日期取北京时间自然日", () => {
  assert.equal(
    reportFileName("项目:A/B", "2026-09-17"),
    "项目_A_B_执行及失信公开信息核查报告_20260917.docx",
  );
  assert.equal(compactDay(shanghaiDay(SHANGHAI_ROLLOVER)), "20260917");
  assert.equal(
    REPORT_TITLE_TAIL,
    TITLE_TAIL,
    "文件名用的核查事项必须与报告标题后缀一致",
  );
});

test("V1 固定 draft: true，且不受 Task 完成状态影响", async () => {
  assert.equal(REPORT_DRAFT, true);
  const report = await renderZxgkReportDocx({
    projectName: "北京术锐机器人有限公司",
    result: parsed([row(1)]),
    checkDate: "2026-09-17",
  });
  const xml = await documentXml(report.buffer);
  assert.ok(xml.includes(DRAFT_MARK_LINE), "开发验证稿标识必须存在");
  assert.ok(xml.includes("2026年9月17日"), "核查日必须写入正文");
  assert.equal(report.checkDateLabel, "2026年9月17日");
  assert.equal(report.records, 1);
});

// ── 15. route 错误语义 ───────────────────────────────────────────────────

test("route 错误语义：401 / 404 / 409 / 502 原样透传，不塌缩成 500", async () => {
  const cases: [CaptureOperationError, number, string][] = [
    [new CaptureOperationError("请先登录。", 401), 401, "请先登录。"],
    [
      new CaptureOperationError(PROJECT_MISSING_MESSAGE, 404),
      404,
      PROJECT_MISSING_MESSAGE,
    ],
    [new CaptureOperationError(NO_DETAIL_MESSAGE, 409), 409, NO_DETAIL_MESSAGE],
    [
      new CaptureOperationError(MIXED_CHECK_DATE_MESSAGE, 409),
      409,
      MIXED_CHECK_DATE_MESSAGE,
    ],
    [
      new CaptureOperationError(STORAGE_READ_MESSAGE, 502),
      502,
      STORAGE_READ_MESSAGE,
    ],
  ];
  for (const [error, status, message] of cases) {
    assert.equal(error.status, status);
    assert.equal(error.message, message);
  }
});

test("路由把异常交给既有 apiError 映射状态码，不自己写死 500", async () => {
  const [route, api] = await Promise.all([
    readFile(
      new URL(
        "../src/app/api/projects/[projectId]/report/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/server/capture-api.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(route, /return apiError\(error\)/);
  assert.match(
    api,
    /error instanceof CaptureOperationError \? error\.status : 500/,
  );
});

test("报告 API 走用户 JWT + RLS + Private Storage download，不生成公开 URL", async () => {
  const [route, server] = await Promise.all([
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
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /captureContext\(request\)/);
  assert.match(route, /apiError\(error\)/);
  assert.match(route, /Content-Disposition/);
  assert.match(route, /filename\*=UTF-8''/);
  assert.match(server, /\.from\("projects"\)/);
  assert.match(server, /\.from\("queries"\)/);
  assert.match(server, /\.from\("captures"\)/);
  assert.match(server, /\.download\(storagePath\)/);
  assert.doesNotMatch(`${route}\n${server}`, /service[_-]?role/i);
  assert.doesNotMatch(`${route}\n${server}`, /getPublicUrl|createSignedUrl/);
});

test("报告 MIME 固定为 .docx", () => {
  assert.equal(
    REPORT_MIME_TYPE,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
});

test("Workbench 提供报告入口、coarse check 与防重复提交", async () => {
  const [workspace, dialog] = await Promise.all([
    readFile(
      new URL("../src/components/project-workspace.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/components/project-report-dialog.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(workspace, />\s*生成尽调报告\s*</);
  assert.match(workspace, /disabled=\{!!reportBlockedReason\}/);
  assert.match(workspace, /"当前项目没有中国执行信息公开网的执行任务"/);
  assert.match(workspace, /"执行留痕尚未产生，请先完成网核"/);
  assert.match(workspace, /isReportTask/);
  assert.match(dialog, /\/api\/projects\/\$\{projectId\}\/report/);
  assert.match(dialog, /if \(lock\.current \|\| !captureCount\) return/);
  assert.match(dialog, /disabled=\{busy \|\| !captureCount\}/);
});
