import { apiError, captureContext, validId } from "@/lib/server/capture-api";
import { CaptureOperationError } from "@/lib/capture-workflow";
import { REPORT_MIME_TYPE } from "@/lib/report-names";
import { loadAnalysisDraft } from "@/lib/server/analysis-draft";
import {
  downloadReportCapture,
  generateZxgkReportDocx,
  loadProjectReportData,
  PROJECT_MISSING_MESSAGE,
} from "@/lib/server/zxgk-report";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };

/** 与导出路由同构的 UTF-8 下载头（服务端生成，浏览器按 filename* 取中文名）。 */
function disposition(filename: string) {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="report.docx"; filename*=UTF-8''${encoded}`;
}

export async function GET(request: Request, context: Context) {
  const projectId = (await context.params).projectId;
  if (!validId(projectId))
    return apiError(new CaptureOperationError(PROJECT_MISSING_MESSAGE, 404));
  try {
    const { userDb } = await captureContext(request);
    const data = await loadProjectReportData(userDb, projectId);
    // AI 分析草稿是**可选输入**：没有草稿就是既有非 AI 报告，语义完全不变；
    // 已确认但基于旧事实时，generateZxgkReportDocx 会抛 409，绝不静默写入过期分析。
    const analysisDraft = await loadAnalysisDraft(userDb, projectId);
    const report = await generateZxgkReportDocx({
      projectName: data.projectName,
      tasks: data.tasks,
      loadCapture: (storagePath) => downloadReportCapture(userDb, storagePath),
      analysisDraft,
    });
    return new Response(new Uint8Array(report.buffer), {
      headers: {
        "Content-Type": REPORT_MIME_TYPE,
        "Content-Length": String(report.buffer.byteLength),
        "Content-Disposition": disposition(report.fileName),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
