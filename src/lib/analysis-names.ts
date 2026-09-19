/**
 * AI 分析草稿的**字段名 / 标题 / 文案 / 持久化形状**口径层（与 `report-names.ts` 同构）。
 *
 * 为什么单独成文件：这四个标题同时被服务端（提示词、结构校验、DOCX 章节）与客户端
 * （文本框标签、状态文案）使用，必须只有一个定义。本文件**不得** import `docx` /
 * `unpdf` / `scripts/*` / 任何 server-only 模块，否则会把服务端代码带进浏览器 bundle。
 *
 * 边界（人工 LOCK，见 `MILESTONE_8_3.md`「边界澄清：事实层确定性，解释层可 AI 辅助」）：
 *   事实层由确定性解析器负责；AI 只做**解释层**——摘要、归纳、重点事项识别、
 *   进一步核查建议。AI 不得新增任何不存在于结构化 facts 中的案件、金额、法院、日期。
 *
 * 口径修正史（只修可靠性，不扩功能）：
 *   Slice 1.1：第二段标题是「重点关注事项」而**不是**「重点风险事项」——本段只做事实性
 *     提示，不下风险判断；字段名 `keyRisks` 保持不变，避免无意义的 API churn。
 *   Slice 2：新增 `AnalysisDraftRecord`（落库形状）与确认状态口径；`ANALYSIS_SESSION_ONLY_NOTE`
 *     被删除 —— 草稿从本 Slice 起会持久化，旧的「关闭弹窗即消失」说法已不成立。
 */

/** 四段分析的字段名（= 模型输出 JSON 的 key；顺序即展示顺序）。 */
export const ANALYSIS_SECTION_KEYS = [
  "overview",
  "keyRisks",
  "keyRecords",
  "followUps",
] as const;

export type AnalysisSectionKey = (typeof ANALYSIS_SECTION_KEYS)[number];

/**
 * 四段分析的固定中文标题；服务端提示词、DOCX 章节标题与客户端标签共用同一份。
 *
 * `keyRisks` 的标题是「重点关注事项」：文案变更**不**触发字段改名。
 */
export const ANALYSIS_SECTION_TITLES: Record<AnalysisSectionKey, string> = {
  overview: "核查结果概览",
  keyRisks: "重点关注事项",
  keyRecords: "重点记录",
  followUps: "建议进一步核实事项",
};

/** 分析草稿（四段纯文本）。 */
export type AnalysisDraft = Record<AnalysisSectionKey, string>;

/** 草稿标识：模型产物永远是草稿，不是正式法律意见。 */
export const ANALYSIS_DRAFT_LABEL =
  "分析草稿（非正式法律意见，需人工核对后使用）";

/** 模型返回不符合固定四段结构时的统一文案（服务端校验与客户端兜底共用）。 */
export const ANALYSIS_RESPONSE_INVALID_MESSAGE =
  "AI 返回的分析结果格式不正确，未展示草稿，请重试。";

/**
 * 输出护栏命中时的统一文案（服务端 `assertAnalysisDraftInScope` 抛出）。
 *
 * 必须**明确**（让用户知道这次是整体作废、不是网络问题），但**不暴露**内部提示词、
 * 命中规则名或任何片段——用户只看到「本次结果整体放弃」。
 */
export const ANALYSIS_GUARDRAIL_MESSAGE =
  "AI 生成的分析草稿包含超出本次核查范围的内容，已整次放弃本次结果（未展示任何片段），请重试。";

// ── 持久化形状（Slice 2）──────────────────────────────────────────────────
//
// 草稿存在 `projects.analysis_draft`（jsonb），一行一项目，沿用既有 `projects_owner`
// RLS：不新增表、不新增 policy。**不**把 rows / PDF / 证据索引复制进 jsonb ——
// 事实始终由 `parseProjectReport` 现算，jsonb 里只留指纹 `sourceHash` 用于 stale 检测。

/** 落库形状的版本号。结构变更必须递增，并让旧版本走「重新生成」而不是静默兼容。 */
export const ANALYSIS_DRAFT_VERSION = 1;

/**
 * `projects.analysis_draft` 的最终形状。
 *
 * 字段归属是硬边界（Slice 2 明确要求）：
 *   - `checkDate` / `sourceHash` / `generatedAt`：**服务端拥有**，客户端不得改写；
 *     它们共同说明「这份分析是针对哪一批事实生成的」。
 *   - `updatedAt` / `confirmedAt`：服务端时间戳，`confirmedAt = null` 表示未确认。
 *   - `sections`：四段正文 —— **唯一**允许人工编辑的部分。
 */
