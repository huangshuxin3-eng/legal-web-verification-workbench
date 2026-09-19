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
  CaptureInput,
  DetailRow,
  ParseResult,
  TextRun,
} from "../scripts/zxgk-execution-parse.ts";
import {
  COMMON_FIELD_LABELS,
  EXECUTION_AMOUNT_LABEL,
  classifyCapture,
  parseExecutionTable,
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
  REPORT_CAPTURE_CONCURRENCY,
  REPORT_DRAFT,
  STORAGE_READ_MESSAGE,
  generateZxgkReportDocx,
  mapWithConcurrency,
  normalizeQueryText,
  parseProjectReport,
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

// ── 事实边界：AI 分析与 DOCX 渲染共用同一份事实 ─────────────────────────

/** 用捕获下标当字节的假 loadCapture（与并发夹具同源）。 */
const loaderFromIndex = async (storagePath: string) =>
  new Blob([new Uint8Array([Number(/c-(\d+)\.pdf$/.exec(storagePath)?.[1])])]);

test("parseProjectReport 暴露已解析事实：项目名、核查日、行序与排除计数", async () => {
  const facts = await parseProjectReport({
    projectName: "北京术锐机器人有限公司",
    tasks: [concurrentTask(2)],
    loadCapture: loaderFromIndex,
    readPages: pagesFromBytes,
  });
  assert.equal(facts.projectName, "北京术锐机器人有限公司");
  assert.equal(facts.checkDate, "2026-09-17");
  assert.equal(facts.checkDateLabel, "2026年9月17日");
  assert.equal(facts.result.problems.length, 0);
  assert.deepEqual(
    facts.result.rows.map((item) => item.index),
    [1, 2],
  );
  assert.equal(facts.skippedNonPdf, 0);
});

test("AI 分析的事实与 DOCX 报告同源：同一批留痕得到同样的口径", async () => {
  const source = {
    projectName: "北京术锐机器人有限公司",
    tasks: [concurrentTask(2)],
    loadCapture: loaderFromIndex,
    readPages: pagesFromBytes,
  };
  const facts = await parseProjectReport(source);
  const report = await generateZxgkReportDocx(source);
  assert.equal(report.records, facts.result.rows.length);
  assert.equal(report.checkDate, facts.checkDate);
  assert.equal(report.checkDateLabel, facts.checkDateLabel);
  assert.equal(report.excludedCaptures, facts.result.excluded.length);
  assert.equal(report.skippedNonPdf, facts.skippedNonPdf);
});

test("parseProjectReport 沿用同一 fail closed：范围不符时在读 PDF 之前就拒绝", async () => {
  let loaded = 0;
  await assert.rejects(
    parseProjectReport({
      projectName: "北京术锐机器人有限公司",
      tasks: [task({ id: "t-1", topic: "商标" })],
      loadCapture: async () => {
        loaded += 1;
        return new Blob();
      },
    }),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 409 &&
      error.message === NO_TASK_MESSAGE,
  );
  assert.equal(loaded, 0);
});

test("parseProjectReport 不产出「空事实」：没有任何有效详情行时 fail closed", async () => {
  await assert.rejects(
    parseProjectReport({
      projectName: "北京术锐机器人有限公司",
      tasks: [
        task({
          id: "t-1",
          queries: [query("q-1", 1, "恒大集团有限公司")],
          captures: [capture("c-png", "q-1", 1, "png")],
        }),
      ],
      loadCapture: async () => new Blob(),
    }),
    (error: unknown) =>
      error instanceof CaptureOperationError &&
      error.status === 409 &&
      error.message === NO_DETAIL_MESSAGE,
  );
});

// ── 16 / 17. 有界并发：并发度、顺序、失败确定性 ───────────────────────────
//
// 测试夹具用**合成几何数据**，不读真实 PDF：把「每页文字段」按实测版面不变量
// （标签列右边界 <190、值列左边界 194.6、行距 24pt、页脚家具字号 6）拼出来，
// 交给真实 `classifyCapture` / `parseExecutionTable` / `renderReportDocx`。
// 这样并发与顺序断言走的仍是产品代码路径，但不需要 Storage、DB 或真实留痕。

const DETAIL_FOOTER = "https://zhzxgk.court.gov.cn/zhzxgk/detail.html";

/** 「被执行人」板块本应公示的全部字段（标签取自 parser，不在测试里另造口径）。 */
const EXECUTION_FIELDS: readonly (readonly [string, string])[] = [
  ["案号", "（2026）粤03执0号"],
  ["被执行人姓名/名称", "恒大集团有限公司"],
  ["性别", "—"],
  ["身份证号码/组织机构代码", "9144030008****371X"],
  ["执行法院", "深圳市南山区人民法院"],
  ["立案时间", "2026-09-01"],
  ["执行标的", "1000000"],
];

/** 合成一页 detail：板块 banner + 字段行（标签/值分列）+ 页脚 detail 标识。 */
function detailPages(caseNo: number): TextRun[][] {
  const runs: TextRun[] = [{ str: "被执行人", x: 40, y: 720, h: 13.5 }];
  let y = 696;
  for (const [label, value] of EXECUTION_FIELDS) {
    runs.push({ str: `${label}：`, x: 60, y, h: 10.5 });
    runs.push({
      str: label === "案号" ? `（2026）粤03执${caseNo}号` : value,
      x: 194.6,
      y,
      h: 10.5,
    });
    y -= 24;
  }
  runs.push({ str: DETAIL_FOOTER, x: 419.2, y: 30, h: 6 });
  return [runs];
}

/** 假 readPages：从 Blob 字节里取回 capture 下标，返回对应的合成页面。 */
const pagesFromBytes = async (bytes: Uint8Array) => detailPages(bytes[0]);

/** 让已就绪的微任务全部排空（不依赖定时器，因此没有平台时序差异）。 */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 可观测的假 Storage 下载：**完成时机由测试显式放行**，不用 setTimeout ——
 * 否则完成顺序会随平台定时器粒度漂移，测试就变成脆弱的时序断言。
 * `release(index)` 表示「这一份可以下完了」；未放行的下载一直挂在等待里。
 */
function observableLoader(failure?: (index: number) => unknown) {
  const state = {
    active: 0,
    maxActive: 0,
    started: [] as number[],
    completed: [] as number[],
  };
  const opened = new Set<number>();
  const waiters = new Map<number, () => void>();
  const release = (index: number) => {
    opened.add(index);
    waiters.get(index)?.();
    waiters.delete(index);
  };
  const wait = (index: number) =>
    opened.has(index)
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.set(index, resolve));

  const loadCapture = async (storagePath: string) => {
    const index = Number(/c-(\d+)\.pdf$/.exec(storagePath)?.[1]);
    state.started.push(index);
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    await wait(index);
    state.active -= 1;
    state.completed.push(index);
    const error = failure?.(index);
    if (error) throw error;
    return new Blob([new Uint8Array([index])]);
  };
  return { state, loadCapture, release };
}

