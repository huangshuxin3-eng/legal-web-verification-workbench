"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Project } from "@/lib/database.types";
import { LegalTraceIcon } from "./legaltrace-icon";
import { ProjectForm } from "./project-form";

export function WorkspaceShell({
  db,
  email,
  logout,
  children,
}: {
  db: SupabaseClient<Database>;
  email?: string;
  logout: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const projectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const [collapsed, setCollapsed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [projects, setProjects] = useState<Pick<Project, "id" | "name">[]>([]);
  const [navigationError, setNavigationError] = useState(false);
  useEffect(() => {
    let active = true;
    async function loadNavigation() {
      try {
        const all: Pick<Project, "id" | "name">[] = [];
        for (let offset = 0; ; offset += 500) {
          const { data, error } = await db
            .from("projects")
            .select("id, name")
            .order("created_at", { ascending: false })
            .order("id")
            .range(offset, offset + 499);
          if (error) throw error;
          all.push(...data);
          if (data.length < 500) break;
        }
        if (active) {
          setProjects(all);
          setNavigationError(false);
        }
      } catch {
        if (active) setNavigationError(true);
      }
    }
    void loadNavigation();
    return () => {
      active = false;
    };
  }, [db, pathname]);
  const compact = projectId ? !collapsed : collapsed;
  return (
    <div className={`lt-workspace ${compact ? "is-compact" : ""}`}>
      <aside className="lt-sidebar">
        <div className="lt-sidebar-top">
          <Link href="/" className="lt-wordmark">
            {compact ? "LT" : "LegalTrace"}
          </Link>
          <button
            className="icon-button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={compact ? "展开项目侧栏" : "收起项目侧栏"}
          >
            <LegalTraceIcon name="collapse" />
          </button>
        </div>
        <Link
          href="/"
          className="lt-sidebar-home"
          aria-current={!projectId ? "page" : undefined}
          title="工作台首页"
        >
          <LegalTraceIcon name="home" />
          <span>工作台首页</span>
        </Link>
        <div className="lt-sidebar-heading">
          <span>项目</span>
          <button
            className="icon-button"
            onClick={() => setCreating(true)}
            aria-label="添加项目"
          >
            <LegalTraceIcon name="plus" />
          </button>
        </div>
        <nav aria-label="项目列表">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className={`lt-sidebar-project ${p.id === projectId ? "active" : ""}`}
              title={p.name}
              aria-current={p.id === projectId ? "page" : undefined}
            >
              <LegalTraceIcon name="briefcase" />
              <span>{p.name}</span>
            </Link>
          ))}
          {navigationError && (
            <Link
              className="lt-nav-error"
              href="/"
              title="项目导航加载失败，返回项目列表"
            >
              项目列表
            </Link>
          )}
        </nav>
        <div className="lt-sidebar-bottom">
          <div className="lt-profile">
            <span className="lt-avatar">LT</span>
            <div>
              <span title={email}>{email || "工作区"}</span>
              <small>LegalTrace 工作区</small>
            </div>
          </div>
          {logout}
        </div>
      </aside>
      <div className="lt-workspace-content">{children}</div>
      {creating && <ProjectForm onClose={() => setCreating(false)} />}
    </div>
  );
}
