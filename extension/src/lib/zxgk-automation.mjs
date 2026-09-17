import {
  AUTOMATION_PHASES,
  AUTOMATION_RESULT,
  AUTOMATION_STATES,
  FIRST_PAGE_NO,
  canRecheckAutomation,
  canResumeAutomation,
  deriveResumeTarget,
  hasListCapture,
  normalizeAutomationJob,
} from "./automation-state.mjs";
import {
  buildRowKey,
  classifyVerificationAvailability,
  evaluateDetailIdentity,
  freezePageRows,
  isZxgkExecutionPage,
  locateRowKey,
  reconcileFrozenSet,
  reconcileRowKeys,
  supportsZxgkExecution,
  ZXGK_EXECUTION_ADAPTER,
  ZXGK_VERIFICATION_OUTCOMES,
  ZXGK_VERIFICATION_WIDGET_STATES,
} from "../adapters/zxgk-execution.mjs";
import { normalizeQueryText, selectCanonicalQuery } from "./query-identity.mjs";

/**
 * 自动核查上下文专用的 Query 失效文案（不要与手工 Query 的文案混用）。
 * worker 在自动核查归档失败时复用同一句话，避免两处文案漂移。
 */
export const AUTOMATION_QUERY_UNAVAILABLE_MESSAGE =
  "本次核查关联的 Query 已不存在或无法访问，无法安全继续本次核查。已生成 Capture 不删除。";

export const AUTOMATION_JOB_INVALID_MESSAGE =
  "本次核查的恢复状态不完整或不一致，无法安全继续。已生成留痕不会删除。";

export const AUTOMATION_RESUME_UNAVAILABLE_MESSAGE =
  "当前没有可继续的核查进度，请重新开始自动核查。";

/**
 * 安全验证组件的观察上限（M8.2b Slice 4B）。
 *
 * 真人正常样本约 1.0s / 1.0s / 16.2s，取 45s 作为观察上限。
 *
 * 语义严格限定为「观察了 45 秒仍然没有进入可人工操作的 READY 状态」，
 * **不是**「网站已证明加载失败」：真实页面没有任何"验证组件加载失败"的 DOM 证据，
 * 因此对外文案只能说"长时间未就绪"，不得断言加载失败或接口故障。
 */
export const VERIFICATION_WIDGET_READY_DEADLINE_MS = 45000;
const VERIFICATION_WIDGET_POLL_MS = 500;

export const VERIFICATION_WIDGET_UNAVAILABLE_CODE =
  "VERIFICATION_WIDGET_UNAVAILABLE";
export const VERIFICATION_WIDGET_NOT_OBSERVED_CODE =
  "VERIFICATION_WIDGET_NOT_OBSERVED";

/**
 * 分页只有两个动作，语义严格不同（M8.2b Slice 5）：
 *
 * - **business advance**：`advancePage` 的 Page N → N+1 transition。它代表业务进度，
 *   必须先把"源页已完成、准备离开"落盘（PAGE_ADVANCE intent + completedPages 前移），
 *   再发出恰好一次跳页动作，然后用页面事实证明目标页并冻结它。
 * - **locate jump**：`locateToCheckpoint` 的"把页面挪到 checkpoint 页"。它不代表
 *   任何业务进度：不写 intent、不动 completedPages、不产生 Capture、也不改 persisted
 *   的 currentPage。定位途中崩溃无需补偿——下一次 fresh resume 会重新从第 1 页定位。
 *
 * 两者共用同一个网页 primitive，但 dispatch 调用点全文件只有一处（dispatchJumpToPage）。
 */

/** 有界观察循环的安全上限：即使注入的时钟不前进也一定会结束。 */
const boundedPolls = (deadlineMs, pollMs) =>
  Math.max(1, Math.ceil(deadlineMs / pollMs) + 2);

const operationTypes = new Set(["LIST", "DETAIL", "PAGE_ADVANCE"]);
const operationPhases = new Set(Object.values(AUTOMATION_PHASES));

/** 页内处理中的状态：此时当前页尚未完成，因此不能出现在 completedPages。 */
const inPageStates = new Set([
  AUTOMATION_STATES.READING_RESULT_ROWS,
  AUTOMATION_STATES.CAPTURING_LIST_PAGE,
  AUTOMATION_STATES.OPENING_DETAIL,
  AUTOMATION_STATES.CAPTURING_DETAIL,
  AUTOMATION_STATES.RETURNING_TO_LIST,
  AUTOMATION_STATES.VERIFYING_LIST_STATE,
]);

const invalidJob = (code, reason) => ({ ok: false, code, reason });

/**
 * 页模型 invariant（M8.2b），只读 normalized 兼容视图，legacy 字段原样保留。
 * 返回 null 表示通过，否则返回 invalidJob 形状的失败结果。
 *
 * 分组：
 * 1. 页坐标：currentPage / totalPages 必须是 >= 1 的整数，且 currentPage 不越界；
 * 2. completedPages：严格从第 1 页连续，pageNo 不重复不跳页，detailCount >= 1；
 * 3. state-sensitive：页内处理中当前页必须未完成，准备离开当前页时源页必须已完成，
 *    只有真正带多页标记的 DONE 才要求停在最后一页且页连续。
 *
 * 当前页冻结集合的类型、非空、去重、长度、详情归属与冻结顺序统一由
 * validateZxgkAutomationJobInvariant 中的冻结集合 invariant 覆盖（输入已泛化为
 * 当前页冻结集合），因此这里不再重复一套同义校验。
 */
function validatePageModel(job) {
  const { currentPage, totalPages } = job;
  if (
    currentPage != null &&
    (!Number.isInteger(currentPage) || currentPage < 1)
  )
    return invalidJob(
      "CURRENT_PAGE_INVALID",
      "currentPage 必须是 >= 1 的整数。",
    );
  if (totalPages != null && (!Number.isInteger(totalPages) || totalPages < 1))
    return invalidJob("TOTAL_PAGES_INVALID", "totalPages 必须是 >= 1 的整数。");
  if (currentPage != null && totalPages != null && currentPage > totalPages)
    return invalidJob("PAGE_OUT_OF_RANGE", "currentPage 不能大于 totalPages。");

  const completedPages = job.completedPages;
  if (!Array.isArray(completedPages))
    return invalidJob("COMPLETED_PAGES_INVALID", "completedPages 必须是数组。");
  for (const [index, item] of completedPages.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return invalidJob(
        "COMPLETED_PAGE_ITEM_INVALID",
        "completedPages 只能包含对象。",
      );
    if (!Number.isInteger(item.pageNo) || item.pageNo < 1)
      return invalidJob(
        "COMPLETED_PAGE_NO_INVALID",
        "completedPages 的 pageNo 必须是 >= 1 的整数。",
      );
    // 严格连续同时排除重复与跳页：[1,2,3] 合法，[2] / [1,3] / [1,1] 都不合法。
    if (item.pageNo !== index + 1)
      return invalidJob(
        "COMPLETED_PAGES_NOT_CONTIGUOUS",
        "completedPages 必须从第 1 页起严格连续。",
      );
    if (!Number.isInteger(item.detailCount) || item.detailCount < 1)
      return invalidJob(
        "COMPLETED_PAGE_COUNT_INVALID",
        "completedPages 的 detailCount 必须是 >= 1 的整数。",
      );
    if (item.listCaptureId != null && !String(item.listCaptureId).trim())
      return invalidJob(
        "COMPLETED_PAGE_CAPTURE_INVALID",
        "completedPages 的 listCaptureId 必须是非空字符串或 null。",
      );
    if (item.completedAt != null && !String(item.completedAt).trim())
      return invalidJob(
        "COMPLETED_PAGE_TIME_INVALID",
        "completedPages 的 completedAt 必须是非空字符串或 null。",
      );
    if (totalPages != null && item.pageNo > totalPages)
      return invalidJob(
        "COMPLETED_PAGE_OUT_OF_RANGE",
        "completedPages 出现超过 totalPages 的页。",
      );
  }

  // 当前页冻结集合的类型与非空已在上面的冻结集合 invariant 中校验，
  // 长度 / 去重 / 详情进度归属 / 冻结顺序同样复用那一套，不重复实现。

  if (inPageStates.has(job.state)) {
    if (
      currentPage != null &&
      completedPages.some((item) => item?.pageNo === currentPage)
    )
      return invalidJob(
        "CURRENT_PAGE_ALREADY_COMPLETED",
        "页内处理中时当前页不应出现在 completedPages。",
      );
  }
  if (job.state === AUTOMATION_STATES.ADVANCING_PAGE) {
    if (currentPage == null)
      return invalidJob(
        "ADVANCE_PAGE_MISSING",
        "ADVANCING_PAGE 必须存在 currentPage。",
      );
    // 必须真的持有跳页 intent：后台没有任何待结算动作却停在 ADVANCING_PAGE，
    // 就是一个假的"处理中"状态（重启后也无从判断该继续做什么）。
    // intent 自身的合法性全部由通用的 operation 校验覆盖，这里不重复实现：
    // 源页号 = OPERATION_PAGE_INVALID、目标页号 = PAGE_ADVANCE_TARGET_INVALID、
    // 源页已完成 = PAGE_ADVANCE_SOURCE_INCOMPLETE。
    if (job.currentOperation?.type !== "PAGE_ADVANCE")
      return invalidJob(
        "ADVANCE_OPERATION_MISSING",
        "ADVANCING_PAGE 必须存在 PAGE_ADVANCE 操作。",
      );
  }
  // 只有真正带多页标记的 DONE 才受多页约束：M8.1 / M8.2a 的 NO_RESULT DONE 没有页标记。
  const hasPageMarkers = totalPages != null || completedPages.length > 0;
  if (job.state === AUTOMATION_STATES.DONE && hasPageMarkers) {
    if (currentPage !== totalPages)
      return invalidJob("DONE_PAGE_MISMATCH", "多页 DONE 必须停在最后一页。");
    if (completedPages.length !== totalPages)
      return invalidJob(
        "DONE_PAGES_INCOMPLETE",
        "多页 DONE 必须连续覆盖全部页。",
      );
    if (job.currentOperation)
      return invalidJob("DONE_OPERATION_ACTIVE", "DONE 时不应存在未结算操作。");
  }

  // 部分完成（legacy 稳定 checkpoint）：连续页前缀 1..currentPage 已完整处理，但网站仍有
  // 未处理页。Slice 5 起新核查一律推进到最后一页并写成 DONE，因此这个状态只来自旧版本；
  // 它仍然是可继续的检查点，但页模型本身必须自洽——页数未知或已到最后一页都不成立，
  // 后者必须写成 DONE，不能谎称部分完成。
  // （PARTIAL_COMPLETE 与 legacy firstPageComplete 并存的情况已被上面的
  // COMPLETE_STATE_MISMATCH 拒绝，这里不再重复一套同义校验。）
  if (job.state === AUTOMATION_STATES.PARTIAL_COMPLETE) {
    if (currentPage == null || totalPages == null)
      return invalidJob(
        "PARTIAL_PAGE_MISSING",
        "PARTIAL_COMPLETE 必须同时存在 currentPage 与 totalPages。",
      );
    if (currentPage >= totalPages)
      return invalidJob(
        "PARTIAL_PAGE_EXHAUSTED",
        "最后一页已全部处理时必须 DONE，不能是 PARTIAL_COMPLETE。",
      );
    // completedPages 的连续性与字段合法性已在上面的循环里校验，这里只补
    // "必须连续覆盖到 currentPage"这一条。
    if (completedPages.length !== currentPage)
      return invalidJob(
        "PARTIAL_PAGES_INCOMPLETE",
        "PARTIAL_COMPLETE 的 completedPages 必须连续覆盖到 currentPage。",
      );
    if (job.currentOperation)
      return invalidJob(
        "PARTIAL_OPERATION_ACTIVE",
        "PARTIAL_COMPLETE 时不应存在未结算操作。",
      );
  }

  return null;
}

