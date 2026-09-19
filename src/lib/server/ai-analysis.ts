/**
 * AI 分析草稿的**提示词构造**、**输出结构校验**、**输出护栏**与**事实指纹**
 * （Slice 1 / 1.1 / 1.2 / 2）。
 *
 * 本文件是纯函数层：不发网络请求、不读 PDF、不连 DB、不写磁盘。
 *
 * 边界（人工 LOCK，见 `MILESTONE_8_3.md`「边界澄清」）：
 *   1. 输入只有 `parseProjectReport` 产出的**结构化事实**（`ParseResult.rows`）。
 *      本文件没有任何 PDF 读取能力，**不可能**把原始 PDF 文本交给 LLM。
 *   2. 输入**最小化**：不向模型提供项目名称，也不提供任何「项目名称 vs 检索对象」
 *      的比较信息 —— 模型拿不到项目名，就不可能对二者关系下判断。
 *      提示词另外显式禁止评价二者关系（纵深防御，见「绝对约束」第 3 条）。
 *   3. 日期只能原样引用；日期逻辑判断（晚于 / 早于 / 接近核查日、时间异常等）
 *      当前版本**没有**程序预计算结果，因此一律禁止。
 *   4. 输出必须是**恰好四段字符串**的 JSON。非法 JSON / 缺字段 / 字段类型错误
 *      一律抛错，不返回半成品（由 `parseAnalysisResponse` 保证）。
 *   5. 结构合法**还不够**：输出还要过 `assertAnalysisDraftInScope` 的程序化护栏，
 *      命中禁令即整次 fail closed（不展示、不自动 retry）。
 *   6. Slice 1.2 —— **确定性聚合**：数量、分类、简单统计一律由代码算好（
 *      `buildAnalysisSummary`），模型只许引用、不许自己数。第二次真实 E2E 出现过
 *      LLM 数错（真实为 13/9/6 合计 28，模型输出「涉及失信 22 / 其中终本 16」），
 *      根因就是让模型自己做了 aggregation。**不解释、只引用**是这里唯一的修法。
 *   7. Slice 2 —— **事实指纹**（`buildAnalysisSourceHash`）与 **keyRecords 可追溯性**：
 *      已确认的草稿只有在指纹仍等于当下事实时才允许进入 DOCX；`keyRecords` 必须引用
 *      原始 `row.index`，不得自行重新编号（第三次真实 E2E 观察到的 1–26 重编号问题）。
 */

import { createHash } from "node:crypto";
import type { DetailRow } from "../../../scripts/zxgk-execution-parse.ts";
import {
  countDuplicateCaseNo,
  groupByPublicTypes,
} from "../../../scripts/zxgk-report-docx.ts";
import { CaptureOperationError } from "../capture-workflow.ts";
import {
  ANALYSIS_GUARDRAIL_MESSAGE,
  ANALYSIS_RESPONSE_INVALID_MESSAGE,
  ANALYSIS_SECTION_KEYS,
  type AnalysisDraft,
} from "../analysis-names.ts";

/**
 * 交给 AI 的事实包：只有已解析、已校验的结构化事实，没有任何原始证据文本。
 *
 * 刻意**不含 `projectName`**：项目名称与检索对象（`被执行人姓名/名称`）的关系不是
 * 本次分析的对象，把项目名交给模型只会诱发「二者不一致 → 需确认关联性」这类
 * 越界结论（Slice 1.1 的真实 E2E 已复现过一次）。类型层面直接删掉该字段，
 * 让「误传项目名」在编译期就不可能。
 */
export type AnalysisFacts = {
  /** 核查日 `YYYY-MM-DD`。日期只作原始事实引用，不作任何日期逻辑判断。 */
  checkDate: string;
  /** 核查网站名称。 */
  siteName: string;
  /** 已解析的结构化事实（报告行序）。 */
  rows: readonly DetailRow[];
};

