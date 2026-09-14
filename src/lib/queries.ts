import type { Task, Query, Database } from "./database.types";
import type { SupabaseClient } from "@supabase/supabase-js";
export type TaskWithQueryCount = Task & {
  queries: { count: number }[];
  capture_count: number;
};
export type QueryWithCaptureCount = Query & { captures: { count: number }[] };
export async function taskCaptureCounts(
  db: SupabaseClient<Database>,
  projectId: string,
  taskId?: string,
) {
  const counts = new Map<string, number>();
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .rpc("task_capture_counts", {
        p_project_id: projectId,
        ...(taskId ? { p_task_id: taskId } : {}),
      })
      .range(offset, offset + 499);
    if (error) throw error;
    for (const row of data) counts.set(row.task_id, Number(row.capture_count));
    if (data.length < 500) break;
  }
  return counts;
}
export function queryLabel(number: number) {
  return `Q${String(number).padStart(2, "0")}`;
}
