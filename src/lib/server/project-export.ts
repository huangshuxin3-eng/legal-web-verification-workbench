import ExcelJS from "exceljs";
import { type Archiver, ZipArchive } from "archiver";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { Database, Capture } from "../database.types";
import { getProjectTasks } from "../task-repository.ts";
import {
  buildProjectExportPlan,
  EXPORT_HEADERS,
  EXPORT_SHEET_NAME,
  type ExportQueryRow,
  type ProjectExportData,
  type ProjectExportPlan,
} from "../project-export.ts";
import { CaptureOperationError } from "../capture-workflow.ts";

async function pagedQueries(
  db: SupabaseClient<Database>,
  taskId: string,
): Promise<ExportQueryRow[]> {
  const rows: ExportQueryRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .from("queries")
      .select("id, task_id, query_no")
      .eq("task_id", taskId)
      .order("query_no")
      .order("id")
      .range(offset, offset + 499);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 500) break;
  }
  return rows;
}

async function pagedCaptures(
  db: SupabaseClient<Database>,
  queryId: string,
): Promise<Capture[]> {
  const rows: Capture[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .from("captures")
      .select("*")
      .eq("query_id", queryId)
      .order("capture_no")
      .order("id")
      .range(offset, offset + 499);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 500) break;
  }
  return rows;
}

export async function loadProjectExportData(
  db: SupabaseClient<Database>,
  projectId: string,
): Promise<ProjectExportData> {
  const project = await db
    .from("projects")
    .select("id, name")
    .eq("id", projectId)
    .single();
  if (project.error || !project.data)
    throw new CaptureOperationError("项目不存在或无权导出。", 404);
  const tasks = await getProjectTasks(db, projectId);
  const result: ProjectExportData["tasks"] = [];
  for (const task of tasks) {
    const captures = [];
    for (const query of await pagedQueries(db, task.id)) {
      for (const capture of await pagedCaptures(db, query.id)) {
        captures.push({ ...capture, query_no: query.query_no });
      }
    }
    result.push({
      id: task.id,
      entity_name: task.entity_name,
      topic: task.topic,
      source_name: task.source_name,
      created_at: task.created_at,
      captures,
    });
  }
  return { ...project.data, tasks: result };
}

export async function createExportWorkbook(plan: ProjectExportPlan) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "非诉网核工作台";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(EXPORT_SHEET_NAME, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: EXPORT_HEADERS[0], key: "sequence", width: 9 },
    { header: EXPORT_HEADERS[1], key: "entityName", width: 34 },
    { header: EXPORT_HEADERS[2], key: "topic", width: 22 },
    { header: EXPORT_HEADERS[3], key: "sourceName", width: 34 },
    { header: EXPORT_HEADERS[4], key: "captureCount", width: 13 },
  ];
  for (const row of plan.rows) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
  sheet.getRow(1).height = 22;
  sheet.autoFilter = { from: "A1", to: "E1" };
  sheet.getColumn(1).alignment = { horizontal: "center" };
  sheet.getColumn(5).alignment = { horizontal: "center" };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function appendEntry(archive: Archiver, content: Buffer, name: string) {
  await new Promise<void>((resolve, reject) => {
    const onEntry = (entry: { name: string }) => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
    };
    archive.on("entry", onEntry);
    archive.on("error", onError);
    archive.append(content, { name, store: true });
  });
}

export async function writeProjectExportZip(options: {
  output: Writable;
  workbook: Buffer;
  workbookName: string;
  plan: ProjectExportPlan;
  loadCapture: (storagePath: string) => Promise<Blob>;
  signal?: AbortSignal;
}) {
  const archive = new ZipArchive({ store: true });
  const completed = finished(options.output);
  archive.pipe(options.output);
  try {
    await appendEntry(archive, options.workbook, options.workbookName);
    for (const file of options.plan.files) {
      if (options.signal?.aborted)
        throw new CaptureOperationError("成果包生成已取消。", 499);
      const blob = await options.loadCapture(file.storage_path);
      await appendEntry(
        archive,
        Buffer.from(await blob.arrayBuffer()),
        file.archivePath,
      );
    }
    await archive.finalize();
    await completed;
  } catch (error) {
    archive.abort();
    options.output.destroy();
    await completed.catch(() => undefined);
    throw error;
  }
}

export async function downloadPrivateCapture(
  db: SupabaseClient<Database>,
  storagePath: string,
) {
  const { data, error } = await db.storage
    .from("captures")
    .download(storagePath);
  if (error || !data)
    throw new CaptureOperationError(
      "部分底稿文件读取失败，未生成成果包，请重试。",
      502,
    );
  return data;
}

export { buildProjectExportPlan };