// ── A. 确定性聚合（Slice 1.2）─────────────────────────────────────────────
//
// 「数量、分类、简单统计」由程序算定，模型只引用不重算。真实 E2E 证明 LLM 会数错
// （真实 13/9/6 合计 28 → 模型输出 22/16/6），因此这类数字**不能**交给模型生成。
//
// 统计口径不是新造的：`publicTypeGroups` / `duplicateCaseGroupCount` 直接复用
// **DOCX 报告**用的纯计数函数（`scripts/zxgk-report-docx.ts` 的 `groupByPublicTypes`
// / `countDuplicateCaseNo`），保证「AI 引用的数字」与「报告正文写出的数字」必然同源，
// 不会出现两套统计口径。

/** 解析器用「、」连接 DOM 渲染顺序的板块名（见 `zxgk-execution-parse` L540）。 */
const PUBLIC_TYPE_SEPARATOR = "、";
const TYPE_EXECUTED = "被执行人";
const TYPE_LOST = "失信被执行人";
const TYPE_TERMINATED = "终本案件";

/**
 * 系统预先算定的事实统计（**唯一**可信的数量来源）。
 *
 * 语义逐一明确，避免模型自由心证：
 *   - `recordCount`：记录总数 = `ParseResult.rows.length`。
 *   - `lostAndTerminatedCount`：一条记录**同时**公示「失信被执行人」与「终本案件」。
 *   - `lostOnlyCount`：只公示「失信被执行人」、**不含**「终本案件」。
 *   - `executedOnlyCount`：只公示「被执行人」（既不含失信、也不含终本）。
 *   - `duplicateCaseGroupCount`：同案号重复的**组数**（报告「N 组案号…各出现两次以上」的 N）。
 *   - `publicTypeGroups`：按实际出现的公示类型组合分组计数，与报告正文完全同一口径。
 *
 * 不给「其他 / 未分类」兜底字段：清单就是全集，不存在需要兜底的记录。
 */
export type AnalysisSummary = {
  recordCount: number;
  lostAndTerminatedCount: number;
  lostOnlyCount: number;
  executedOnlyCount: number;
  duplicateCaseGroupCount: number;
  publicTypeGroups: { publicTypes: string; count: number }[];
};

/** 按成员判定归类：不依赖板块书写顺序，也不做字符串前缀匹配。 */
export function buildAnalysisSummary(
  rows: readonly DetailRow[],
): AnalysisSummary {
  let lostAndTerminatedCount = 0;
  let lostOnlyCount = 0;
  let executedOnlyCount = 0;
  for (const row of rows) {
    const types = new Set(
      String(row.publicTypes ?? "")
        .split(PUBLIC_TYPE_SEPARATOR)
        .filter(Boolean),
    );
    const lost = types.has(TYPE_LOST);
    const terminated = types.has(TYPE_TERMINATED);
    if (lost && terminated) lostAndTerminatedCount += 1;
    else if (lost) lostOnlyCount += 1;
    else if (types.has(TYPE_EXECUTED)) executedOnlyCount += 1;
  }
  const list = [...rows];
  return {
    recordCount: rows.length,
    lostAndTerminatedCount,
    lostOnlyCount,
    executedOnlyCount,
    duplicateCaseGroupCount: countDuplicateCaseNo(list).groups,
    publicTypeGroups: groupByPublicTypes(list),
  };
}

/**
 * 统计的**中文可读**序列化：模型要直接照抄这些数字，键名必须无歧义
 * （内部类型用 camelCase，交给模型的一律是带中文语义标签的形状，与 `serializeRow` 同风格）。
 */
function serializeSummary(summary: AnalysisSummary): Record<string, unknown> {
  return {
    记录总数: summary.recordCount,
    失信与终本同时公示: summary.lostAndTerminatedCount,
    仅失信被执行人: summary.lostOnlyCount,
    仅被执行人: summary.executedOnlyCount,
    同案号重复组数: summary.duplicateCaseGroupCount,
    按公示类型组合计数: summary.publicTypeGroups.map((group) => ({
      公示类型: group.publicTypes,
      记录数: group.count,
    })),
  };
}