/** 跳页后的观察窗口与轮询间隔：只用于“长期没有确定结论就 fail closed”，不是成功判据。 */
const PAGE_ADVANCE_TIMEOUT_MS = 20000;
const PAGE_ADVANCE_POLL_MS = 250;

/**
 * 纯判定：第 pageNo 页是否已经可以证明 PAGE_COMPLETE。
 *
 * 只使用页坐标、冻结结果集合、详情完成集合与列表留痕这几项直接事实：
 * - 不用“Capture 数量 === 11”这类计数代替集合覆盖；
 * - 不用“分组控件是否禁用”；
 * - 不用“是否打开过全部详情”。
 *
 * M8.2a 的第一页同样走这一份判定（legacy 字段由 normalize 派生为等价视图）。
 */
export function pageCompleteness(job, pageNo) {
  const normalized = normalizeAutomationJob(job);
  if (normalized.currentPage !== pageNo)
    return {
      ok: false,
      reason: `当前页不是第 ${pageNo} 页，无法证明该页已完成。`,
    };
  const keys = normalized.pageFrozenKeys;
  if (!Array.isArray(keys) || !keys.length)
    return { ok: false, reason: `第 ${pageNo} 页没有冻结的结果集合。` };
  if (new Set(keys).size !== keys.length)
    return { ok: false, reason: `第 ${pageNo} 页的冻结结果集合存在重复。` };
  if (job.expectedDetailCount !== keys.length)
    return {
      ok: false,
      reason: `第 ${pageNo} 页的期望详情数与冻结结果集合不一致。`,
    };
  const completed = job.completedDetailKeys || [];
  if (new Set(completed).size !== completed.length)
    return { ok: false, reason: `第 ${pageNo} 页的详情完成进度存在重复。` };
  const missing = keys.filter((key) => !completed.includes(key));
  if (missing.length)
    return {
      ok: false,
      reason: `第 ${pageNo} 页仍有未处理的结果：${missing.join("；")}。`,
    };
  if (!hasListCapture(job))
    return { ok: false, reason: `第 ${pageNo} 页的结果列表尚未留痕。` };
  if (job.currentOperation)
    return { ok: false, reason: "仍有未结束的操作，未标记完成。" };
  const resultPage = normalized.resultPage;
  if (resultPage?.pageNo != null && resultPage.pageNo !== pageNo)
    return { ok: false, reason: `最近一次读取的结果页不是第 ${pageNo} 页。` };
  return { ok: true };
}

/** 跳页观察的失败结果：带上可区分的 code，由上层写入 PAUSED。 */
const advanceFailed = (code, error, sourcePage, targetPage) => ({
  outcome: "FAILED",
  code,
  error,
  sourcePage,
  targetPage,
});

/**
 * 纯判定：跳页动作发出之后，页面事实是否已经证明"到达目标页"。
 *
 * 只使用页坐标、结果总页数与目标页结果集合这几项直接事实，不发动作、不写状态：
 * - 已到达目标页且结果总页数仍是 baseline → SETTLED（附目标页冻结集合）；
 * - 仍停在源页或页信号不完整 → PENDING（继续观察，绝不重发动作）；
 * - 明确停在别的页 → FAILED；结果总页数变化 → FAILED；目标页不可冻结 → FAILED。
 *
 * 刻意不判断"验证失败"：那必须由页面自己的文案证明，属于调用方的职责。
 * same-environment 的 settlePendingPageAdvance 与 fresh resume 的重新跳页共用这一份
 * 判定，避免两处各写一套页坐标规则。
 */
export function classifyPageArrival(
  snapshot,
  { sourcePage, targetPage, baseline },
) {
  const page = snapshot?.page || {};
  if (page.input === targetPage && page.shown === targetPage) {
    // 到达目标页还不够：结果总页数与 baseline 不一致时结果集可能已经变化。
    if (page.totalPages !== baseline)
      return {
        outcome: "FAILED",
        code: "TOTAL_PAGES_CHANGED",
        error: `结果总页数已从 ${baseline} 变为 ${page.totalPages ?? "未知"}，本次自动核查已暂停，请人工核对后再决定是否重新核查。`,
      };
    const frozen = freezePageRows(snapshot, targetPage);
    if (!frozen.ok)
      return {
        outcome: "FAILED",
        code: "ADVANCE_ROWS_INVALID",
        error: frozen.error,
      };
    return { outcome: "SETTLED", rows: frozen.rows, keys: frozen.keys };
  }

  // 仍停在源页：请求可能还在飞行，也可能动作没有生效，一律继续观察到 deadline。
  if (page.input === sourcePage && page.shown === sourcePage)
    return { outcome: "PENDING" };

  // 已明确落在另一个页：不纠正、不重发，直接 fail closed。
  if (Number.isInteger(page.input) && page.input === page.shown)
    return {
      outcome: "FAILED",
      code: "ADVANCE_WRONG_PAGE",
      error: `跳页后页面停在第 ${page.input} 页，不是第 ${targetPage} 页，本次自动核查已暂停（不会再次发出跳页动作）。`,
    };

  // 页信号不完整（飞行中）：既不算到达，也不算失败。
  return { outcome: "PENDING" };
}

/**
 * pending PAGE_ADVANCE 的纯判定（same-environment settle）。
 *
 * 只根据真实页面快照回答"这次跳页现在算不算达成"，不发动作、不写状态。
 * 到达 / 待定 / 失败的全部页坐标规则由 classifyPageArrival 提供，这里只补两件事：
 * - 页面明确报告验证失败必须先于页坐标判定（验证失效时页坐标可能仍残留源页的值，
 *   pager 是被隐藏而不是被清空）；
 * - 结果里带上源页 / 目标页，便于上层写 PAUSED 时保留诊断信息。
 *
 * "验证失败"只能由页面自己的证据证明（snapshot.verification），绝不由读取异常推断；
 * 快照缺失或被判定为不可读时一律 PENDING，绝不凭空给出结论。
 * 真正的 fresh resume（重建查询环境后重新验证）不属于这里。
 */
export function settlePendingPageAdvance(job, snapshot) {
  const pending = job?.currentOperation;
  if (pending?.type !== "PAGE_ADVANCE")
    return advanceFailed(
      "NO_PAGE_ADVANCE_PENDING",
      "当前没有待确认的跳页操作。",
      null,
      null,
    );
  const sourcePage = pending.pageNo;
  const targetPage = pending.targetPage;
  const baseline = normalizeAutomationJob(job).totalPages;

  if (snapshot?.verification?.failed === true)
    return advanceFailed(
      "PAGE_ADVANCE_REQUIRES_VERIFICATION",
      `跳页后页面提示「${snapshot.verification.evidence || "安全验证失败"}」，需要在页面上重新完成安全验证，本次自动核查已暂停（不会再次发出跳页动作）。`,
      sourcePage,
      targetPage,
    );

  const decision = classifyPageArrival(snapshot, {
    sourcePage,
    targetPage,
    baseline,
  });
  return { ...decision, sourcePage, targetPage };
}

/**
 * advancePage 的前置条件：任何一项不成立都绝不发出网站动作，也不写任何状态。
 * 传入的必须是 normalizeAutomationJob 之后的视图。
 */
function pageAdvancePreconditions(job) {
  const { currentPage, totalPages } = job;
  if (!Number.isInteger(currentPage) || currentPage < 1)
    return "当前页坐标无效，未发出跳页动作。";
  if (!Number.isInteger(totalPages) || totalPages < 1)
    return "结果总页数尚未建立 baseline，未发出跳页动作。";
  if (currentPage >= totalPages)
    return `当前已是最后一页（第 ${currentPage} / ${totalPages} 页），没有可推进的页。`;
  if (job.currentOperation) return "仍有未结算的操作，未发出跳页动作。";
  const complete = pageCompleteness(job, currentPage);
  if (!complete.ok) return complete.reason;
  const pages = Array.isArray(job.completedPages) ? job.completedPages : [];
  if (pages.some((item, index) => item?.pageNo !== index + 1))
    return "已完成页记录必须从第 1 页起严格连续，未发出跳页动作。";
  if (pages.length !== currentPage - 1 && pages.length !== currentPage)
    return `第 ${currentPage} 页的完成记录与页坐标不一致，未发出跳页动作。`;
  return null;
}

/** 已完成的当前页只记最小 summary：历史页不留 rows / rowKeys / detailCaptures。 */
function pageCompleteSummary(job, normalized, pageNo, completedAt) {
  const existing = Array.isArray(normalized.completedPages)
    ? normalized.completedPages
    : [];
  // 已经记过这一页（legacy 完成标记派生，或幂等重入）时绝不重复 append。
  if (existing.length === pageNo) return existing;
  return [
    ...existing,
    {
      pageNo,
      detailCount: job.expectedDetailCount,
      listCaptureId: job.listCapture?.id ?? null,
      completedAt,
    },
  ];
}

/**
 * 校验持久化 zxgk automationJob 中明显不可能或自相矛盾的组合。
 * 该函数只读且不修复 snapshot，并保留 LIST/DETAIL 的 captureId 恢复窗口。
 */
