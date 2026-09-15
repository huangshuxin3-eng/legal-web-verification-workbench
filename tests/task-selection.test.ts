import { test } from "node:test";
import assert from "node:assert/strict";
import {
  retainVisibleSelection,
  selectVisibleTasks,
  toggleTaskSelection,
} from "../src/lib/task-selection.ts";

test("Task checkbox 支持单选和取消选择", () => {
  const selected = toggleTaskSelection(new Set<string>(), "task-a", true);
  assert.deepEqual([...selected], ["task-a"]);
  assert.deepEqual([...toggleTaskSelection(selected, "task-a", false)], []);
});

test("全选只包含当前筛选结果", () => {
  const visible = ["task-a", "task-c"];
  assert.deepEqual([...selectVisibleTasks(visible, true)], visible);
  assert.equal(selectVisibleTasks(visible, true).has("task-b"), false);
  assert.equal(selectVisibleTasks(visible, false).size, 0);
});

test("筛选变化会移除已经不可见的选择", () => {
  const selected = new Set(["task-a", "task-b", "task-c"]);
  assert.deepEqual(
    [...retainVisibleSelection(selected, ["task-b", "task-c"])],
    ["task-b", "task-c"],
  );
});
