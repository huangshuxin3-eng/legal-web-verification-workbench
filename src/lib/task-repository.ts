import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Task } from "./database.types";
import type { TaskWithQueryCount } from "./queries";
import type { TaskInput } from "./tasks";
import {
  canonicalTaskFields,
  reclassifyCandidates,
  taskIdentity,
  type CandidateTask,
} from "./task-generator.ts";

export type TaskCreateInput = TaskInput & { status: "not_started" };

export async function createTask(
  db: SupabaseClient<Database>,
  projectId: string,
  input: TaskInput,
) {
  const result = await db
    .from("tasks")
    .insert({ ...input, project_id: projectId })
    .select("*, queries(count)")
    .single();
  if (result.error) throw result.error;
  return result.data as Omit<TaskWithQueryCount, "capture_count">;
}

export async function updateTask(
  db: SupabaseClient<Database>,
  projectId: string,
  taskId: string,
  input: TaskInput,
) {
  const result = await db
    .from("tasks")
    .update(input)
    .eq("id", taskId)
    .eq("project_id", projectId)
    .select("*, queries(count)")
    .single();
  if (result.error) throw result.error;
  return result.data as Omit<TaskWithQueryCount, "capture_count">;
}

export async function createTasks(
  db: SupabaseClient<Database>,
  projectId: string,
  inputs: readonly TaskCreateInput[],
): Promise<Task[]> {
  if (!inputs.length) return [];
  const normalized = inputs.map((input) => canonicalTaskFields(input));
  const { data, error } = await db
    .from("tasks")
    .insert(normalized.map((input) => ({ ...input, project_id: projectId })))
    .select("*");
  if (error) throw error;
  return data;
}

export async function getProjectTasks(
  db: SupabaseClient<Database>,
  projectId: string,
): Promise<Task[]> {
  const rows: Task[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .from("tasks")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at")
      .order("id")
      .range(offset, offset + 499);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 500) break;
  }
  return rows;
}

export async function createTasksAfterRecheck(
  db: SupabaseClient<Database>,
  projectId: string,
  inputs: readonly TaskCreateInput[],
) {
  const candidates: CandidateTask[] = inputs.map((input) => {
    const normalized = canonicalTaskFields({
      ...input,
      status: "not_started" as const,
    });
    return {
      ...normalized,
      key: taskIdentity(projectId, normalized),
      availability: "pending",
    };
  });
  const latest = await getProjectTasks(db, projectId);
  const checked = reclassifyCandidates(projectId, candidates, latest);
  const pending = checked.filter(
    (candidate) => candidate.availability === "pending",
  );
  const created = await createTasks(
    db,
    projectId,
    pending.map(({ key: _key, availability: _availability, ...task }) => task),
  );
  return { created, skipped: checked.length - pending.length };
}
