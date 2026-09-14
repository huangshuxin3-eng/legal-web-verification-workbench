"use client";
import { useState } from "react";
import type { TaskWithQueryCount } from "@/lib/queries";
import { safeWebsite, statusClasses, statusLabels } from "@/lib/tasks";
import { Dialog } from "./dialog";
import { QuerySection } from "./query-section";
export function TaskDrawer({
  task,
  onClose,
  onEdit,
  onTaskUpdated,
}: {
  task: TaskWithQueryCount;
  onTaskUpdated: (task: TaskWithQueryCount) => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const url = safeWebsite(task.source_url);
  return (
    <Dialog title="Task 详情" onClose={onClose} drawer busy={busy}>
      <span
        className={`rounded-full px-3 py-1 text-xs ${statusClasses[task.status]}`}
      >
        {statusLabels[task.status]}
      </span>
      <dl className="mt-8 space-y-6">
        {[
          ["核查对象", task.entity_name],
          ["核查事项", task.topic],
          ["核查网站", task.source_name],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="mt-2 break-words font-medium">{value}</dd>
          </div>
        ))}
        <div>
          <dt className="text-xs text-slate-500">网站网址</dt>
          <dd className="mt-2 break-all text-sm">
            {url ? (
              <a
                className="text-blue-700 underline"
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
          <dt className="text-xs text-slate-500">备注</dt>
          <dd className="mt-2 whitespace-pre-wrap break-words text-sm">
            {task.note || "未填写备注"}
          </dd>
        </div>
      </dl>
      <button className="btn mt-6 w-full" onClick={onEdit} disabled={busy}>
        编辑 Task
      </button>
      <QuerySection
        task={task}
        onTaskUpdated={onTaskUpdated}
        onBusyChange={setBusy}
      />
    </Dialog>
  );
}