// ── B. 事实指纹（Slice 2）────────────────────────────────────────────────
//
// 用途**只有一个**：stale detection —— 判断「已确认的草稿」是否仍对应现在的事实。
// 明确**不是**安全用途：没有盐、没有密钥、不是密码学承诺，任何人都能重算。
//
// 必须满足的三条（人工口径）：
//   ① rows 内容相同 → hash 相同；
//   ② rows 内容有任何关键变化 → hash 变化；
//   ③ 不受 Promise 完成顺序影响。
//
// ③ 由「只喂**已按 selection 顺序排定**的 rows、不喂任何异步中间态」保证：
//    有界并发只改变谁先跑完，`parseProjectReport` 保证行序与并发无关
//    （见 `tests/zxgk-report-flow.test.ts` 的「完成顺序 3→1→2 不改变输出顺序」）。

/** 指纹算法版本：参与哈希，换算法/换口径时递增，旧草稿自然变成 stale。 */
export const ANALYSIS_SOURCE_HASH_VERSION = "v1";

/**
 * 事实的**规范形式**：字段名排序 + 固定键序；**行序保持不变**（行序本身是事实，
 * 主表序号就是它）。排序只消除「对象键插入顺序」这种与事实无关的差异。
 */
function canonicalFacts(facts: {
  checkDate: string;
  siteName: string;
  rows: readonly DetailRow[];
}): string {
  return JSON.stringify({
    checkDate: facts.checkDate,
    siteName: facts.siteName,
    rows: facts.rows.map((row) => ({
      index: row.index,
      publicTypes: row.publicTypes,
      remarks: row.remarks,
      evidenceFile: row.evidenceFile,
      fields: Object.entries(row.fields ?? {}).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    })),
  });
}

/**
 * 结构化事实 → 确定性指纹（sha256 十六进制）。
 *
 * 不把 summary 计入：summary 是 rows 的纯函数（`buildAnalysisSummary`），
 * 计入只会让「两处各算一份」有机会漂移，不会增加任何判别力。
 */
export function buildAnalysisSourceHash(facts: {
  checkDate: string;
  siteName: string;
  rows: readonly DetailRow[];
}): string {
  return createHash("sha256")
    .update(ANALYSIS_SOURCE_HASH_VERSION)
    .update("\n")
    .update(canonicalFacts(facts))
    .digest("hex");
}

export type AnalysisPrompt = {
  system: string;
  user: string;
};

/**
 * 系统提示词：固定文案，不随数据变化。
 *
 * 每条约束都对应一条硬规则；改动这里等于改动产品口径，需同步
 * `MILESTONE_8_3.md` 的边界说明、`src/lib/analysis-names.ts` 的标题口径与
 * `tests/zxgk-analysis.test.ts`。
 */
