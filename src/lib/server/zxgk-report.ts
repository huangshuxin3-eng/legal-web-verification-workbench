/**
 * 「生成尽调报告」的服务端流程（V1）。
 *
 * 调用链：
 *   loadProjectReportData(db, projectId)      ← 只做 DB 读取（用户 JWT + RLS，不碰 service role）
 *     Project → 既有 Task 顺序 → ZXGK 执行 Task → 该 Task 的 canonical Query（+ 其 Capture 元数据）
 *   selectReportCaptures(tasks)               ← 纯函数：范围 → canonical Query → 稳定排序 → 业务文件名
 *   resolveCheckDate(days)                    ← 纯函数：核查日仲裁（跨日 fail closed）
 *   readPages → classifyCapture → parseExecutionTable   ← 复用已验收的解析器
 *   buildReportModel → renderReportDocx → Packer.toBuffer ← 复用已验收的报告模型与渲染器
 *
 * 明确不做（人工口径 LOCK）：
 *   1. 不新增「项目名称 === task.entity_name」之类的 mismatch 校验：报告标题用项目名称，
 *      查询对象可以是另一个主体，二者不同是合法情形。
 *   2. 不生成 Excel 再读 Excel：DB / Storage → CaptureInput → 解析器 → 报告模型，
 *      Excel 与 DOCX 是并列输出能力，共用同一个解析器。
 *   3. 不持久化报告产物（不新增 report / artifact 表）：点击即生成，HTTP 下载。
 *   4. 不复制解析器 / 报告模型 / 版式规则：只调用 `scripts/` 下已验收的纯逻辑。
 *   5. PDF 下载与解析**有界并发**（`REPORT_CAPTURE_CONCURRENCY`）：只并发 3 份，
 *      不是把几十份一次性打满；顺序、错误语义与产物都与串行实现一致。
 *
 * 关于 canonical Query：规则是仓库既有 invariant（见 `NONLIT_WORKBENCH_CONTEXT.md`
 * 「canonical Query 选择规则」），扩展侧实现在 `extension/src/lib/query-identity.mjs`。
 * `extension/` 是独立包且本仓库 tsconfig `allowJs: false`（直接 import 会报 TS7016），
 * 故此处按**同一规则、同一 tie-break** 落地；行为一致性由
 * `tests/zxgk-report-flow.test.ts` 固化（含与扩展同源的用例）。不新造任何选择规则。
 */

import { Packer } from "docx";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDocumentProxy } from "unpdf";
import type { Capture, Database, Query, Task } from "../database.types.ts";
import { CaptureOperationError } from "../capture-workflow.ts";
import { captureExtension, generatedCaptureName } from "../capture-names.ts";
import {
  checkDateLabel,
  isReportTask,
  reportFileName,
  shanghaiDay,
} from "../report-names.ts";
import { getProjectTasks } from "../task-repository.ts";
import {
  classifyCapture,
  parseExecutionTable,
  type CaptureInput,
  type ParseResult,
  type TextRun,
} from "../../../scripts/zxgk-execution-parse.ts";
import {
  buildReportModel,
  renderReportDocx,
} from "../../../scripts/zxgk-report-docx.ts";

// ── 错误语义（人工确认口径）──────────────────────────────────────────────

export const NO_TASK_MESSAGE = "当前项目没有中国执行信息公开网的执行任务。";
export const NO_DETAIL_MESSAGE = "当前项目没有可用于生成报告的执行详情留痕。";
export const MIXED_CHECK_DATE_MESSAGE =
  "当前报告包含不同核查日期的留痕，暂不能合并生成。";
export const STORAGE_READ_MESSAGE =
  "部分留痕文件读取失败，未生成报告，请重试。";
export const PROJECT_MISSING_MESSAGE = "项目不存在或无权生成报告。";

export function unresolvedQueryMessage(entityName: string, topic: string) {
  return `任务「${entityName}｜${topic}」下没有检索词等于核查对象的 Query，无法确定应纳入报告的留痕。`;
}

export function unparsableMessage(problems: readonly string[]) {
  const reasons = problems
    .slice(0, 3)
    .map((problem) => `（${problem}）`)
    .join("");
  return `有 ${problems.length} 份留痕无法完整解析，未生成报告。${reasons}`;
}

/** V1 固定为开发验证草稿：Task 完成只代表工作流状态，不代表已过人工法律审核。 */
export const REPORT_DRAFT = true;

