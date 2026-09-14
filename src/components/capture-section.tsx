"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "./auth-provider";
import type { Capture, Task } from "@/lib/database.types";
import type { QueryWithCaptureCount } from "@/lib/queries";
import {
  captureLabel,
  captureExtension,
  generatedCaptureName,
  MAX_CAPTURE_BYTES,
} from "@/lib/capture-names";
import {
  captureRequest,
  CaptureClientError,
  type UploadRecovery,
} from "@/lib/capture-client";
import { dateLabel, safeWebsite } from "@/lib/tasks";

export function CaptureSection({
  query,
  task,
  disabled,
  onChanged,
  onBusyChange,
}: {
  query: QueryWithCaptureCount;
  task: Task;
  disabled: boolean;
  onChanged: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const { db } = useAuth();
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState<UploadRecovery | null>(null);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(
    null,
  );
  const lock = useRef(false);
  const load = useCallback(async () => {
    const rows: Capture[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db
        .from("captures")
        .select("*")
        .eq("query_id", query.id)
        .order("capture_no")
        .range(offset, offset + 499);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 500) break;
    }
    setCaptures(rows);
  }, [db, query.id]);
  useEffect(() => {
    let active = true;
    void load()
      .catch(() => {
        if (active) setError("留痕列表加载失败，请重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  const filename = (capture: Capture) =>
    generatedCaptureName(
      { ...task, query_no: query.query_no, capture_no: capture.capture_no },
      captureExtension(capture.storage_path),
      new Date(capture.created_at),
    );

  async function action(operation: () => Promise<void>, success?: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      await operation();
      if (success) {
        setNotice(success);
        setAdding(false);
        setDeleting(null);
        try {
          await load();
          await onChanged();
        } catch {
          setError("操作已成功，但列表或统计刷新失败，请刷新，不要重复提交。");
        }
      }
    } catch (error) {
      setError(
        error instanceof CaptureClientError
          ? error.message
          : "操作失败，请检查网络后重试。",
      );
      if (error instanceof CaptureClientError && error.recovery)
        setRecovery(error.recovery);
    } finally {
      lock.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <section
      className="mt-4 border-t border-slate-100 pt-4"
      aria-label="留痕管理"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-slate-600">
          留痕 {query.captures[0]?.count ?? 0} 份
        </span>
        <button
          className="text-sm text-blue-700"
          disabled={disabled || loading || adding || !!recovery}
          onClick={() => setAdding(true)}
        >
          ＋ 添加留痕
        </button>
      </div>
      {(query.captures[0]?.count ?? 0) === 0 && (
        <p className="mt-2 text-xs text-amber-700">此查询尚未留痕。</p>
      )}
      {error && (
        <p className="error mt-3" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-2 text-xs text-emerald-700" role="status">
          {notice}
        </p>
      )}
      {Object.values(query.capture_operations ?? {})
        .filter((operation) => operation.id !== recovery?.captureId)
        .map((operation) => (
          <div
            key={operation.id}
            className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs"
          >
            <p>
              {operation.action === "delete"
                ? "留痕删除尚未完成"
                : "留痕上传尚未完成"}
              （编号 {captureLabel(operation.capture_no)}）。
            </p>
            <div className="mt-2 flex flex-wrap gap-3">
              {operation.action === "upload" && (
                <button
                  className="text-blue-700"
                  disabled={disabled}
                  onClick={() =>
                    void action(async () => {
                      await captureRequest(db, "/api/captures/recover", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          captureId: operation.id,
                          queryId: query.id,
                          mode: "finish",
                        }),
                      });
                    }, "上传已确认完成。")
                  }
                >
                  继续完成上传
                </button>
              )}
              <button
                className="text-red-700"
                disabled={disabled}
                onClick={() =>
                  void action(async () => {
                    await captureRequest(db, "/api/captures/recover", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        captureId: operation.id,
                        queryId: query.id,
                        mode: "cleanup",
                      }),
                    });
                  }, "未完成的文件操作已清理。")
                }
              >
                {operation.action === "delete"
                  ? "重试已确认的删除"
                  : "取消并清理上传"}
              </button>
            </div>
          </div>
        ))}
      {recovery && (
        <button
          className="btn mt-2"
          disabled={disabled}
          onClick={() =>
            void action(async () => {
              const response = await captureRequest(
                db,
                "/api/captures/recover",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(recovery),
                },
              );
              await response.json();
              setRecovery(null);
            }, "已核对上传结果，未关联文件已清理。")
          }
        >
          核对上传并清理未关联文件
        </button>
      )}
      {error && !recovery && (
        <button
          className="mt-2 text-xs underline"
          disabled={disabled}
          onClick={() =>
            void action(async () => {
              await load();
              await onChanged();
            })
          }
        >
          刷新留痕与统计
        </button>
      )}
      {adding && (
        <form
          className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const file = form.get("file");
            if (
              !(file instanceof File) ||
              !file.size ||
              file.size > MAX_CAPTURE_BYTES
            ) {
              setError("请选择不超过 20 MB 的 PDF、PNG 或 JPG 留痕文件。");
              return;
            }
            const sourceUrl = String(form.get("source_url") ?? "").trim();
            if (sourceUrl && !safeWebsite(sourceUrl)) {
              setError("网页地址必须是有效的 HTTP(S) 地址。");
              return;
            }
            form.set("query_id", query.id);
            void action(async () => {
              const response = await captureRequest(db, "/api/captures", {
                method: "POST",
                body: form,
              });
              const saved = (await response.json()) as Capture;
              setCaptures((previous) => [...previous, saved]);
              setRecovery(null);
            }, "留痕已上传。");
          }}
        >
          <label>
            留痕文件（PDF/PNG/JPG，最多 20 MB）
            <input
              name="file"
              type="file"
              accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
              required
              disabled={disabled || busy}
            />
          </label>
          <label>
            网页地址（可选）
            <input
              name="source_url"
              type="url"
              placeholder="https://"
              disabled={disabled || busy}
            />
          </label>
          <div className="flex gap-2">
            <button
              className="btn primary"
              disabled={disabled || busy || !!recovery}
            >
              {busy ? "上传中…" : "上传留痕"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={disabled || busy}
              onClick={() => setAdding(false)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <p className="mt-3 text-xs text-slate-500" role="status">
          正在加载留痕…
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {captures.map((capture) => (
            <li
              key={capture.id}
              className="rounded-lg border border-slate-200 p-3"
            >
              <p className="text-xs font-semibold">
                {captureLabel(capture.capture_no)}
              </p>
              <p className="mt-1 break-all text-xs">{filename(capture)}</p>
              <time
                dateTime={capture.created_at}
                className="mt-1 block text-xs text-slate-500"
              >
                {dateLabel(capture.created_at)}
              </time>
              <div className="mt-2 flex gap-4 text-xs">
                <button
                  className="text-blue-700"
                  disabled={disabled}
                  onClick={() =>
                    void action(async () => {
                      const response = await captureRequest(
                        db,
                        `/api/captures/${capture.id}`,
                      );
                      setPreview({
                        url: URL.createObjectURL(await response.blob()),
                        name: filename(capture),
                      });
                    })
                  }
                >
                  预览
                </button>
                <button
                  className="text-blue-700"
                  disabled={disabled}
                  onClick={() =>
                    void action(async () => {
                      const response = await captureRequest(
                        db,
                        `/api/captures/${capture.id}?download=1`,
                      );
                      const url = URL.createObjectURL(await response.blob());
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = filename(capture);
                      document.body.append(link);
                      link.click();
                      link.remove();
                      setTimeout(() => URL.revokeObjectURL(url), 60000);
                    })
                  }
                >
                  下载
                </button>
                <button
                  className="text-red-700"
                  disabled={disabled}
                  onClick={() => setDeleting(capture.id)}
                >
                  删除
                </button>
              </div>
              {deleting === capture.id && (
                <div
                  className="mt-3 rounded bg-red-50 p-3 text-xs"
                  role="group"
                  aria-label="确认删除留痕"
                >
                  <p>
                    确定删除留痕 {captureLabel(capture.capture_no)}
                    ？文件和记录将一并删除，无法恢复。
                  </p>
                  <div className="mt-2 flex gap-3">
                    <button
                      disabled={disabled || busy}
                      onClick={() => setDeleting(null)}
                    >
                      取消
                    </button>
                    <button
                      className="font-semibold text-red-700"
                      disabled={disabled || busy}
                      onClick={() =>
                        void action(async () => {
                          await captureRequest(
                            db,
                            `/api/captures/${capture.id}`,
                            { method: "DELETE" },
                          );
                          setCaptures((previous) =>
                            previous.filter((c) => c.id !== capture.id),
                          );
                          setPreview(null);
                        }, "留痕文件及记录已删除。")
                      }
                    >
                      {busy ? "删除中…" : "确认删除"}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {preview && (
        <div className="mt-3 rounded-lg border border-slate-200 p-3">
          <div className="mb-2 flex justify-between gap-3">
            <p className="break-all text-xs">{preview.name}</p>
            <button
              className="shrink-0 text-xs text-blue-700"
              onClick={() => setPreview(null)}
            >
              关闭预览
            </button>
          </div>
          {/* Authenticated bytes via a temporary local Blob URL, not a public Storage URL. */}
          {preview.name.endsWith(".pdf") ? (
            <iframe
              src={preview.url}
              title={preview.name}
              className="h-[70vh] w-full"
            />
          ) : (
            <img
              src={preview.url}
              alt={preview.name}
              className="max-h-[70vh] w-full object-contain"
            />
          )}
        </div>
      )}
    </section>
  );
}
