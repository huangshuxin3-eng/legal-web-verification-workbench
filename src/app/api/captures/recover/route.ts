import {
  apiError,
  cleanupCaptureUpload,
  removeCapture,
  captureContext,
  ownedQuery,
  validId,
} from "@/lib/server/capture-api";
import { CaptureOperationError } from "@/lib/capture-workflow";
export async function POST(request: Request) {
  try {
    const { userDb } = await captureContext(request);
    const { captureId, queryId, mode } = (await request.json()) as {
      captureId: string;
      queryId: string;
      mode?: "finish" | "cleanup";
    };
    if (!validId(captureId))
      throw new CaptureOperationError("恢复请求无效。", 400);
    const query = await ownedQuery(userDb, queryId);
    const { data, error } = await userDb
      .from("captures")
      .select("*")
      .eq("id", captureId)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      if (data.query_id !== queryId)
        throw new CaptureOperationError("无权处理此记录。", 403);
      if (query.capture_operations[captureId]?.action === "delete") {
        await removeCapture(userDb, data);
        return Response.json(
          { deleted: true },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        { saved: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (mode === "finish") {
      const finished = await userDb
        .rpc("finish_capture_upload", {
          p_query_id: queryId,
          p_capture_id: captureId,
        })
        .single();
      if (finished.error)
        throw new CaptureOperationError(
          "无法完成上传，文件可能未传完。可以取消并清理这次上传。",
          409,
        );
      return Response.json(
        { saved: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    await cleanupCaptureUpload(userDb, queryId, captureId);
    return Response.json(
      { cleaned: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
