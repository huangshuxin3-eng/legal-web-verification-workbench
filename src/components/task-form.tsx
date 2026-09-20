"use client";
import { useState } from "react";
import type { Task, TaskStatus } from "@/lib/database.types";
import {
  errorMessage,
  safeWebsite,
  statusLabels,
  type TaskInput,
} from "@/lib/tasks";
import { Dialog } from "./dialog";
export function TaskForm({
  task,
  onClose,
  onSave,
}: {
  task?: Task;
  onClose: () => void;
  onSave: (input: TaskInput) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      title={task ? "编辑核查任务" : "新建核查任务"}
      onClose={onClose}
      busy={busy}
      formLayout
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="btn primary"
            type="submit"
            form="task-form"
            disabled={busy}
          >
            {busy
              ? task
                ? "保存中…"
                : "创建中…"
              : task
                ? "保存修改"
                : "创建核查任务"}
          </button>
        </div>
      }
    >
      <form
        id="task-form"
        className="space-y-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const form = new FormData(e.currentTarget);
          const input: TaskInput = {
            entity_name: String(form.get("entity_name")).trim(),
            topic: String(form.get("topic")).trim(),
            source_name: String(form.get("source_name")).trim(),
            source_url: String(form.get("source_url")).trim(),
            note: String(form.get("note")).trim() || null,
            status: task ? (form.get("status") as TaskStatus) : "not_started",
          };
          if (!input.entity_name || !input.topic || !input.source_name) {
            setError("请填写所有必填项，不能只输入空格。");
            return;
          }
          if (!safeWebsite(input.source_url)) {
            setError("请输入有效的 http:// 或 https:// 网站网址。");
            return;
          }
          setBusy(true);
          setError("");
          try {
            await onSave(input);
          } catch (error) {
            setError(errorMessage(error));
            setBusy(false);
          }
        }}
      >
        <label>
          核查对象 *
          <input
            className="h-12"
            name="entity_name"
            defaultValue={task?.entity_name}
            required
            autoFocus
          />
        </label>
        <label>
          核查事项 *
          <input
            className="h-12"
            name="topic"
            defaultValue={task?.topic}
            required
          />
        </label>
        <label>
          数据来源 *
          <input
            className="h-12"
            name="source_name"
            defaultValue={task?.source_name}
            required
          />
        </label>
        <label>
          网站地址
          <input
            className="h-12"
            name="source_url"
            type="url"
            placeholder="https://"
            defaultValue={task?.source_url}
            required
          />
        </label>
        <label>
          备注（可选）
          <textarea
            className="min-h-[120px]"
            name="note"
            rows={4}
            defaultValue={task?.note ?? ""}
          />
        </label>
        {task && (
          <label>
            状态
            <select className="h-12" name="status" defaultValue={task.status}>
              {Object.entries(statusLabels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
