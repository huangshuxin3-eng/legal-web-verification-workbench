"use client";
import { useState } from "react";
import type { TaskWithQueryCount } from "@/lib/queries";
import { safeWebsite, statusLabels } from "@/lib/tasks";
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
      <div className="lt-detail-top">
        <div>
          <span className="lt-detail-badge">{statusLabels[task.status]}</span>
          <h3>{task.entity_name}</h3>
          <p>
            {task.topic} · {task.source_name}
          </p>
        </div>
        <button className="btn lt-compact-btn" onClick={onEdit} disabled={busy}>
          编辑核查任务
        </button>
      </div>
      <section className="lt-detail-meta" aria-label="核查任务摘要">
        <div>
          网站地址：
          {url ? (
            <a
              className="underline"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {task.source_url}
            </a>
          ) : (
            task.source_url
          )}
        </div>
        <p className="lt-detail-note">备注：{task.note || "—"}</p>
      </section>
      <QuerySection
        task={task}
        onTaskUpdated={onTaskUpdated}
        onBusyChange={setBusy}
      />
      <section className="lt-detail-danger">
        <button
          className="lt-link-btn danger"
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
