import { apiError, captureContext, ownedQuery } from "@/lib/server/capture-api";
import { removeQueryTree } from "@/lib/server/hierarchy-delete";
export async function DELETE(
  request: Request,
  context: { params: Promise<{ queryId: string }> },
) {
  try {
    const { userDb } = await captureContext(request);
    const queryId = (await context.params).queryId;
    const query = await ownedQuery(userDb, queryId);
    await removeQueryTree(userDb, query);
    return Response.json(
      { deleted: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