// ── canonical Query ──────────────────────────────────────────────────────
// Keep this invariant aligned with extension/src/lib/query-identity.mjs selectCanonicalQuery.

export type ReportQueryRow = Pick<
  Query,
  "id" | "task_id" | "query_no" | "query_text" | "created_at"
>;

/**
 * 检索词身份只做 trim：`恒大集团有限公司` 与 `恒大 集团有限公司` 是**不同**检索词，
 * 不合并、不改写（与扩展侧 `normalizeQueryText` 一致）。
 */
export function normalizeQueryText(value: unknown): string {
  return String(value ?? "").trim();
}

function queryNoOf(row: ReportQueryRow): number {
  const value = Number(row?.query_no);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** `query_no` 最小 → `created_at` ASC → `id` ASC。 */
function compareCanonical(left: ReportQueryRow, right: ReportQueryRow): number {
  const noLeft = queryNoOf(left);
  const noRight = queryNoOf(right);
  if (noLeft !== noRight) return noLeft - noRight;
  const timeLeft = String(left?.created_at ?? "");
  const timeRight = String(right?.created_at ?? "");
  if (timeLeft !== timeRight) return timeLeft < timeRight ? -1 : 1;
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

/**
 * 选出 canonical Query：当前 Task 内 `query_text` 等于检索词（默认检索词 =
 * `trim(task.entity_name)`）的 Query 中 `query_no` 最小者。历史同文本 Query 原样保留。
 */
export function selectCanonicalQuery(
  rows: readonly ReportQueryRow[],
  queryText: unknown,
): ReportQueryRow | null {
  const wanted = normalizeQueryText(queryText);
  if (!wanted) return null;
  const matches = (rows ?? []).filter(
    (row) => normalizeQueryText(row?.query_text) === wanted,
  );
  if (!matches.length) return null;
  return [...matches].sort(compareCanonical)[0];
}

// ── 范围与排序（纯函数）──────────────────────────────────────────────────

export type ZxgkReportTask = Pick<
  Task,
  "id" | "entity_name" | "topic" | "source_name"
> & {
  /** 该 Task 的全部 Query（含历史 Query）与 Capture 元数据，顺序不重要。 */
  queries: readonly ReportQueryRow[];
  captures: readonly Capture[];
};

/** 进入报告的一份留痕：业务文件名与核查日在此定型。 */
export type ReportCapture = {
  taskId: string;
  storagePath: string;
  /** 与工作台/导出同源的业务文件名（站点留痕文件名规则相同）。 */
  fileName: string;
  /** Asia/Shanghai 自然日 `YYYY-MM-DD`。 */
  day: string;
};

export type ReportCaptureSelection = {
  /** 顺序即报告行序：Task 顺序 → 该 Task 的 canonical Query → capture_no → id。 */
  captures: ReportCapture[];
  /** 非 PDF 留痕（手工上传的图片）不参与解析，正常排除并计数。 */
  skippedNonPdf: number;
};

/**
 * 范围筛选 + canonical Query 选择 + 稳定排序。
 *
 * 只取**每个 Task 的 canonical Query** 名下的 Capture：同一 Task 下的历史 Query /
 * 非 canonical Query 不进报告。不同 Task 之间不做 query_no / capture_no 交叉排序。
 */
export function selectReportCaptures(
  tasks: readonly ZxgkReportTask[],
): ReportCaptureSelection {
  const eligible = tasks.filter((task) => isReportTask(task));
  if (!eligible.length) throw new CaptureOperationError(NO_TASK_MESSAGE, 409);

  const captures: ReportCapture[] = [];
  let skippedNonPdf = 0;
  for (const task of eligible) {
    const canonical = selectCanonicalQuery(task.queries, task.entity_name);
    if (!canonical)
      throw new CaptureOperationError(
        unresolvedQueryMessage(task.entity_name, task.topic),
        409,
      );
    const rows = task.captures
      .filter((capture) => capture.query_id === canonical.id)
      .toSorted(
        (left, right) =>
          left.capture_no - right.capture_no || left.id.localeCompare(right.id),
      );
    for (const capture of rows) {
      if (captureExtension(capture.storage_path) !== "pdf") {
        skippedNonPdf += 1;
        continue;
      }
      const created = new Date(capture.created_at);
      captures.push({
        taskId: task.id,
        storagePath: capture.storage_path,
        fileName: generatedCaptureName(
          {
            entity_name: task.entity_name,
            topic: task.topic,
            source_name: task.source_name,
            query_no: canonical.query_no,
            capture_no: capture.capture_no,
          },
          "pdf",
          created,
        ),
        day: shanghaiDay(created),
      });
    }
  }
  if (!captures.length) throw new CaptureOperationError(NO_DETAIL_MESSAGE, 409);
  return { captures, skippedNonPdf };
}

/**
 * 核查日：全部**有效详情留痕**必须属于同一个 Asia/Shanghai 自然日。
 * 跨日不取 latest，直接 fail closed；一份详情都没有也 fail closed。
 */
export function resolveCheckDate(days: readonly string[]): string {
  const unique = [...new Set(days)];
  if (!unique.length) throw new CaptureOperationError(NO_DETAIL_MESSAGE, 409);
  if (unique.length > 1)
    throw new CaptureOperationError(MIXED_CHECK_DATE_MESSAGE, 409);
  return unique[0];
}

// ── PDF 文字层读取（与 CLI 同源，按阶段口径有意保留）────────────────────

export async function readPages(bytes: Uint8Array): Promise<TextRun[][]> {
  const doc = await getDocumentProxy(bytes);
  const pages: TextRun[][] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const runs: TextRun[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      runs.push({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        h: item.height,
      });
    }
    pages.push(runs);
  }
  // unpdf 的 getDocumentProxy() 返回已解析的 proxy，运行时没有 destroy()（类型里有）。
  return pages;
}

// ── 渲染（复用已验收的模型层与渲染层，不复制任何版式规则）────────────────

export type ZxgkReportDocument = {
  buffer: Buffer;
  fileName: string;
  /** 核查日 `YYYY-MM-DD`（文件名口径）。 */
  checkDate: string;
  /** 核查日报告语体（正文口径），例如「2026年9月17日」。 */
  checkDateLabel: string;
  /** 报告记录数（= 主表数据行数 = 补充块数）。 */
  records: number;
  excludedCaptures: number;
  skippedNonPdf: number;
};

/**
 * ParseResult → 报告模型 → `.docx`。
 * 标题使用**项目名称**；不校验项目名称与查询对象是否一致。
 */
export async function renderZxgkReportDocx(options: {
  projectName: string;
  result: ParseResult;
  checkDate: string;
  skippedNonPdf?: number;
}): Promise<ZxgkReportDocument> {
  if (options.result.problems.length)
    throw new CaptureOperationError(
      unparsableMessage(options.result.problems),
      409,
    );
  if (!options.result.rows.length)
    throw new CaptureOperationError(NO_DETAIL_MESSAGE, 409);

  const model = buildReportModel(options.result, {
    targetName: options.projectName,
    checkDate: checkDateLabel(options.checkDate),
    draft: REPORT_DRAFT,
  });
  const buffer = await Packer.toBuffer(renderReportDocx(model));
  return {
    buffer,
    fileName: reportFileName(options.projectName, options.checkDate),
    checkDate: options.checkDate,
    checkDateLabel: checkDateLabel(options.checkDate),
    records: options.result.rows.length,
    excludedCaptures: options.result.excluded.length,
    skippedNonPdf: options.skippedNonPdf ?? 0,
  };
}

// ── 有界并发（本轮唯一的性能改动）────────────────────────────────────────

/**
 * 「下载 + 读 PDF」同时进行的份数。
 *
 * 实测依据（2026-09-19 生产 profiling，31 份真实留痕 + diagnostics_channel）：
 * 串行 route ≈ 35.4s，其中 31 次 Storage 请求占 31.1s，而 body 合计只有 2.67s
 * → 瓶颈是跨境 round-trip（TTFB 中位 872ms），不是带宽、parser 或 renderer。
 * 3 是收益拐点：按真实逐份数据推演，2→3 省 5.2s，3→4 只再省 2.2s。
 */
export const REPORT_CAPTURE_CONCURRENCY = 3;

/**
 * 有界并发映射：任意时刻活跃 worker 不超过 `concurrency` 个，结果**按输入下标**回填。
 *
 * 失败语义刻意做成确定性的：某一份失败**不会**提前中断其它 worker，
 * 而是等全部 worker 收工后，按**输入顺序**抛出第一份失败。
 * 这样「谁先 reject」不会改变可观察结果 —— 与串行实现逐字一致。
 */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  worker: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  const failures = new Map<number, unknown>();
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await worker(items[index], index);
        } catch (error) {
          failures.set(index, error);
        }
      }
    },
  );
  await Promise.all(workers);
  for (let index = 0; index < items.length; index += 1) {
    if (failures.has(index)) throw failures.get(index);
  }
  return results;
}

