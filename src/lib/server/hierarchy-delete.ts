import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Project, Query, Task } from "../database.types";
import { CaptureOperationError } from "../capture-workflow";
import {
  deleteProjectHierarchy,
  deleteTaskHierarchy,
} from "../hierarchy-deletion";
import {
  cleanupCaptureUpload,
  ownedQuery,
  removeCapture,
  validId,
} from "./capture-api";

export async function ownedTask(userDb: SupabaseClient<Database>, id: string) {
  if (!validId(id))
    throw new CaptureOperationError("任务不存在或无权访问。", 404);
  const { data, error } = await userDb
    .from("tasks")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !data)
    throw new CaptureOperationError("任务不存在或无权访问。", 404);
  return data;
}

export async function ownedProject(
  userDb: SupabaseClient<Database>,
  id: string,
) {
  if (!validId(id))
    throw new CaptureOperationError("项目不存在或无权访问。", 404);
  const { data, error } = await userDb
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !data)
    throw new CaptureOperationError("项目不存在或无权访问。", 404);
  return data;
}

export async function removeQueryTree(
  userDb: SupabaseClient<Database>,
  query: Query,
) {
  for (const operation of Object.values(query.capture_operations)) {
    if (operation.action !== "delete")
      await cleanupCaptureUpload(userDb, query.id, operation.id);
  }
  while (true) {
    const { data, error } = await userDb
      .from("captures")
      .select("*")
      .eq("query_id", query.id)
      .order("capture_no")
      .limit(100);
    if (error) throw error;
    if (!data.length) break;
    for (const capture of data) await removeCapture(userDb, capture);
  }
  const { error } = await userDb
    .from("queries")
    .delete()
    .eq("id", query.id)
    .select("id")
    .single();
  if (error)
    throw new CaptureOperationError(
      "查询未删除，可能有正在上传的留痕文件。请重试；已经完成的文件清理无需重复。",
      409,
    );
}

export async function removeTaskTree(
  userDb: SupabaseClient<Database>,
  task: Task,
) {
  await deleteTaskHierarchy(task, {
    listQueries: async (taskId) => {
      const { data, error } = await userDb
        .from("queries")
        .select("*")
        .eq("task_id", taskId)
        .order("query_no")
        .limit(100);
      if (error) throw error;
      return data;
    },
    removeQuery: async (row) => {
      const query = await ownedQuery(userDb, row.id);
      await removeQueryTree(userDb, query);
    },
    deleteTaskRecord: async (row) => {
      const { error } = await userDb
        .from("tasks")
        .delete()
        .eq("id", row.id)
        .eq("project_id", row.project_id)
        .select("id")
        .single();
      if (error) {
        const remaining = await userDb
          .from("tasks")
          .select("id")
          .eq("id", row.id)
          .maybeSingle();
        if (!remaining.error && !remaining.data) return;
        throw new CaptureOperationError(
          "任务尚未完全删除。已清理的留痕不会恢复，请重试以继续清理剩余数据。",
          409,
        );
      }
    },
  });
}

export async function removeProjectTree(
  userDb: SupabaseClient<Database>,
  project: Project,
) {
  await deleteProjectHierarchy(project, {
    listTasks: async (projectId) => {
      const { data, error } = await userDb
        .from("tasks")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at")
        .order("id")
        .limit(100);
      if (error) throw error;
      return data;
    },
    removeTask: (task) => removeTaskTree(userDb, task),
    deleteProjectRecord: async (row) => {
      const { error } = await userDb
        .from("projects")
        .delete()
        .eq("id", row.id)
        .select("id")
        .single();
      if (error) {
        const remaining = await userDb
          .from("projects")
          .select("id")
          .eq("id", row.id)
          .maybeSingle();
        if (!remaining.error && !remaining.data) return;
        throw new CaptureOperationError(
          "项目尚未完全删除。已清理的内容不会恢复，请重试以继续清理剩余数据。",
          409,
        );
      }
    },
  });
}
