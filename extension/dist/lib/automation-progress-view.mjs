import { caseNoFromRowKey } from "../adapters/zxgk-execution.mjs";
import {
  AUTOMATION_STATES,
  canRecheckAutomation,
  canResumeFirstPage,
  hasListCapture,
} from "./automation-state.mjs";

const firstPageProcessingStates = new Set([
  AUTOMATION_STATES.CAPTURING_LIST_PAGE,
  AUTOMATION_STATES.READING_RESULT_ROWS,
  AUTOMATION_STATES.OPENING_DETAIL,
  AUTOMATION_STATES.CAPTURING_DETAIL,
  AUTOMATION_STATES.RETURNING_TO_LIST,
  AUTOMATION_STATES.VERIFYING_LIST_STATE,
]);

/** Side Panel 所需的 zxgk automationJob 派生值；不修改或修复 job。 */
export function deriveZxgkAutomationProgressViewModel(job) {
  const completedKeys = Array.isArray(job?.completedDetailKeys)
    ? job.completedDetailKeys
    : [];
  const rowKeys = Array.isArray(job?.pageOneRowKeys) ? job.pageOneRowKeys : [];
  const completedDetailCount = completedKeys.length;
  const expectedDetailCount = job?.expectedDetailCount ?? 0;
  const listCaptureComplete = hasListCapture(job);
  const nextRowKey = rowKeys.find((key) => !completedKeys.includes(key));
  const pendingOperation = job?.currentOperation || null;

  return {
    completedDetailCount,
    expectedDetailCount,
    listCaptureComplete,
    generatedCaptureCount: (listCaptureComplete ? 1 : 0) + completedDetailCount,
    nextIncompleteCaseNo: nextRowKey ? caseNoFromRowKey(nextRowKey) : "",
    pendingOperationCaseNo: pendingOperation?.caseNo || "",
    waitingForHumanVerification:
      job?.state === AUTOMATION_STATES.WAITING_HUMAN_VERIFICATION,
    canContinue: canRecheckAutomation(job),
    canResume: canResumeFirstPage(job),
    firstPageProcessing: firstPageProcessingStates.has(job?.state),
    firstPageComplete: job?.state === AUTOMATION_STATES.FIRST_PAGE_COMPLETE,
    totalPages: job?.resultPage?.totalPages ?? null,
    errorShownInCard:
      [AUTOMATION_STATES.PAUSED, AUTOMATION_STATES.FAILED].includes(
        job?.state,
      ) && Boolean(job?.error),
  };
}
