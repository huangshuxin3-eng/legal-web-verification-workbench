import { apiError, captureContext, validId } from "@/lib/server/capture-api";
import { CaptureOperationError } from "@/lib/capture-workflow";
import {
  createTasksAfterRecheck,
  type TaskCreateInput,
} from "@/lib/task-repository";
import { safeWebsite } from "@/lib/tasks";

export const runtime = "nodejs";

function validTask(value: unknown): value is TaskCreateInput {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<TaskCreateInput>;
  return (
    typeof task.entity_name === "string" &&
    Boolean(task.entity_name.trim()) &&
    typeof task.topic === "string" &&
    Boolean(task.topic.trim()) &&
    typeof task.source_name === "string" &&
    Boolean(task.source_name.trim()) &&
    typeof task.source_url === "string" &&
    Boolean(safeWebsite(task.source_url.trim())) &&
    (task.note == null || typeof task.note === "string")
  );
}

export async function POST(request: Request) {
  try {
    const { userDb } = await captureContext(request);
    const body = (await request.json().catch(() => null)) as {
      projectId?: unknown;
      tasks?: unknown;
    } | null;
    if (
      typeof body?.projectId !== "string" ||
      !validId(body.projectId) ||
      !Array.isArray(body.tasks) ||
      !body.tasks.length ||
      !body.tasks.every(validTask)
    )
      throw new CaptureOperationError("批量任务数据无效。", 400);

    const project = await userDb
      .from("projects")
      .select("id")
      .eq("id", body.projectId)
      .single();
    if (project.error || !project.data)
      throw new CaptureOperationError("项目不存在或无权访问。", 404);

    const result = await createTasksAfterRecheck(
      userDb,
      body.projectId,
      body.tasks.map((task) => ({
        ...task,
        note: task.note?.trim() || null,
        status: "not_started" as const,
      })),
    );
    return Response.json(
      { created: result.created.length, skipped: result.skipped },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
