"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "./auth-provider";
import { TaskForm } from "./task-form";
import { TaskDrawer } from "./task-drawer";
import type { Project, Task, TaskStatus } from "@/lib/database.types";
import { errorMessage, statusLabels, type TaskInput } from "@/lib/tasks";
import { taskCaptureCounts, type TaskWithQueryCount } from "@/lib/queries";

export function ProjectWorkspace({ projectId }: { projectId: string }) {
  const { db } = useAuth();
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
  const filtered = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (!status || task.status === status) &&
          (!entity || task.entity_name === entity) &&
          (!topic || task.topic === topic) &&
          [task.entity_name, task.topic, task.source_name].some((value) =>
            value
              .toLocaleLowerCase()
              .includes(search.trim().toLocaleLowerCase()),
          ),
      ),
    [tasks, status, entity, topic, search],
  );
  const selectedTask = tasks.find((task) => task.id === selected);
  const completed = tasks.filter((task) => task.status === "completed").length;
  async function save(input: TaskInput) {
    const result =
      editor === "new"
        ? await db
            .from("tasks")
            .insert({ ...input, project_id: projectId })
            .select("*, queries(count)")
            .single()
        : await db
            .from("tasks")
            .update(input)
            .eq("id", editor!.id)
            .eq("project_id", projectId)
            .select("*, queries(count)")
            .single();
    if (result.error) throw result.error;
    const saved = {
      ...result.data,
      capture_count:
        tasks.find((t) => t.id === result.data.id)?.capture_count ?? 0,
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
        <button
          className="btn primary"
          onClick={() => setEditor("new")}
          disabled={!!pending}
        >
          ＋ 新增 Task
        </button>
      </div>
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
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          状态
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
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
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
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
          <select value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">全部事项</option>
            {[...new Set(tasks.map((t) => t.topic))].sort().map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </section>
      <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
        <span>
          显示 {filtered.length} / {tasks.length} 项 Task
        </span>
        {(search || status || entity || topic) && (
          <button
            onClick={() => {
              setSearch("");
              setStatus("");
              setEntity("");
              setTopic("");
            }}
          >
            清除筛选
          </button>
        )}
      </div>
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
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
            {filtered.map((task) => (
              <tr
                key={task.id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => setSelected(task.id)}
              >
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
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="p-14 text-center text-sm text-slate-500">
            {tasks.length === 0
              ? "还没有 Task，点击“新增 Task”开始。"
              : "没有匹配的 Task，请调整筛选条件。"}
          </div>
        )}
      </div>
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
        />
      )}
      {editor && (
        <TaskForm
          task={editor === "new" ? undefined : editor}
          onClose={() => setEditor(null)}
          onSave={save}
        />
      )}
    </main>
  );
}
