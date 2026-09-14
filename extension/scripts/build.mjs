import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, "..");
const project = resolve(extension, "..");
const src = resolve(extension, "src");
const dist = resolve(extension, "dist");
// 先写入 staging，全部成功后再替换 dist；避免中途失败留下被清空的 dist。
const staging = resolve(extension, ".dist-staging");
const previous = resolve(extension, ".dist-previous");
const envPath = resolve(project, ".env.local");

let envFile;
try {
  envFile = await readFile(envPath, "utf8");
} catch {
  throw new Error(
    `无法读取 ${envPath}。请先创建该文件（可复制 .env.example），并填写 NEXT_PUBLIC_SUPABASE_URL 与 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY。`,
  );
}
const env = Object.fromEntries(
  envFile
    .split(/\r?\n/)
    .filter(
      (line) => line && !line.trimStart().startsWith("#") && line.includes("="),
    )
    .map((line) => {
      const index = line.indexOf("=");
      return [
        line.slice(0, index).trim(),
        line
          .slice(index + 1)
          .trim()
          .replace(/^['"]|['"]$/g, ""),
      ];
    }),
);
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const workbenchUrl = env.NEXT_PUBLIC_WORKBENCH_URL || "http://localhost:3000";
if (!supabaseUrl || !publishableKey)
  throw new Error(
    `${envPath} 缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  );
for (const [name, value] of Object.entries({ supabaseUrl, workbenchUrl })) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/")
    throw new Error(`${name} 必须是 HTTP(S) Origin，不含路径`);
}

await rm(staging, { recursive: true, force: true });
await cp(src, staging, { recursive: true });
const manifest = JSON.parse(
  await readFile(resolve(extension, "manifest.template.json"), "utf8"),
);
manifest.host_permissions = [
  `${new URL(supabaseUrl).origin}/*`,
  `${new URL(workbenchUrl).origin}/*`,
];
await writeFile(
  resolve(staging, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  resolve(staging, "config.mjs"),
  `export const CONFIG = Object.freeze(${JSON.stringify({ supabaseUrl, publishableKey, workbenchUrl }, null, 2)});\n`,
);
// The verified probe file is the single source of truth for PDF layout.
await cp(
  resolve(project, "..", "chrome-pdf-probe", "extension", "print-config.mjs"),
  resolve(staging, "print-config.mjs"),
);

await rm(previous, { recursive: true, force: true });
try {
  await rename(dist, previous);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await rename(staging, dist);
await rm(previous, { recursive: true, force: true }).catch(() => {});
console.log(`Built unpacked extension: ${dist}`);
