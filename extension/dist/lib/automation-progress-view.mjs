import { caseNoFromRowKey } from "../adapters/zxgk-execution.mjs";
import {
  AUTOMATION_STATES,
  canRecheckAutomation,
  canResumeAutomation,
  deriveResumeTarget,
  hasListCapture,
  normalizeAutomationJob,
} from "./automation-state.mjs";

const currentPageProcessingStates = new Set([
  AUTOMATION_STATES.CAPTURING_LIST_PAGE,
  AUTOMATION_STATES.READING_RESULT_ROWS,
  AUTOMATION_STATES.OPENING_DETAIL,
  AUTOMATION_STATES.CAPTURING_DETAIL,
  AUTOMATION_STATES.RETURNING_TO_LIST,
  AUTOMATION_STATES.VERIFYING_LIST_STATE,
]);

/**
 * Side Panel 所需的 zxgk automationJob 派生值；不修改或修复 job。
 *
 * 页模型统一走 normalizeAutomationJob 的 read-time 兼容视图：legacy job 自动等价，
 * 而 currentPage = 2 时**绝不能**再读 pageOneRowKeys —— 那是第 1 页的集合，
 * 会让"下一项"显示成第 1 页的案号。
 */
export function deriveZxgkAutomationProgressViewModel(job) {
  const normalized = normalizeAutomationJob(job);
  const completedKeys = Array.isArray(normalized?.completedDetailKeys)
    ? normalized.completedDetailKeys
    : [];
  const rowKeys = Array.isArray(normalized?.pageFrozenKeys)
    ? normalized.pageFrozenKeys
    : [];
  const completedPages = Array.isArray(normalized?.completedPages)
    ? normalized.completedPages
    : [];
  const completedDetailCount = completedKeys.length;
  const expectedDetailCount = normalized?.expectedDetailCount ?? 0;
  const listCaptureComplete = hasListCapture(normalized);
  const nextRowKey = rowKeys.find((key) => !completedKeys.includes(key));
  const pendingOperation = normalized?.currentOperation || null;
  const resumeTarget = deriveResumeTarget(normalized);

  return {
    // 页坐标：当前页处理的都是"当前页"的集合与进度。
    currentPage: normalized?.currentPage ?? null,
    totalPages: normalized?.totalPages ?? null,
    completedPageCount: completedPages.length,
    // 历史页各自贡献 1 份列表留痕 + 该页详情留痕，用于多页终止态的展示。
    completedPageCaptureCount: completedPages.reduce(
      (total, page) => total + (page?.detailCount ?? 0) + 1,
      0,
    ),
    completedDetailCount,
    expectedDetailCount,
    listCaptureComplete,
    generatedCaptureCount: (listCaptureComplete ? 1 : 0) + completedDetailCount,
    nextIncompleteCaseNo: nextRowKey ? caseNoFromRowKey(nextRowKey) : "",
    pendingOperationCaseNo: pendingOperation?.caseNo || "",
    waitingForHumanVerification:
      job?.state === AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
    canContinue: canRecheckAutomation(job),
    // 可继续的 checkpoint 不再限于第 1 页：Slice 5 起恢复目标就是 persisted 的当前页，
    // 任意页都可以安全 resume；legacy 的 PARTIAL_COMPLETE 同样是一个可继续的检查点。
    canResume: canResumeAutomation(job),
    resumeTargetPage: resumeTarget.ok ? resumeTarget.targetPage : null,
    currentPageProcessing: currentPageProcessingStates.has(job?.state),
    firstPageComplete: job?.state === AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
    partialComplete: job?.state === AUTOMATION_STATES.PARTIAL_COMPLETE,
    errorShownInCard:
      [AUTOMATION_STATES.PAUSED, AUTOMATION_STATES.FAILED].includes(
        job?.state,
      ) && Boolean(job?.error),
  };
}
