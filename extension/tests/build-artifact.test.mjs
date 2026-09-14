import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  extensionRoot,
  normalize,
  probePrintConfigPath,
} from "./helpers/source-modules.mjs";

const dist = join(extensionRoot, "dist");
const src = join(extensionRoot, "src");

async function filesUnder(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = prefix ? join(prefix, entry.name) : entry.name;
    files.push(
      ...(entry.isDirectory()
        ? await filesUnder(join(directory, entry.name), next)
        : [next]),
    );
  }
  return files;
}

const buildHint = "请先运行 npm --prefix extension run build 生成 extension/dist。";

test("dist mirrors every extension/src file", async () => {
  const sourceFiles = await filesUnder(src);
  assert.ok(sourceFiles.length > 0, "extension/src 不应为空");
  for (const file of sourceFiles) {
    let produced;
    try {
      produced = await readFile(join(dist, file), "utf8");
    } catch {
      assert.fail(`extension/dist 缺少 ${file}；${buildHint}`);
    }
    const expected = await readFile(join(src, file), "utf8");
    assert.equal(
      normalize(produced),
      normalize(expected),
      `extension/dist/${file} 与 extension/src/${file} 不同步；${buildHint}`,
    );
  }
});

test("dist republishes the probe PDF profile without a second copy", async () => {
  const probe = normalize(await readFile(probePrintConfigPath, "utf8"));
  const published = normalize(
    await readFile(join(dist, "print-config.mjs"), "utf8"),
  );
  assert.equal(published, probe);
});

test("dist manifest keeps the five permissions and two exact origins", async () => {
  const manifest = JSON.parse(
    await readFile(join(dist, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.permissions, [
    "activeTab",
    "debugger",
    "sidePanel",
    "storage",
    "tabs",
  ]);
  assert.equal(manifest.host_permissions.length, 2);
  for (const pattern of manifest.host_permissions) {
    assert.match(pattern, /^https?:\/\/[^/*]+\/\*$/);
    assert.notEqual(pattern, "<all_urls>");
  }
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes("all_urls"), false);
});

test("dist config exposes only public client credentials", async () => {
  const config = await readFile(join(dist, "config.mjs"), "utf8");
  for (const key of ["supabaseUrl", "publishableKey", "workbenchUrl"])
    assert.ok(config.includes(key), `dist/config.mjs 缺少 ${key}`);
  assert.equal(/service_role|secret|password/i.test(config), false);
});

test("dist worker and print contain the Milestone 4 hardening", async () => {
  const worker = normalize(await readFile(join(dist, "worker.mjs"), "utf8"));
  const print = normalize(await readFile(join(dist, "lib", "print.mjs"), "utf8"));
  // 这些正是审计发现陈旧 dist 中缺失的逻辑。
  assert.match(worker, /stage = "validate"/);
  assert.match(worker, /technicalError/);
  assert.match(worker, /displayError/);
  assert.match(worker, /debuggerMs/);
  assert.match(print, /const printStarted = performance\.now\(\)/);
  assert.match(print, /Late debugger detach failed/);
  assert.match(print, /detach-failed/);
});

test("dist does not ship sources that never existed in src", async () => {
  const produced = await filesUnder(dist);
  const allowedGenerated = new Set(["manifest.json", "config.mjs", "print-config.mjs"]);
  const sourceFiles = new Set(await filesUnder(src));
  for (const file of produced)
    if (!sourceFiles.has(file))
      assert.ok(
        allowedGenerated.has(file),
        `extension/dist/${file} 不是 src 文件，也不是已知的构建期生成文件`,
      );
});
