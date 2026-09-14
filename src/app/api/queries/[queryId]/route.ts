import {
  apiError,
  cleanupCaptureUpload,
  captureContext,
  ownedQuery,
  removeCapture,
} from "@/lib/server/capture-api";
import { CaptureOperationError } from "@/lib/capture-workflow";
export async function DELETE(
  request: Request,
  context: { params: Promise<{ queryId: string }> },
) {
  try {
    const { userDb } = await captureContext(request);
    const queryId = (await context.params).queryId;
    const query = await ownedQuery(userDb, queryId);
    for (const operation of Object.values(query.capture_operations)) {
      if (operation.action !== "delete")
        await cleanupCaptureUpload(userDb, queryId, operation.id);
    }
    const { count, error: countError } = await userDb
      .from("captures")
      .select("id", { count: "exact", head: true })
      .eq("query_id", queryId);
    if (countError) throw countError;
    if (count) {
      // Delete from the start each batch; never skip rows after deleting a page.
      while (true) {
        const { data, error } = await userDb
          .from("captures")
          .select("*")
          .eq("query_id", queryId)
          .order("capture_no")
          .limit(100);
        if (error) throw error;
        if (!data.length) break;
        for (const capture of data) await removeCapture(userDb, capture);
      }
    }
    const { error } = await userDb
      .from("queries")
      .delete()
      .eq("id", queryId)
      .select("id")
      .single();
    if (error)
      throw new CaptureOperationError(
        "查询未删除，可能有正在上传的留痕文件。请刷新后重试；已删除的留痕不会恢复。",
        409,
      );
    return Response.json(
      { deleted: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