/** 完整流程：选择留痕 → 有界并发下载 / 读 PDF → 解析 → 渲染。 */
export async function generateZxgkReportDocx(options: {
  projectName: string;
  tasks: readonly ZxgkReportTask[];
  loadCapture: (storagePath: string) => Promise<Blob>;
  /** 仅供测试注入；缺省即真实 `readPages`（与 `loadCapture` 同一注入模式）。 */
  readPages?: (bytes: Uint8Array) => Promise<TextRun[][]>;
}): Promise<ZxgkReportDocument> {
  const selection = selectReportCaptures(options.tasks);
  const readPagesImpl = options.readPages ?? readPages;

  const loaded = await mapWithConcurrency(
    selection.captures,
    REPORT_CAPTURE_CONCURRENCY,
    async (capture) => {
      const blob = await options.loadCapture(capture.storagePath);
      return readPagesImpl(new Uint8Array(await blob.arrayBuffer()));
    },
  );

  // 顺序只由 selection 决定：并发只改变「谁先跑完」，绝不改变表格行序。
  const inputs: CaptureInput[] = [];
  const detailDays: string[] = [];
  loaded.forEach((pages, index) => {
    const capture = selection.captures[index];
    inputs.push({ fileName: capture.fileName, pages });
    // 核查日只取**详情**留痕：列表页不构成一次案件公示，不参与日期仲裁。
    if (classifyCapture(pages) === "detail") detailDays.push(capture.day);
  });

  const checkDate = resolveCheckDate(detailDays);
  const result = parseExecutionTable(inputs);
  return renderZxgkReportDocx({
    projectName: options.projectName,
    result,
    checkDate,
    skippedNonPdf: selection.skippedNonPdf,
  });
}

