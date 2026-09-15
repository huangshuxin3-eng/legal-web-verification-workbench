import {
  AUTOMATION_PHASES,
  AUTOMATION_RESULT,
  AUTOMATION_STATES,
  canRecheckAutomation,
  canResumeFirstPage,
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

const FIRST_PAGE_NO = 1;

/**
 * 自动核查上下文专用的 Query 失效文案（不要与手工 Query 的文案混用）。
 * worker 在自动核查归档失败时复用同一句话，避免两处文案漂移。
 */
export const AUTOMATION_QUERY_UNAVAILABLE_MESSAGE =
  "本次核查关联的 Query 已不存在或无法访问，无法安全继续本次核查。已生成 Capture 不删除。";

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