export const ANALYSIS_SYSTEM_PROMPT = `你正在生成一份尽调核查的「AI 分析草稿」——它不是正式法律意见，也不是核查结论。你会收到两部分输入：一份已经由确定性规则解析器从公开网站留痕中解析完成的结构化事实清单，以及一组由系统**预先计算好**的统计数字。你的任务是**只基于这两部分**写出四段分析草稿，其中所有数量一律照抄系统统计。

## 绝对约束
1. 只能依据输入的结构化事实。禁止虚构、补充或推断任何案件、当事人、案号、法院、金额、日期、证件号码。清单里没有的名称与数字，一个都不许出现。
2. 不得新增或推断金额、法院、日期、案号；禁止把外部知识、经验或行业惯例当作事实写入，也不要凭常识补全不完整的字段。
3. 「项目名称」与检索对象（被执行人姓名/名称）之间的关系**不是**本次分析的对象：不得评价、推断、比较或提示二者是否一致、是否对应、是否关联，也不得把任何主体名称差异写成风险、异常、疑点或待核实事项。输入里**没有**项目名称，因此任何关于项目名称的判断都必然是虚构。
4. 日期只能作为原始事实**原样引用**（例如「立案时间为 2026-01-16」）。不得自行计算日期差，不得判断某日期「晚于核查日」「早于核查日」「接近核查日」「时间异常」，也不得作任何同类时间逻辑推理。确需日期逻辑判断时，必须由程序预先计算并显式提供；当前版本**没有**提供，因此一律不得判断。
5. 不得推断主体的偿债能力、信用状况、经营状况、履约意愿，或任何输入事实无法支持的结论；不得给出法律结论、责任认定、胜诉可能性或诉讼策略式断言。
6. 信息不足时必须明确写出「现有核查信息不足以判断」，不得用推测填补。
7. 允许的产出只有两类：对给定事实的汇总 / 归纳，以及建议人工进一步核查的方向。
8. 输出是分析草稿，必须让读者能看出这是草稿而非定稿意见。
9. 所有数量（记录总数、各类别数量、按公示类型组合的数量、同案号重复组数）**只能**引用「系统已计算统计」中给出的数值，逐字照抄，不得自行统计、重新清点、改写、换算或估算任何数量。若你对明细清单的理解与系统统计不一致，一律以**系统统计**为准，不得写出与之冲突的数字。
10. 「结构化事实清单」**就是全部记录**，不存在清单之外的记录。禁止假设或暗示清单不完整：不得出现「其他记录」「未展开记录」「未列示记录」「未纳入记录」「遗漏记录」这类说法，也不得据此建议补充核查根本不存在的记录。
11. 字段空白是公示口径的正常结果，**不是**数据缺失，不得建议人工核实其成因：公示类型不含「终本案件」的记录，「终本日期」「未履行金额」本就不公示、为空；公示类型不含「被执行人」「终本案件」的记录，「执行标的」本就不公示、为空。禁止输出「建议确认某字段为何为空」「是否为空的字段是否因公示类型不同」这类建议；这类空白不构成任何疑点或待核事项。
12. 「keyRecords」只挑选**真正值得重点关注**的少量记录，最多 8 条，**不要求**覆盖全部记录。每条必须以该记录在明细清单中的**原始序号**开头，形如「原始序号9｜（2023）辽01执1682号｜要点」，其中数字必须是清单里该条记录「序号」字段的**原值**。禁止另行从 1 开始重新编号，禁止使用「1、」「2、」「1.」这类自拟序号；引用清单里不存在的序号会导致本次分析整体作废。

## 输出格式
只输出一个 JSON 对象，不要输出 JSON 之外的任何文字，不要使用 Markdown 代码块。恰好包含以下四个字段，值均为字符串（可用 \\n 分段，但不要使用表格或列表符号）：

- "overview"：核查结果概览 —— 核查范围、记录总数、公示类型构成等事实性汇总；其中的数量一律取自「系统已计算统计」。
- "keyRisks"：重点关注事项 —— 依据清单中值得关注的情形（如终本、失信、执行标的大小、同案号多笔记录等）。没有则写「未发现需特别提示的事项」。
- "keyRecords"：重点记录 —— 从清单中挑选最多 8 条真正值得重点关注的记录，每条写成「原始序号N｜案号（或证据文件名）｜要点」一行，N 必须是该记录在清单中的原始「序号」。没有则写「无」。
- "followUps"：建议进一步核实事项 —— 建议人工进一步核实的方向，不得写成法律意见。`;

/**
 * user 消息里「系统已计算统计」的起始标记（模型必须照抄这里的数字）。
 * 刻意排在事实清单**之前**：先给权威统计，再给明细，避免模型读到明细后自行归纳出数量。
 */