// ── 数据读取（用户 JWT + RLS）─────────────────────────────────────────────

async function pagedQueries(
  db: SupabaseClient<Database>,
  taskId: string,
): Promise<ReportQueryRow[]> {
  const rows: ReportQueryRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .from("queries")
      .select("id, task_id, query_no, query_text, created_at")
      .eq("task_id", taskId)
      .order("query_no")
      .order("id")
      .range(offset, offset + 499);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 500) break;
  }
  return rows;
}

async function pagedCaptures(
  db: SupabaseClient<Database>,
  queryId: string,
): Promise<Capture[]> {
  const rows: Capture[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .from("captures")
      .select("*")
      .eq("query_id", queryId)
      .order("capture_no")
      .order("id")
      .range(offset, offset + 499);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 500) break;
  }
  return rows;
}

/**
 * Private Storage 读取：与导出同一条路径（用户 JWT + RLS + `.download`），
 * 只是错误文案面向报告。刻意不静默跳过失败的留痕 —— 缺一份事实就不出报告。
 */
export async function downloadReportCapture(
  db: SupabaseClient<Database>,
  storagePath: string,
) {
  const { data, error } = await db.storage
    .from("captures")
    .download(storagePath);
  if (error || !data)
    throw new CaptureOperationError(STORAGE_READ_MESSAGE, 502);
  return data;
}

export type ProjectReportData = {
  projectName: string;
  tasks: ZxgkReportTask[];
};

/**
 * 载入报告所需的全部 persisted data。
 * Task 顺序 = 既有 `getProjectTasks` 顺序（不再二次排序），只处理范围内的 Task。
 */
export async function loadProjectReportData(
  db: SupabaseClient<Database>,
  projectId: string,
): Promise<ProjectReportData> {
  const project = await db
    .from("projects")
    .select("id, name")
    .eq("id", projectId)
    .single();
  if (project.error || !project.data)
    throw new CaptureOperationError(PROJECT_MISSING_MESSAGE, 404);

  const tasks = await getProjectTasks(db, projectId);
  const result: ZxgkReportTask[] = [];
  for (const task of tasks) {
    if (!isReportTask(task)) continue;
    const queries = await pagedQueries(db, task.id);
    const captures: Capture[] = [];
    for (const query of queries)
      captures.push(...(await pagedCaptures(db, query.id)));
    result.push({
      id: task.id,
      entity_name: task.entity_name,
      topic: task.topic,
      source_name: task.source_name,
      queries,
      captures,
    });
  }
  return { projectName: project.data.name, tasks: result };
}
