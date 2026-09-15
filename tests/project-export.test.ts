import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import {
  buildProjectExportPlan,
  EXPORT_HEADERS,
  EXPORT_SHEET_NAME,
  projectExportNames,
  type ProjectExportTask,
} from "../src/lib/project-export.ts";
import {
  createExportWorkbook,
  writeProjectExportZip,
} from "../src/lib/server/project-export.ts";
import { generatedCaptureName } from "../src/lib/capture-names.ts";

function capture(
  id: string,
  queryNo: number,
  captureNo: number,
  extension: "pdf" | "png" | "jpg",
  day: number,
) {
  return {
    id,
    query_no: queryNo,
    capture_no: captureNo,
    storage_path: `owner/project/task/query/${id}.${extension}`,
    created_at: `2026-09-${String(day).padStart(2, "0")}T02:00:00.000Z`,
  };
}

const tasks: ProjectExportTask[] = [
  {
    id: "task-empty",
    entity_name: "不应出现的主体",
    topic: "无底稿事项",
    source_name: "空网站",
    created_at: "2026-09-01T00:00:00.000Z",
    captures: [],
  },
  {
    id: "task-a-litigation",
    entity_name: "主体<A/B>",
    topic: "诉讼:执行",
    source_name: "法院/网站",
    created_at: "2026-09-02T00:00:00.000Z",
    captures: [
      capture("pdf-2", 2, 1, "pdf", 4),
      capture("jpg-1", 1, 2, "jpg", 3),
      capture("png-1", 1, 1, "png", 2),
    ],
  },
  {
    id: "task-b-business",
    entity_name: "主体 B",
    topic: "工商信息",
    source_name: "公示系统",
    created_at: "2026-09-04T00:00:00.000Z",
    captures: [capture("pdf-b", 1, 1, "pdf", 5)],
  },
  {
    id: "task-a-trademark",
    entity_name: "主体<A/B>",
    topic: "商标",
    source_name: "商标网",
    created_at: "2026-09-03T00:00:00.000Z",
    captures: [capture("png-a", 3, 4, "png", 6)],
  },
];

