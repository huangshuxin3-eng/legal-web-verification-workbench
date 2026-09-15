import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { apiError, captureContext, validId } from "@/lib/server/capture-api";
import { CaptureOperationError } from "@/lib/capture-workflow";
import {
  buildProjectExportPlan,
  createExportWorkbook,
  downloadPrivateCapture,
  loadProjectExportData,
  writeProjectExportZip,
} from "@/lib/server/project-export";
import { projectExportNames } from "@/lib/project-export";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };

function disposition(filename: string) {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="project-export.zip"; filename*=UTF-8''${encoded}`;
}

export async function GET(request: Request, context: Context) {
  const projectId = (await context.params).projectId;
  if (!validId(projectId))
    return apiError(new CaptureOperationError("项目不存在或无权导出。", 404));
  const temporaryPath = join(tmpdir(), `nonlit-export-${randomUUID()}.zip`);
  let handedToResponse = false;
  try {
    const { userDb } = await captureContext(request);
    const data = await loadProjectExportData(userDb, projectId);
    const plan = buildProjectExportPlan(data.tasks);
    if (!plan.files.length)
      throw new CaptureOperationError("当前项目暂无可导出的底稿。", 409);
    const names = projectExportNames(data.name);
    const workbook = await createExportWorkbook(plan);
    await writeProjectExportZip({
      output: createWriteStream(temporaryPath, { flags: "wx" }),
      workbook,
      workbookName: names.workbook,
      plan,
      signal: request.signal,
      loadCapture: (storagePath) => downloadPrivateCapture(userDb, storagePath),
    });
    const size = (await stat(temporaryPath)).size;
    const file = createReadStream(temporaryPath);
    const cleanup = () => void unlink(temporaryPath).catch(() => undefined);
    file.once("close", cleanup);
    file.once("error", cleanup);
    handedToResponse = true;
    return new Response(Readable.toWeb(file) as ReadableStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(size),
        "Content-Disposition": disposition(names.zip),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiError(error);
  } finally {
    if (!handedToResponse) await unlink(temporaryPath).catch(() => undefined);
  }
}
