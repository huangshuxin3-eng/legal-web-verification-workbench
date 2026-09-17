export const AUTOMATION_STATES = Object.freeze({
  IDLE: "IDLE",
  OPENING_QUERY_PAGE: "OPENING_QUERY_PAGE",
  FILLING_ENTITY: "FILLING_ENTITY",
  SUBMITTING_QUERY: "SUBMITTING_QUERY",
  WAITING_HUMAN_VERIFICATION: "WAITING_HUMAN_VERIFICATION",
  CHECKING_RESULT: "CHECKING_RESULT",
  CREATING_QUERY: "CREATING_QUERY",
  CAPTURING_NO_RESULT: "CAPTURING_NO_RESULT",
  HAS_RESULT_UNSUPPORTED: "HAS_RESULT_UNSUPPORTED",
  CAPTURING_LIST_PAGE: "CAPTURING_LIST_PAGE",
  READING_RESULT_ROWS: "READING_RESULT_ROWS",
  OPENING_DETAIL: "OPENING_DETAIL",
  CAPTURING_DETAIL: "CAPTURING_DETAIL",
  RETURNING_TO_LIST: "RETURNING_TO_LIST",
  VERIFYING_LIST_STATE: "VERIFYING_LIST_STATE",
  ADVANCING_PAGE: "ADVANCING_PAGE",
  FIRST_PAGE_COMPLETE: "FIRST_PAGE_COMPLETE",
  PARTIAL_COMPLETE: "PARTIAL_COMPLETE",
  PAUSED: "PAUSED",
  FAILED: "FAILED",
  DONE: "DONE",
});

/**
 * 稳定 checkpoint 态：PARTIAL_COMPLETE（M8.2b Slice 3B 引入，Slice 5 重新定义）。
 *
 * 语义（Slice 5 起）：已经有连续完整前缀 1..K，但网站仍有剩余页的**稳定 checkpoint**。
 * 它是**正常结束**：不是错误、不是运行中，也是一个已结算态——后台重启时不会像中断
 * 状态那样被改写成 FAILED；同时它是可以「继续剩余分页核查」的检查点。
 *
 * Slice 5 的通用分页引擎会把一次核查一直推进到最后一页并写成 DONE，因此**新的核查
 * 不再产生 PARTIAL_COMPLETE**；这个状态只作为旧版本遗留的检查点保留读取兼容。
 * 名字里只描述"处理到什么程度"，绝不写开发阶段或具体页数。
 *
 * FIRST_PAGE_COMPLETE 继续作为 M8.2a 的 legacy 终止态保留读取兼容；Slice 5 起新的
 * 成功路径统一写成 DONE（包括 totalPages = 1 的情况），新产品路径不再产生它。
 */

/**
 * 页模型的最小页号。
 *
 * M8.2a 的持久化 job 没有页坐标（它只有一个当前页），读取时按第 1 页处理。
 */
export const FIRST_PAGE_NO = 1;

/** 当前正在处理什么，只用于进度显示与诊断，不影响状态机流转。 */
export const AUTOMATION_PHASES = Object.freeze({
  LOCATING: "LOCATING",
  OPENING: "OPENING",
  CAPTURING: "CAPTURING",
  RETURNING: "RETURNING",
  VERIFYING: "VERIFYING",
});

export const AUTOMATION_RESULT = Object.freeze({
  NO_RESULT: "NO_RESULT",
  HAS_RESULT: "HAS_RESULT",
  UNKNOWN: "UNKNOWN",
});

/**
 * 运行中的状态：后台正在执行页面操作或留痕，不允许再次发起自动核查。
 * WAITING_HUMAN_VERIFICATION 也算运行中：这一轮还没有结束。
 */
