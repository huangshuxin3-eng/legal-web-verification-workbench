import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteProjectHierarchy,
  deleteTaskHierarchy,
  deleteTasksSequentially,
} from "../src/lib/hierarchy-deletion.ts";

type TestProject = { id: string; ownerId: string };
type TestTask = { id: string; projectId: string };
type TestQuery = { id: string; taskId: string };
type TestCapture = { id: string; queryId: string; storagePath: string };

function model() {
  const projects = new Map<string, TestProject>();
  const tasks = new Map<string, TestTask>();
  const queries = new Map<string, TestQuery>();
  const captures = new Map<string, TestCapture>();
  const files = new Set<string>();
  let failPath: string | null = null;

  async function removeQuery(query: TestQuery) {
    for (const capture of [...captures.values()].filter(
      (capture) => capture.queryId === query.id,
    )) {
      if (capture.storagePath === failPath)
        throw new Error("storage unavailable");
      files.delete(capture.storagePath);
      captures.delete(capture.id);
    }
    queries.delete(query.id);
  }

  const taskOperations = {
    listQueries: async (taskId: string) =>
      [...queries.values()]
        .filter((query) => query.taskId === taskId)
        .slice(0, 2),
    removeQuery,
    deleteTaskRecord: async (task: TestTask) => {
      tasks.delete(task.id);
    },
  };

  async function removeTask(task: TestTask) {
    await deleteTaskHierarchy(task, taskOperations);
  }

  const projectOperations = {
    listTasks: async (projectId: string) =>
      [...tasks.values()]
        .filter((task) => task.projectId === projectId)
        .slice(0, 2),
    removeTask,
    deleteProjectRecord: async (project: TestProject) => {
      projects.delete(project.id);
    },
  };

  return {
    projects,
    tasks,
    queries,
    captures,
    files,
    taskOperations,
    projectOperations,
    failOn(path: string | null) {
      failPath = path;
    },
    addProject(id: string, ownerId = "owner-a") {
      const project = { id, ownerId };
      projects.set(id, project);
      return project;
    },
    addTask(id: string, projectId: string) {
      const task = { id, projectId };
      tasks.set(id, task);
      return task;
    },
    addQuery(id: string, taskId: string) {
      const query = { id, taskId };
      queries.set(id, query);
      return query;
    },
    addCapture(id: string, queryId: string, storagePath: string) {
      captures.set(id, { id, queryId, storagePath });
      files.add(storagePath);
    },
    ownedTask(userId: string, taskId: string) {
      const task = tasks.get(taskId);
      const project = task && projects.get(task.projectId);
      if (!task || project?.ownerId !== userId) throw new Error("not found");
      return task;
    },
    ownedProject(userId: string, projectId: string) {
      const project = projects.get(projectId);
      if (!project || project.ownerId !== userId) throw new Error("not found");
      return project;
    },
  };
}

test("删除空 Task", async () => {
  const state = model();
  state.addProject("project");
  const task = state.addTask("task", "project");
  await deleteTaskHierarchy(task, state.taskOperations);
  assert.equal(state.tasks.has(task.id), false);
});

test("删除含 Query 但无 Capture 的 Task", async () => {
  const state = model();
  state.addProject("project");
  const task = state.addTask("task", "project");
  state.addQuery("query", task.id);
  await deleteTaskHierarchy(task, state.taskOperations);
  assert.equal(state.tasks.size, 0);
  assert.equal(state.queries.size, 0);
});

test("删除含 Capture 的 Task 会清理私有文件且不影响其他 Task", async () => {
  const state = model();
  state.addProject("project");
  const removed = state.addTask("removed", "project");
  const retained = state.addTask("retained", "project");
  const removedQuery = state.addQuery("removed-query", removed.id);
  const retainedQuery = state.addQuery("retained-query", retained.id);
  state.addCapture(
    "removed-capture",
    removedQuery.id,
    "owner/project/removed/file.pdf",
  );
  state.addCapture(
    "retained-capture",
    retainedQuery.id,
    "owner/project/retained/file.pdf",
  );

  await deleteTaskHierarchy(removed, state.taskOperations);
  assert.equal(state.tasks.has(removed.id), false);
  assert.equal(state.files.has("owner/project/removed/file.pdf"), false);
  assert.equal(state.captures.has("removed-capture"), false);
  assert.equal(state.tasks.has(retained.id), true);
  assert.equal(state.queries.has(retainedQuery.id), true);
  assert.equal(state.files.has("owner/project/retained/file.pdf"), true);
});

test("删除空 Project", async () => {
  const state = model();
  const project = state.addProject("project");
  await deleteProjectHierarchy(project, state.projectOperations);
  assert.equal(state.projects.has(project.id), false);
});

