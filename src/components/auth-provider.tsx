"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getSupabase } from "@/lib/supabase";
import {
  registrationErrorMessage,
  registrationValidationError,
  type AuthMode,
} from "@/lib/auth";
import { usePathname } from "next/navigation";
import { LegalTraceLanding } from "./legaltrace-landing";
import { WorkspaceShell } from "./workspace-shell";

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
  const pathname = usePathname();
  const [showLanding, setShowLanding] = useState(true);
  const [db] = useState(getSupabase);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [notice, setNotice] = useState("");
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
  if (!session && showLanding && pathname === "/")
    return <LegalTraceLanding onLogin={() => setShowLanding(false)} />;
  if (!session)
    return (
      <main className="lt-auth">
        <header className="lt-auth-header">
          <button
            onClick={() => setShowLanding(true)}
            hidden={pathname !== "/"}
          >
            返回首页
          </button>
        </header>
        <div className="lt-auth-content">
          <div className="lt-auth-monogram">LT</div>
          <h1>欢迎</h1>
          <p className="lt-auth-subtitle">
            {authMode === "login" ? (
              <>
                登录到 LegalTrace
                <br />
                以继续核查。
              </>
            ) : (
              "注册账号以开始使用 LegalTrace"
            )}
          </p>
          <form
            className="lt-auth-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setError("");
              setNotice("");
              const values = new FormData(event.currentTarget);
              const email = String(values.get("email")).trim();
              const password = String(values.get("password"));
              if (authMode === "register") {
                const validationError = registrationValidationError(
                  password,
                  String(values.get("passwordConfirmation")),
                );
                if (validationError) {
                  setError(validationError);
                  return;
                }
              }
              setBusy(true);
              try {
                if (authMode === "login") {
                  const { error } = await db.auth.signInWithPassword({
                    email,
                    password,
                  });
                  if (error)
                    setError("登录失败，请检查邮箱、密码及账号是否已确认。");
                } else {
                  const { data, error } = await db.auth.signUp({
                    email,
                    password,
                  });
                  if (error) {
                    setError(registrationErrorMessage(error));
                  } else if (data.session) {
                    setSession(data.session);
                  } else {
                    setNotice("注册成功，请前往邮箱完成确认后再登录。");
                  }
                }
              } catch {
                setError(
                  authMode === "login"
                    ? "登录失败，请检查网络后重试。"
                    : "注册失败，请检查网络后重试。",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="lt-floating-label">
              <span>邮箱</span>
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
              />
            </label>
            <label className="lt-floating-label">
              <span>密码</span>
              <input
                name="password"
                type="password"
                autoComplete={
                  authMode === "login" ? "current-password" : "new-password"
                }
                required
              />
            </label>
            {authMode === "register" && (
              <label className="lt-floating-label">
                <span>确认密码</span>
                <input
                  name="passwordConfirmation"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </label>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-sm text-emerald-700">
                {notice}
              </p>
            )}
            <button className="btn primary w-full" disabled={busy}>
              {busy
                ? authMode === "login"
                  ? "登录中…"
                  : "注册中…"
                : authMode === "login"
                  ? "登录"
                  : "注册"}
            </button>
          </form>
          <div className="lt-auth-modes" aria-label="账号操作">
            {(["login", "register"] as const)
              .filter((mode) => mode !== authMode)
              .map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`btn ${authMode === mode ? "primary" : "ghost"}`}
                  aria-pressed={authMode === mode}
                  disabled={busy}
                  onClick={() => {
                    setAuthMode(mode);
                    setError("");
                    setNotice("");
                  }}
                >
                  {mode === "login" ? "登录" : "注册"}
                </button>
              ))}
          </div>
        </div>
      </main>
    );
  return (
    <AuthContext.Provider
      key={session.user.id}
      value={{ db, userId: session.user.id }}
    >
      <WorkspaceShell
        db={db}
        email={session.user.email}
        logout={
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
        }
      >
        {error && (
          <p role="alert" className="error mx-auto max-w-7xl">
            {error}
          </p>
        )}
        {children}
      </WorkspaceShell>
    </AuthContext.Provider>
  );
}
