import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Task 列表展示连续序号和查看、编辑、删除操作", async () => {
  const source = await readFile(
    new URL("../src/components/project-workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /<th[^>]*>序号<\/th>/);
  assert.match(source, /filtered\.map\(\(task, index\)/);
  assert.match(source, /\{index \+ 1\}/);
  for (const action of ["查看", "编辑", "删除"])
    assert.match(source, new RegExp(`>\\s*${action}\\s*<\\/button>`));
});

test("表格删除入口只打开共用确认框，取消不会修改 Task", async () => {
  const source = await readFile(
    new URL("../src/components/project-workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /setDeletingTask\(task\)/);
  assert.match(source, /<TaskDeleteDialog/);
  assert.match(source, /onClose=\{\(\) => setDeletingTask\(null\)\}/);
  assert.doesNotMatch(source, /captureRequest/);
});

test("确认删除只移除目标 Task，并保留 Drawer 的共用删除入口", async () => {
  const [workspace, drawer] = await Promise.all([
    readFile(
      new URL("../src/components/project-workspace.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/components/task-drawer.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(
    workspace,
    /previous\.filter\(\(task\) => task\.id !== taskId\)/,
  );
  assert.match(workspace, /setNotice\("任务已永久删除。"\)/);
  assert.match(drawer, />\s*删除任务\s*<\/button>/);
  assert.match(drawer, /<TaskDeleteDialog/);
});

test("Task 表保留序号并提供当前结果全选和批量确认框", async () => {
  const source = await readFile(
    new URL("../src/components/project-workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /aria-label="选择当前筛选结果中的全部任务"/);
  assert.match(source, /selectVisibleTasks\(visibleTaskIds/);
  assert.match(source, /已选择 \{selectedTasks\.length\} 个任务/);
  assert.match(source, />\s*批量删除\s*<\/button>/);
  assert.match(source, /<TaskBatchDeleteDialog/);
  assert.match(source, /<th[^>]*>序号<\/th>/);
});

test("批量确认框取消不请求删除并展示聚合统计", async () => {
  const source = await readFile(
    new URL("../src/components/task-batch-delete-dialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Task 数量/);
  assert.match(source, /Query 总数量/);
  assert.match(source, /留痕总数量/);
  assert.match(source, /onClick=\{onClose\}/);
  assert.match(source, /永久删除 \$\{tasks\.length\} 个任务/);
});

test("批量部分失败只移除成功项并保留失败项选择", async () => {
  const source = await readFile(
    new URL("../src/components/project-workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /previous\.filter\(\(task\) => !deleted\.has\(task\.id\)\)/,
  );
  assert.match(source, /setSelectedTaskIds\(failed\)/);
  assert.match(
    source,
    /已删除 \$\{result\.deletedIds\.length\} 个任务，\$\{result\.failedIds\.length\} 个任务删除失败，请重试。/,
  );
});