export const AUTOMATION_RUNNING_STATES = Object.freeze([
  AUTOMATION_STATES.OPENING_QUERY_PAGE,
  AUTOMATION_STATES.FILLING_ENTITY,
  AUTOMATION_STATES.SUBMITTING_QUERY,
  AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  AUTOMATION_STATES.CHECKING_RESULT,
  AUTOMATION_STATES.CREATING_QUERY,
  AUTOMATION_STATES.CAPTURING_NO_RESULT,
  AUTOMATION_STATES.CAPTURING_LIST_PAGE,
  AUTOMATION_STATES.READING_RESULT_ROWS,
  AUTOMATION_STATES.OPENING_DETAIL,
  AUTOMATION_STATES.CAPTURING_DETAIL,
  AUTOMATION_STATES.RETURNING_TO_LIST,
  AUTOMATION_STATES.VERIFYING_LIST_STATE,
  AUTOMATION_STATES.ADVANCING_PAGE,
]);

/**
 * 后台中断后无法确认上一步结果的状态。WAITING_HUMAN_VERIFICATION 是正常的
 * 人工等待态，可以停留在本地存储里，因此不在其中。
 */
export const AUTOMATION_INTERRUPTED_STATES = Object.freeze(
  AUTOMATION_RUNNING_STATES.filter(
    (state) => state !== AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
  ),
);

export function isAutomationRunning(job) {
  return AUTOMATION_RUNNING_STATES.includes(job?.state);
}

export function canRecheckAutomation(job) {
  return (
    job?.state === AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION ||
    (job?.state === AUTOMATION_STATES.PAUSED &&
      job?.result === AUTOMATION_RESULT.UNKNOWN)
  );
}

/**
 * PARTIAL_COMPLETE 有意不在其中：它的正确动作是「继续剩余分页核查」（复用原 Query、
 * 跳过已完成的列表与详情），而重新启动实际上会从第 1 页重新产生一整套 Capture，
 * 很容易被误解成「继续剩余分页」。因此部分完成时只提供继续入口，不提供重新自动核查。
 */
export function canStartNewAutomation(job) {
  return (
    !job ||
    [
      AUTOMATION_STATES.DONE,
      AUTOMATION_STATES.FAILED,
      AUTOMATION_STATES.HAS_RESULT_UNSUPPORTED,
      AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
    ].includes(job.state)
  );
}

/**
 * checkpoint identity 已经失效的错误码：这些状态下再「继续本次核查」只会重复同一个
 * 失败（结果集或页数已经变了），因此必须 fail closed 到手工模式，而不是给用户一个
 * 必然失败的动作。临时性故障（读不到页面、跳页超时、验证组件未就绪）不在其中。
 */
export const AUTOMATION_CHECKPOINT_INVALID_CODES = Object.freeze([
  "TOTAL_PAGES_CHANGED",
  "RESUME_PAGE_MISMATCH",
  "RESUME_BOUNDARY_MISSING",
  "RESUME_BOUNDARY_CHANGED",
  "RESUME_FROZEN_SET_CHANGED",
  "ADVANCE_WRONG_PAGE",
  "ADVANCE_ROWS_INVALID",
]);

/**
 * 纯推导：未完成核查应该回到第几页。
 *
 * 只读 normalizeAutomationJob 的兼容视图，不 mutate、不读写 storage、不发网络请求，
 * 也刻意不看 automation state（调用方在任何 saveState 之前调用它）。
 *
 * Slice 5 起不再有"只支持第 1 / 第 2 页"的两页边界。目标页恒为 persisted 的
 * **currentPage**：它正是已经冻结过结果集合的那一页，"回到第几页"这件事本身不需要
 * 任何推导。这里绝不推导 currentPage + 1：跳过对源页的重新证明会让通用引擎在未确认
 * 源页完整的情况下往后翻页，而"源页完整"必须由通用引擎在页面上重新证明。
 *
 * 可恢复的 checkpoint 必须同时具备：
 * - 合法的页坐标：currentPage >= 1，且不越界；totalPages 允许缺失（M8.2a 的 legacy
 *   job 没有页数），但一旦存在就必须是合法值；
 * - 当前页已经冻结过结果集合：没有它就无从对照结果集身份；
 * - completedPages 要么停在 currentPage - 1（当前页正在处理中），要么已经覆盖到
 *   currentPage（当前页已完整处理、只差一次 business advance）。严格连续由 invariant
 *   保证，这里仍然只读地复核一遍：状态层的失败必须是 fail closed，而不是猜。
 *
 * 任何一条不成立都返回 ok:false，交人工；不修复数据、不猜页。
 */
