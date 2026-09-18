/**
 * 尽调报告的**命名 / 日期 / 范围**口径层（与 `project-export.ts` 的 `projectExportNames` 同构）。
 *
 * 为什么单独成文件：命名与范围口径同时被服务端（生成文件名、过滤 Task）
 * 和客户端（按钮 coarse check、弹窗文案）使用，必须只有一个定义。
 * 本文件**不得** import `docx` / `unpdf` / `scripts/*`，否则会把 Node-only 依赖
 * 带进浏览器 bundle。
 *
 * 日期口径（人工 LOCK）：
 *   核查日 = **实际纳入报告的有效详情留痕**的 Asia/Shanghai 自然日，
 *   既不是报告生成日，也不是下载日；跨日直接 fail closed（不取 latest）。
 */

import { filenamePart } from "./capture-names.ts";

/**
 * 报告标题后缀（核查事项）。
 * 必须与 `scripts/zxgk-report-docx.ts` 的 `TITLE_TAIL` 一致 —— 两者相等由
 * `tests/zxgk-report-flow.test.ts` 固化，避免渲染层与文件名口径漂移。
 */
export const REPORT_TITLE_TAIL = "执行及失信公开信息核查报告";

/** `.docx` 的 MIME。 */
export const REPORT_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * 报告范围：核查事项 + 核查网站。
 *
 * 与扩展侧适配器 `extension/src/adapters/zxgk-execution.mjs` 的
 * `supportsZxgkExecution(task)`（`task.topic === "执行" && task.source_name === "中国执行信息公开网"`）
 * 完全同口径；这里不新增任何范围规则，只是把同一判据放到服务端与 UI 都能引用的位置。
 */
export const REPORT_TOPIC = "执行";
export const REPORT_SOURCE_NAME = "中国执行信息公开网";

export function isReportTask(task: {
  topic: string;
  source_name: string;
}): boolean {
  return task.topic === REPORT_TOPIC && task.source_name === REPORT_SOURCE_NAME;
}

/** 时间戳 → Asia/Shanghai 自然日，`en-CA` 的输出即为 `YYYY-MM-DD`。 */
export function shanghaiDay(instant: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** `YYYY-MM-DD` → 报告语体的核查日，例如「2026年9月17日」。 */
export function checkDateLabel(day: string): string {
  const [year, month, date] = day.split("-");
  return `${Number(year)}年${Number(month)}月${Number(date)}日`;
}

/** `YYYY-MM-DD` → 文件名用的 `YYYYMMDD`。 */
export function compactDay(day: string): string {
  return day.replaceAll("-", "");
}

/**
 * 报告文件名：`{安全项目名}_{核查事项}_{核查日}.docx`。
 * 日期取核查日（留痕日期），不是生成日；项目名走既有 `filenamePart` 消毒。
 */
export function reportFileName(projectName: string, day: string): string {
  return `${filenamePart(projectName)}_${REPORT_TITLE_TAIL}_${compactDay(day)}.docx`;
}