export type AnalysisDraftRecord = {
  version: number;
  /** 核查日 `YYYY-MM-DD`，生成/保存时由服务端写入。 */
  checkDate: string;
  /** 事实指纹（deterministic hash，非密码学用途），用于 stale 检测。 */
  sourceHash: string;
  /** 首次生成时间（ISO 8601）。 */
  generatedAt: string;
  /** 最后一次写入时间（ISO 8601）。 */
  updatedAt: string;
  /** 人工确认时间（ISO 8601）；**任何**人工修改后必须回到 null。 */
  confirmedAt: string | null;
  sections: AnalysisDraft;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInstant(value: unknown): value is string {
  return isText(value) && !Number.isNaN(Date.parse(value));
}

/**
 * 严格读取落库记录：**任何**不符合形状的情形都返回 null（fail closed）。
 *
 * 为什么是 null 而不是抛错：调用方要区分「没有草稿」与「有但不可用」没有产品意义 ——
 * 两种情况下 UI 都只能显示「没有可用的分析」并允许重新生成。但**不可用**的草稿
 * 绝不允许被当成可用草稿去渲染 DOCX（那正是 stale 静默进入报告的风险）。
 */
export function readAnalysisDraftRecord(
  value: unknown,
): AnalysisDraftRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.version !== ANALYSIS_DRAFT_VERSION) return null;
  if (
    typeof source.checkDate !== "string" ||
    !DAY_PATTERN.test(source.checkDate)
  )
    return null;
  if (
    typeof source.sourceHash !== "string" ||
    !SOURCE_HASH_PATTERN.test(source.sourceHash)
  )
    return null;
  if (!isInstant(source.generatedAt) || !isInstant(source.updatedAt))
    return null;
  if (source.confirmedAt !== null && !isInstant(source.confirmedAt))
    return null;
  const sections = source.sections;
  if (!sections || typeof sections !== "object" || Array.isArray(sections))
    return null;
  const raw = sections as Record<string, unknown>;
  const parsed = {} as AnalysisDraft;
  for (const key of ANALYSIS_SECTION_KEYS) {
    const text = raw[key];
    if (!isText(text)) return null;
    parsed[key] = text.trim();
  }
  return {
    version: ANALYSIS_DRAFT_VERSION,
    checkDate: source.checkDate,
    sourceHash: source.sourceHash.trim(),
    generatedAt: source.generatedAt,
    updatedAt: source.updatedAt,
    confirmedAt: source.confirmedAt,
    sections: parsed,
  };
}

// ── 人工确认状态（Slice 2）────────────────────────────────────────────────

/**
 * UI 状态。`dirty` = 文本框内容与最近一次保存的版本不一致（**尚未**提交）。
 *
 * `dirty-confirmed` 是刻意独立的：曾经确认过的草稿被再次编辑后，**必须**重新确认
 * 才会重新进入报告 —— 后端保存时清空 `confirmedAt` 正是这条规则的落点。
 */
export type AnalysisDraftStatus =
  "none" | "unconfirmed" | "confirmed" | "dirty" | "dirty-confirmed";

export function analysisDraftStatus(
  record: AnalysisDraftRecord | null,
  dirty: boolean,
): AnalysisDraftStatus {
  if (!record) return "none";
  if (dirty) return record.confirmedAt ? "dirty-confirmed" : "dirty";
  return record.confirmedAt ? "confirmed" : "unconfirmed";
}

/** 状态文案（UI 直接显示；`none` 表示没有草稿，不显示状态）。 */
export const ANALYSIS_STATUS_LABELS: Record<AnalysisDraftStatus, string> = {
  none: "",
  unconfirmed: "未确认",
  confirmed: "已确认",
  dirty: "有未保存修改",
  "dirty-confirmed": "有未保存修改，保存后需重新确认",
};

/** 草稿现在会持久化；只有已确认的分析才进报告。 */
export const ANALYSIS_PERSISTED_NOTE =
  "分析草稿会保存到本项目，可关闭弹窗后继续编辑；只有「已确认」的分析才会写入最终报告。";

/** 提交的编辑内容不符合固定 schema 时的文案（save / confirm 共用）。 */
export const ANALYSIS_SAVE_INVALID_MESSAGE =
  "提交的分析内容格式不正确，未保存，请重试。";

/** 已存 jsonb 不是合法草稿形状时的文案（服务端 502 与客户端兜底共用）。 */
export const ANALYSIS_DRAFT_INVALID_MESSAGE =
  "已保存的分析草稿格式异常，未加载，请重新生成 AI 分析。";

/** 还没有草稿就尝试保存 / 确认时的文案。 */
export const ANALYSIS_DRAFT_MISSING_MESSAGE =
  "当前项目还没有分析草稿，请先「生成 AI 分析」。";

/**
 * stale fail closed 文案（Slice 2 明确口径，逐字固定）。
 *
 * 触发条件：已确认的草稿所基于的事实指纹 ≠ 生成报告时重算的指纹。
 * 「不允许旧 AI 分析静默进入新报告」——宁可让报告生成失败，也不写入过期分析。
 */
export const ANALYSIS_STALE_MESSAGE =
  "已确认的 AI 分析基于旧版核查事实，请重新生成并确认 AI 分析后再生成报告。";
