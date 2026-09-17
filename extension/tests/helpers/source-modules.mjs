import { cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, "..", "..");
// Legal Web Check PDF Profile v1 的单一来源，与 scripts/build.mjs 使用同一文件。
const probePrintConfig = resolve(
  extension,
  "..",
  "..",
  "chrome-pdf-probe",
  "extension",
  "print-config.mjs",
);

let root;
let pending;

/**
 * extension/src 是有意不完整的：config.mjs 与 print-config.mjs 由构建期注入。
 * 这里按与 scripts/build.mjs 完全相同的方式补齐这两个文件，使测试直接运行
 * extension/src 的真实逻辑，而不是依赖可能陈旧的 dist 产物。
 *
 * 并发安全：同一进程内多个 `Promise.all(loadSourceModule(...))` 只会真正复制一次，
 * 其余调用复用同一个 promise，否则并发的 rm+cp 会互相踩到同一个临时目录。
 */
async function buildSourceRoot() {
  const target = join(tmpdir(), `nonlit-extension-src-${process.pid}`);
  await rm(target, { recursive: true, force: true });
  await cp(resolve(extension, "src"), target, { recursive: true });
  await cp(probePrintConfig, join(target, "print-config.mjs"));
  await writeFile(
    join(target, "config.mjs"),
    `export const CONFIG = Object.freeze(${JSON.stringify(
      {
        supabaseUrl: "https://source-test.supabase.co",
        publishableKey: "source-test-publishable-key",
        workbenchUrl: "http://localhost:3000",
      },
      null,
      2,
    )});\n`,
  );
  root = target;
  return root;
}

export async function sourceRoot() {
  if (root) return root;
  if (!pending) pending = buildSourceRoot();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}

export async function loadSourceModule(relativePath) {
  const target = await sourceRoot();
  return import(pathToFileURL(resolve(target, relativePath)).href);
}

export const extensionRoot = extension;
export const probePrintConfigPath = probePrintConfig;

/** CRLF/LF 归一比较：core.autocrlf 会让工作区行尾不一致，但语义相同。 */
export function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

export async function cleanupSourceRoot() {
  pending = undefined;
  if (!root) return;
  const target = root;
  root = undefined;
  await rm(target, { recursive: true, force: true }).catch(() => {});
}
