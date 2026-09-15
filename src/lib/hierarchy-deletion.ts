type Identified = { id: string };

export async function deleteTaskHierarchy<TTask extends Identified, TQuery>(
  task: TTask,
  operations: {
    listQueries: (taskId: string) => Promise<TQuery[]>;
    removeQuery: (query: TQuery) => Promise<void>;
    deleteTaskRecord: (task: TTask) => Promise<void>;
  },
) {
  while (true) {
    const queries = await operations.listQueries(task.id);
    if (!queries.length) break;
    for (const query of queries) await operations.removeQuery(query);
  }
  await operations.deleteTaskRecord(task);
}

export async function deleteProjectHierarchy<
  TProject extends Identified,
  TTask,
>(
  project: TProject,
  operations: {
    listTasks: (projectId: string) => Promise<TTask[]>;
    removeTask: (task: TTask) => Promise<void>;
    deleteProjectRecord: (project: TProject) => Promise<void>;
  },
) {
  while (true) {
    const tasks = await operations.listTasks(project.id);
    if (!tasks.length) break;
    for (const task of tasks) await operations.removeTask(task);
  }
  await operations.deleteProjectRecord(project);
}

export async function deleteTasksSequentially(
  taskIds: readonly string[],
  removeTask: (taskId: string) => Promise<void>,
) {
  const deletedIds: string[] = [];
  const failedIds: string[] = [];
  for (const taskId of [...new Set(taskIds)]) {
    try {
      await removeTask(taskId);
      deletedIds.push(taskId);
    } catch {
      failedIds.push(taskId);
    }
  }
  return { deletedIds, failedIds };
}
