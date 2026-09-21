import { resolve } from "node:path";

export const PRODUCTION_WORKBENCH_URL =
  "https://legal-web-verification-workbench.vercel.app";
export const PRODUCTION_HOST_PERMISSIONS = [
  "https://rcfjgjxwftwkdbiwsavy.supabase.co/*",
  `${PRODUCTION_WORKBENCH_URL}/*`,
];

export function betaArchiveName(manifest) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version ?? ""))
    throw new Error("manifest version 无效，无法生成 Beta 包名");
  return `nonlit-web-verification-helper-${manifest.version}-beta.zip`;
}

export function betaPackagePaths(projectRoot) {
  return {
    source: resolve(projectRoot, "extension", "dist"),
    release: resolve(projectRoot, "release"),
  };
}

export function assertProductionArtifacts(configText, manifest) {
  if (!configText.includes(`"workbenchUrl": "${PRODUCTION_WORKBENCH_URL}"`))
    throw new Error("config.mjs 不是 Production workbench 配置");
  if (configText.includes("http://localhost:3000"))
    throw new Error("config.mjs 仍包含 localhost");
  for (const permission of PRODUCTION_HOST_PERMISSIONS)
    if (!manifest.host_permissions?.includes(permission))
      throw new Error(
        `manifest 缺少 Production host permission：${permission}`,
      );
  if (manifest.host_permissions?.includes("http://localhost:3000/*"))
    throw new Error("manifest 仍包含 localhost host permission");
}

export function assertDistEntries(entries) {
  const normalized = entries.map((entry) => entry.replaceAll("\\", "/"));
  for (const required of [
    "manifest.json",
    "config.mjs",
    "sidepanel.html",
    "worker.mjs",
  ])
    if (!normalized.includes(required))
      throw new Error(`extension/dist 根目录缺少 ${required}`);

  const forbidden = new Set([".git", "node_modules", "tests"]);
  for (const entry of normalized) {
    const parts = entry.split("/");
    if (
      entry.startsWith("/") ||
      parts.includes("..") ||
      parts.some((part) => forbidden.has(part)) ||
      parts.some((part) => part === ".env" || part.startsWith(".env."))
    )
      throw new Error(`Beta 包含禁止的路径：${entry}`);
  }
}