export const ANALYSIS_SUMMARY_MARKER = "【系统已计算统计】";

/** 事实清单在 user 消息里的起始标记（测试按此切分并独立解析 JSON）。 */
export const ANALYSIS_FACTS_MARKER = "【结构化事实 JSON】";

/** 单条事实的序列化：只带走有值的字段，空值一律省略（不写成 —、0、无）。 */
function serializeRow(row: DetailRow): Record<string, unknown> {
  const fields: Record<string, string> = {};
  for (const [label, value] of Object.entries(row.fields ?? {})) {
    if (typeof value === "string" && value.trim()) fields[label] = value;
  }
  const record: Record<string, unknown> = {
    序号: row.index,
    公示类型: row.publicTypes,
  };
  if (row.remarks?.trim()) record.备注 = row.remarks;
  if (row.evidenceFile?.trim()) record.证据文件 = row.evidenceFile;
  record.字段 = fields;
  return record;
}

/**
 * 结构化事实 → system / user 两段文本。确定性：同一输入必得同一输出。
 *
 * user 消息只包含：核查日、核查网站、**系统已计算统计**、结构化事实 JSON。
 * **没有**项目名称，也没有任何「项目名 vs 检索对象」的比较信息 —— 见
 * `AnalysisFacts` 的类型说明与 `tests/zxgk-analysis.test.ts` 的输入最小化用例。
 *
 * 统计由 `buildAnalysisSummary` 就地算定（与 rows 必然同源，不存在两处各算一份）：
 * 调用方仍旧只传核查日 / 核查网站 / 结构化行，不需要、也不可能传入统计 —— 也就无法
 * 传入与明细不一致的统计。
 */
export function buildAnalysisPrompt(facts: AnalysisFacts): AnalysisPrompt {
  const records = facts.rows.map(serializeRow);
  const summary = serializeSummary(buildAnalysisSummary(facts.rows));
  const user = [
    `【核查日】${facts.checkDate}`,
    `【核查网站】${facts.siteName}`,
    ANALYSIS_SUMMARY_MARKER,
    JSON.stringify(summary),
    ANALYSIS_FACTS_MARKER,
    JSON.stringify(records),
  ].join("\n");
  return { system: ANALYSIS_SYSTEM_PROMPT, user };
}

function invalidResponse() {
  return new CaptureOperationError(ANALYSIS_RESPONSE_INVALID_MESSAGE, 502);
}

/**
 * 严格校验模型输出：必须是可以解析的 JSON 对象，且恰好包含四段非空字符串。
 *
 * 额外字段一律忽略（不进入草稿）；任何不符合要求的情形都抛
 * `CaptureOperationError(…, 502)`，调用方不得展示半成品。
 *
 * 只做**结构**校验；内容层面的禁令由 `assertAnalysisDraftInScope` 负责。
 */
export function parseAnalysisResponse(raw: unknown): AnalysisDraft {
  if (typeof raw !== "string" || !raw.trim()) throw invalidResponse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidResponse();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw invalidResponse();
  const source = parsed as Record<string, unknown>;
  const draft = {} as AnalysisDraft;
  for (const key of ANALYSIS_SECTION_KEYS) {
    const value = source[key];
    if (typeof value !== "string" || !value.trim()) throw invalidResponse();
    draft[key] = value.trim();
  }
  return draft;
}

