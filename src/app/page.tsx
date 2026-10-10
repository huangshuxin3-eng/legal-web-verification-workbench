"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import { ProjectForm } from "@/components/project-form";
import type { Project } from "@/lib/database.types";
import { dateLabel, errorMessage } from "@/lib/tasks";
import { LegalTraceIcon } from "@/components/legaltrace-icon";
import { useRouter } from "next/navigation";
type ProjectRow = Project & { tasks: { count: number }[] };
export default function ProjectsPage() {
  const router = useRouter();
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
    <main className="lt-welcome">
      <div className="lt-welcome-content">
        <h1>欢迎使用 LegalTrace</h1>
        <p className="lt-welcome-description">
          从一个项目开始，让每项核查有据可查。
        </p>
        <div className="lt-project-selector">
          <label htmlFor="project-choice">选择项目</label>
          <select
            id="project-choice"
            defaultValue=""
            disabled={loading}
            onChange={(event) => {
              if (event.target.value)
                router.push(`/projects/${event.target.value}`);
            }}
          >
            <option value="">请选择一个项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={() => setCreating(true)}>
            添加项目
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
          <section className="lt-welcome-projects" aria-label="已有项目">
            <h2>你的项目</h2>
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="lt-welcome-project"
              >
                <LegalTraceIcon name="briefcase" />
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {p.code ? `${p.code} · ` : ""}
                    {p.tasks[0]?.count ?? 0} 项核查任务 ·{" "}
                    {dateLabel(p.created_at)}
                  </small>
                </span>
              </Link>
            ))}
          </section>
        )}
        <p className="lt-welcome-note">
          公开信息查询 · 证据留存 · 人工复核 · 报告交付
        </p>
      </div>
      {creating && <ProjectForm onClose={() => setCreating(false)} />}
    </main>
  );
}
