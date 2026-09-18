"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth-provider";
import { TaskForm } from "./task-form";
import { TaskDrawer } from "./task-drawer";
import type { Project, Task, TaskStatus } from "@/lib/database.types";
import { errorMessage, statusLabels, type TaskInput } from "@/lib/tasks";
import { taskCaptureCounts, type TaskWithQueryCount } from "@/lib/queries";
import { createTask, updateTask } from "@/lib/task-repository";
import { ProjectDeleteDialog } from "./project-delete-dialog";
import { ProjectExportDialog } from "./project-export-dialog";
import { ProjectReportDialog } from "./project-report-dialog";
import { isReportTask } from "@/lib/report-names";
import { TaskDeleteDialog } from "./task-delete-dialog";
import {
  TaskBatchDeleteDialog,
  type BatchTaskDeleteResult,
} from "./task-batch-delete-dialog";
import {
  retainVisibleSelection,
  selectVisibleTasks,
  toggleTaskSelection,
} from "@/lib/task-selection";
import { sortTasksCanonical, taskSequenceMap } from "@/lib/task-order";
import {
  filterTasks,
  paginateTasks,
  TASK_PAGE_SIZES,
  type TaskPageSize,
} from "@/lib/task-view";

export function ProjectWorkspace({
  projectId,
  batchResult,
}: {
  projectId: string;
  batchResult?: { created: number; skipped: number };
}) {
  const { db } = useAuth();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<TaskWithQueryCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<Task | "new" | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [entity, setEntity] = useState("");
  const [topic, setTopic] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "warning">(
    "success",
  );
  const [projectMenu, setProjectMenu] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deletingTask, setDeletingTask] = useState<TaskWithQueryCount | null>(
    null,
  );
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<TaskPageSize>(25);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data: project, error } = await db
        .from("projects")
        .select("*")
        .eq("id", projectId)
        .single();
      if (error) throw error;
      const all: Omit<TaskWithQueryCount, "capture_count">[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await db
          .from("tasks")
          .select("*, queries(count)")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .order("id")
          .range(offset, offset + 499);
        if (error) throw error;
        all.push(...data);
        if (data.length < 500) break;
      }
      setProject(project);
      const counts = await taskCaptureCounts(db, projectId);
      setTasks(
        all.map((task) => ({
          ...task,
          capture_count: counts.get(task.id) ?? 0,
        })),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [db, projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  const orderedTasks = useMemo(() => sortTasksCanonical(tasks), [tasks]);
  const sequenceByTask = useMemo(() => taskSequenceMap(tasks), [tasks]);
  const filtered = useMemo(
    () => filterTasks(orderedTasks, { search, status, entity, topic }),
    [orderedTasks, search, status, entity, topic],
  );
  const pagination = useMemo(
    () => paginateTasks(filtered, page, pageSize),
    [filtered, page, pageSize],
  );
  const pageTasks = pagination.items;
  const visibleTaskIds = useMemo(
    () => pageTasks.map((task) => task.id),
    [pageTasks],
  );
  useEffect(() => {
    if (page !== pagination.page) setPage(pagination.page);
  }, [page, pagination.page]);
  useEffect(() => {
    setSelectedTaskIds((current) => {
      const next = retainVisibleSelection(current, visibleTaskIds);
      return next.size === current.size ? current : next;
    });
  }, [visibleTaskIds]);
  const selectedTasks = pageTasks.filter((task) =>
    selectedTaskIds.has(task.id),
  );
  const allVisibleSelected =
    pageTasks.length > 0 && selectedTasks.length === pageTasks.length;
  const selectedTask = tasks.find((task) => task.id === selected);
  const completed = tasks.filter((task) => task.status === "completed").length;
  const createdNotice = batchResult?.created ?? 0;
  const skippedNotice = batchResult?.skipped ?? 0;
  const projectCounts = {
    tasks: tasks.length,
    queries: tasks.reduce(
      (sum, task) => sum + (task.queries[0]?.count ?? 0),
      0,
    ),
    captures: tasks.reduce((sum, task) => sum + task.capture_count, 0),
  };
  const exportableTasks = tasks.filter((task) => task.capture_count > 0);
  const exportCounts = {
    entities: new Set(exportableTasks.map((task) => task.entity_name)).size,
    tasks: exportableTasks.length,
    captures: exportableTasks.reduce(
      (sum, task) => sum + task.capture_count,
      0,
    ),
  };
  // 「生成尽调报告」只做 coarse check：范围内是否有 Task、是否有留痕。
  // 是否存在详情页、能否完整解析、是否跨核查日，一律由服务端 authoritative 判定。
  const reportTasks = tasks.filter(isReportTask);
  const reportCaptureCount = reportTasks.reduce(
    (sum, task) => sum + task.capture_count,
    0,
  );
  const reportBlockedReason = reportTasks.length
    ? reportCaptureCount
      ? ""
      : "执行留痕尚未产生，请先完成网核"
    : "当前项目没有中国执行信息公开网的执行任务";
  async function save(input: TaskInput) {
    const data =
      editor === "new"
        ? await createTask(db, projectId, input)
        : await updateTask(db, projectId, editor!.id, input);
    const saved = {
      ...data,
      capture_count: tasks.find((t) => t.id === data.id)?.capture_count ?? 0,
    };
    setTasks((previous) =>
      editor === "new"
        ? [saved, ...previous]
        : previous.map((task) => (task.id === saved.id ? saved : task)),
    );
    setEditor(null);
  }
  async function changeStatus(task: Task, status: TaskStatus) {
    if (pending) return;
    setPending(task.id);
    setError("");
    try {
      const { data, error } = await db
        .from("tasks")
        .update({ status })
        .eq("id", task.id)
        .eq("project_id", projectId)
        .select("*, queries(count)")
        .single();
      if (error) throw error;
      setTasks((previous) =>
        previous.map((t) =>
          t.id === data.id ? { ...data, capture_count: t.capture_count } : t,
        ),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }
  function handleTaskDeleted(taskId: string) {
    setTasks((previous) => previous.filter((task) => task.id !== taskId));
    setSelected((current) => (current === taskId ? null : current));
    setDeletingTask(null);
    setPending(null);
    setNoticeTone("success");
    setNotice("任务已永久删除。");
  }
  function handleBatchDeleted(result: BatchTaskDeleteResult) {
    const deleted = new Set(result.deletedIds);
    const failed = new Set(result.failedIds);
    setTasks((previous) => previous.filter((task) => !deleted.has(task.id)));
    setSelectedTaskIds(failed);
    setSelected((current) =>
      current && deleted.has(current) ? null : current,
    );
    setBatchDeleteOpen(false);
    setNoticeTone(result.failedIds.length ? "warning" : "success");
    setNotice(
      result.failedIds.length
        ? `已删除 ${result.deletedIds.length} 个任务，${result.failedIds.length} 个任务删除失败，请重试。`
        : `已删除 ${result.deletedIds.length} 个任务。`,
    );
  }
  if (loading)
    return (
      <main className="p-12" role="status">
        正在加载项目…
      </main>
    );
  if (!project)
    return (
      <main className="mx-auto max-w-7xl p-8">
        <p role="alert" className="error">
          {error || "项目不存在或无权访问。"}
        </p>
        <div className="mt-4 flex gap-4">
          <Link className="btn" href="/">
            返回项目列表
          </Link>
          <button className="btn" onClick={load}>
            重试
          </button>
        </div>
      </main>
    );
  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <Link className="text-sm text-slate-500 hover:text-blue-700" href="/">
        ← 我的项目
      </Link>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="break-words text-2xl font-semibold">{project.name}</h1>
          <p className="mt-2 text-sm text-slate-500">
            项目编号：{project.code || "未填写"}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            className="btn"
            disabled={!!reportBlockedReason}
            title={reportBlockedReason || undefined}
            onClick={() => setReportOpen(true)}
          >
            生成尽调报告
          </button>
          <button className="btn" onClick={() => setExportOpen(true)}>
            导出网核成果
          </button>
          <Link className="btn" href={`/projects/${projectId}/tasks/generate`}>
            批量生成任务
          </Link>
          <button
            className="btn primary"
            onClick={() => setEditor("new")}
            disabled={!!pending}
          >
            ＋ 新增 Task
          </button>
          <div className="relative">
            <button
              className="btn"
              aria-label="项目操作"
              aria-expanded={projectMenu}
              onClick={() => setProjectMenu((open) => !open)}
            >
              …
            </button>
            {projectMenu && (
              <div className="absolute right-0 z-10 mt-2 w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                <button
                  className="w-full rounded-md px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50"
                  onClick={() => {
                    setProjectMenu(false);
                    setDeletingProject(true);
                  }}
                >
                  删除项目
                </button>
              </div>
            )}
          </div>
          {reportBlockedReason && (
            <span className="self-center text-xs text-amber-700">
              {reportBlockedReason}
            </span>
          )}
        </div>
      </div>
      {(createdNotice > 0 || skippedNotice > 0) && (
        <p
          className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
          role="status"
        >
          已创建 {createdNotice} 个核查任务，跳过 {skippedNotice} 个已有任务。
        </p>
      )}
      {notice && (
        <p
          className={`fixed right-6 bottom-6 z-50 rounded-lg border px-5 py-3 text-sm shadow-lg ${
            noticeTone === "warning"
              ? "border-amber-300 bg-amber-50 text-amber-900"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
          role="status"
        >
          {notice}
        </p>
      )}
      <div className="my-7 flex flex-wrap gap-x-8 gap-y-2 border-y border-slate-200 py-4 text-sm">
        <span>
          Task 总数 <b className="ml-2 text-lg">{tasks.length}</b>
        </span>
        <span>
          已完成 <b className="ml-2 text-lg text-emerald-700">{completed}</b>
        </span>
        <span>
          未完成 <b className="ml-2 text-lg">{tasks.length - completed}</b>
        </span>
      </div>
      {error && (
        <p className="error mb-5" role="alert">
          {error}{" "}
          <button className="underline" onClick={load} disabled={!!pending}>
            刷新
          </button>
        </p>
      )}
      <section aria-label="任务筛选" className="mb-5 grid gap-3 md:grid-cols-4">
        <label>
          搜索
          <input
            placeholder="核查对象、事项或网站名称"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          状态
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          核查对象
          <select
            value={entity}
            onChange={(e) => {
              setEntity(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部对象</option>
            {[...new Set(tasks.map((t) => t.entity_name))]
              .sort()
              .map((value) => (
                <option key={value}>{value}</option>
              ))}
          </select>
        </label>
        <label>
          核查事项
          <select
            value={topic}
            onChange={(e) => {
              setTopic(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部事项</option>
            {[...new Set(tasks.map((t) => t.topic))].sort().map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </section>
      <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
        <span>
          显示 {pagination.start}–{pagination.end} / {filtered.length} 项 Task
        </span>
        {(search || status || entity || topic) && (
          <button
            onClick={() => {
              setSearch("");
              setStatus("");
              setEntity("");
              setTopic("");
              setPage(1);
            }}
          >
            清除筛选
          </button>
        )}
      </div>
      {selectedTasks.length > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm">
          <span>已选择 {selectedTasks.length} 个任务</span>
          <button
            className="font-medium text-red-700"
            onClick={() => setBatchDeleteOpen(true)}
          >
            批量删除
          </button>
        </div>
      )}
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[780px]">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="w-14">
                <span className="sr-only">选择</span>
                <input
                  ref={(input) => {
                    if (input)
                      input.indeterminate =
                        selectedTasks.length > 0 && !allVisibleSelected;
                  }}
                  className="h-4 w-4"
                  type="checkbox"
                  aria-label="选择当前页当前可见的全部任务"
                  checked={allVisibleSelected}
                  disabled={!pageTasks.length}
                  onChange={(event) =>
                    setSelectedTaskIds(
                      selectVisibleTasks(visibleTaskIds, event.target.checked),
                    )
                  }
                />
              </th>
              <th className="w-16">序号</th>
              <th className="w-40">状态</th>
              <th>核查对象</th>
              <th>核查事项</th>
              <th>核查网站</th>
              <th>Query 数量</th>
              <th>留痕数量</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageTasks.map((task) => (
              <tr
                key={task.id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => setSelected(task.id)}
              >
                <td onClick={(event) => event.stopPropagation()}>
                  <input
                    className="h-4 w-4"
                    type="checkbox"
                    aria-label={`选择 ${task.entity_name} ${task.topic}`}
                    checked={selectedTaskIds.has(task.id)}
                    onChange={(event) =>
                      setSelectedTaskIds((current) =>
                        toggleTaskSelection(
                          current,
                          task.id,
                          event.target.checked,
                        ),
                      )
                    }
                  />
                </td>
                <td className="text-slate-500">
                  {sequenceByTask.get(task.id)}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select
                    aria-label={`${task.entity_name} ${task.topic} 状态`}
                    value={task.status}
                    disabled={!!pending}
                    onChange={(e) =>
                      void changeStatus(task, e.target.value as TaskStatus)
                    }
                  >
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="font-medium break-words">{task.entity_name}</td>
                <td>{task.topic}</td>
                <td>{task.source_name}</td>
                <td>{task.queries[0]?.count ?? 0}</td>
                <td>{task.capture_count}</td>
                <td>
                  <div className="flex gap-4">
                    <button
                      className="text-blue-700"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(task.id);
                      }}
                    >
                      查看
                    </button>
                    <button
                      disabled={!!pending}
                      className="text-slate-600"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(null);
                        setEditor(task);
                      }}
                    >
                      编辑
                    </button>
                    <button
                      disabled={!!pending}
                      className="text-red-700"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeletingTask(task);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="p-14 text-center text-sm text-slate-500">
            {tasks.length === 0 ? (
              <div>
                <p className="font-medium text-slate-700">暂无核查任务</p>
                <div className="mt-4 flex justify-center gap-3">
                  <Link
                    className="btn primary"
                    href={`/projects/${projectId}/tasks/generate`}
                  >
                    批量生成任务
                  </Link>
                  <button className="btn" onClick={() => setEditor("new")}>
                    手动新建任务
                  </button>
                </div>
              </div>
            ) : (
              "没有匹配的 Task，请调整筛选条件。"
            )}
          </div>
        )}
      </div>
      {filtered.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <label className="flex items-center gap-2">
            每页数量
            <select
              className="w-24"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value) as TaskPageSize);
                setPage(1);
              }}
            >
              {TASK_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-3">
            <button
              className="btn"
              disabled={pagination.page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              上一页
            </button>
            <span>
              第 {pagination.page} / {pagination.totalPages} 页
            </span>
            <button
              className="btn"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() =>
                setPage((current) =>
                  Math.min(pagination.totalPages, current + 1),
                )
              }
            >
              下一页
            </button>
          </div>
        </div>
      )}
      {selectedTask && !editor && (
        <TaskDrawer
          key={selectedTask.id}
          task={selectedTask}
          onTaskUpdated={(updated) =>
            setTasks((previous) =>
              previous.map((task) => (task.id === updated.id ? updated : task)),
            )
          }
          onClose={() => setSelected(null)}
          onEdit={() => {
            setEditor(selectedTask);
          }}
          onDeleted={handleTaskDeleted}
        />
      )}
      {editor && (
        <TaskForm
          task={editor === "new" ? undefined : editor}
          onClose={() => setEditor(null)}
          onSave={save}
        />
      )}
      {deletingProject && (
        <ProjectDeleteDialog
          project={project}
          counts={projectCounts}
          onClose={() => setDeletingProject(false)}
          onDeleted={() => {
            router.push("/");
            router.refresh();
          }}
        />
      )}
      {deletingTask && (
        <TaskDeleteDialog
          task={deletingTask}
          onClose={() => setDeletingTask(null)}
          onBusyChange={(busy) => setPending(busy ? deletingTask.id : null)}
          onDeleted={handleTaskDeleted}
        />
      )}
      {batchDeleteOpen && selectedTasks.length > 0 && (
        <TaskBatchDeleteDialog
          tasks={selectedTasks}
          onClose={() => setBatchDeleteOpen(false)}
          onCompleted={handleBatchDeleted}
        />
      )}
      {reportOpen && (
        <ProjectReportDialog
          projectId={projectId}
          projectName={project.name}
          taskCount={reportTasks.length}
          captureCount={reportCaptureCount}
          onClose={() => setReportOpen(false)}
          onGenerated={() => {
            setReportOpen(false);
            setNoticeTone("success");
            setNotice("尽调报告已生成并开始下载。");
          }}
        />
      )}
      {exportOpen && (
        <ProjectExportDialog
          projectId={projectId}
          projectName={project.name}
          entityCount={exportCounts.entities}
          taskCount={exportCounts.tasks}
          captureCount={exportCounts.captures}
          onClose={() => setExportOpen(false)}
          onGenerated={() => {
            setExportOpen(false);
            setNoticeTone("success");
            setNotice("网核成果包已生成并开始下载。");
          }}
        />
      )}
    </main>
  );
}
