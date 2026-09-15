import { apiError, captureContext, validId } from "@/lib/server/capture-api";
import { CaptureOperationError } from "@/lib/capture-workflow";
import { deleteTasksSequentially } from "@/lib/hierarchy-deletion";
import { ownedTask, removeTaskTree } from "@/lib/server/hierarchy-delete";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { userDb } = await captureContext(request);
    const body = (await request.json().catch(() => null)) as {
      taskIds?: unknown;
    } | null;
    if (
      !Array.isArray(body?.taskIds) ||
      !body.taskIds.length ||
      !body.taskIds.every((id) => typeof id === "string" && validId(id))
    )
      throw new CaptureOperationError("请选择需要删除的有效任务。", 400);

    const result = await deleteTasksSequentially(
      body.taskIds,
      async (taskId) => {
        const task = await ownedTask(userDb, taskId);
        await removeTaskTree(userDb, task);
      },
    );
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
