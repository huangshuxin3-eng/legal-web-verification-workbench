import {
  AUTOMATION_RESULT,
  AUTOMATION_STATES,
  canRecheckAutomation,
} from "./automation-state.mjs";
import {
  isZxgkExecutionPage,
  supportsZxgkExecution,
  ZXGK_EXECUTION_ADAPTER,
} from "../adapters/zxgk-execution.mjs";

function messageOf(error) {
  return String(error?.message || error || "自动核查失败。");
}

function sameTaskContext(task, job) {
  return (
    task?.id === job.taskId &&
    task?.project_id === job.projectId &&
    task?.entity_name === job.entityName &&
    task?.entity_name === job.queryText &&
    task?.topic === job.topic &&
    task?.source_name === job.sourceName &&
    task?.source_url === job.sourceUrl
  );
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
      job = await saveState(job, AUTOMATION_STATES.OPENING_QUERY_PAGE, {
        tabId: tab.id,
        entityName: task.entity_name,
        queryText: task.entity_name,
        queryId: null,
        topic: task.topic,
        sourceName: task.source_name,
        sourceUrl: task.source_url,
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
      return fail(job, error);
    }
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
      job = await saveState(job, AUTOMATION_STATES.CREATING_QUERY, {
        result,
        error: null,
      });
      const query = await dependencies.createQuery(job.taskId, job.queryText);
      job = await saveState(job, AUTOMATION_STATES.CREATING_QUERY, {
        query,
        queryId: query.id,
      });
      if (result === AUTOMATION_RESULT.HAS_RESULT)
        return saveState(job, AUTOMATION_STATES.HAS_RESULT_UNSUPPORTED);
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
      return fail(job, error);
    }
  }

  return { start, continueAfterVerification };
}
