import { apiError, captureContext } from "@/lib/server/capture-api";
import { ownedTask, removeTaskTree } from "@/lib/server/hierarchy-delete";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  try {
    const { userDb } = await captureContext(request);
    const task = await ownedTask(userDb, (await context.params).taskId);
    await removeTaskTree(userDb, task);
    return Response.json(
      { deleted: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