export function validateZxgkAutomationJobInvariant(job) {
  if (!job || typeof job !== "object")
    return invalidJob("JOB_MISSING", "automationJob 不存在或格式无效。");
  if (!String(job.taskId || "").trim())
    return invalidJob("TASK_ID_MISSING", "automationJob 缺少 taskId。");
  if (!String(job.queryText || "").trim())
    return invalidJob("QUERY_TEXT_MISSING", "automationJob 缺少 queryText。");

  // 页模型统一从 read-time 兼容视图判断；legacy 字段本身继续按原样校验。
  const normalized = normalizeAutomationJob(job);
  const pageNo = Number.isInteger(normalized.currentPage)
    ? normalized.currentPage
    : FIRST_PAGE_NO;
  const completedPages = Array.isArray(normalized.completedPages)
    ? normalized.completedPages
    : [];

  // 当前页冻结集合与冻结顺序：M8.2b job 用 pageFrozenKeys / currentPageRows，
  // legacy job 由 normalize 从 pageOneRowKeys / pageOneRows 派生，两者等价。
  // 下面所有冻结集合 invariant 都基于这个视图，因此同一套规则同时覆盖两种 shape，
  // 不需要为多页再写第二套同义校验。
  if (job.pageOneRowKeys != null && !Array.isArray(job.pageOneRowKeys))
    return invalidJob("ROW_KEYS_INVALID", "pageOneRowKeys 必须是数组或空值。");
  if (job.pageOneRows != null && !Array.isArray(job.pageOneRows))
    return invalidJob("ROWS_INVALID", "pageOneRows 必须是数组或空值。");
  // 当前页冻结集合自身先合法，才谈得上与它的一致性校验。
  if (job.pageFrozenKeys != null && !Array.isArray(job.pageFrozenKeys))
    return invalidJob("PAGE_FROZEN_KEYS_INVALID", "当前页冻结集合必须是数组。");
  if (Array.isArray(job.pageFrozenKeys) && !job.pageFrozenKeys.length)
    return invalidJob("PAGE_FROZEN_KEYS_EMPTY", "当前页冻结集合必须非空。");
  if (job.currentPageRows != null && !Array.isArray(job.currentPageRows))
    return invalidJob(
      "PAGE_ROWS_INVALID",
      "currentPageRows 必须是数组或空值。",
    );
  const keysPresent = Array.isArray(normalized.pageFrozenKeys);
  const keys = keysPresent ? normalized.pageFrozenKeys : [];
  const pageRows = Array.isArray(normalized.currentPageRows)
    ? normalized.currentPageRows
    : null;

  if (keys.some((key) => !String(key || "").trim()))
    return invalidJob("ROW_KEY_EMPTY", "当前页冻结集合包含空值。");
  if (new Set(keys).size !== keys.length)
    return invalidJob("ROW_KEYS_DUPLICATE", "当前页冻结集合包含重复结果。");

  if (pageRows) {
    if (!keysPresent || pageRows.length !== keys.length)
      return invalidJob("ROWS_KEYS_LENGTH_MISMATCH", "冻结结果与 rowKey 数量不一致。");
    const derived = pageRows.map(buildRowKey);
    if (derived.some((key, index) => key !== keys[index]))
      return invalidJob("ROWS_KEYS_ORDER_MISMATCH", "冻结结果与 rowKey 顺序不一致。");
  }

  if (job.expectedDetailCount != null) {
    if (!Number.isInteger(job.expectedDetailCount) || job.expectedDetailCount < 0)
      return invalidJob("EXPECTED_COUNT_INVALID", "expectedDetailCount 必须是非负整数。");
    if (keysPresent && job.expectedDetailCount !== keys.length)
      return invalidJob("EXPECTED_COUNT_MISMATCH", "expectedDetailCount 与冻结结果数不一致。");
  }

  const completed = job.completedDetailKeys ?? [];
  if (!Array.isArray(completed))
    return invalidJob("COMPLETED_KEYS_INVALID", "completedDetailKeys 必须是数组。");
  if (new Set(completed).size !== completed.length)
    return invalidJob("COMPLETED_KEYS_DUPLICATE", "completedDetailKeys 包含重复结果。");
  if (completed.length && !keysPresent)
    return invalidJob("COMPLETED_WITHOUT_FROZEN_SET", "尚未冻结结果集却已有详情完成进度。");
  if (completed.some((key) => !keys.includes(key)))
    return invalidJob("COMPLETED_KEY_UNKNOWN", "详情完成进度包含冻结结果集之外的 rowKey。");
  if (job.expectedDetailCount != null && completed.length > job.expectedDetailCount)
    return invalidJob("COMPLETED_COUNT_OVERFLOW", "详情完成数超过 expectedDetailCount。");

  const detailCaptures = job.detailCaptures ?? [];
  if (!Array.isArray(detailCaptures))
    return invalidJob("DETAIL_CAPTURES_INVALID", "detailCaptures 必须是数组。");
  if (
    detailCaptures.some(
      (item) => item?.rowKey && (!keysPresent || !keys.includes(item.rowKey)),
    )
  )
    return invalidJob("DETAIL_CAPTURE_KEY_UNKNOWN", "详情留痕包含冻结结果集之外的 rowKey。");

  const hasProgress =
    keys.length > 0 ||
    completed.length > 0 ||
    detailCaptures.length > 0 ||
    Boolean(job.listCapture) ||
    Boolean(job.currentOperation?.captureId) ||
    Boolean(job.firstPageComplete);
  if (hasProgress && !String(job.queryId || "").trim())
    return invalidJob("QUERY_ID_MISSING", "已有第一页进度但缺少 queryId。");

  if (
    job.listCapture?.query_id &&
    job.queryId &&
    job.listCapture.query_id !== job.queryId
  )
    return invalidJob("LIST_CAPTURE_QUERY_MISMATCH", "列表留痕不属于 automationJob.queryId。");

  const operation = job.currentOperation;
  if (operation != null) {
    if (!operationTypes.has(operation.type))
      return invalidJob("OPERATION_TYPE_INVALID", "currentOperation.type 无效。");
    if (!operationPhases.has(operation.phase))
      return invalidJob("OPERATION_PHASE_INVALID", "currentOperation.phase 无效。");
    // 不写死第 1 页：操作永远属于当前页，legacy job 的有效当前页仍是 1。
    if (operation.pageNo !== pageNo)
      return invalidJob(
        "OPERATION_PAGE_INVALID",
        "currentOperation.pageNo 必须等于当前页。",
      );
    if (operation.type === "PAGE_ADVANCE") {
      // PAGE_ADVANCE 只校验形状：它描述“源页已完成，准备离开当前页”，
      // 不携带任何详情专用字段，也不代表真的发生过翻页。
      if (operation.targetPage !== operation.pageNo + 1)
        return invalidJob(
          "PAGE_ADVANCE_TARGET_INVALID",
          "PAGE_ADVANCE.targetPage 必须等于源页号加 1。",
        );
      if (!Number.isInteger(operation.attempt) || operation.attempt < 1)
        return invalidJob(
          "PAGE_ADVANCE_ATTEMPT_INVALID",
          "PAGE_ADVANCE.attempt 必须是 >= 1 的整数。",
        );
      if (
        operation.rowKey != null ||
        operation.caseNo != null ||
        operation.detailTabId != null ||
        operation.captureId != null
      )
        return invalidJob(
          "PAGE_ADVANCE_HAS_DETAIL_FIELDS",
          "PAGE_ADVANCE operation 携带了详情专用字段。",
        );
      if (!completedPages.some((item) => item?.pageNo === operation.pageNo))
        return invalidJob(
          "PAGE_ADVANCE_SOURCE_INCOMPLETE",
          "PAGE_ADVANCE 的源页必须已经完成。",
        );
    } else if (operation.type === "LIST") {
      if (
        operation.rowKey != null ||
        operation.caseNo != null ||
        operation.detailTabId != null
      )
        return invalidJob("LIST_OPERATION_HAS_DETAIL_FIELDS", "LIST operation 携带了详情专用字段。");
      if (
        operation.capture?.query_id &&
        job.queryId &&
        operation.capture.query_id !== job.queryId
      )
        return invalidJob("LIST_PENDING_QUERY_MISMATCH", "待收尾列表留痕不属于 automationJob.queryId。");
    } else {
      if (!String(operation.rowKey || "").trim())
        return invalidJob("DETAIL_OPERATION_KEY_MISSING", "DETAIL operation 缺少 rowKey。");
      if (!keysPresent || !keys.includes(operation.rowKey))
        return invalidJob("DETAIL_OPERATION_KEY_UNKNOWN", "DETAIL operation.rowKey 不属于冻结结果集。");
      if (pageRows) {
        const index = keys.indexOf(operation.rowKey);
        const expectedCaseNo = pageRows[index]?.caseNo;
        if (
          expectedCaseNo &&
          operation.caseNo &&
          String(expectedCaseNo) !== String(operation.caseNo)
        )
          return invalidJob("DETAIL_OPERATION_CASE_MISMATCH", "DETAIL operation.caseNo 与冻结结果冲突。");
      }
    }
  }

  const complete = Boolean(job.firstPageComplete);
  if (job.state === AUTOMATION_STATES.FIRST_PAGE_COMPLETE && !complete)
    return invalidJob("COMPLETE_MARKER_MISSING", "FIRST_PAGE_COMPLETE 缺少完成摘要。");
  if (complete && job.state !== AUTOMATION_STATES.FIRST_PAGE_COMPLETE)
    return invalidJob("COMPLETE_STATE_MISMATCH", "完成摘要与 automation state 不一致。");
  if (complete) {
    if (!job.listCapture)
      return invalidJob("COMPLETE_LIST_CAPTURE_MISSING", "第一页完成但列表留痕尚未稳定收尾。");
    if (!keysPresent || job.expectedDetailCount == null)
      return invalidJob("COMPLETE_FROZEN_SET_MISSING", "第一页完成但缺少冻结结果集。");
    if (completed.length !== job.expectedDetailCount)
      return invalidJob("COMPLETE_DETAILS_MISSING", "第一页完成标记与详情完成数不一致。");
    if (operation)
      return invalidJob("COMPLETE_OPERATION_ACTIVE", "第一页完成时仍存在未结算操作。");
  }

  // M8.2b 页模型 invariant：只读 normalized 兼容视图，legacy 字段不受影响。
  const pageFailure = validatePageModel(normalized);
  if (pageFailure) return pageFailure;

  return { ok: true };
}

function messageOf(error) {
  return String(error?.message || error || "自动核查失败。");
}

/** 已推进到某个状态后失败：保留进度信息，避免覆盖已完成结果。 */
function stop(job, message) {
  return Object.assign(new Error(String(message)), { job });
}

function sameTaskContext(task, job) {
  return (
    task?.id === job.taskId &&
    task?.project_id === job.projectId &&
    task?.entity_name === job.entityName &&
    normalizeQueryText(task?.entity_name) === job.queryText &&
    task?.topic === job.topic &&
    task?.source_name === job.sourceName &&
    task?.source_url === job.sourceUrl
  );
}

/**
 * 列表操作的进度记录。默认形状与详情保持一致的四个身份字段；
 * 只有需要承载“Capture 已成功”这类收尾信息时才追加字段。
 *
 * pageNo 必填、刻意不给默认值：operation 永远属于调用时的当前页，漏传参数会静默
 * 退化成第 1 页，从而在第 2 页触发 OPERATION_PAGE_INVALID。
 */
function listOperation(pageNo, phase, extra = null) {
  const operation = {
    type: "LIST",
    pageNo,
    rowKey: null,
    caseNo: null,
    phase,
  };
  return extra ? { ...operation, ...extra } : operation;
}

