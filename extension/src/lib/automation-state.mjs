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
 * "部分完成"终止态：PARTIAL_COMPLETE（M8.2b Slice 3B）。
 *
 * 语义：这一轮自动执行已经把连续页前缀 1..currentPage 完整处理过，但网站仍然存在
 * 未处理的后续页。它是**正常结束**：不是错误、不是运行中，也是一个已结算态——
 * 后台重启时不会像中断状态那样被改写成 FAILED。
 *
 * 它对第 2 / 21 页与第 5 / 21 页同样成立，因此名字里只描述"处理到什么程度"，
 * 绝不写开发阶段或具体页数。
 *
 * FIRST_PAGE_COMPLETE 继续作为 M8.2a 的 legacy 终止态保留（只由「继续本次核查」
 * 的第 1 页路径产生），全新核查不再使用它。
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
 * PARTIAL_COMPLETE 有意不在其中：当前没有「从部分完成继续自动核查」的产品语义，
 * 再次启动实际上会从第 1 页重新产生一整套 Capture，很容易被误解成「继续剩余分页」。
 * 因此部分完成时既不提供自动继续，也不提供重新自动核查，用户只能看到状态，
 * 必要时返回手工模式。
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
 * 本轮的恢复范围严格限定在 Slice 3B 的两页边界内：
 * - 第 1 页（含“已处理完、但还没离开这一页”）→ 目标第 1 页：恢复后必须先在页面上重新
 *   证明第 1 页仍然是同一份结果集，再交给 driver 决定是否继续往后处理；
 * - 第 2 页已冻结且尚未完整处理 → 目标第 2 页。
 *
 * 绝不推导 currentPage + 1，也绝不返回第 3 页：任何超出两页范围的 checkpoint 都
 * 判为不可恢复，交人工。
 */
export function deriveResumeTarget(job) {
  const normalized = normalizeAutomationJob(job);
  if (!normalized || typeof normalized !== "object")
    return { ok: false, reason: "没有可继续的自动核查进度。" };
  const { currentPage, totalPages } = normalized;
  const pages = Array.isArray(normalized.completedPages)
    ? normalized.completedPages
    : [];
  const keys = Array.isArray(normalized.pageFrozenKeys)
    ? normalized.pageFrozenKeys
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

  if (currentPage === FIRST_PAGE_NO) {
    // 第 1 页：必须有冻结结果集合（boundary 指纹的来源），且 completedPages 不能
    // 出现超出第 1 页的记录。**第 1 页是否已经处理完不影响目标页**：完成页的推进
    // 属于 driver 的两页边界，state 层只负责把核查带回第 1 页。
    if (!keys.length)
      return {
        ok: false,
        reason: "第 1 页还没有冻结的结果集合，无法安全恢复。",
      };
    if (pages.length > FIRST_PAGE_NO)
      return { ok: false, reason: "第 1 页的完成记录与页坐标不一致。" };
    return {
      ok: true,
      targetPage: FIRST_PAGE_NO,
    };
  }

  if (currentPage === FIRST_PAGE_NO + 1) {
    // 第 2 页：只有"第 1 页已完成、第 2 页已冻结、baseline 明确"的 checkpoint
    // 才可恢复——恢复第 2 页必须重新跳页并用 baseline 判定到达。
    if (!Number.isInteger(totalPages))
      return {
        ok: false,
        reason: "恢复第 2 页需要明确的结果总页数 baseline，无法安全恢复。",
      };
    if (!keys.length)
      return {
        ok: false,
        reason: "第 2 页还没有冻结的结果集合，无法安全恢复。",
      };
    if (pages.length !== FIRST_PAGE_NO)
      return {
        ok: false,
        reason: "第 2 页的完成进度与页坐标不一致，无法安全恢复。",
      };
    return {
      ok: true,
      targetPage: FIRST_PAGE_NO + 1,
    };
  }

  return {
    ok: false,
    reason: "本轮只支持恢复到第 1 页或第 2 页，无法安全恢复。",
  };
}

/**
 * 未完成的核查是否还有可继续的进度（M8.2b Slice 4B 泛化）。
 *
 * 与 canStartNewAutomation 的区别是语义：这里有 checkpoint，正确动作是
 * 「继续本次核查」（复用原 Query、跳过已完成的列表与详情；第 2 页的 checkpoint
 * 则先重建查询环境并重新完成人工验证，再回到第 2 页），而不是从第 1 条重新开始。
 *
 * 以下都不提供「继续本次核查」：
 * - 不在 PAUSED / FAILED（运行中、已结算态都没有可继续的动作）；
 * - 没有结果（NO_RESULT / UNKNOWN 没有页级 checkpoint）；
 * - 缺少 queryId；
 * - 页模型不足以推导恢复目标（含第 3 页及以后：本轮没有安全的恢复路径）；
 * - checkpoint identity 已经失效（结果集 / 页数已经变化）：此时 resume 必然重复
 *   同一个失败，必须交人工。
 */
export function canResumeAutomation(job) {
  if (
    ![AUTOMATION_STATES.PAUSED, AUTOMATION_STATES.FAILED].includes(job?.state)
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
