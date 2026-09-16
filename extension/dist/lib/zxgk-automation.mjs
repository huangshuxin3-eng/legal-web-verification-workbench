import {
  AUTOMATION_PHASES,
  AUTOMATION_RESULT,
  AUTOMATION_STATES,
  FIRST_PAGE_NO,
  canRecheckAutomation,
  canResumeFirstPage,
  normalizeAutomationJob,
} from "./automation-state.mjs";
import {
  buildRowKey,
  evaluateDetailIdentity,
  freezePageOneRows,
  isZxgkExecutionPage,
  locateRowKey,
  reconcileFrozenSet,
  reconcileRowKeys,
  supportsZxgkExecution,
  ZXGK_EXECUTION_ADAPTER,
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
    if (!completedPages.some((item) => item?.pageNo === currentPage))
      return invalidJob(
        "ADVANCE_PAGE_NOT_COMPLETED",
        "ADVANCING_PAGE 时源页必须已经完成。",
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

  return null;
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
 */
function listOperation(phase, extra = null) {
  const operation = {
    type: "LIST",
    pageNo: FIRST_PAGE_NO,
    rowKey: null,
    caseNo: null,
    phase,
  };
  return extra ? { ...operation, ...extra } : operation;
}

function detailOperation(row, phase) {
  return {
    type: "DETAIL",
    pageNo: FIRST_PAGE_NO,
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
        // 新一轮从第 1 页第 1 条开始：清掉上一轮遗留的第一页进度，
        // 但 Query 仍然复用同一个检索词。
        resultPage: null,
        expectedDetailCount: null,
        pageOneRowKeys: null,
        completedDetailKeys: [],
        detailCaptures: [],
        listCapture: null,
        listFilename: null,
        currentOperation: null,
        firstPageComplete: null,
      });
      await dependencies.openQueryPage(tab.id, tab.url);
      job = await saveState(job, AUTOMATION_STATES.FILLING_ENTITY);
      const filled = await dependencies.fillEntity(tab.id, job.queryText);
      if (!filled?.ok)
        throw new Error(filled?.error || "主体名称自动填写失败。");
      job = await saveState(job, AUTOMATION_STATES.SUBMITTING_QUERY);
      const submitted = await dependencies.submitQuery(tab.id);
      if (!submitted?.ok)
        throw new Error(submitted?.error || "查询按钮点击失败。");
      return saveState(job, AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION);
    } catch (error) {
      return fail(error.job || job, error);
    }
  }

  /**
   * 继续本次核查：同一个 automationJob / run、同一个 Query、同一个 queryId。
   * 只重新建立网页执行环境并重新查询，不改动已有的 Query 与 Capture。
   * 开始前必须确认本轮 Query 仍然有效（存在、同 Task、同检索词），否则 fail closed。
   * 原自动化标签页已关闭时新建一个并在其中重建环境，不导航用户当前活动标签页。
   */
  async function resume({ taskId }) {
    let job = await dependencies.getJob();
    if (!job || job.adapter !== ZXGK_EXECUTION_ADAPTER)
      throw new Error("没有可继续的自动核查任务。");
    try {
      const invariant = validateZxgkAutomationJobInvariant(job);
      if (!invariant.ok)
        throw new Error(`${AUTOMATION_JOB_INVALID_MESSAGE}（${invariant.code}）`);
      if (!canResumeFirstPage(job))
        throw new Error("当前没有可继续的第一页核查进度，请重新开始自动核查。");
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
      await dependencies.openQueryPage(tab.id, tab.url);
      job = await saveState(job, AUTOMATION_STATES.FILLING_ENTITY);
      const filled = await dependencies.fillEntity(tab.id, job.queryText);
      if (!filled?.ok)
        throw new Error(filled?.error || "主体名称自动填写失败。");
      job = await saveState(job, AUTOMATION_STATES.SUBMITTING_QUERY);
      const submitted = await dependencies.submitQuery(tab.id);
      if (!submitted?.ok)
        throw new Error(submitted?.error || "查询按钮点击失败。");
      return saveState(job, AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION);
    } catch (error) {
      return fail(error.job || job, error);
    }
  }

  /**
   * 第一页列表留痕。只有列表留痕完整成功，才会开始处理详情。
   * 已经成功留痕过的列表在继续本次核查时不会重复生成。
   *
   * 与详情使用同一套成功事务语义：Capture 一旦 finalize 成功，立刻把成功
   * captureId 与补记载荷一起落盘，然后才做 verify / 状态收尾。
   */
  async function captureListPage(job) {
    job = await saveState(job, AUTOMATION_STATES.CAPTURING_LIST_PAGE, {
      currentOperation: listOperation(AUTOMATION_PHASES.CAPTURING),
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
      currentOperation: listOperation(AUTOMATION_PHASES.CAPTURING, {
        captureId: archived.capture.id,
        capture: archived.capture,
        filename: archived.filename,
      }),
    });
    return settlePendingListCapture(job, job.currentOperation);
  }

  /** 返回列表后必须复核仍是第 1 页，且冻结的目标集合仍全部可定位。 */
  async function verifyListState(job, expectedRowKeys) {
    job = await saveState(job, AUTOMATION_STATES.VERIFYING_LIST_STATE, {
      currentOperation: listOperation(AUTOMATION_PHASES.VERIFYING),
    });
    const snapshot = await dependencies.readResultPage(job.tabId);
    const reconciled = reconcileRowKeys(expectedRowKeys, snapshot);
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
   */
  async function settlePendingOperation(job, pending) {
    if (!pending) return job;
    if (pending.type === "LIST") return settlePendingListCapture(job, pending);
    if (pending.captureId && pending.rowKey)
      return settlePendingCapture(job, pending);
    if (pending.detailTabId) await releaseDetailTab(job, pending.detailTabId);
    return saveState(job, job.state, { currentOperation: null });
  }

  /** 逐条处理详情：定位 → 打开 → 校验身份 → 留痕 → 返回 → 复核。 */
  async function captureDetailRow(job, row) {
    const rowKey = buildRowKey(row);
    const pending = job.currentOperation;
    // 防御：万一在“Capture 已成功但尚未补记进度”的窗口进入本条，先补记。
    if (pending?.captureId && pending.rowKey === rowKey)
      job = await settlePendingCapture(job, pending);
    if ((job.completedDetailKeys || []).includes(rowKey)) return job;
    job = await saveState(job, AUTOMATION_STATES.OPENING_DETAIL, {
      currentOperation: detailOperation(row, AUTOMATION_PHASES.LOCATING),
    });
    const snapshot = await dependencies.readResultPage(job.tabId);
    const located = locateRowKey(snapshot, rowKey);
    if (!located.ok) throw stop(job, located.error);
    job = await saveState(job, AUTOMATION_STATES.OPENING_DETAIL, {
      currentOperation: detailOperation(row, AUTOMATION_PHASES.OPENING),
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
        ...detailOperation(row, AUTOMATION_PHASES.OPENING),
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
        ...detailOperation(row, AUTOMATION_PHASES.CAPTURING),
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
        ...detailOperation(row, AUTOMATION_PHASES.RETURNING),
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
        ...detailOperation(row, AUTOMATION_PHASES.VERIFYING),
        detailTabId: null,
        captureId: archived.capture.id,
      },
    });
    const afterReturn = await dependencies.readResultPage(job.tabId);
    const reconciled = reconcileRowKeys(job.pageOneRowKeys, afterReturn);
    if (!reconciled.ok) throw stop(job, reconciled.error);
    // 只有留痕成功且确认回到第一页之后，才记为已完成。
    return saveState(job, AUTOMATION_STATES.VERIFYING_LIST_STATE, {
      completedDetailKeys: [...(job.completedDetailKeys || []), rowKey],
      currentOperation: null,
    });
  }

  /** 第 1 页完成条件：列表 + N 个唯一详情 + 无残留操作。 */
  async function firstPageCompleteness(job) {
    const completed = job.completedDetailKeys || [];
    const unique = new Set(completed);
    if (
      completed.length !== job.expectedDetailCount ||
      unique.size !== job.expectedDetailCount
    )
      throw stop(
        job,
        `第 1 页未完成：已处理 ${unique.size} / ${job.expectedDetailCount} 条详情。`,
      );
    const missing = (job.pageOneRowKeys || []).filter(
      (key) => !unique.has(key),
    );
    if (missing.length)
      throw stop(job, `第 1 页仍有未处理的结果：${missing.join("；")}。`);
    if (job.currentOperation) throw stop(job, "仍有未结束的操作，未标记完成。");
    // FIRST_PAGE_COMPLETE 不是 DONE：网站可能还有第 2 页及以后，本轮不翻页。
    return saveState(job, AUTOMATION_STATES.FIRST_PAGE_COMPLETE, {
      currentOperation: null,
      error: null,
      firstPageComplete: {
        pageNo: FIRST_PAGE_NO,
        totalPages: job.resultPage?.totalPages ?? null,
        detailCount: job.expectedDetailCount,
        newCaptures: job.expectedDetailCount + 1,
      },
    });
  }

  /**
   * 第一页循环：列表尚未留痕则先留痕，再按冻结顺序处理未完成的详情。
   * 继续本次核查时复用它，因此已完成的列表与详情都不会重复。
   */
  async function runFirstPageLoop(job, rows) {
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
      job = await verifyListState(job, job.pageOneRowKeys);
    }
    for (const row of rows) job = await captureDetailRow(job, row);
    return firstPageCompleteness(job);
  }

  /** 全新的第一页核查：重新读取并冻结第 1 页目标集合。 */
  async function captureFirstPage(job) {
    job = await saveState(job, AUTOMATION_STATES.READING_RESULT_ROWS, {
      result: AUTOMATION_RESULT.HAS_RESULT,
      error: null,
      currentOperation: listOperation(AUTOMATION_PHASES.LOCATING),
    });
    const snapshot = await dependencies.readResultPage(job.tabId);
    const frozen = freezePageOneRows(snapshot);
    if (!frozen.ok) throw stop(job, frozen.error);
    job = await saveState(job, AUTOMATION_STATES.READING_RESULT_ROWS, {
      resultPage: {
        pageNo: FIRST_PAGE_NO,
        totalPages: snapshot.page?.totalPages ?? null,
        totalSize: snapshot.page?.totalSize ?? null,
      },
      expectedDetailCount: frozen.rows.length,
      pageOneRowKeys: frozen.keys,
      completedDetailKeys: [],
      detailCaptures: [],
      listCapture: null,
      listFilename: null,
      currentOperation: null,
    });
    return runFirstPageLoop(job, frozen.rows);
  }

  /**
   * 继续第一页：重新查询后，当前第 1 页集合必须与原冻结集合完全一致
   * （顺序可变），然后跳过已完成的列表与详情，从第一个未完成 rowKey 继续。
   */
  async function resumeFirstPage(job) {
    const pending = job.currentOperation || null;
    job = await saveState(job, AUTOMATION_STATES.READING_RESULT_ROWS);
    const snapshot = await dependencies.readResultPage(job.tabId);
    const reconciled = reconcileFrozenSet(job.pageOneRowKeys, snapshot);
    if (!reconciled.ok) throw stop(job, reconciled.error);
    // 这里刻意不清空 currentOperation：先补记上一轮已经成功的留痕，再收尾。
    // 否则会在“补记”之前多出一个新的中断窗口，反而可能重复留痕。
    job = await saveState(job, AUTOMATION_STATES.READING_RESULT_ROWS, {
      resultPage: {
        pageNo: FIRST_PAGE_NO,
        totalPages: snapshot.page?.totalPages ?? null,
        totalSize: snapshot.page?.totalSize ?? null,
      },
    });
    // 上一轮若中断在“Capture 已成功、但尚未补记进度”的窗口，这里补记：
    // 列表靠 captureId 直接补记 listCapture，详情靠 captureId 补记完成项。
    job = await settlePendingOperation(job, pending);
    return runFirstPageLoop(job, reconciled.rows);
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
      const tab = await dependencies.getTab(job.tabId);
      if (!tab) throw new Error("自动核查标签页已关闭。");
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
        // 已有第一页进度 = 继续本次核查；否则才是全新的第一页核查。
        return job.pageOneRowKeys?.length
          ? await resumeFirstPage(job)
          : await captureFirstPage(job);
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

  return { start, resume, continueAfterVerification };
}