/** 同上：detailOperation 的 pageNo 同样必填，理由与 listOperation 一致。 */
function detailOperation(pageNo, row, phase) {
  return {
    type: "DETAIL",
    pageNo,
    rowKey: buildRowKey(row),
    caseNo: row.caseNo,
    phase,
  };
}

export function createZxgkAutomation(dependencies) {
  const saveState = async (job, state, patch = {}) =>
    dependencies.saveJob({
      ...job,
      ...patch,
      state,
      updatedAt: dependencies.now().toISOString(),
    });

  const fail = async (job, error) => {
    const failed = await saveState(job, AUTOMATION_STATES.FAILED, {
      error: messageOf(error),
    });
    throw Object.assign(new Error(failed.error), { job: failed });
  };

  /**
   * 观察到的页面事实与 baseline 冲突：保留进度、置 PAUSED，并带上可区分的 code。
   * 与 fail 的区别是语义：这里不是“执行失败”，而是“必须停下来交人工判断”。
   */
  const pauseWith = async (job, code, message) => {
    const paused = await saveState(job, AUTOMATION_STATES.PAUSED, {
      errorCode: code,
      error: message,
    });
    return Object.assign(new Error(message), { job: paused });
  };

  /** 当前 Task 内是否已经有同文本 Query 可以复用。 */
  async function findCanonicalQuery(taskId, queryText) {
    const rows = await dependencies.listTaskQueries(taskId);
    return selectCanonicalQuery(rows, queryText);
  }

  /**
   * 结果确认后确定本轮 Query：已复用则原样继续，确实没有同文本 Query 时才创建一次。
   * 同一检索词在后续每一轮自动核查中都会复用同一个 Query。
   */
  async function ensureQuery(job) {
    if (job.queryId) return job;
    job = await saveState(job, AUTOMATION_STATES.CREATING_QUERY);
    const canonical = await findCanonicalQuery(job.taskId, job.queryText);
    if (canonical)
      return saveState(job, AUTOMATION_STATES.CREATING_QUERY, {
        query: canonical,
        queryId: canonical.id,
      });
    const query = await dependencies.createQuery(job.taskId, job.queryText);
    return saveState(job, AUTOMATION_STATES.CREATING_QUERY, {
      query,
      queryId: query.id,
    });
  }

  /**
   * 提交查询之后的有界观察（M8.2b Slice 4B）。
   *
   * 只有真的观察到安全验证组件进入可人工操作状态（READY），才把这一步交给人工；
   * 否则按**真实观察到的事实** fail closed。它不判断"网站坏了"：
   * - LOADING / PRESENT_BUT_NOT_READY 持续到 deadline
   *     → PAUSED + VERIFICATION_WIDGET_UNAVAILABLE（文案只说"长时间未就绪"）；
   * - NOT_PRESENT 持续到 deadline（真人证明它有多重业务含义）
   *     → PAUSED + VERIFICATION_WIDGET_NOT_OBSERVED（更泛化的文案，不伪造 widget 证据）。
   *
   * Phase A 只回答"新的安全验证组件是否已经进入可人工操作状态"，因此**不消费
   * verification outcome**：真人页面证明上一轮的"验证已失效"文案可以在新组件正常
   * LOADING → READY 的整个过程中继续留在页面上。把这种陈旧 outcome 当作 PAUSE 依据，
   * 会让一个本来可以正常验证的页面被误判。45 秒 deadline 也只针对"组件没有进入
   * READY"，不针对旧的 verification outcome。
   *
   * "本次人工验证没有被网站接受"由 continueAfterVerification（Phase B）重新读取
   * 页面事实后判定——那时页面上的失效文案才是本次验证的证据。
   *
   * 读取失败与"还没就绪"同样处理：继续观察到 deadline，绝不据此推断原因。
   * 有界：总时长不超过 deadline，并且有一个与 deadline 对应的轮询上限，
   * 因此即使注入的时钟不前进也一定会结束，不存在无限 retry。
   */
  async function awaitVerificationWidget(
    job,
    deadlineMs = VERIFICATION_WIDGET_READY_DEADLINE_MS,
  ) {
    if (typeof dependencies.readVerificationAvailability !== "function")
      throw new Error("缺少安全验证组件的观察依赖，未提交查询。");
    if (typeof dependencies.sleep !== "function")
      throw new Error("缺少等待依赖，未提交查询。");
    const deadline = dependencies.now().getTime() + deadlineMs;
    const maxPolls = boundedPolls(deadlineMs, VERIFICATION_WIDGET_POLL_MS);
    let lastState = null;
    for (let poll = 0; ; poll += 1) {
      let facts = null;
      try {
        facts = await dependencies.readVerificationAvailability(job.tabId);
      } catch {
        // 读不到事实不等于"网站坏了"，也不等于"还没就绪"：只当这一轮没观测到。
        facts = null;
      }
      const availability = classifyVerificationAvailability(facts);
      if (
        availability.ok &&
        availability.state === ZXGK_VERIFICATION_WIDGET_STATES.READY
      )
        return saveState(job, AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION, {
          error: null,
          errorCode: null,
        });
      // Phase A 不读 outcome 判 PAUSE：真人页面证明旧的"验证已失效"文案可以在新的
      // 组件正常 LOADING → READY 期间继续存在，因此这里只用它来判断"是否已经通过"。
      // 页面自己宣布"验证已通过"：这一轮已经不需要人工再验证一次，
      // 但仍然走同一个 WAITING_HUMAN_VERIFICATION 交接点，由用户决定何时继续。
      if (
        availability.outcome === ZXGK_VERIFICATION_OUTCOMES.VERIFIED_OR_QUERYING
      )
        return saveState(job, AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION, {
          error: null,
          errorCode: null,
        });
      if (availability.ok) lastState = availability.state;
      if (poll + 1 >= maxPolls || dependencies.now().getTime() >= deadline)
        break;
      await dependencies.sleep(VERIFICATION_WIDGET_POLL_MS);
    }
    const seconds = Math.round(deadlineMs / 1000);
    if (lastState === ZXGK_VERIFICATION_WIDGET_STATES.NOT_PRESENT)
      return saveState(job, AUTOMATION_STATES.PAUSED, {
        errorCode: VERIFICATION_WIDGET_NOT_OBSERVED_CODE,
        error: `点击查询后 ${seconds} 秒内没有在页面上观察到安全验证组件，无法确认页面是否已进入可人工验证状态。请重新建立页面后再试。`,
      });
    return saveState(job, AUTOMATION_STATES.PAUSED, {
      errorCode: VERIFICATION_WIDGET_UNAVAILABLE_CODE,
      error: `安全验证长时间未就绪（已观察 ${seconds} 秒），页面没有报告加载失败。请重新建立页面后再试。`,
    });
  }

  /**
   * 全新的一轮自动核查。
   *
   * 前端行为：`openQueryPage(..., { force: true })` 会让 worker **重新加载**查询入口，
   * 而不是在已经停在入口的标签页上直接复用。真实页面事实支持这么做：安全验证的令牌
   * 与弹窗状态全部是内存态，只有真正重新加载才能得到「从零开始」的验证环境，
   * 也才能让下面的安全验证观察有确定含义。
   *
   * 提交查询后必须先真的观察到安全验证组件进入可操作状态（awaitVerificationWidget）
   * 才把这一步交给人工；否则按观察到的事实 PAUSED，绝不假装已进入人工验证。
   */
  async function start({ taskId, projectId }) {
    let job = {
      adapter: ZXGK_EXECUTION_ADAPTER,
      state: AUTOMATION_STATES.IDLE,
      taskId,
      projectId,
      startedAt: dependencies.now().toISOString(),
      error: null,
      result: null,
    };
    try {
      const task = await dependencies.getTask(taskId);
      if (
        !task ||
        task.project_id !== projectId ||
        !supportsZxgkExecution(task)
      )
        throw new Error(
          "当前 Task 不支持 zxgk_execution 自动核查。请使用手工模式。",
        );
      const tab = await dependencies.getActiveTab();
      if (!tab?.id) throw new Error("无法取得当前活动标签页。");
      // 检索词固定为 Task.entity_name，与手工流程当前选中的 Query 无关。
      const queryText = normalizeQueryText(task.entity_name);
      const canonical = await findCanonicalQuery(taskId, queryText);
      job = await saveState(job, AUTOMATION_STATES.OPENING_QUERY_PAGE, {
        tabId: tab.id,
        entityName: task.entity_name,
        queryText,
        query: canonical || null,
        queryId: canonical?.id ?? null,
        topic: task.topic,
        sourceName: task.source_name,
        sourceUrl: task.source_url,
        // 新一轮从第 1 页第 1 条开始：清掉上一轮遗留的全部分页进度，**包含页坐标
        // 本身**——否则上一轮停在第 2 页的 currentPage / 冻结集合会污染新一轮
        // （normalize 会沿用显式页坐标，pageCompleteness(job, 1) 立刻不成立）。
        // Query 仍然复用同一个检索词。
        currentPage: FIRST_PAGE_NO,
        totalPages: null,
        completedPages: [],
        pageFrozenKeys: null,
        currentPageRows: null,
        resultPage: null,
        expectedDetailCount: null,
        pageOneRowKeys: null,
        completedDetailKeys: [],
        detailCaptures: [],
        listCapture: null,
        listFilename: null,
        currentOperation: null,
        firstPageComplete: null,
        errorCode: null,
      });
      await dependencies.openQueryPage(tab.id, tab.url, { force: true });
      job = await saveState(job, AUTOMATION_STATES.FILLING_ENTITY);
      const filled = await dependencies.fillEntity(tab.id, job.queryText);
      if (!filled?.ok)
        throw new Error(filled?.error || "主体名称自动填写失败。");
      job = await saveState(job, AUTOMATION_STATES.SUBMITTING_QUERY);
      const submitted = await dependencies.submitQuery(tab.id);
      if (!submitted?.ok)
        throw new Error(submitted?.error || "查询按钮点击失败。");
      // 提交成功还不等于"可以交给人工"：必须先真的观察到安全验证组件进入可操作状态。
      return awaitVerificationWidget(job);
    } catch (error) {
      return fail(error.job || job, error);
    }
  }

  /**
   * 继续本次核查（M8.2b Slice 4B：fresh environment）。
   *
   * 同一个 automationJob / run、同一个 Query、同一个 queryId。原自动化标签页仍在就
   * 复用，已经不在就新建一个专用标签页（绝不导航用户当前活动标签页），然后在其中
   * **重建**查询环境并重新提交查询。
   *
   * 重建之后页面必然回到第 1 页（页面事实：查询按钮绑定 submitCaptcha()，它会先
   * initCurrentPage() 再 search()），因此第 2 页的 checkpoint 会在人工验证之后由
   * resumeCheckpoint 重新跳到第 2 页，而不是在这里猜旧环境停在哪一页。
   *
   * 开始前必须确认本轮 Query 仍然有效（存在、同 Task、同检索词），否则 fail closed。
   */
  async function resume({ taskId }) {
    let job = await dependencies.getJob();
    if (!job || job.adapter !== ZXGK_EXECUTION_ADAPTER)
      throw new Error("没有可继续的自动核查任务。");
    try {
      const invariant = validateZxgkAutomationJobInvariant(job);
      if (!invariant.ok)
        throw new Error(`${AUTOMATION_JOB_INVALID_MESSAGE}（${invariant.code}）`);
      if (!canResumeAutomation(job))
        throw new Error(AUTOMATION_RESUME_UNAVAILABLE_MESSAGE);
      if (taskId !== job.taskId)
        throw new Error("当前选择的 Task 已变化，本次自动核查已停止。");
      const task = await dependencies.getTask(job.taskId);
      if (!sameTaskContext(task, job))
        throw new Error("Task 内容或归属已经变化，本次自动核查已停止。");
      // fail closed：继续之前重新读取本轮 Query，必须仍然存在、仍属于同一 Task，
      // 且检索词与 job 记录的完全一致（按 normalizeQueryText 比较）。
      // 任何一条不满足都不继续：不新建 Query、不静默切换其他 Query、不生成 Capture。
      const jobQuery = await dependencies.getQuery(job.queryId);
      if (
        !jobQuery ||
        jobQuery.task_id !== job.taskId ||
        normalizeQueryText(jobQuery.query_text) !==
          normalizeQueryText(job.queryText)
      )
        throw new Error(AUTOMATION_QUERY_UNAVAILABLE_MESSAGE);
      // 原 automation 标签页仍在就复用它；已经不在了就新建一个专用标签页，
      // 并把新 tab 写回 job.tabId。绝不退化为导航用户当前正在浏览的活动标签页。
      let tab = await dependencies.getTab(job.tabId);
      if (!tab?.id) {
        tab = await dependencies.createTab();
        if (!tab?.id) throw new Error("无法创建用于自动核查的标签页。");
      }
      job = await saveState(job, AUTOMATION_STATES.OPENING_QUERY_PAGE, {
        tabId: tab.id,
      });
      await dependencies.openQueryPage(tab.id, tab.url, { force: true });
      job = await saveState(job, AUTOMATION_STATES.FILLING_ENTITY);
      const filled = await dependencies.fillEntity(tab.id, job.queryText);
      if (!filled?.ok)
        throw new Error(filled?.error || "主体名称自动填写失败。");
      job = await saveState(job, AUTOMATION_STATES.SUBMITTING_QUERY);
      const submitted = await dependencies.submitQuery(tab.id);
      if (!submitted?.ok)
        throw new Error(submitted?.error || "查询按钮点击失败。");
      return awaitVerificationWidget(job);
    } catch (error) {
      return fail(error.job || job, error);
    }
  }

  /**
   * 当前页的结果列表留痕（页泛化）。只有列表留痕完整成功，才会开始处理该页详情。
   * 已经成功留痕过的列表在继续本次核查时不会重复生成。
   *
   * 每一页都必须有一份独立的列表留痕：进入新页时 listCapture 已被清空，
   * 因此"第 2 页的 rows 已冻结"不等于"第 2 页列表已留痕"。
   *
   * 与详情使用同一套成功事务语义：Capture 一旦 finalize 成功，立刻把成功
   * captureId 与补记载荷一起落盘，然后才做 verify / 状态收尾。
   */
  async function captureListPage(job) {
    const pageNo = normalizeAutomationJob(job).currentPage;
    job = await saveState(job, AUTOMATION_STATES.CAPTURING_LIST_PAGE, {
      currentOperation: listOperation(pageNo, AUTOMATION_PHASES.CAPTURING),
    });
    let archived;
    try {
      archived = await dependencies.archiveQuery(job.queryId, job.tabId);
    } catch (error) {
      throw stop(job, messageOf(error));
    }
    if (!archived?.capture)
      throw stop(job, "结果列表留痕没有返回 Capture，自动核查已停止。");
    // 成功事务：这一步先把成功标记落盘。即使随后在等待验证或返回列表时中断，
    // 继续本次核查也能凭 captureId 确认列表已经留痕，不会重复 Capture。
    job = await saveState(job, AUTOMATION_STATES.CAPTURING_LIST_PAGE, {
      currentOperation: listOperation(pageNo, AUTOMATION_PHASES.CAPTURING, {
        captureId: archived.capture.id,
        capture: archived.capture,
        filename: archived.filename,
      }),
    });
    return settlePendingListCapture(job, job.currentOperation);
  }

  /** 返回列表后必须复核仍在当前页，且冻结的目标集合仍全部可定位。 */
  async function verifyListState(job, expectedRowKeys) {
    const pageNo = normalizeAutomationJob(job).currentPage;
    job = await saveState(job, AUTOMATION_STATES.VERIFYING_LIST_STATE, {
      currentOperation: listOperation(pageNo, AUTOMATION_PHASES.VERIFYING),
    });
    const snapshot = await dependencies.readResultPage(job.tabId);
    const reconciled = reconcileRowKeys(expectedRowKeys, snapshot, pageNo);
    if (!reconciled.ok) throw stop(job, reconciled.error);
    return saveState(job, AUTOMATION_STATES.VERIFYING_LIST_STATE, {
      currentOperation: null,
    });
  }

  /**
   * 关闭上一轮遗留的详情标签页。这纯粹是清理：它不参与任何完成判定，
   * 因此失败不阻断继续（rowKey 身份与 Capture 归属都不依赖标签页）。
   */
  async function releaseDetailTab(job, detailTabId) {
    try {
      await dependencies.closeDetail(detailTabId, job.tabId);
    } catch {
      // 尽力而为；遗留标签页不影响后续 rowKey 定位与留痕归属。
    }
  }

  /**
   * currentOperation 是列表操作且已经带 captureId：结果列表的 Capture 确实
   * 已经 finalize 成功。继续本次核查时只补记 listCapture，绝不重复留痕。
   */
  async function settlePendingListCapture(job, pending) {
    if (!pending?.captureId) return job;
    const record = job.listCapture || pending.capture;
    // captureId 与补记载荷在同一次原子写入中落盘，正常路径不会走到这里；
    // 真走到这里说明本地记录不完整，宁可停人工，也不猜着重留一次痕。
    if (!record)
      throw stop(
        job,
        "列表留痕已成功但本地缺少留痕记录，自动核查已停止以避免重复留痕。",
      );
    return saveState(job, job.state, {
      listCapture: record,
      listFilename: job.listFilename || pending.filename || null,
      currentOperation: null,
    });
  }

  /**
   * currentOperation 已经带 captureId：该条证据确实已经生成，
   * 继续本次核查时只补记进度，绝不重复留痕。
   */
  async function settlePendingCapture(job, pending) {
    const rowKey = pending?.rowKey;
    if (!rowKey) return job;
    if (pending.detailTabId) await releaseDetailTab(job, pending.detailTabId);
    if ((job.completedDetailKeys || []).includes(rowKey))
      return saveState(job, job.state, { currentOperation: null });
    return saveState(job, AUTOMATION_STATES.VERIFYING_LIST_STATE, {
      completedDetailKeys: [...(job.completedDetailKeys || []), rowKey],
      currentOperation: null,
    });
  }

  /**
   * 收尾上一轮遗留的操作：凡是留痕已经真实生成（currentOperation 带
   * captureId）的，只补记进度；没有成功留痕的只做清理，稍后按 rowKey 重试。
   *
   * PAGE_ADVANCE 是有意例外：它没有任何可以"补记"的本地证据，旧环境里的
   * dispatch 结果也不可信。因此这里只做清理，绝不把"跳页意图"当成"跳页已成功"。
   * - same environment：由 settlePendingPageAdvance 用真实页面事实证明；
   * - fresh environment：由恢复流程在重新证明源页之后重新发出一次跳页。
   */
  async function settlePendingOperation(job, pending) {
    if (!pending) return job;
    if (pending.type === "LIST") return settlePendingListCapture(job, pending);
    if (pending.type === "PAGE_ADVANCE")
      return saveState(job, job.state, { currentOperation: null });
    if (pending.captureId && pending.rowKey)
      return settlePendingCapture(job, pending);
    if (pending.detailTabId) await releaseDetailTab(job, pending.detailTabId);
    return saveState(job, job.state, { currentOperation: null });
  }

  /**
   * 逐条处理详情：定位 → 打开 → 校验身份 → 留痕 → 返回 → 复核。
   * 页泛化：定位与返回复核都只认 normalize 后的当前页与当前页冻结集合，
   * 绝不读 legacy pageOneRowKeys（否则第 2 页会拿第 1 页的集合做复核）。
   */
  async function captureDetailRow(job, row) {
    const rowKey = buildRowKey(row);
    const normalized = normalizeAutomationJob(job);
    const pageNo = normalized.currentPage;
    const frozenKeys = normalized.pageFrozenKeys;
    const pending = job.currentOperation;
    // 防御：万一在“Capture 已成功但尚未补记进度”的窗口进入本条，先补记。
    if (pending?.captureId && pending.rowKey === rowKey)
      job = await settlePendingCapture(job, pending);
    if ((job.completedDetailKeys || []).includes(rowKey)) return job;
    job = await saveState(job, AUTOMATION_STATES.OPENING_DETAIL, {
      currentOperation: detailOperation(
        pageNo,
        row,
        AUTOMATION_PHASES.LOCATING,
      ),
    });
    const snapshot = await dependencies.readResultPage(job.tabId);
    const located = locateRowKey(snapshot, rowKey, pageNo);
    if (!located.ok) throw stop(job, located.error);
    job = await saveState(job, AUTOMATION_STATES.OPENING_DETAIL, {
      currentOperation: detailOperation(pageNo, row, AUTOMATION_PHASES.OPENING),
    });
    let opened;
    try {
      opened = await dependencies.openDetail(job.tabId, rowKey);
    } catch (error) {
      throw stop(job, messageOf(error));
    }
    if (!opened?.detailTabId) throw stop(job, "未能打开该条结果的详情标签页。");
    job = await saveState(job, AUTOMATION_STATES.OPENING_DETAIL, {
      currentOperation: {
        ...detailOperation(pageNo, row, AUTOMATION_PHASES.OPENING),
        detailTabId: opened.detailTabId,
      },
    });
    let observed;
    try {
      observed = await dependencies.readDetailIdentity(opened.detailTabId);
    } catch (error) {
      throw stop(job, messageOf(error));
    }
    const verified = evaluateDetailIdentity(row, observed);
    if (!verified.ok) throw stop(job, verified.error);
    job = await saveState(job, AUTOMATION_STATES.CAPTURING_DETAIL, {
      currentOperation: {
        ...detailOperation(pageNo, row, AUTOMATION_PHASES.CAPTURING),
        detailTabId: opened.detailTabId,
      },
    });
    let archived;
    try {
      archived = await dependencies.archiveQuery(
        job.queryId,
        opened.detailTabId,
      );
    } catch (error) {
      throw stop(job, messageOf(error));
    }
    if (!archived?.capture)
      throw stop(job, "详情留痕没有返回 Capture，自动核查已停止。");
    // Capture 一旦成功就立刻把 captureId 落盘：即使随后返回列表失败、
    // 或后台在此时中断，继续本次核查时也不会重复留痕这一条。
    job = await saveState(job, AUTOMATION_STATES.RETURNING_TO_LIST, {
      currentOperation: {
        ...detailOperation(pageNo, row, AUTOMATION_PHASES.RETURNING),
        detailTabId: opened.detailTabId,
        captureId: archived.capture.id,
      },
      detailCaptures: [
        ...(job.detailCaptures || []),
        {
          rowKey,
          caseNo: row.caseNo,
          name: row.name,
          captureId: archived.capture.id,
          captureNo: archived.capture.capture_no,
          filename: archived.filename,
        },
      ],
    });
    try {
      await dependencies.closeDetail(opened.detailTabId, job.tabId);
    } catch (error) {
      throw stop(job, messageOf(error));
    }
    job = await saveState(job, AUTOMATION_STATES.VERIFYING_LIST_STATE, {
      currentOperation: {
        ...detailOperation(pageNo, row, AUTOMATION_PHASES.VERIFYING),
        detailTabId: null,
        captureId: archived.capture.id,
      },
    });
    const afterReturn = await dependencies.readResultPage(job.tabId);
    const reconciled = reconcileRowKeys(frozenKeys, afterReturn, pageNo);
    if (!reconciled.ok) throw stop(job, reconciled.error);
    // 只有留痕成功且确认回到当前页之后，才记为已完成。
    return saveState(job, AUTOMATION_STATES.VERIFYING_LIST_STATE, {
      completedDetailKeys: [...(job.completedDetailKeys || []), rowKey],
      currentOperation: null,
    });
  }

  /**
   * deterministic 的 Page N → Page N+1 business transition（M8.2b Slice 3A / Slice 5 泛化）。
   *
   * 只推进一页：绝不循环、绝不自动重试，一次 transition 最多发出一次跳页动作。
   * 是否到达只由页面事实决定——重新读取真实快照并双信号核对，primitive 的返回值
   * 只表示“动作已发出”，从不被当作“已到达”。
   *
   * 目标页由 currentPage + 1 决定，因此它对任意 N 都成立，不需要任何页数上限。
   */
  async function advancePage(job) {
    // STEP 1 — 前置条件：任何一项不成立都不发出网站动作，也不写任何状态。
    const normalized = normalizeAutomationJob(job);
    const sourcePage = normalized.currentPage;
    const baseline = normalized.totalPages;
    if (
      typeof dependencies.jumpToPage !== "function" ||
      typeof dependencies.sleep !== "function"
    )
      throw stop(job, "缺少跳页动作依赖，未发出跳页动作。");
    const precondition = pageAdvancePreconditions(normalized);
    if (precondition) throw stop(job, precondition);
    const targetPage = sourcePage + 1;

    // STEP 2 — 先落盘“当前页已完成、准备离开”，再产生任何网站副作用。
    // 完成检查点与跳页 intent 必须在同一次原子写入里：只写一半的中间状态会同时违反
    // 冻结集合与 completedPages 的 invariant。它与“目标页已到达”严格分开落盘。
    job = await saveState(job, AUTOMATION_STATES.ADVANCING_PAGE, {
      error: null,
      errorCode: null,
      // legacy 第一页完成标记交由 completedPages 接管，避免两者互相矛盾。
      firstPageComplete: null,
      currentPage: sourcePage,
      totalPages: baseline,
      pageFrozenKeys: normalized.pageFrozenKeys,
      currentPageRows: normalized.currentPageRows,
      completedPages: pageCompleteSummary(
        job,
        normalized,
        sourcePage,
        dependencies.now().toISOString(),
      ),
      currentOperation: {
        type: "PAGE_ADVANCE",
        pageNo: sourcePage,
        targetPage,
        attempt: 1,
        phase: AUTOMATION_PHASES.LOCATING,
      },
    });

    // STEP 3 — 只发出一次动作。唯一的网站 dispatch 调用点在 dispatchJumpToPage。
    const dispatched = await dispatchJumpToPage(job.tabId, targetPage);
    if (!dispatched.ok) throw stop(job, dispatched.error);

    // STEP 4/5 — 只认页面事实；到期仍没有确定结论就 fail closed，绝不重发。
    const deadline = dependencies.now().getTime() + PAGE_ADVANCE_TIMEOUT_MS;
    for (;;) {
      // 读取失败必须与“请求仍在飞行”严格区分：飞行中的真实表现是源页快照（旧 DOM
      // 仍在，见 §26 A5 的 success callback 同步替换），而不是读取异常。异常可能来自
      // 标签页被关闭、evaluate 失败、页面结构异常或依赖错误，无法据此证明是验证失效，
      // 因此既不当 PENDING、也不猜成验证码问题，一律 fail closed 交人工，且绝不重发。
      let snapshot;
      try {
        snapshot = await dependencies.readResultPage(job.tabId);
      } catch (error) {
        throw await pauseWith(
          job,
          "PAGE_ADVANCE_READ_FAILED",
          `分页后无法确认结果页面状态，已暂停自动核查。（诊断：${messageOf(error)}）`,
        );
      }
      if (!snapshot?.ok)
        throw await pauseWith(
          job,
          "PAGE_ADVANCE_READ_FAILED",
          "分页后无法确认结果页面状态，已暂停自动核查。（诊断：未读到结果页快照。）",
        );
      const decision = settlePendingPageAdvance(job, snapshot);
      if (decision.outcome === "SETTLED")
        return freezeArrivedPage(job, {
          pageNo: targetPage,
          baseline,
          rows: decision.rows,
          keys: decision.keys,
          snapshot,
        });
      if (decision.outcome === "FAILED")
        throw await pauseWith(job, decision.code, decision.error);
      if (dependencies.now().getTime() >= deadline) {
        // 走到这里一定是“页面一直可读、但目标页始终没有出现”（验证失效与读取失败
        // 都已提前 fail closed），所以超时就是超时：不把“读不出结论”猜成验证码问题。
        throw await pauseWith(
          job,
          "PAGE_ADVANCE_TIMEOUT",
          `跳页后第 ${targetPage} 页在限定时间内没有出现，本次自动核查已暂停（不会再次发出跳页动作）。`,
        );
      }
      await dependencies.sleep(PAGE_ADVANCE_POLL_MS);
    }
  }

  /**
   * 唯一的跳页 dispatch 调用点（M8.2b Slice 4B）。
   *
   * business advance 的每一次 transition 与 fresh resume 的每一次 locating 都只经过
   * 这里，因此全文件只有一处 dependencies.jumpToPage：一次执行最多发出一处网站动作，
   * 结构上不存在“两个调用点导致多翻一页”的可能。
   *
   * 依赖缺失与动作抛出都只转成结果对象，由调用方按自己的 job 语义 fail closed：
   * 绝不在这里重试，也绝不把“没发出去”当成“已经发出去”。
   */
  async function dispatchJumpToPage(tabId, targetPage) {
    if (typeof dependencies.jumpToPage !== "function")
      return { ok: false, error: "缺少跳页动作依赖，未发出跳页动作。" };
    try {
      const dispatched = await dependencies.jumpToPage(tabId, targetPage);
      if (!dispatched?.ok)
        return { ok: false, error: dispatched?.error || "跳页动作未能发出。" };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /**
   * 页面事实已经证明首次到达第 pageNo 页：就地冻结该页并重置页内状态。
   *
   * 这是"首次到达这一页"的写入，因此必须把页内状态全部换成新页的：
   * 历史页 summary 保留，当前页 rows / keys / 已完成详情 / 留痕 / 操作全部重置。
   *
   * - 不触碰 pageOneRowKeys：第 1 页的边界指纹是 fresh resume 唯一的可比对身份，
   *   必须一直保持原样（D1）。
   * - 不产生任何网站动作，也不写 PAGE_ADVANCE intent。
   * - business advance 的到达分支与"跳页意图已落盘但页面已到目标页"共用这一份写入。
   *
   * 回到"已经处理过一部分的 checkpoint 页"不要用这里——那会把已完成进度清空并导致
   * 重复留痕，那种场景用 markResumePage。
   */
  async function freezeArrivedPage(
    job,
    { pageNo, baseline, rows, keys, snapshot },
  ) {
    return saveState(job, AUTOMATION_STATES.READING_RESULT_ROWS, {
      error: null,
      errorCode: null,
      currentPage: pageNo,
      totalPages: baseline,
      resultPage: {
        pageNo,
        totalPages: snapshot.page?.totalPages ?? null,
        totalSize: snapshot.page?.totalSize ?? null,
      },
      currentPageRows: rows,
      pageFrozenKeys: keys,
      expectedDetailCount: keys.length,
      completedDetailKeys: [],
      detailCaptures: [],
      listCapture: null,
      listFilename: null,
      currentOperation: null,
    });
  }

  /**
   * 回到"已经处理过一部分的 checkpoint 页"时的最小写入：只把"最近一次读取的结果页"
   * 更新为页面事实，页内进度（冻结集合、已完成详情、列表留痕、详情留痕）原样保留。
   *
   * 与 freezeArrivedPage 的区别就是这一点：任何重置都会让已完成的列表与详情再留痕一次。
   */
  async function markResumePage(job, pageNo, baseline, snapshot) {
    return saveState(job, AUTOMATION_STATES.READING_RESULT_ROWS, {
      error: null,
      errorCode: null,
      currentPage: pageNo,
      totalPages: baseline,
      resultPage: {
        pageNo,
        totalPages: snapshot.page?.totalPages ?? null,
        totalSize: snapshot.page?.totalSize ?? null,
      },
    });
  }

  /**
   * 当前页循环（页泛化）：列表尚未留痕则先留痕，再按冻结顺序处理该页未完成的详情。
   *
   * 每一页（第 1 页到第 N 页）都共用这一份实现，通用分页循环与「继续剩余分页核查」
   * 也复用它，因此已完成的列表与详情都不会重复。它只负责把**当前页**处理完，不决定
   * 本轮终态，也不决定是否翻页——那由 runPageRun / advancePage 决定。
   */
  async function runCurrentPageLoop(job, rows) {
    // 兜底：即使调用方漏了收尾，只要 currentOperation 带着成功的 captureId，
    // 就只补记 listCapture，绝不重新 Capture 列表。
    if (
      !job.listCapture &&
      job.currentOperation?.type === "LIST" &&
      job.currentOperation.captureId
    )
      job = await settlePendingListCapture(job, job.currentOperation);
    if (!job.listCapture) {
      job = await captureListPage(job);
      job = await verifyListState(
        job,
        normalizeAutomationJob(job).pageFrozenKeys,
      );
    }
    for (const row of rows) job = await captureDetailRow(job, row);
    return job;
  }

  /**
   * 全新的核查：读取并冻结第 1 页目标集合，然后交给通用分页循环
   * （第 1 页 → … → 第 N 页 → DONE）。
   */
  async function captureCurrentPage(job) {
    job = await saveState(job, AUTOMATION_STATES.READING_RESULT_ROWS, {
      result: AUTOMATION_RESULT.HAS_RESULT,
      error: null,
      currentOperation: listOperation(
        FIRST_PAGE_NO,
        AUTOMATION_PHASES.LOCATING,
      ),
    });
    const snapshot = await dependencies.readResultPage(job.tabId);
    const frozen = freezePageRows(snapshot, FIRST_PAGE_NO);
    if (!frozen.ok) throw stop(job, frozen.error);
    job = await saveState(job, AUTOMATION_STATES.READING_RESULT_ROWS, {
      // 页模型与 legacy 字段同时写：全新核查必然在第 1 页，legacy 字段不撒谎，
      // 而「继续剩余分页核查」的判定仍然依赖 pageOneRowKeys。
      currentPage: FIRST_PAGE_NO,
      totalPages: snapshot.page?.totalPages ?? null,
      resultPage: {
        pageNo: FIRST_PAGE_NO,
        totalPages: snapshot.page?.totalPages ?? null,
        totalSize: snapshot.page?.totalSize ?? null,
      },
      pageFrozenKeys: frozen.keys,
      currentPageRows: frozen.rows,
      pageOneRowKeys: frozen.keys,
      expectedDetailCount: frozen.rows.length,
      completedDetailKeys: [],
      detailCaptures: [],
      listCapture: null,
      listFilename: null,
      currentOperation: null,
    });
    return runPageRun(job, frozen.rows);
  }

  /**
   * 通用分页执行（M8.2b Slice 5）：唯一的 generic page loop。
   *
   * 语义（每个迭代严格一次）：
   *   run current page completely
   *   → 已是最后一页？收尾成 DONE
   *   → 否则发出**恰好一次** business advance，冻结目标页，再处理紧接的下一结果页
   *
   * 刻意没有的东西：页数上限、`maxPagesThisRun` 之类的运行期计数器、"本轮只跑两页"的
   * 阶段常量、行数 / 分页按钮状态推断末页的启发式、任何自动重试与递归分页。
   * 是否还有后续页只由页面自报的 totalPages baseline 决定；每一页只有在
   * pageCompleteness 成立之后才会被离开（由 advancePage 的前置条件强制）。
   *
   * 控制流里只有一个 advancePage 调用点，因此一次执行不可能在同一处翻两次页。
   */
  async function runPageRun(job, rows) {
    job = await runCurrentPageLoop(job, rows);
    for (;;) {
      const current = normalizeAutomationJob(job);
      // 页数未知时既不能证明"还有后续页"，也不能证明"已到最后一页"，只能 fail closed。
      if (!Number.isInteger(current.totalPages) || current.totalPages < 1)
        throw stop(
          job,
          "结果总页数尚未建立 baseline，无法确认本站是否还有后续页。",
        );
      if (current.currentPage >= current.totalPages) return finishPageRun(job);
      // 唯一的 Page N → Page N+1 business transition：advancePage 内部只发一次跳页动作、
      // 绝不重试、绝不循环，并且自己重新证明源页完整后才允许离开。
      job = await advancePage(job);
      job = await runCurrentPageLoop(
        job,
        normalizeAutomationJob(job).currentPageRows,
      );
    }
  }

  /**
   * 一轮执行的唯一成功终态：DONE（M8.2b Slice 5 统一）。
   *
   * 只有三条同时成立才写 DONE：当前页就是最后一页、当前页自身完整、completedPages
   * 连续覆盖 1..totalPages（后者的严格连续性由 invariant 强制）。**绝不**用间接信号
   * 判断末页——行数不足、分页按钮被禁用、下一个结果页为空都不在判据里。
   *
   * 当前页的完成检查点与终态必须在**同一次写入**里落盘：只写一半的中间状态会同时
   * 违反冻结集合与 completedPages 的 invariant（页内态不允许当前页已完成）。
   *
   * totalPages = 1 的单页站点同样收尾成 DONE，不再写 M8.2a 的 FIRST_PAGE_COMPLETE：
   * 那个状态只保留读取兼容，新流程不再产生。PARTIAL_COMPLETE 同理。
   */
  async function finishPageRun(job) {
    const normalized = normalizeAutomationJob(job);
    const currentPage = normalized.currentPage;
    const totalPages = normalized.totalPages;
    const complete = pageCompleteness(job, currentPage);
    if (!complete.ok) throw stop(job, complete.reason);
    if (!Number.isInteger(totalPages) || totalPages < 1)
      throw stop(
        job,
        "结果总页数尚未建立 baseline，无法确认本站是否还有后续页。",
      );
    if (currentPage !== totalPages)
      throw stop(
        job,
        `第 ${currentPage} 页已处理完，但网站仍自报共 ${totalPages} 页，未按完成收尾（不会跳过任何后续页）。`,
      );
    const completedPages = pageCompleteSummary(
      job,
      normalized,
      currentPage,
      dependencies.now().toISOString(),
    );
    return saveState(job, AUTOMATION_STATES.DONE, {
      currentOperation: null,
      error: null,
      errorCode: null,
      firstPageComplete: null,
      currentPage,
      totalPages,
      completedPages,
    });
  }

  /** 只读一页快照：读取失败按"读不到"处理，由调用方 fail closed。 */
  async function readPageOrNull(tabId) {
    try {
      const snapshot = await dependencies.readResultPage(tabId);
      return snapshot?.ok === true ? snapshot : null;
    } catch {
      return null;
    }
  }

  /**
   * 页面能否证明它仍然是某一个已知的结果页（same environment 的最小判据）。
   *
   * 只认页坐标与结果总页数。**有意不使用** resultVisible / pagerVisible /
   * rows.length：真人在"验证已失效"时观察到 resultVisible=true（旧结果仍在 DOM 里），
   * 因此它们不能作为环境可信的判据；结果集身份的一致性由 reconcileFrozenSet 负责。
   */
  function pageFactsMatch(snapshot, pageNo, baseline) {
    const page = snapshot?.page || {};
    return (
      page.input === pageNo &&
      page.shown === pageNo &&
      page.totalPages === baseline
    );
  }

  /**
   * fresh resume 的第 1 页证明（M8.2b Slice 4B，Slice 5 保持严格不变）。
   *
   * 三条都必须成立，任何一条不成立都 fail closed：
   * 1. 页面坐标严格是第 1 页；
   * 2. 页面自报总页数等于 persisted baseline（增 / 减 / 缺失都不接受，
   *    **绝不**接受新的 baseline）；
   * 3. 第 1 页结果集合必须与 pageOneRowKeys 完全一致（boundary fingerprint）。
   *
   * pageOneRowKeys 在这里只被当作第 1 页的 boundary 指纹消费：它不参与第 2..N 页的
   * 列表留痕、详情进度或冻结集合判定，也绝不因为页面变化而被改写。第 2..N 页的历史
   * rowKeys 有意**不**持久化（D1）：接受"已完成过的中间页无法被重新验证"这一残余风险，
   * 换取不写入任何历史页行键。
   */
  function proveFirstPage(job, snapshot) {
    const baseline = normalizeAutomationJob(job).totalPages;
    if (!Number.isInteger(baseline) || baseline < 1)
      return {
        ok: false,
        code: "RESUME_BOUNDARY_MISSING",
        reason:
          "本次核查没有可用的结果总页数 baseline，无法确认结果集未发生变化。",
      };
    const page = snapshot?.page || {};
    if (page.input !== FIRST_PAGE_NO || page.shown !== FIRST_PAGE_NO)
      return {
        ok: false,
        code: "RESUME_PAGE_MISMATCH",
        reason: `页面不是结果第 ${FIRST_PAGE_NO} 页（页面显示第 ${page.shown ?? "未知"} 页），无法安全恢复本次核查。`,
      };
    if (page.totalPages !== baseline)
      return {
        ok: false,
        code: "TOTAL_PAGES_CHANGED",
        reason: `结果总页数已从 ${baseline} 变为 ${page.totalPages ?? "未知"}，本次核查的检查点已经失效，请人工核对后重新核查。`,
      };
    const fingerprint = Array.isArray(job.pageOneRowKeys)
      ? job.pageOneRowKeys
      : null;
    if (!fingerprint || !fingerprint.length)
      return {
        ok: false,
        code: "RESUME_BOUNDARY_MISSING",
        reason: "本次核查缺少第 1 页的结果边界记录，无法确认结果集未发生变化。",
      };
    const reconciled = reconcileFrozenSet(fingerprint, snapshot, FIRST_PAGE_NO);
    if (!reconciled.ok)
      return {
        ok: false,
        code: "RESUME_BOUNDARY_CHANGED",
        reason: reconciled.error,
      };
    return { ok: true, rows: reconciled.rows };
  }

  /**
   * 把页面定位到 checkpoint 页（fresh resume 专用，M8.2b Slice 5）。
   *
   * 前置：已经用 proveFirstPage 在重建出来的第 1 页上确认了 baseline 与边界指纹。
   *
   * locate jump 与 business advance 严格不同：
   * - **不写** PAGE_ADVANCE intent、不改 completedPages、不产生任何 Capture、
   *   也不改 persisted 的 currentPage：它只回答"页面现在停在第几页"；
   * - 只在页面确实不在目标页时才发出**恰好一次**跳页动作，绝不重试；
   * - 到达判定与 same-environment settle 共用 classifyPageArrival，因此"页面明确落在
   *   别的页"与"结果总页数已经变化"走同一套 fail closed，而不是自己再造一套规则。
   *
   * 定位途中崩溃不需要任何补偿记录：下一次 fresh resume 会重新从第 1 页开始定位。
   */
  async function locateToCheckpoint(job, observed, targetPage, baseline) {
    if (pageFactsMatch(observed, targetPage, baseline)) return observed;
    if (
      typeof dependencies.jumpToPage !== "function" ||
      typeof dependencies.sleep !== "function"
    )
      throw stop(job, "缺少跳页动作依赖，未发出跳页动作。");
    // 定位的源页就是"页面当前真正停在哪一页"：它只是判定"是否还在飞行中"的参照，
    // 不是任何业务进度，因此不进 persisted 状态。
    const sourcePage = Number.isInteger(observed?.page?.shown)
      ? observed.page.shown
      : FIRST_PAGE_NO;
    const dispatched = await dispatchJumpToPage(job.tabId, targetPage);
    if (!dispatched.ok) throw stop(job, dispatched.error);

    const deadline = dependencies.now().getTime() + PAGE_ADVANCE_TIMEOUT_MS;
    const maxPolls = boundedPolls(
      PAGE_ADVANCE_TIMEOUT_MS,
      PAGE_ADVANCE_POLL_MS,
    );
    for (let poll = 0; ; poll += 1) {
      const snapshot = await readPageOrNull(job.tabId);
      if (!snapshot)
        throw await pauseWith(
          job,
          "RESUME_PAGE_UNREADABLE",
          "定位检查点分页时无法读取结果页面，已暂停自动核查。",
        );
      if (pageFactsMatch(snapshot, targetPage, baseline)) return snapshot;
      const decision = classifyPageArrival(snapshot, {
        sourcePage,
        targetPage,
        baseline,
      });
      if (decision.outcome === "FAILED")
        throw await pauseWith(job, decision.code, decision.error);
      if (poll + 1 >= maxPolls || dependencies.now().getTime() >= deadline)
        throw await pauseWith(
          job,
          "PAGE_ADVANCE_TIMEOUT",
          `定位第 ${targetPage} 页时页面在限定时间内没有出现，本次自动核查已暂停（不会再次发出跳页动作）。`,
        );
      await dependencies.sleep(PAGE_ADVANCE_POLL_MS);
    }
  }

  /**
   * 恢复已有 checkpoint 的本次核查（M8.2b Slice 4B，Slice 5 泛化到任意页）。
   *
   * 调用方已经保证：环境已重建、人工验证已完成、result === HAS_RESULT，
   * 且 target 来自 deriveResumeTarget —— 目标恒为 persisted 的 currentPage。
   *
   * 三条路径严格分开，且全部只以页面事实为准：
   * - **same environment**（第 1 页除外）：页面自己证明它仍然是 persisted 的当前页
   *   （页坐标 + baseline + 已冻结集合全部一致）时，才允许在原环境上就继续，不重建、
   *   不重发跳页。第 1 页不走这条快路径：它一律重新做边界证明，避免绕过 boundary 指纹。
   * - **pending PAGE_ADVANCE**：注册表里还留着"源页已完成、准备离开"的意图，但页坐标
   *   仍停在源页。旧环境里的 dispatch 结果不可信，因此只认页面事实：真的到了目标页就
   *   就地冻结并继续；否则落回 fresh 路径，重新证明源页后重新发出一次 business transition。
   * - **fresh environment**：重建环境后页面必然回到第 1 页，因此先证明第 1 页
   *   （baseline 不变 + 边界指纹严格对账），再定位到 checkpoint 页并与它已冻结的集合
   *   严格对账；对账通过后页内进度原样保留（已完成的列表与详情绝不重复留痕），
   *   最后交给通用分页循环跑到最后一页。
   *
   * 目标页之前的每一页都**不需要**重新证明：它们的历史证据已经在 DB 里，页级
   * checkpoint 只回答"这一页是否已经完整处理过"。
   *
   * 任何关键事实不能证明都 fail closed：不猜页、不重写 fingerprint、不重复留痕。
   */
  async function resumeCheckpoint(job, target) {
    const persisted = normalizeAutomationJob(job);
    const baseline = persisted.totalPages;
    const targetPage = target.targetPage;
    const pending = job.currentOperation || null;

    // same environment 快路径：页面自己证明它仍然是 persisted 的当前页。
    // 第 1 页例外——它必须走下面的边界证明，绝不因为"页面正好在第 1 页"就跳过。
    if (targetPage !== FIRST_PAGE_NO) {
      const same = await readPageOrNull(job.tabId);
      if (same && pageFactsMatch(same, targetPage, baseline)) {
        const reconciled = reconcileFrozenSet(
          persisted.pageFrozenKeys,
          same,
          targetPage,
        );
        if (!reconciled.ok)
          throw await pauseWith(
            job,
            "RESUME_FROZEN_SET_CHANGED",
            reconciled.error,
          );
        // 这里刻意不清空 currentOperation：先把上一轮已经成功的留痕补记完，
        // 否则会在"补记"之前多出一个新的中断窗口，反而可能重复留痕。
        job = await settlePendingOperation(job, pending);
        return runPageRun(job, reconciled.rows);
      }
    }

    // 上一轮已经落盘"源页已完成、准备离开这一页"的意图，但记录里的页坐标仍停在源页。
    // 旧环境里的 dispatch 结果不可信，因此这里只接受一种页面事实：**页面真的已经在
    // 目标页**——那说明意图其实已经生效，就地冻结并继续，绝不重发动作。
    //
    // 页面停在源页或其它任何一页都不在这里下结论：它可能只是环境已经被重建（重建后
    // 页面必然回到第 1 页）。那时一律落回下面的 fresh 路径重新证明源页，再重新发出
    // 一次 business transition——这同时保证"环境不同就绝不拿旧 dispatch 的结果当事实"。
    const pendingTurn =
      pending?.type === "PAGE_ADVANCE" &&
      Number.isInteger(pending.targetPage) &&
      pending.targetPage === pending.pageNo + 1
        ? pending
        : null;
    if (pendingTurn) {
      const arrived = await readPageOrNull(job.tabId);
      if (arrived) {
        const decision = classifyPageArrival(arrived, {
          sourcePage: pendingTurn.pageNo,
          targetPage: pendingTurn.targetPage,
          baseline,
        });
        if (decision.outcome === "SETTLED") {
          job = await freezeArrivedPage(job, {
            pageNo: pendingTurn.targetPage,
            baseline,
            rows: decision.rows,
            keys: decision.keys,
            snapshot: arrived,
          });
          return runPageRun(job, decision.rows);
        }
      }
    }

    // fresh environment：必须在第 1 页上重新建立可信 checkpoint。
    const firstSnapshot = await readPageOrNull(job.tabId);
    if (!firstSnapshot)
      throw await pauseWith(
        job,
        "RESUME_PAGE_UNREADABLE",
        "无法读取综合查询结果页面，无法确认本次核查停在哪一页，已暂停自动核查。",
      );
    const proof = proveFirstPage(job, firstSnapshot);
    if (!proof.ok) throw await pauseWith(job, proof.code, proof.reason);

    const located = await locateToCheckpoint(
      job,
      firstSnapshot,
      targetPage,
      baseline,
    );
    const reconciled = reconcileFrozenSet(
      persisted.pageFrozenKeys,
      located,
      targetPage,
    );
    if (!reconciled.ok)
      throw await pauseWith(job, "RESUME_FROZEN_SET_CHANGED", reconciled.error);
    // 只更新"最近一次读取的结果页"：页内进度（已完成详情、列表留痕、详情留痕）
    // 原样保留，否则恢复会重复留痕这一页已经生成过的证据。
    job = await markResumePage(job, targetPage, baseline, located);
    job = await settlePendingOperation(job, pending);
    return runPageRun(job, reconciled.rows);
  }

  async function continueAfterVerification({ taskId }) {
    let job = await dependencies.getJob();
    if (!job || job.adapter !== ZXGK_EXECUTION_ADAPTER)
      throw new Error("没有可继续的自动核查任务。");
    try {
      const invariant = validateZxgkAutomationJobInvariant(job);
      if (!invariant.ok)
        throw new Error(`${AUTOMATION_JOB_INVALID_MESSAGE}（${invariant.code}）`);
      if (!canRecheckAutomation(job))
        throw new Error("当前自动核查状态不能继续检查结果。");
      if (taskId !== job.taskId)
        throw new Error("当前选择的 Task 已变化，本次自动核查已停止。");
      const task = await dependencies.getTask(job.taskId);
      if (!sameTaskContext(task, job))
        throw new Error("Task 内容或归属已经变化，本次自动核查已停止。");
      // 恢复目标必须在任何 saveState 之前确定：写入会改变 state，而
      // deriveResumeTarget 只读页模型（没有 checkpoint 时它也只返回 ok:false）。
      const target = deriveResumeTarget(job);
      const tab = await dependencies.getTab(job.tabId);
      // 标签页丢失 / 已经离开查询页时绝不猜页：交回「继续剩余分页核查」重建页面。
      if (!tab || !isZxgkExecutionPage(tab.url))
        throw new Error(
          "自动核查标签页已关闭或已离开综合查询页面，请使用「继续剩余分页核查」重新建立页面。",
        );
      // Phase B（Slice 4B 修正 1）：用户已经点击「验证完成，继续」，因此此刻页面上的
      // 失效文案才是"本次人工验证没有被网站接受"的证据。Phase A 里同样的文案可能只是
      // 上一轮验证留下的陈旧状态，所以判定必须放在这里、而不是观察阶段。
      // 读不到事实时不做任何推断：交给下面的结果判定按既有语义处理。
      try {
        const rejected = classifyVerificationAvailability(
          await dependencies.readVerificationAvailability(job.tabId),
        );
        if (rejected.outcome === ZXGK_VERIFICATION_OUTCOMES.REJECTED_OR_EXPIRED)
          return saveState(job, AUTOMATION_STATES.PAUSED, {
            errorCode: "VERIFICATION_REQUIRED",
            error:
              "页面提示安全验证已失效，本次人工验证没有被网站接受。请在页面上重新完成安全验证，再点击「验证完成，继续」。",
          });
      } catch {
        // 读失败不是"验证失败"的证据，继续走原有的结果判定。
      }
      job = await saveState(job, AUTOMATION_STATES.CHECKING_RESULT);
      const result = await dependencies.inspectResult(job.tabId, tab.url);
      if (result === AUTOMATION_RESULT.UNKNOWN)
        return saveState(job, AUTOMATION_STATES.PAUSED, {
          result,
          error:
            "当前页面尚未呈现可确认的无结果提示或结果表格。请检查页面后重试，或返回手工模式。",
        });
      job = await saveState(job, AUTOMATION_STATES.CHECKING_RESULT, {
        result,
        error: null,
      });
      job = await ensureQuery(job);
      if (result === AUTOMATION_RESULT.HAS_RESULT) {
        // 有 checkpoint = 继续剩余分页核查（复用原 Query 与已完成的留痕）；
        // 否则才是全新的核查（第 1 页 → 第 2 页）。
        return target.ok
          ? await resumeCheckpoint(job, target)
          : await captureCurrentPage(job);
      }
      job = await saveState(job, AUTOMATION_STATES.CAPTURING_NO_RESULT);
      const captureTab = await dependencies.getTab(job.tabId);
      if (!captureTab || !isZxgkExecutionPage(captureTab.url))
        throw new Error("留痕前查询结果页面已关闭或发生跳转，未生成 Capture。");
      const archived = await dependencies.archiveQuery(job.queryId, job.tabId);
      return saveState(job, AUTOMATION_STATES.DONE, {
        capture: archived.capture,
        filename: archived.filename,
      });
    } catch (error) {
      return fail(error.job || job, error);
    }
  }

  return { start, resume, continueAfterVerification, advancePage };
}