/** 一份含 `count` 份 detail 留痕的 Task：capture_no = 下标 + 1。 */
function concurrentTask(count: number): ZxgkReportTask {
  return task({
    id: "t-1",
    queries: [query("q-1", 1, "恒大集团有限公司")],
    captures: Array.from({ length: count }, (_, index) =>
      capture(`c-${index}`, "q-1", index + 1),
    ),
  });
}

test("并发夹具与 parser 的板块字段口径一致（夹具漂移会在这里失败）", () => {
  assert.deepEqual(
    EXECUTION_FIELDS.map(([label]) => label),
    [...COMMON_FIELD_LABELS, EXECUTION_AMOUNT_LABEL],
  );
  assert.equal(classifyCapture(detailPages(1)), "detail");
});

test("并发度固定为 3，且主循环已不再逐份 await", async () => {
  assert.equal(REPORT_CAPTURE_CONCURRENCY, 3);
  const source = await readFile(
    new URL("../src/lib/server/zxgk-report.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /export const REPORT_CAPTURE_CONCURRENCY = 3;/);
  assert.match(source, /mapWithConcurrency\(/);
  assert.doesNotMatch(
    source,
    /for \(const capture of selection\.captures\)/,
    "旧的逐份串行循环必须已被池化调用替换",
  );
});

test("mapWithConcurrency：并发上限、真实并发、按输入下标回填、边界输入", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 9 }, (_, index) => index);
  const results = await mapWithConcurrency(items, 3, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    // 只让出一次事件循环：本例不制造完成顺序（完成顺序由闸门测试单独验证），
    // 因此不引入任何定时器，断言与平台定时器粒度无关。
    await settle();
    active -= 1;
    return item * 2;
  });
  assert.equal(maxActive, 3, "活跃 worker 峰值必须正好是 3，不能是伪并发");
  assert.deepEqual(
    results,
    items.map((item) => item * 2),
  );

  assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([7], 3, async (item) => item), [7]);
  assert.deepEqual(
    await mapWithConcurrency([1, 2], 5, async (item) => item + 1),
    [2, 3],
  );
});

