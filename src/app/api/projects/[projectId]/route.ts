import { apiError, captureContext } from "@/lib/server/capture-api";
import { ownedProject, removeProjectTree } from "@/lib/server/hierarchy-delete";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { userDb } = await captureContext(request);
    const project = await ownedProject(
      userDb,
      (await context.params).projectId,
    );
    await removeProjectTree(userDb, project);
    return Response.json(
      { deleted: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
