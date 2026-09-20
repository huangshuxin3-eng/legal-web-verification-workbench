"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getSupabase } from "@/lib/supabase";
import Link from "next/link";

const AuthContext = createContext<{
  db: SupabaseClient<Database>;
  userId: string;
} | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is required");
  return value;
}
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [db] = useState(getSupabase);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!db) return;
    let active = true;
    const {
      data: { subscription },
    } = db.auth.onAuthStateChange((_event, next) => {
      if (active) {
        setSession(next);
        setLoading(false);
      }
    });
    db.auth
      .getSession()
      .then(({ data, error }) => {
        if (active) {
          setSession(data.session);
          setLoading(false);
          if (error) setError("登录状态读取失败，请重新登录。");
        }
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setError("无法连接登录服务，请刷新重试。");
        }
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [db]);
  if (!db)
    return (
      <main className="mx-auto mt-24 max-w-lg panel p-8">
        <h1 className="text-xl font-semibold">配置非诉网核工作台</h1>
        <p className="mt-4 text-sm text-slate-600">
          请按 README 配置 Supabase 环境变量并执行数据库迁移，然后重新启动应用。
        </p>
      </main>
    );
  if (loading)
    return (
      <main className="p-12 text-slate-500" role="status">
        正在读取登录状态…
      </main>
    );
  if (!session)
    return (
      <main className="mx-auto mt-20 max-w-sm px-4">
        <div className="panel p-7">
          <p className="text-xs font-semibold tracking-widest text-blue-700">
            LEGAL WEB CHECK
          </p>
          <h1 className="mt-3 text-2xl font-semibold">非诉网核工作台</h1>
          <p className="mt-2 text-sm text-slate-500">
            登录后管理项目与核查任务
          </p>
          <form
            className="mt-8 space-y-5"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              const values = new FormData(event.currentTarget);
              try {
                const { error } = await db.auth.signInWithPassword({
                  email: String(values.get("email")).trim(),
                  password: String(values.get("password")),
                });
                if (error)
                  setError("登录失败，请检查邮箱、密码及账号是否已确认。");
              } catch {
                setError("登录失败，请检查网络后重试。");
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              邮箱
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="btn primary w-full" disabled={busy}>
              {busy ? "登录中…" : "登录"}
            </button>
          </form>
        </div>
      </main>
    );
  return (
    <AuthContext.Provider
      key={session.user.id}
      value={{ db, userId: session.user.id }}
    >
      <header className="border-b border-slate-200/80 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-6 py-3.5">
          <Link
            href="/"
            className="text-sm font-semibold tracking-tight text-slate-900"
          >
            非诉网核工作台
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden max-w-64 truncate text-xs text-slate-400 sm:inline">
              {session.user.email}
            </span>
            <button
              className="btn ghost h-8 px-3 text-xs text-slate-500"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const { error } = await db.auth.signOut({ scope: "local" });
                  if (error) setError("退出失败，请重试。");
                } catch {
                  setError("退出失败，请重试。");
                } finally {
                  setBusy(false);
                }
              }}
            >
              退出登录
            </button>
          </div>
        </div>
      </header>
      {error && (
        <p role="alert" className="error mx-auto max-w-7xl">
          {error}
        </p>
      )}
      {children}
    </AuthContext.Provider>
  );
}