test("mapWithConcurrency：完成顺序 3→1→2 仍按 1→2→3 回填", async () => {
  const gates = new Map<number, () => void>();
  const completed: number[] = [];
  const pending = mapWithConcurrency([0, 1, 2], 3, async (item) => {
    await new Promise<void>((resolve) => gates.set(item, resolve));
    completed.push(item);
    return `done-${item}`;
  });
  gates.get(2)?.();
  await settle();
  gates.get(0)?.();
  await settle();
  gates.get(1)?.();
  assert.deepEqual(await pending, ["done-0", "done-1", "done-2"]);
  assert.deepEqual(completed, [2, 0, 1], "完成顺序确实是 3→1→2");
});

test("mapWithConcurrency：等全部收工后按输入顺序抛第一失败，不看谁先 reject", async () => {
  const first = new Error("index-0");
  const later = new Error("index-2");
  const gates = new Map<number, () => void>();
  const completed: number[] = [];
  const pending = mapWithConcurrency([0, 1, 2], 3, async (item) => {
    await new Promise<void>((resolve) => gates.set(item, resolve));
    completed.push(item);
    if (item === 0) throw first;
    if (item === 2) throw later;
    return item;
  });
  gates.get(2)?.();
  await settle();
  gates.get(0)?.();
  await settle();
  gates.get(1)?.();
  await assert.rejects(pending, (error: unknown) => error === first);
  assert.deepEqual(completed, [2, 0, 1]);
});

