import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_TOPIC_ORDER,
  sortTasksCanonical,
  taskSequenceMap,
} from "../src/lib/task-order.ts";
import {
  filterTasks,
  paginateTasks,
  TASK_PAGE_SIZES,
} from "../src/lib/task-view.ts";
import {
  retainVisibleSelection,
  selectVisibleTasks,
} from "../src/lib/task-selection.ts";

function task(
  id: string,
  entity_name: string,
  topic: string,
  created_at: string,
) {
  return {
    id,
    entity_name,
    topic,
    created_at,
    status: "not_started",
    source_name: `${topic}网站`,
  };
}

test("canonical Task 排序复用全部预设事项顺序且结果稳定", () => {
  assert.deepEqual(CANONICAL_TOPIC_ORDER, [
    "工商信息",
    "执行",
    "失信",
    "诉讼",
    "法院公告",
    "限制消费",
    "破产",
    "行政处罚 / 信用",
    "商标",
    "专利",
    "证券监管",
    "新闻舆情",
  ]);
  const input = CANONICAL_TOPIC_ORDER.toReversed().map((topic, index) =>
    task(String(index), "同一主体", topic, `2026-09-01T00:00:${index}.000Z`),
  );
  assert.deepEqual(
    sortTasksCanonical(input).map((item) => item.topic),
    CANONICAL_TOPIC_ORDER,
  );
  assert.deepEqual(
    sortTasksCanonical(input).map((item) => item.id),
    sortTasksCanonical(input.toReversed()).map((item) => item.id),
  );
});

test("Task 先按主体、预设事项排序，自定义事项排后并按创建顺序", () => {
  const sorted = sortTasksCanonical([
    task("custom-new", "北京主体", "自定义 B", "2026-09-04T00:00:00Z"),
    task("sh", "上海主体", "工商信息", "2026-09-01T00:00:00Z"),
    task("custom-old", "北京主体", "自定义 A", "2026-09-03T00:00:00Z"),
    task("litigation", "北京主体", "诉讼", "2026-09-02T00:00:00Z"),
    task("business", "北京主体", "工商信息", "2026-09-05T00:00:00Z"),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["business", "litigation", "custom-old", "custom-new", "sh"],
  );
});

test("同一主体同一事项按 Task 创建顺序及 id 稳定排序", () => {
  const sorted = sortTasksCanonical([
    task("later", "主体", "执行", "2026-09-02T00:00:00Z"),
    task("same-b", "主体", "执行", "2026-09-01T00:00:00Z"),
    task("same-a", "主体", "执行", "2026-09-01T00:00:00Z"),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["same-a", "same-b", "later"],
  );
});

test("稳定序号基于完整排序，筛选后不会重新编号", () => {
  const tasks = [
    task("litigation", "主体", "诉讼", "2026-09-04T00:00:00Z"),
    task("business", "主体", "工商信息", "2026-09-01T00:00:00Z"),
    task("execution", "主体", "执行", "2026-09-02T00:00:00Z"),
    task("dishonest", "主体", "失信", "2026-09-03T00:00:00Z"),
  ];
  const ordered = sortTasksCanonical(tasks);
  const sequences = taskSequenceMap(tasks);
  const filtered = filterTasks(ordered, {
    search: "",
    status: "",
    entity: "",
    topic: "失信",
  });
  assert.deepEqual(
    filtered.map((item) => sequences.get(item.id)),
    [3],
  );
  assert.equal(sequences.get("litigation"), 4);
});

test("分页支持 25/50/100，搜索筛选在分页之前执行", () => {
  assert.deepEqual(TASK_PAGE_SIZES, [25, 50, 100]);
  const tasks = Array.from({ length: 120 }, (_, index) => ({
    ...task(
      String(index + 1),
      `主体${String(index + 1).padStart(3, "0")}`,
      "工商信息",
      `2026-09-01T00:${String(index).padStart(2, "0")}:00Z`,
    ),
    source_name: index % 2 ? "目标网站" : "其他网站",
  }));
  for (const size of TASK_PAGE_SIZES)
    assert.equal(paginateTasks(tasks, 1, size).items.length, size);
  const filtered = filterTasks(tasks, {
    search: "目标网站",
    status: "",
    entity: "",
    topic: "",
  });
  assert.equal(filtered.length, 60);
  const secondPage = paginateTasks(filtered, 2, 25);
  assert.equal(secondPage.items.length, 25);
  assert.equal(secondPage.start, 26);
  assert.equal(secondPage.end, 50);
});

test("删除末页最后一项后页码回到上一有效页", () => {
  const before = paginateTasks(Array.from({ length: 26 }), 2, 25);
  assert.equal(before.page, 2);
  assert.equal(before.items.length, 1);
  const after = paginateTasks(Array.from({ length: 25 }), 2, 25);
  assert.equal(after.page, 1);
  assert.equal(after.items.length, 25);
});

test("全选只包含当前页，切页后不可见选择被清除", () => {
  const pageOne = ["task-1", "task-2"];
  const pageTwo = ["task-3", "task-4"];
  const selected = selectVisibleTasks(pageOne, true);
  assert.deepEqual([...selected], pageOne);
  assert.equal(selected.has("task-3"), false);
  assert.deepEqual([...retainVisibleSelection(selected, pageTwo)], []);
  assert.deepEqual([...selectVisibleTasks(pageOne, false)], []);
});