// ── 输出护栏（Slice 1.1 / 1.2 / 2）─────────────────────────────────────────
//
// 护栏 = 模型输出之后的**程序化机械检查**，不做复杂 NLP、不调用第二个模型、不自动
// retry（避免重复计费）。命中即**整次 fail closed**：不展示任何片段，不返回半成品。
//
// 为什么需要它：提示词是软约束，真实 E2E 已出现过五类越界输出。护栏是硬兜底，
// 只覆盖禁令的**明显**形态：
//   P. project / query 关系判断（把项目名与检索对象的差异写成风险 / 待核事项）；
//   D. 日期逻辑判断（晚于 / 早于 / 接近核查日、时间异常等）。
//   R. 假设清单外还有记录（其他 / 未展开 / 未列示 / 遗漏记录）。
//   E. 把「字段空白」当疑点，建议人工核实成因（该空白已由公示口径解释）。
//   K. keyRecords 不可追溯（超过 8 条 / 引用不存在的序号 / 自行从 1 重新编号）。
//
// **刻意不做**数字一致性解析（Slice 1.2 明确取舍）：从自由文本里可靠地抽取「N 条终本」
// 并判定是否与 summary 冲突，需要区分金额、日期、案号里的数字，机械规则误杀率高。
// 数量正确性改由「确定性 summary + 提示词第 9 条（照抄不重算）」保证 —— 那是可靠层，
// 护栏不在这里假装能做到。
//
// keyRecords 的检查同样**只做机械判定**：数「原始序号N」引用的个数、比对序号是否真实
// 存在于当前 rows、拦行首自拟编号。不做语义理解、不判断「这条是否真的重要」。

/** 护栏规则名（仅供服务端诊断，**不进**任何对外文案）。 */
export type AnalysisGuardrailRule =
  | "project-name-relation"
  | "date-logic"
  | "phantom-records"
  | "empty-field-recheck"
  | "key-records-limit"
  | "key-records-unknown-index"
  | "key-records-renumbered";

const PROJECT_NAME_SOURCE =
  "(?:项目名称|项目名|项目主体|项目全称|查询项目名称)";
/** 会把「项目名 vs 检索对象」变成比较 / 风险 / 待核事项的关系措辞。 */
const PROJECT_RELATION_SOURCE =
  "(?:一致|不一致|关联|关联性|匹配|相符|不符|吻合|对应|差异|偏差|确认|核对)";
/** 同段兜底用的 mismatch 专有措辞（比关系措辞更窄，避免误杀）。 */
const PROJECT_MISMATCH_SOURCE =
  "(?:不一致|不符|不匹配|关联性|关联关系|是否一致|是否相符|是否关联|需要确认|需确认)";

/**
 * 项目名关系禁令的命中模式：
 *   1–2. 同句近距离：项目名 ↔ 一致 / 关联 / 确认 … 任一方向
 *   3–4. 同段兜底：本段同时出现项目名与「不一致 / 关联性 / 需确认」这类 mismatch 措辞
 *
 * 输入里已经没有项目名称，因此模型一旦写出项目名，本身就是越界信号。
 * `[^。；\n]` 让 1–2 限定在同一句内，避免跨句误判。
 */
const PROJECT_NAME_RELATION_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `${PROJECT_NAME_SOURCE}[^。；\\n]{0,40}?${PROJECT_RELATION_SOURCE}`,
  ),
  new RegExp(
    `${PROJECT_RELATION_SOURCE}[^。；\\n]{0,40}?${PROJECT_NAME_SOURCE}`,
  ),
  new RegExp(`${PROJECT_NAME_SOURCE}[\\s\\S]*${PROJECT_MISMATCH_SOURCE}`),
  new RegExp(`${PROJECT_MISMATCH_SOURCE}[\\s\\S]*${PROJECT_NAME_SOURCE}`),
];

/**
 * 日期逻辑禁令的命中模式。只认**明确的判断措辞**，不认「2026-01-16」这类原样引用：
 *   1. 晚于 / 早于 / 迟于 / 先于 / 后于 … 核查日
 *   2. 接近 / 临近 / 靠近 / 距 … 核查日
 *   3. 核查日 … 之前 / 之后 / 前后（窗口 24 字，够容纳「核查日为 2026-09-17，均在其之前」）
 *   4. 时间 / 日期 / 时序 / 时间线 + 异常 / 存疑 / 矛盾 / 可疑，或「时间逻辑 / 日期逻辑」
 *
 * 刻意**不**收录「时间不一致」这类落在记录之间的比较 —— 它可能是合法的事实观察
 * （例如同案号两笔记录的立案时间不同），只拦「针对核查日」的时间推理。
 */