test("并发下载 + 解析时活跃 worker 峰值恰为 3，7 份留痕不超额并发", async () => {
  const { state, loadCapture, release } = observableLoader();
  const pending = generateZxgkReportDocx({
    projectName: "北京术锐机器人有限公司",
    tasks: [concurrentTask(7)],
    loadCapture,
    readPages: pagesFromBytes,
  });
  // 同步起跑的只有 3 个 worker（下标 0/1/2），第 4 份必须等有人收工
  assert.deepEqual(state.started, [0, 1, 2]);
  assert.equal(state.maxActive, 3);
  for (let index = 0; index < 7; index += 1) release(index);
  const report = await pending;
  assert.deepEqual(state.started, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(state.maxActive, 3, "全程峰值必须卡在 3，不能超额并发");
  assert.equal(report.records, 7);
});

test("完成顺序 3→1→2 不改变输出顺序：行序与证据映射仍按 selection 顺序", async () => {
  const { state, loadCapture, release } = observableLoader();
  const pending = generateZxgkReportDocx({
    projectName: "北京术锐机器人有限公司",
    tasks: [concurrentTask(3)],
    loadCapture,
    readPages: pagesFromBytes,
  });
  // 显式放行：完成次序 = 下标 2 → 0 → 1（与 selection 顺序相反）
  release(2);
  await settle();
  assert.deepEqual(state.completed, [2]);
  release(0);
  await settle();
  assert.deepEqual(state.completed, [2, 0]);
  release(1);
  const report = await pending;
  assert.deepEqual(state.completed, [2, 0, 1], "完成顺序确实是 3→1→2");
  assert.equal(report.records, 3);

  const xml = await documentXml(report.buffer);
  const evidence = [1, 2, 3].map((n) =>
    xml.indexOf(`_Q01_${String(n).padStart(3, "0")}_20260917.pdf`),
  );
  assert.ok(
    evidence.every((position) => position >= 0),
    "证据文件名应逐行出现",
  );
  assert.deepEqual(
    [...evidence].sort((left, right) => left - right),
    evidence,
    "evidence filename mapping 必须按 selection 顺序，而不是完成顺序",
  );
});

test("多 Task / 多 Capture 时并发不改变全局顺序", async () => {
  const first = task({
    id: "t-a",
    entity_name: "主体甲",
    queries: [query("q-a", 1, "主体甲")],
    captures: [capture("c-0", "q-a", 1), capture("c-1", "q-a", 2)],
  });
  const second = task({
    id: "t-b",
    entity_name: "主体乙",
    queries: [query("q-b", 1, "主体乙")],
    captures: [capture("c-2", "q-b", 3), capture("c-3", "q-b", 4)],
  });
  // 前 3 份先起跑（下标 0/1/2）；下标 1 收工后立刻接管下标 3。
  const { state, loadCapture, release } = observableLoader();
  const pending = generateZxgkReportDocx({
    projectName: "北京术锐机器人有限公司",
    tasks: [first, second],
    loadCapture,
    readPages: pagesFromBytes,
  });
  assert.deepEqual(state.started, [0, 1, 2]);
  release(1);
  await settle();
  assert.deepEqual(state.started, [0, 1, 2, 3], "空出的 worker 立刻接管下一份");
  release(3);
  await settle();
  release(2);
  await settle();
  release(0);
  const report = await pending;
  assert.equal(state.maxActive, 3);
  assert.deepEqual(
    state.completed,
    [1, 3, 2, 0],
    "完成顺序与 selection 顺序不同",
  );
  assert.equal(report.records, 4);

  const xml = await documentXml(report.buffer);
  const order = [1, 2, 3, 4].map((n) =>
    xml.indexOf(`_Q01_${String(n).padStart(3, "0")}_20260917.pdf`),
  );
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual(
    [...order].sort((left, right) => left - right),
    order,
    "跨 Task 的证据顺序仍必须是 selection 顺序",
  );
  assert.ok(
    xml.indexOf("主体甲_执行_") < xml.indexOf("主体乙_执行_"),
    "Task 顺序必须保持",
  );
});

test("失败确定性：后序 Capture 先失败、前序 Capture 后失败，仍抛 selection 顺序上的第一失败", async () => {
  const first = new CaptureOperationError(STORAGE_READ_MESSAGE, 502);
  const later = new CaptureOperationError(STORAGE_READ_MESSAGE, 502);
  const { state, loadCapture, release } = observableLoader((index) =>
    index === 0 ? first : index === 2 ? later : undefined,
  );
  const pending = generateZxgkReportDocx({
    projectName: "北京术锐机器人有限公司",
    tasks: [concurrentTask(3)],
    loadCapture,
    readPages: pagesFromBytes,
  });
  // 下标 2 先失败，下标 0 后失败；最终仍必须抛下标 0 的错误
  release(2);
  await settle();
  release(0);
  await settle();
  release(1);
  await assert.rejects(pending, (error: unknown) => error === first);
  assert.deepEqual(
    state.completed,
    [2, 0, 1],
    "下标 2 在时间上先于下标 0 失败",
  );
  assert.equal(state.maxActive, 3);
});

test("多份失败时也按 selection 顺序取第一失败，与完成先后无关", async () => {
  const errors = [new Error("index-1"), new Error("index-2")];
  const { state, loadCapture, release } = observableLoader((index) =>
    index === 0 ? undefined : errors[index - 1],
  );
  const pending = generateZxgkReportDocx({
    projectName: "北京术锐机器人有限公司",
    tasks: [concurrentTask(3)],
    loadCapture,
    readPages: pagesFromBytes,
  });
  release(0);
  await settle();
  release(2);
  await settle();
  release(1);
  await assert.rejects(pending, (error: unknown) => error === errors[0]);
  assert.deepEqual(state.completed, [0, 2, 1], "下标 2 先于下标 1 失败");
});

test("全部成功时与串行实现业务等价：document.xml 逐字相同", async () => {
  const count = 7;
  const tasks = [concurrentTask(count)];
  const loader = observableLoader();
  const pending = generateZxgkReportDocx({
    projectName: "北京术锐机器人有限公司",
    tasks,
    loadCapture: loader.loadCapture,
    readPages: pagesFromBytes,
  });
  for (let index = 0; index < count; index += 1) loader.release(index);
  const concurrent = await pending;
  assert.equal(loader.state.maxActive, 3);

  // 串行参考实现：走同一批纯函数，按 selection 顺序逐份 await（改动前的形态）。
  const selection = selectReportCaptures(tasks);
  const inputs: CaptureInput[] = [];
  const detailDays: string[] = [];
  for (const item of selection.captures) {
    const pages = await pagesFromBytes(
      new Uint8Array([Number(/c-(\d+)\.pdf$/.exec(item.storagePath)?.[1])]),
    );
    inputs.push({ fileName: item.fileName, pages });
    if (classifyCapture(pages) === "detail") detailDays.push(item.day);
  }
  const serial = await renderZxgkReportDocx({
    projectName: "北京术锐机器人有限公司",
    result: parseExecutionTable(inputs),
    checkDate: resolveCheckDate(detailDays),
    skippedNonPdf: selection.skippedNonPdf,
  });

  assert.equal(concurrent.records, serial.records);
  assert.equal(concurrent.excludedCaptures, serial.excludedCaptures);
  const [concurrentXml, serialXml] = [
    await documentXml(concurrent.buffer),
    await documentXml(serial.buffer),
  ];
  let at = 0;
  while (at < concurrentXml.length && concurrentXml[at] === serialXml[at])
    at += 1;
  assert.equal(
    concurrentXml === serialXml,
    true,
    `并发与串行必须产出同一份 word/document.xml；首个差异在第 ${at} 字符：` +
      `并发「${concurrentXml.slice(at, at + 80)}」 vs 串行「${serialXml.slice(at, at + 80)}」`,
  );
});
