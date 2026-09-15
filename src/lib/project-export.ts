import type { Capture, Project, Query, Task } from "./database.types";
import {
  captureExtension,
  filenamePart,
  generatedCaptureName,
} from "./capture-names.ts";
import { sortTasksCanonical } from "./task-order.ts";

export const EXPORT_SHEET_NAME = "网核清单";
export const EXPORT_HEADERS = [
  "序号",
  "核查对象",
  "核查事项",
  "核查网站",
  "底稿数量",
] as const;

export type ProjectExportCapture = Pick<
  Capture,
  "id" | "capture_no" | "storage_path" | "created_at"
> & { query_no: number };

export type ProjectExportTask = Pick<
  Task,
  "id" | "entity_name" | "topic" | "source_name" | "created_at"
> & { captures: ProjectExportCapture[] };

export type ProjectExportRow = {
  sequence: number;
  entityName: string;
  topic: string;
  sourceName: string;
  captureCount: number;
};

export type ProjectExportFile = ProjectExportCapture & {
  taskId: string;
  filename: string;
  archivePath: string;
};

export type ProjectExportPlan = {
  rows: ProjectExportRow[];
  files: ProjectExportFile[];
  entityCount: number;
};

function exportPathPart(value: string) {
  return Array.from(filenamePart(value)).slice(0, 36).join("") || "未命名";
}

function boundedCaptureFilename(filename: string, maximum = 140) {
  if (filename.length <= maximum) return filename;
  const suffix = filename.match(/(_Q\d+_\d+_\d{8}\.[^.]+)$/)?.[1];
  if (!suffix) return filename.slice(0, maximum);
  return `${filename.slice(0, maximum - suffix.length)}${suffix}`;
}

function numberedFolder(index: number, value: string) {
  return `${String(index + 1).padStart(2, "0")}_${exportPathPart(value)}`;
}

export function projectExportNames(projectName: string, now = new Date()) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .replaceAll("-", "");
  const safeProject = filenamePart(projectName);
  return {
    zip: `${safeProject}_网核成果_${date}.zip`,
    workbook: `${safeProject}_网核清单_${date}.xlsx`,
  };
}

export function buildProjectExportPlan(
  tasks: readonly ProjectExportTask[],
): ProjectExportPlan {
  const allTasks = sortTasksCanonical(tasks);
  const capturedTasks = allTasks.filter((task) => task.captures.length > 0);
  const exportedEntities = new Set(
    capturedTasks.map((task) => task.entity_name),
  );
  const exportedTopics = new Set(
    capturedTasks.map((task) => JSON.stringify([task.entity_name, task.topic])),
  );
  const entities = [
    ...new Set(
      allTasks
        .filter((task) => exportedEntities.has(task.entity_name))
        .map((task) => task.entity_name),
    ),
  ];
  const entityIndex = new Map(entities.map((value, index) => [value, index]));
  const topicsByEntity = new Map<string, string[]>();
  for (const task of allTasks) {
    if (!exportedTopics.has(JSON.stringify([task.entity_name, task.topic])))
      continue;
    const topics = topicsByEntity.get(task.entity_name) ?? [];
    if (!topics.includes(task.topic)) topics.push(task.topic);
    topicsByEntity.set(task.entity_name, topics);
  }
  const orderedTasks = capturedTasks;

  const rows: ProjectExportRow[] = [];
  const files: ProjectExportFile[] = [];
  for (const [taskIndex, task] of orderedTasks.entries()) {
    const captures = task.captures.toSorted(
      (left, right) =>
        left.query_no - right.query_no ||
        left.capture_no - right.capture_no ||
        left.id.localeCompare(right.id),
    );
    rows.push({
      sequence: taskIndex + 1,
      entityName: task.entity_name,
      topic: task.topic,
      sourceName: task.source_name,
      captureCount: captures.length,
    });
    const entityPosition = entityIndex.get(task.entity_name)!;
    const topicPosition = topicsByEntity
      .get(task.entity_name)!
      .indexOf(task.topic);
    const directory = `底稿文件/${numberedFolder(entityPosition, task.entity_name)}/${numberedFolder(topicPosition, task.topic)}`;
    for (const capture of captures) {
      const extension = captureExtension(capture.storage_path);
      const filename = boundedCaptureFilename(
        generatedCaptureName(
          {
            entity_name: task.entity_name,
            topic: task.topic,
            source_name: task.source_name,
            query_no: capture.query_no,
            capture_no: capture.capture_no,
          },
          extension,
          new Date(capture.created_at),
        ),
      );
      files.push({
        ...capture,
        taskId: task.id,
        filename,
        archivePath: `${directory}/${filename}`,
      });
    }
  }
  return { rows, files, entityCount: entities.length };
}

export type ProjectExportData = Pick<Project, "id" | "name"> & {
  tasks: ProjectExportTask[];
};

export type ExportQueryRow = Pick<Query, "id" | "task_id" | "query_no">;
