"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "./auth-provider";
import type { Query, Task } from "@/lib/database.types";
import { dateLabel, errorMessage } from "@/lib/tasks";
import {
  queryLabel,
  taskCaptureCounts,
  type TaskWithQueryCount,
  type QueryWithCaptureCount,
} from "@/lib/queries";
import { CaptureSection } from "./capture-section";
import { captureRequest, CaptureClientError } from "@/lib/capture-client";

export function QuerySection({
  task,
  onTaskUpdated,
  onBusyChange,
}: {
  task: Task;
  onTaskUpdated: (task: TaskWithQueryCount) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { db } = useAuth();
  const taskId = task.id;
  const [queries, setQueries] = useState<QueryWithCaptureCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Query | "new" | null>(null);
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState<Query | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const updatedRef = useRef(onTaskUpdated);
  updatedRef.current = onTaskUpdated;

  const refresh = useCallback(async () => {
    const rows: QueryWithCaptureCount[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db
        .from("queries")
        .select("*, captures(count)")
        .eq("task_id", taskId)
        .order("query_no")
        .range(offset, offset + 499);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 500) break;
    }
    const { data, error } = await db
      .from("tasks")
      .select("*, queries(count)")
      .eq("id", taskId)
      .single();
    if (error) throw error;
    setQueries(rows);
    const counts = await taskCaptureCounts(db, data.project_id, taskId);
    updatedRef.current({ ...data, capture_count: counts.get(taskId) ?? 0 });
  }, [db, taskId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await refresh();
    } catch (error) {
      setError(
        error instanceof CaptureClientError
          ? error.message
          : errorMessage(error),
      );
    } finally {
      setLoading(false);
    }
  }, [refresh]);
  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(action: () => Promise<void>, success: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      await action();
      setEditor(null);
      setDeleting(null);
      setText("");
      setNotice(success);
      try {
        await refresh();
      } catch {
        setError(
          "操作已保存，但列表刷新失败。请点击“刷新查询”，不要重复提交。",
        );
      }
    } catch (error) {
      setError(
        error instanceof CaptureClientError
          ? error.message
          : errorMessage(error),
      );
    } finally {
      lock.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <section
      className="mt-8 border-t border-slate-200 pt-6"
      aria-label="查询记录"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">查询记录</h2>
        <button
          type="button"
          className="btn"
          disabled={busy || loading || !!editor || !!deleting}
          onClick={() => {
            setEditor("new");
            setText("");
            setNotice("");
            setError("");
          }}
        >
          ＋ 新增查询
        </button>
      </div>
      {error && (
        <div className="error mt-4" role="alert">
          {error}{" "}
          <button
            className="underline"
            disabled={busy || loading}
            onClick={load}
          >
            刷新查询
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {editor && (
        <form
          className="mt-4 space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const content = text.trim();
            if (!content) {
              setError("请填写查询内容，不能只输入空格。");
              return;
            }
            void mutate(
              async () => {
                const result =
                  editor === "new"
                    ? await db
                        .from("queries")
                        .insert({ task_id: taskId, query_text: content })
                        .select("*, captures(count)")
                        .single()
                    : await db
                        .from("queries")
                        .update({ query_text: content })
                        .eq("id", editor.id)
                        .eq("task_id", taskId)
                        .select("*, captures(count)")
                        .single();
                if (result.error) throw result.error;
                setQueries((previous) =>
                  editor === "new"
                    ? [...previous, result.data]
                    : previous.map((q) =>
                        q.id === result.data.id ? result.data : q,
                      ),
                );
              },
              editor === "new" ? "查询已新增。" : "查询已更新。",
            );
          }}
        >
          <label>
            {editor === "new"
              ? "查询内容 / 查询条件"
              : `编辑 ${queryLabel(editor.query_no)}`}
            <textarea
              required
              autoFocus
              rows={3}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              placeholder="例如：申请人 = XX科技有限公司"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setEditor(null);
                setError("");
              }}
            >
              取消
            </button>
            <button className="btn primary" disabled={busy}>
              {busy ? "保存中…" : "保存查询"}
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <p role="status" className="py-6 text-sm text-slate-500">
          正在加载查询…
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {queries.map((query) => (
            <article
              key={query.id}
              className="rounded-lg border border-slate-200 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-blue-700">
                  {queryLabel(query.query_no)}
                </h3>
                <time
                  dateTime={query.created_at}
                  className="text-xs text-slate-500"
                >
                  {dateLabel(query.created_at)}
                </time>
              </div>
              <p className="my-3 whitespace-pre-wrap break-words text-sm">
                {query.query_text}
              </p>
              <div className="flex gap-4 text-sm">
                <button
                  disabled={busy || !!editor || !!deleting}
                  onClick={() => {
                    setEditor(query);
                    setText(query.query_text);
                    setError("");
                    setNotice("");
                  }}
                  className="text-blue-700"
                >
                  编辑
                </button>
                <button
                  disabled={busy || !!editor || !!deleting}
                  onClick={() => {
                    setDeleting(query);
                    setNotice("");
                    setError("");
                  }}
                  className="text-red-700"
                >
                  删除
                </button>
              </div>
              {deleting?.id === query.id && (
                <div
                  role="group"
                  aria-label={`确认删除 ${queryLabel(query.query_no)}`}
                  className="mt-4 rounded-lg bg-red-50 p-3"
                >
                  <p className="text-sm">
                    确定删除 {queryLabel(query.query_no)}
                    ？将一并删除该查询的所有留痕文件，删除后无法恢复，此编号不会复用。
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => setDeleting(null)}
                    >
                      取消
                    </button>
                    <button
                      className="btn text-red-700"
                      disabled={busy}
                      onClick={() =>
                        void mutate(async () => {
                          await captureRequest(db, `/api/queries/${query.id}`, {
                            method: "DELETE",
                          });
                          setQueries((previous) =>
                            previous.filter((q) => q.id !== query.id),
                          );
                        }, "查询已删除。")
                      }
                    >
                      {busy ? "删除中…" : "确认删除"}
                    </button>
                  </div>
                </div>
              )}
              <CaptureSection
                query={query}
                task={task}
                disabled={busy || !!editor || !!deleting}
                onChanged={refresh}
                onBusyChange={(value) => {
                  setBusy(value);
                  onBusyChange(value);
                }}
              />
            </article>
          ))}
          {!queries.length && !error && (
            <p className="py-4 text-sm text-slate-500">
              还没有查询记录，点击“新增查询”记录具体查询条件。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
