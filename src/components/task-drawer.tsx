"use client";
import { useState } from "react";
import type { TaskWithQueryCount } from "@/lib/queries";
import { safeWebsite, statusClasses, statusLabels } from "@/lib/tasks";
import { Dialog } from "./dialog";
import { QuerySection } from "./query-section";
import { TaskDeleteDialog } from "./task-delete-dialog";
export function TaskDrawer({
  task,
  onClose,
  onEdit,
  onTaskUpdated,
  onDeleted,
}: {
  task: TaskWithQueryCount;
  onTaskUpdated: (task: TaskWithQueryCount) => void;
  onClose: () => void;
  onEdit: () => void;
  onDeleted: (taskId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const url = safeWebsite(task.source_url);
  return (
    <Dialog title="核查任务详情" onClose={onClose} drawer busy={busy}>
      <div className="flex items-center justify-between gap-3">
        <span
          className={`rounded-full px-3 py-1 text-xs ${statusClasses[task.status]}`}
        >
          {statusLabels[task.status]}
        </span>
        <button
          className="btn ghost h-8 min-h-0 px-3 text-xs"
          onClick={onEdit}
          disabled={busy}
        >
          编辑核查任务
        </button>
      </div>
      <section className="mt-4" aria-label="核查任务摘要">
        <h2 className="break-words text-xl font-semibold tracking-tight text-slate-950">
          {task.entity_name}
        </h2>
        <p className="mt-1.5 break-words text-sm text-slate-500">
          {task.topic} · {task.source_name}
        </p>
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="text-xs text-slate-400">网站地址</dt>
            <dd className="mt-1 break-all">
              {url ? (
                <a
                  className="text-blue-700 underline decoration-blue-200 underline-offset-2"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {task.source_url} ↗
                </a>
              ) : (
                task.source_url
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">备注</dt>
            <dd
              className={`mt-1 whitespace-pre-wrap break-words ${task.note ? "text-slate-700" : "text-slate-300"}`}
            >
              {task.note || "—"}
            </dd>
          </div>
        </dl>
      </section>
      <QuerySection
        task={task}
        onTaskUpdated={onTaskUpdated}
        onBusyChange={setBusy}
      />
      <section className="mt-8 border-t border-red-200 pt-6">
        <h2 className="text-sm font-semibold text-red-800">危险操作</h2>
        <button
          className="btn mt-3 w-full border-red-300 text-red-700 hover:bg-red-50"
          disabled={busy}
          onClick={() => setConfirmingDelete(true)}
        >
          删除任务
        </button>
      </section>
      {confirmingDelete && (
        <TaskDeleteDialog
          task={task}
          onClose={() => setConfirmingDelete(false)}
          onBusyChange={setBusy}
          onDeleted={onDeleted}
        />
      )}
    </Dialog>
  );
}
