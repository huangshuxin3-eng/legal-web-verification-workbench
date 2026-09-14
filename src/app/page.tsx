"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import { ProjectForm } from "@/components/project-form";
import type { Project } from "@/lib/database.types";
import { dateLabel, errorMessage } from "@/lib/tasks";
type ProjectRow = Project & { tasks: { count: number }[] };
export default function ProjectsPage() {
  const { db } = useAuth();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const all: ProjectRow[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await db
          .from("projects")
          .select("*, tasks(count)")
          .order("created_at", { ascending: false })
          .order("id")
          .range(offset, offset + 499);
        if (error) throw error;
        all.push(...data);
        if (data.length < 500) break;
      }
      setProjects(all);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [db]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">工作空间</p>
          <h1 className="mt-1 text-2xl font-semibold">我的项目</h1>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          ＋ 新建项目
        </button>
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}{" "}
          <button className="underline" onClick={load}>
            重试
          </button>
        </div>
      ) : loading ? (
        <p role="status">正在加载项目…</p>
      ) : projects.length === 0 ? (
        <div className="panel p-16 text-center">
          <h2 className="font-medium">还没有项目</h2>
          <p className="mt-2 text-sm text-slate-500">
            新建项目，开始整理核查任务。
          </p>
        </div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th>项目名称</th>
                <th>项目编号</th>
                <th>Task 数量</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {projects.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium">{p.name}</td>
                  <td>{p.code || "—"}</td>
                  <td>{p.tasks[0]?.count ?? 0}</td>
                  <td className="whitespace-nowrap text-slate-500">
                    {dateLabel(p.created_at)}
                  </td>
                  <td>
                    <Link
                      className="whitespace-nowrap text-blue-700 hover:underline"
                      href={`/projects/${p.id}`}
                    >
                      进入项目 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <ProjectForm onClose={() => setCreating(false)} />}
    </main>
  );
}
