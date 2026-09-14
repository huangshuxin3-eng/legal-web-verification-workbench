import type { Task, TaskStatus } from "./database.types";
export const statusLabels: Record<TaskStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  completed: "已完成",
  blocked: "无法完成",
};
export const statusClasses: Record<TaskStatus, string> = {
  not_started: "bg-slate-100 text-slate-600",
  in_progress: "bg-blue-50 text-blue-700",
  completed: "bg-emerald-50 text-emerald-700",
  blocked: "bg-amber-50 text-amber-800",
};
export type TaskInput = Pick<
  Task,
  "entity_name" | "topic" | "source_name" | "source_url" | "note" | "status"
>;
export function dateLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}
export function safeWebsite(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
export function errorMessage(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : "";
  if (code === "42501") return "没有操作权限，请确认登录状态。";
  if (code === "PGRST116")
    return "记录不存在、已被删除或无权访问，请刷新后重试。";
  if (code === "23514") return "字段内容不符合要求，请检查必填项及网址。";
  return "操作失败，请检查网络和 Supabase 配置后重试。";
}