const DATE_LOGIC_PATTERNS: readonly RegExp[] = [
  /(?:晚于|早于|迟于|先于|后于)[^。；\n]{0,6}核查日期?/,
  /(?:接近|临近|靠近|距)[^。；\n]{0,4}核查日期?/,
  /核查日期?[^。；\n]{0,24}(?:之前|之后|以前|以后|前后)/,
  /(?:时间|日期|时序|时间线)(?:异常|存疑|可疑|矛盾|逻辑错误|逻辑矛盾|逻辑不通)/,
  /(?:时间|日期)逻辑/,
];

/**
 * 「假设存在清单外记录」禁令的命中模式（Slice 1.2）：
 *   1. 直接宣称清单外还有记录：未展开 / 未列示 / 未纳入 / 遗漏 … 记录。
 *   2. 以存在性断言包装的清单外记录：存在 / 另有 / 还有 … 其他（其它）记录。
 *
 * 刻意**不**拦「同案号另有记录」：那是解析器写进备注的**合法事实字样**
 * （例如「其中 1 条标注同案号另有记录」），所以第 2 条必须同时出现「其他 / 其它」，
 * 不能只认「另有」。
 */
const PHANTOM_RECORD_PATTERNS: readonly RegExp[] = [
  /(?:未展开|未列示|未列出|未纳入|未计入|遗漏|隐匿|隐藏)[^。；\n]{0,8}(?:记录|条目|数据|内容)/,
  /(?:存在|另有|还有|含有|包含|涉及)[^。；\n]{0,4}(?:其他|其它)[^。；\n]{0,6}(?:记录|条目|数据)/,
];

/**
 * 「空字段成因建议」禁令的命中模式（Slice 1.2）。
 *
 * 报告口径已确定：无「终本案件」公示类型 → 终本日期 / 未履行金额为空；
 * 无「被执行人」「终本案件」公示类型 → 执行标的为空。这是公示口径的正常结果，
 * 不是缺失，因此把「为空」再拿来做建议是无效建议。
 *
 * 只认**建议语气 + 核查动作 + 空值**同句共现（第 1 条），或**空值 + 追问成因**（第 2 条）。
 * 单纯陈述「执行标的为空」是合法的事实引用，不拦。
 */
const EMPTY_FIELD_RECHECK_PATTERNS: readonly RegExp[] = [
  /(?:建议|需|应|请|宜)[^。；\n]{0,24}(?:确认|核实|核对|查明|查证)[^。；\n]{0,24}(?:为空|空白|留空|空缺|缺失)/,
  /(?:为空|空白|留空|空缺|缺失)[^。；\n]{0,20}(?:是否因|是否因为|原因|成因)/,
];

/**
 * keyRecords 的可追溯性规则（Slice 2）。
 *
 * 真实背景：第三次 E2E 里 keyRecords 把挑出来的 26 条记录**自行编号 1–26**，
 * 于是「AI 说的第 9 条」在报告主表里找不到对应行 —— 用户无法回到原始记录。
 * 修法是两头卡：提示词要求写「原始序号N｜…」（第 12 条），护栏机械拒绝越界形态。
 *
 * 只做三件机械判定，**不做**语义理解、不判断「这条是否真的重要」：
 *   1. 「原始序号N」引用超过 `ANALYSIS_KEY_RECORDS_LIMIT` 条 → 拒绝（要求「少量」）；
 *   2. 任一 N 不在当前 rows 的 `index` 集合里 → 拒绝（不可追溯）；
 *   3. 行首出现自拟编号（`1、` / `1.` / `1｜` / `1)`）→ 拒绝（即是重新编号形态）。
 */