export function deriveResumeTarget(job) {
  const normalized = normalizeAutomationJob(job);
  if (!normalized || typeof normalized !== "object")
    return { ok: false, reason: "没有可继续的自动核查进度。" };
  const { currentPage, totalPages } = normalized;
  const keys = Array.isArray(normalized.pageFrozenKeys)
    ? normalized.pageFrozenKeys
    : [];
  const pages = Array.isArray(normalized.completedPages)
    ? normalized.completedPages
    : [];

  if (totalPages != null && (!Number.isInteger(totalPages) || totalPages < 1))
    return {
      ok: false,
      reason: "结果总页数不是合法值，无法确认恢复目标。",
    };
  if (!Number.isInteger(currentPage) || currentPage < 1)
    return {
      ok: false,
      reason: "本次核查没有可用的当前页坐标，无法确认恢复目标。",
    };
  if (totalPages != null && currentPage > totalPages)
    return { ok: false, reason: "当前页坐标已经越界，无法确认恢复目标。" };
  if (!keys.length)
    return {
      ok: false,
      reason: `第 ${currentPage} 页还没有冻结的结果集合，无法安全恢复。`,
    };
  if (pages.some((item, index) => item?.pageNo !== index + 1))
    return {
      ok: false,
      reason: "已完成页记录不是从第 1 页起的连续前缀，无法安全恢复。",
    };
  if (pages.length !== currentPage - 1 && pages.length !== currentPage)
    return {
      ok: false,
      reason: `第 ${currentPage} 页的完成记录与页坐标不一致，无法安全恢复。`,
    };

  return { ok: true, targetPage: currentPage };
}

/**
 * 未完成的核查是否还有可继续的进度。
 *
 * 与 canStartNewAutomation 的区别是语义：这里有 checkpoint，正确动作是
 * 「继续剩余分页核查」（复用原 Query、跳过已完成的列表与详情；非第 1 页的 checkpoint
 * 则先重建查询环境并重新完成人工验证，再定位回该页），而不是从第 1 条重新开始。
 *
 * 以下都不提供「继续剩余分页核查」：
 * - 不在 PAUSED / FAILED / PARTIAL_COMPLETE（运行中与 DONE 都没有可继续的动作）；
 * - 没有结果（NO_RESULT / UNKNOWN 没有页级 checkpoint）；
 * - 缺少 queryId；
 * - 页模型不足以推导恢复目标；
 * - checkpoint identity 已经失效（结果集 / 页数已经变化）：此时 resume 必然重复
 *   同一个失败，必须交人工。
 *
 * PARTIAL_COMPLETE 只在 legacy checkpoint 的范围内被接受：Slice 5 起新的核查一律推进
 * 到最后并写成 DONE，因此它只可能来自旧版本，而它的语义正是"连续完整前缀 1..K 已处理完、
 * 仍有剩余页"——「继续剩余分页核查」对它是正确的动作。它仍然不属于 canStartNewAutomation。
 */
export function canResumeAutomation(job) {
  if (
    ![
      AUTOMATION_STATES.PAUSED,
      AUTOMATION_STATES.FAILED,
      AUTOMATION_STATES.PARTIAL_COMPLETE,
    ].includes(job?.state)
  )
    return false;
  if (AUTOMATION_CHECKPOINT_INVALID_CODES.includes(job?.errorCode))
    return false;
  if (job?.result !== AUTOMATION_RESULT.HAS_RESULT) return false;
  if (!String(job?.queryId || "").trim()) return false;
  return deriveResumeTarget(job).ok;
}

