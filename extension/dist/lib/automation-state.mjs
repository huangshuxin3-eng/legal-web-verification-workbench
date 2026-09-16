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
  PAUSED: "PAUSED",
  FAILED: "FAILED",
  DONE: "DONE",
});

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
 * 本轮第一页核查是否还有可继续的进度。
 *
 * 与 canStartNewAutomation 的区别是语义：这里有未完成的第一页进度，
 * 正确动作是「继续本次核查」（复用原 Query、跳过已完成的列表与详情），
 * 而不是从第 1 条重新开始。
 */
export function canResumeFirstPage(job) {
  return (
    [AUTOMATION_STATES.PAUSED, AUTOMATION_STATES.FAILED].includes(job?.state) &&
    job?.result === AUTOMATION_RESULT.HAS_RESULT &&
    Boolean(job?.queryId) &&
    Array.isArray(job?.pageOneRowKeys) &&
    job.pageOneRowKeys.length > 0
  );
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