export const ANALYSIS_KEY_RECORDS_LIMIT = 8;

/** 可追溯引用前缀：`原始序号9｜（2023）辽01执1682号｜…`。 */
export const ANALYSIS_KEY_RECORDS_PREFIX = "原始序号";

const KEY_RECORDS_REFERENCE_PATTERN = /原始序号\s*(\d+)/g;
/**
 * 行首裸编号。`\d+` 后面**紧跟**分隔符才算，所以正文里的「2026-01-16 立案」
 * 与「2 条记录」都不会命中；而 `1、（2026）粤03执1234号` 会命中 —— 正是要拦的形态。
 */
const KEY_RECORDS_RENUMBER_PATTERN = /^[ \t]*\d+[ \t]*[、.．｜|)）]/m;

/**
 * keyRecords 专项护栏：返回命中的规则名，未命中返回 null。
 *
 * 单独一个函数（而不是并进 `findAnalysisGuardrailViolation`）是因为它**需要 rows**：
 * 「序号是否真实存在」必须拿当前事实来判，不能只看文本。
 */
export function findKeyRecordsViolation(
  text: string,
  rows: readonly DetailRow[],
): AnalysisGuardrailRule | null {
  if (!text) return null;
  const referenced = [...text.matchAll(KEY_RECORDS_REFERENCE_PATTERN)].map(
    (match) => Number(match[1]),
  );
  if (referenced.length > ANALYSIS_KEY_RECORDS_LIMIT)
    return "key-records-limit";
  if (referenced.length) {
    const known = new Set(rows.map((row) => row.index));
    if (referenced.some((index) => !known.has(index)))
      return "key-records-unknown-index";
  }
  if (KEY_RECORDS_RENUMBER_PATTERN.test(text)) return "key-records-renumbered";
  return null;
}

/** 返回命中的护栏规则名；未命中返回 null。纯函数，可独立测试。 */
export function findAnalysisGuardrailViolation(
  text: string,
): AnalysisGuardrailRule | null {
  if (!text) return null;
  if (PROJECT_NAME_RELATION_PATTERNS.some((pattern) => pattern.test(text)))
    return "project-name-relation";
  if (DATE_LOGIC_PATTERNS.some((pattern) => pattern.test(text)))
    return "date-logic";
  if (PHANTOM_RECORD_PATTERNS.some((pattern) => pattern.test(text)))
    return "phantom-records";
  if (EMPTY_FIELD_RECHECK_PATTERNS.some((pattern) => pattern.test(text)))
    return "empty-field-recheck";
  return null;
}

/**
 * 输出护栏：四段**逐段**做机械检查，任一段命中即整次 fail closed。
 *
 * `rows` 是必须的：keyRecords 的「序号是否真实存在」只能对着**当前事实**判，
 * 这也是本函数唯一需要事实的地方 —— 其余规则都只看文本。
 *
 * 抛 `CaptureOperationError(ANALYSIS_GUARDRAIL_MESSAGE, 502)` —— 文案明确告知
 * 「本次结果整体放弃」，但**不**暴露命中的规则名、提示词或任何输出片段。
 * 不做局部裁剪、不做自动 retry：宁可没有草稿，也不留下越界内容。
 *
 * 校验通过时原样返回草稿，便于与 `parseAnalysisResponse` 串联。
 */
export function assertAnalysisDraftInScope(
  draft: AnalysisDraft,
  rows: readonly DetailRow[],
): AnalysisDraft {
  for (const key of ANALYSIS_SECTION_KEYS) {
    const text = draft[key];
    if (findAnalysisGuardrailViolation(text)) throw outOfScope();
    if (key === "keyRecords" && findKeyRecordsViolation(text, rows))
      throw outOfScope();
  }
  return draft;
}

function outOfScope() {
  return new CaptureOperationError(ANALYSIS_GUARDRAIL_MESSAGE, 502);
}