/**
 * 结果列表的留痕是否已经真实生成。
 *
 * Capture 一旦 finalize 成功，成功标记（currentOperation.captureId）会先于
 * 收尾字段 listCapture 落盘，两者之间存在极窄的中断窗口。把两者都算作
 * “已留痕”，进度显示才不会在恢复前谎报“待留痕”，也不会诱导重复留痕。
 */
export function hasListCapture(job) {
  return Boolean(
    job?.listCapture ||
    (job?.currentOperation?.type === "LIST" && job.currentOperation.captureId),
  );
}

/**
 * 持久化 automationJob 的页模型兼容视图（read-time，不是 migration）。
 *
 * 纯函数：不修改输入、不读写 storage、不发起网络 / Query / Capture 操作，
 * 也不修复自相矛盾的数据（非法值原样透传，交给 invariant 判定）。
 *
 * M8.2a 的 pageOneRows / pageOneRowKeys / firstPageComplete 继续按原样保留，
 * 这里只把它们映射为页坐标的等价字段。旧数据不会被静默改写，也不做
 * getJob() → normalize → saveState() 这类自动写回。
 *
 * 派生规则（只使用已经存在的事实，绝不猜）：
 * - currentPage：仅当 job 没有页坐标、但已经冻结过当前页时派生为第 1 页；
 * - totalPages：firstPageComplete.totalPages → resultPage.totalPages，都没有则 null；
 * - pageFrozenKeys / currentPageRows：新字段缺失时分别取 pageOneRowKeys /
 *   pageOneRows。这里比 currentPage 宽松一档：即使 job 已经带 currentPage
 *   （半迁移数据），冻结集合也必须有输入，否则冻结集合 invariant 会被静默跳过；
 * - completedPages：只有存在明确的完成摘要时才算该页已完成，仅冻结结果集不算。
 *
 * 只按“字段不存在（undefined）”派生：显式写入的 null 视为已经被清空，
 * 不会被 legacy 字段覆盖，避免把上一页的冻结集合当成当前页。
 */
export function normalizeAutomationJob(job) {
  if (!job || typeof job !== "object") return job;
  const normalized = { ...job };
  const legacyKeys = Array.isArray(job.pageOneRowKeys)
    ? [...job.pageOneRowKeys]
    : undefined;
  const legacyRows = Array.isArray(job.pageOneRows)
    ? [...job.pageOneRows]
    : undefined;

  if (job.currentPage === undefined && legacyKeys)
    normalized.currentPage = FIRST_PAGE_NO;
  if (job.totalPages === undefined)
    normalized.totalPages =
      job.firstPageComplete?.totalPages ?? job.resultPage?.totalPages ?? null;
  if (job.pageFrozenKeys === undefined && legacyKeys)
    normalized.pageFrozenKeys = legacyKeys;
  if (job.currentPageRows === undefined && legacyRows)
    normalized.currentPageRows = legacyRows;
  if (job.completedPages === undefined)
    normalized.completedPages = deriveCompletedPages(job);

  return normalized;
}

/**
 * 历史页只保留最小 completion summary。
 *
 * 有意不保存历史页的 rows / rowKeys / detailCaptures：Capture DB 负责证据
 * 持久化，页级 checkpoint 只回答“这一页是否已经完整处理过”。
 */
function deriveCompletedPages(job) {
  const summary = job.firstPageComplete;
  if (!summary) return [];
  return [
    {
      pageNo: Number.isInteger(summary.pageNo) ? summary.pageNo : FIRST_PAGE_NO,
      detailCount: summary.detailCount,
      listCaptureId: job.listCapture?.id ?? null,
      completedAt: summary.completedAt ?? job.updatedAt ?? null,
    },
  ];
}
