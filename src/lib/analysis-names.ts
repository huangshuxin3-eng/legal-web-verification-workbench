/**
 * AI 分析草稿的**字段名 / 标题 / 文案**口径层（与 `report-names.ts` 同构）。
 *
 * 为什么单独成文件：这四个标题同时被服务端（提示词、结构校验）与客户端（文本框标签）
 * 使用，必须只有一个定义。本文件**不得** import `docx` / `unpdf` / `scripts/*` /
 * 任何 server-only 模块，否则会把服务端代码带进浏览器 bundle。
 *
 * 边界（人工 LOCK，见 `MILESTONE_8_3.md`「边界澄清：事实层确定性，解释层可 AI 辅助」）：
 *   事实层由确定性解析器负责；AI 只做**解释层**——摘要、归纳、重点事项识别、
 *   进一步核查建议。AI 不得新增任何不存在于结构化 facts 中的案件、金额、法院、日期。
 *
 * Slice 1.1 的两处口径修正（只修可靠性，不扩功能）：
 *   1. 第二段标题是「重点关注事项」而**不是**「重点风险事项」——本段只做事实性提示，
 *      不下风险判断；字段名 `keyRisks` 保持不变，避免无意义的 API churn。
 *   2. 新增 `ANALYSIS_GUARDRAIL_MESSAGE`：AI 输出命中护栏（见 `server/ai-analysis.ts`
 *      的 `assertAnalysisDraftInScope`）时整次 fail closed 的对外文案。
 *
 * Slice 1.2（确定性聚合）**没有改动本文件**：护栏仍是同一条对外文案，现在同时覆盖
 * 四类禁令（project/query 关系、日期逻辑、假设清单外记录、空字段成因建议）——
 * 文案对用户只表达「整次放弃、未展示片段」，不区分具体规则。
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
 * 四段分析的固定中文标题；服务端提示词与客户端标签共用同一份。
 *
 * `keyRisks` 的标题是「重点关注事项」：文案变更**不**触发字段改名。
 */
export const ANALYSIS_SECTION_TITLES: Record<AnalysisSectionKey, string> = {
  overview: "核查结果概览",
  keyRisks: "重点关注事项",
  keyRecords: "重点记录",
  followUps: "建议进一步核实事项",
};

/** 分析草稿（四段纯文本）。Slice 1 只在内存中存在，不落库。 */
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

/** Slice 1 明确不做持久化：草稿只在本次弹窗会话内有效。 */
export const ANALYSIS_SESSION_ONLY_NOTE =
  "分析草稿仅在本次会话中有效，关闭弹窗后不会保留；本版本尚未写入报告。";
