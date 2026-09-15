import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { businessName } from "../src/lib/names.mjs";
import {
  cleanupSourceRoot,
  loadSourceModule,
  probePrintConfigPath,
} from "./helpers/source-modules.mjs";

test.after(cleanupSourceRoot);

test("manifest requests only the five Milestone 4 permissions", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../manifest.template.json", import.meta.url)),
  );
  assert.deepEqual(manifest.permissions, [
    "activeTab",
    "debugger",
    "sidePanel",
    "storage",
    "tabs",
  ]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
});

test("Chinese PDF business filename is deterministic and Windows safe", () => {
  assert.equal(
    businessName(
      {
        entity_name: "北京木锐机器人有限公司",
        topic: "执:行",
        source_name: "中国执行信息公开网",
      },
      1,
      4,
      "2026-09-13T16:00:00Z",
    ),
    "北京木锐机器人有限公司_执_行_中国执行信息公开网_Q01_004_20260914.pdf",
  );
});

test("PDF profile is imported from probe as the build source of truth", async () => {
  const probe = await readFile(probePrintConfigPath, "utf8");
  assert.match(probe, /paperWidth:\s*210 \/ 25\.4/);
  assert.match(probe, /printBackground:\s*true/);
  assert.match(probe, /displayHeaderFooter:\s*true/);
  assert.match(probe, /UTC\+08:00/);
});

test("print lifecycle detaches after success and print failure", async () => {
  const calls = [];
  const listeners = new Set();
  globalThis.chrome = {
    debugger: {
      attach: async () => calls.push("attach"),
      sendCommand: async () => {
        calls.push("print");
        return { data: "JVBERi0=" };
      },
      detach: async () => calls.push("detach"),
      onDetach: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
    },
  };
  // 直接加载 extension/src 的真实逻辑，而不是 dist 产物。
  const { printTab } = await loadSourceModule("lib/print.mjs");
  await printTab(3);
  assert.deepEqual(calls, ["attach", "print", "detach"]);
  calls.length = 0;
  chrome.debugger.sendCommand = async () => {
    calls.push("print");
    throw new Error("injected");
  };
  await assert.rejects(printTab(3), /injected/);
  assert.deepEqual(calls, ["attach", "print", "detach"]);
  assert.equal(listeners.size, 0);

  calls.length = 0;
  chrome.debugger.attach = async () => {
    calls.push("attach");
    throw new Error("forbidden target");
  };
  await assert.rejects(printTab(3), /forbidden target/);
  assert.deepEqual(calls, ["attach"]);

  calls.length = 0;
  chrome.debugger.attach = async () => calls.push("attach");
  const controller = new AbortController();
  chrome.debugger.sendCommand = () => {
    calls.push("print");
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  };
  await assert.rejects(printTab(3, controller.signal), /取消/);
  assert.deepEqual(calls, ["attach", "print", "detach"]);
});

test("Task Picker 可按核查对象、事项和网站名称搜索", async () => {
  const { taskMatchesSearch } = await loadSourceModule("lib/task-picker.mjs");
  const task = {
    entity_name: "北京木锐机器人有限公司",
    topic: "执行",
    source_name: "中国执行信息公开网",
  };
  assert.equal(taskMatchesSearch(task, "木锐"), true);
  assert.equal(taskMatchesSearch(task, "执行"), true);
  assert.equal(taskMatchesSearch(task, "公开网"), true);
  assert.equal(taskMatchesSearch(task, "商标"), false);
});

test("当前网站只按完整 hostname 精确匹配，无效 URL 不会抛错", async () => {
  const { groupTasksForPicker, hostname } = await loadSourceModule(
    "lib/task-picker.mjs",
  );
  const tasks = [
    {
      id: "exact",
      entity_name: "主体 A",
      topic: "执行",
      source_name: "执行网",
      source_url: "https://zxgk.court.gov.cn/path",
    },
    {
      id: "evil",
      entity_name: "主体 B",
      topic: "执行",
      source_name: "相似域名",
      source_url: "https://zxgk.court.gov.cn.evil.com/",
    },
    {
      id: "invalid",
      entity_name: "主体 C",
      topic: "自定义",
      source_name: "无效网址",
      source_url: "not a url",
    },
  ];
  assert.equal(hostname("not a url"), null);
  const grouped = groupTasksForPicker(
    tasks,
    "https://zxgk.court.gov.cn/search?q=1",
  );
  assert.deepEqual(
    grouped.matches.map((task) => task.id),
    ["exact"],
  );
  assert.deepEqual(
    grouped.others.map((task) => task.id),
    ["evil", "invalid"],
  );
});

test("切换标签页会重算推荐组但不会覆盖已选 Task", async () => {
  const { groupTasksForPicker, validSelectedTaskId } = await loadSourceModule(
    "lib/task-picker.mjs",
  );
  const tasks = [
    {
      id: "execution",
      entity_name: "主体",
      topic: "执行",
      source_name: "执行网",
      source_url: "https://zxgk.court.gov.cn/",
    },
    {
      id: "trademark",
      entity_name: "主体",
      topic: "商标",
      source_name: "商标网",
      source_url: "https://sbj.cnipa.gov.cn/",
    },
  ];
  assert.deepEqual(
    groupTasksForPicker(tasks, "https://zxgk.court.gov.cn/").matches.map(
      (task) => task.id,
    ),
    ["execution"],
  );
  assert.deepEqual(
    groupTasksForPicker(tasks, "https://sbj.cnipa.gov.cn/").matches.map(
      (task) => task.id,
    ),
    ["trademark"],
  );
  assert.equal(validSelectedTaskId(tasks, "execution"), "execution");
  assert.equal(validSelectedTaskId(tasks, "missing"), "");
});

test("Task 变化时先清空旧 Query，再只恢复属于新 Task 的 Query", async () => {
  const source = await readFile(
    new URL("../src/sidepanel.mjs", import.meta.url),
  );
  const text = source.toString("utf8");
  const chooseTask = text.slice(
    text.indexOf("async function chooseTask"),
    text.indexOf("async function chooseQuery"),
  );
  assert.match(chooseTask, /fill\(\$\("query"\), \[\], "加载中…"\)/);
  assert.match(
    chooseTask,
    /queryRows = id \? await data\.queries\(id\) : \[\]/,
  );
  assert.match(
    chooseTask,
    /restoreQuery && queryRows\.some\(\(q\) => q\.id === restoreQuery\)/,
  );
});
