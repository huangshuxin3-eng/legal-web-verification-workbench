import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { businessName } from "../src/lib/names.mjs";

test("manifest requests only the four Milestone 4 permissions", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../manifest.template.json", import.meta.url)),
  );
  assert.deepEqual(manifest.permissions, [
    "activeTab",
    "debugger",
    "sidePanel",
    "storage",
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
  const probe = await readFile(
    new URL(
      "../../../chrome-pdf-probe/extension/print-config.mjs",
      import.meta.url,
    ),
    "utf8",
  );
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
  const { printTab } = await import("../dist/lib/print.mjs");
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
