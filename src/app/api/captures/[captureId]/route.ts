import {
  apiError,
  captureContext,
  ownedCapture,
  ownedQuery,
  removeCapture,
} from "@/lib/server/capture-api";
import {
  captureExtension,
  captureMimeType,
  generatedCaptureName,
} from "@/lib/capture-names";
import { CaptureOperationError } from "@/lib/capture-workflow";
export const runtime = "nodejs";
type Context = { params: Promise<{ captureId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { userDb } = await captureContext(request);
    const capture = await ownedCapture(
      userDb,
      (await context.params).captureId,
    );
    const query = await ownedQuery(userDb, capture.query_id);
    const { data, error } = await userDb.storage
      .from("captures")
      .download(capture.storage_path);
    if (error || !data)
      throw new CaptureOperationError(
        "无法读取留痕文件，请重试；若上次删除未完成，可重试删除。",
        502,
      );
    const extension = captureExtension(capture.storage_path);
    const filename = generatedCaptureName(
      {
        ...query.tasks,
        query_no: query.query_no,
        capture_no: capture.capture_no,
      },
      extension,
      new Date(capture.created_at),
    );
    const disposition =
      new URL(request.url).searchParams.get("download") === "1"
        ? "attachment"
        : "inline";
    const encoded = encodeURIComponent(filename).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(data, {
      headers: {
        "Content-Type": captureMimeType(extension),
        "Content-Disposition": `${disposition}; filename="capture.${extension}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const { userDb } = await captureContext(request);
    const capture = await ownedCapture(
      userDb,
      (await context.params).captureId,
    );
    await removeCapture(userDb, capture);
    return Response.json(
      { deleted: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
