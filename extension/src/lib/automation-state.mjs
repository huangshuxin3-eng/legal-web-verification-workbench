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
  FIRST_PAGE_COMPLETE: "FIRST_PAGE_COMPLETE",
  PAUSED: "PAUSED",
  FAILED: "FAILED",
  DONE: "DONE",
});

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