test("删除完整 Project 层级会清理所有 Capture 文件", async () => {
  const state = model();
  const project = state.addProject("project");
  for (let index = 1; index <= 3; index += 1) {
    const task = state.addTask(`task-${index}`, project.id);
    const query = state.addQuery(`query-${index}`, task.id);
    state.addCapture(
      `capture-${index}`,
      query.id,
      `owner/project/task-${index}/file.pdf`,
    );
  }
  await deleteProjectHierarchy(project, state.projectOperations);
  assert.equal(state.projects.size, 0);
  assert.equal(state.tasks.size, 0);
  assert.equal(state.queries.size, 0);
  assert.equal(state.captures.size, 0);
  assert.equal(state.files.size, 0);
});

test("文件清理失败时保留父级并可安全重试", async () => {
  const state = model();
  state.addProject("project");
  const task = state.addTask("task", "project");
  const query = state.addQuery("query", task.id);
  const path = "owner/project/task/file.pdf";
  state.addCapture("capture", query.id, path);
  state.failOn(path);
  await assert.rejects(
    deleteTaskHierarchy(task, state.taskOperations),
    /storage unavailable/,
  );
  assert.equal(state.tasks.has(task.id), true);
  assert.equal(state.queries.has(query.id), true);
  assert.equal(state.captures.has("capture"), true);
  assert.equal(state.files.has(path), true);

  state.failOn(null);
  await deleteTaskHierarchy(task, state.taskOperations);
  await deleteTaskHierarchy(task, state.taskOperations);
  assert.equal(state.tasks.has(task.id), false);
  assert.equal(state.files.has(path), false);
});

test("账号 B 不能取得账号 A 的 Task 或 Project 删除入口", () => {
  const state = model();
  const project = state.addProject("project", "owner-a");
  const task = state.addTask("task", project.id);
  assert.throws(() => state.ownedTask("owner-b", task.id), /not found/);
  assert.throws(() => state.ownedProject("owner-b", project.id), /not found/);
  assert.equal(state.tasks.has(task.id), true);
  assert.equal(state.projects.has(project.id), true);
});

test("批量删除空 Task、Query Task 和 Capture Task，不影响未选 Task", async () => {
  const state = model();
  state.addProject("project");
  const empty = state.addTask("empty", "project");
  const withQuery = state.addTask("with-query", "project");
  state.addQuery("query-only", withQuery.id);
  const withCapture = state.addTask("with-capture", "project");
  const capturedQuery = state.addQuery("captured-query", withCapture.id);
  state.addCapture("capture", capturedQuery.id, "owner/project/capture.pdf");
  const retained = state.addTask("retained", "project");

  const result = await deleteTasksSequentially(
    [empty.id, withQuery.id, withCapture.id],
    async (taskId) => {
      const task = state.ownedTask("owner-a", taskId);
      await deleteTaskHierarchy(task, state.taskOperations);
    },
  );
  assert.deepEqual(result.deletedIds, [empty.id, withQuery.id, withCapture.id]);
  assert.deepEqual(result.failedIds, []);
  assert.equal(state.tasks.has(retained.id), true);
  assert.equal(state.tasks.size, 1);
  assert.equal(state.queries.size, 0);
  assert.equal(state.captures.size, 0);
  assert.equal(state.files.size, 0);
});

test("批量删除部分失败会准确返回数量，失败项可安全重试", async () => {
  const state = model();
  state.addProject("project");
  const succeeded = state.addTask("succeeded", "project");
  const failed = state.addTask("failed", "project");
  const query = state.addQuery("query", failed.id);
  const path = "owner/project/failed.pdf";
  state.addCapture("capture", query.id, path);
  state.failOn(path);

  const remove = async (taskId: string) => {
    const task = state.ownedTask("owner-a", taskId);
    await deleteTaskHierarchy(task, state.taskOperations);
  };
  const first = await deleteTasksSequentially(
    [succeeded.id, succeeded.id, failed.id],
    remove,
  );
  assert.deepEqual(first.deletedIds, [succeeded.id]);
  assert.deepEqual(first.failedIds, [failed.id]);
  assert.equal(state.tasks.has(succeeded.id), false);
  assert.equal(state.tasks.has(failed.id), true);

  state.failOn(null);
  const retry = await deleteTasksSequentially(first.failedIds, remove);
  assert.deepEqual(retry.deletedIds, [failed.id]);
  assert.deepEqual(retry.failedIds, []);
  assert.equal(state.tasks.size, 0);
  assert.equal(state.files.size, 0);
});

test("账号 B 批量删除账号 A 的 Task 全部失败且不改变数据", async () => {
  const state = model();
  const project = state.addProject("project", "owner-a");
  const task = state.addTask("task", project.id);
  const result = await deleteTasksSequentially([task.id], async (taskId) => {
    state.ownedTask("owner-b", taskId);
  });
  assert.deepEqual(result.deletedIds, []);
  assert.deepEqual(result.failedIds, [task.id]);
  assert.equal(state.tasks.has(task.id), true);
});