type ZipEntry = { name: string; bytes: Buffer };
function storedZipEntries(zip: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let endOffset = zip.length - 22;
  while (endOffset >= 0 && zip.readUInt32LE(endOffset) !== 0x06054b50)
    endOffset -= 1;
  assert.ok(endOffset >= 0);
  const entryCount = zip.readUInt16LE(endOffset + 10);
  let offset = zip.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    assert.equal(method, 0);
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, bytes: zip.subarray(dataOffset, dataOffset + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function renderZip() {
  const plan = buildProjectExportPlan(tasks);
  const workbook = await createExportWorkbook(plan);
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await writeProjectExportZip({
    output,
    workbook,
    workbookName: "项目_网核清单_20260915.xlsx",
    plan,
    loadCapture: async (path) => new Blob([`content:${path}`]),
  });
  return { plan, zip: Buffer.concat(chunks) };
}

test("只导出有 Capture 的 Task，按 Task 聚合并复用 canonical 顺序", () => {
  const plan = buildProjectExportPlan(tasks.toReversed());
  assert.equal(plan.entityCount, 2);
  assert.deepEqual(
    plan.rows.map((row) => [
      row.sequence,
      row.entityName,
      row.topic,
      row.captureCount,
    ]),
    [
      [1, "主体 B", "工商信息", 1],
      [2, "主体<A/B>", "商标", 1],
      [3, "主体<A/B>", "诉讼:执行", 3],
    ],
  );
  assert.equal(
    plan.rows.some((row) => row.entityName === "不应出现的主体"),
    false,
  );
  assert.equal(
    plan.rows.reduce((sum, row) => sum + row.captureCount, 0),
    5,
  );
  assert.equal(plan.files.length, 5);
});

test("主体顺序依据 canonical 排序，空 Task 不进入清单或创建目录", () => {
  const earlyEmptyTaskForEntityB: ProjectExportTask = {
    id: "task-b-empty-early",
    entity_name: "主体 B",
    topic: "早期空事项",
    source_name: "空网站",
    created_at: "2026-08-01T00:00:00.000Z",
    captures: [],
  };
  const plan = buildProjectExportPlan([...tasks, earlyEmptyTaskForEntityB]);
  assert.deepEqual(
    plan.rows.map((row) => row.entityName),
    ["主体 B", "主体<A/B>", "主体<A/B>"],
  );
  assert.ok(plan.files[0].archivePath.startsWith("底稿文件/01_主体 B/"));
  assert.ok(
    plan.files.every((file) => !file.archivePath.includes("早期空事项")),
  );
});

test("Capture 按 query_no、capture_no 稳定排序并复用 M4 业务文件名", () => {
  const plan = buildProjectExportPlan(tasks);
  const firstTaskFiles = plan.files.filter(
    (file) => file.taskId === "task-a-litigation",
  );
  assert.deepEqual(
    firstTaskFiles.map((file) => [file.query_no, file.capture_no]),
    [
      [1, 1],
      [1, 2],
      [2, 1],
    ],
  );
  assert.equal(
    firstTaskFiles[0].filename,
    generatedCaptureName(
      {
        entity_name: "主体<A/B>",
        topic: "诉讼:执行",
        source_name: "法院/网站",
        query_no: 1,
        capture_no: 1,
      },
      "png",
      new Date("2026-09-02T02:00:00.000Z"),
    ),
  );
});

test("导出路径只有主体与事项目录，Windows 非法字符被替换且路径受限", () => {
  const plan = buildProjectExportPlan(tasks);
  assert.match(
    plan.files.find((file) => file.taskId === "task-a-litigation")!.archivePath,
    /^底稿文件\/02_主体_A_B_\/02_诉讼_执行\//,
  );
  for (const file of plan.files) {
    for (const part of file.archivePath.split("/").slice(1))
      assert.doesNotMatch(part, /[<>:"\\|?*]/);
    assert.ok(file.archivePath.length <= 240);
  }
});

test("Excel 固定五列并具有表头、冻结首行、筛选、列宽和居中样式", async () => {
  const plan = buildProjectExportPlan(tasks);
  const bytes = await createExportWorkbook(plan);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    bytes as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.getWorksheet(EXPORT_SHEET_NAME)!;
  const headerValues = sheet.getRow(1).values;
  assert.ok(Array.isArray(headerValues));
  assert.deepEqual(headerValues.slice(1), [...EXPORT_HEADERS]);
  assert.equal(sheet.rowCount, 4);
  assert.equal(sheet.getCell("E2").value, 1);
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.views[0].ySplit, 1);
  assert.ok(sheet.autoFilter);
  assert.equal(sheet.getRow(1).font.bold, true);
  assert.equal(sheet.getColumn(1).alignment?.horizontal, "center");
  assert.equal(sheet.getColumn(5).alignment?.horizontal, "center");
  assert.ok((sheet.getColumn(2).width ?? 0) >= 30);
});

test("ZIP 包含 Excel 及全部 PDF、PNG、JPG，清单合计与底稿数一致", async () => {
  const { plan, zip } = await renderZip();
  const entries = storedZipEntries(zip);
  assert.equal(entries.length, plan.files.length + 1);
  const workbookEntry = entries.find((entry) => entry.name.endsWith(".xlsx"));
  assert.ok(workbookEntry);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    workbookEntry.bytes as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  assert.equal(workbook.getWorksheet(EXPORT_SHEET_NAME)?.rowCount, 4);
  for (const file of plan.files)
    assert.equal(
      entries
        .find((entry) => entry.name === file.archivePath)
        ?.bytes.toString("utf8"),
      `content:${file.storage_path}`,
    );
  assert.ok(entries.every((entry) => !entry.name.endsWith("/")));
  assert.ok(entries.every((entry) => !entry.name.includes("不应出现的主体")));
  assert.equal(
    entries.filter((entry) => entry.name.endsWith(".pdf")).length,
    2,
  );
  assert.equal(
    entries.filter((entry) => entry.name.endsWith(".png")).length,
    2,
  );
  assert.equal(
    entries.filter((entry) => entry.name.endsWith(".jpg")).length,
    1,
  );
  assert.equal(
    plan.rows.reduce((sum, row) => sum + row.captureCount, 0),
    entries.length - 1,
  );
});

test("空项目和零 Capture 项目不会形成可导出的计划", () => {
  assert.deepEqual(buildProjectExportPlan([]), {
    rows: [],
    files: [],
    entityCount: 0,
  });
  assert.equal(buildProjectExportPlan(tasks.slice(0, 1)).files.length, 0);
});

test("成果包和清单使用安全项目名及北京时间日期", () => {
  assert.deepEqual(
    projectExportNames("项目:A/B", new Date("2026-09-14T16:01:00.000Z")),
    {
      zip: "项目_A_B_网核成果_20260915.zip",
      workbook: "项目_A_B_网核清单_20260915.xlsx",
    },
  );
});

test("导出 API 使用用户 JWT、RLS 与 Private Storage download，不生成公开 URL", async () => {
  const route = await readFile(
    new URL(
      "../src/app/api/projects/[projectId]/export/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const server = await readFile(
    new URL("../src/lib/server/project-export.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /captureContext\(request\)/);
  assert.match(server, /\.from\("projects"\)/);
  assert.match(server, /\.from\("captures"\)/);
  assert.match(server, /\.download\(storagePath\)/);
  assert.doesNotMatch(`${route}\n${server}`, /service[_-]?role/i);
  assert.doesNotMatch(`${route}\n${server}`, /getPublicUrl|createSignedUrl/);
});

test("Private Storage 读取失败时 ZIP 生成失败且不会报告成功", async () => {
  const plan = buildProjectExportPlan(tasks);
  const output = new PassThrough();
  output.resume();
  await assert.rejects(
    writeProjectExportZip({
      output,
      workbook: Buffer.from("xlsx"),
      workbookName: "清单.xlsx",
      plan,
      loadCapture: async () => {
        throw new Error("storage unavailable");
      },
    }),
    /storage unavailable/,
  );
  assert.equal(output.destroyed, true);
});

test("Workbench 提供导出入口、真实统计、空项目提示和防重复提交", async () => {
  const [workspace, dialog] = await Promise.all([
    readFile(
      new URL("../src/components/project-workspace.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/components/project-export-dialog.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(workspace, />\s*导出网核成果\s*</);
  assert.match(dialog, /核查对象数量/);
  assert.match(dialog, /有底稿的 Task 数量/);
  assert.match(dialog, /Capture \/ 底稿文件数量/);
  assert.match(dialog, /当前项目暂无可导出的底稿/);
  assert.match(dialog, /if \(lock\.current \|\| !captureCount\) return/);
  assert.match(dialog, /disabled=\{busy \|\| !captureCount\}/);
});
