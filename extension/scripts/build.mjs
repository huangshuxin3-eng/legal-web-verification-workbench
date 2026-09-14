import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, "..");
const project = resolve(extension, "..");
const dist = resolve(extension, "dist");
const env = Object.fromEntries(
  (await readFile(resolve(project, ".env.local"), "utf8"))
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
  throw new Error(".env.local 缺少 Supabase URL 或 Publishable Key");
for (const [name, value] of Object.entries({ supabaseUrl, workbenchUrl })) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/")
    throw new Error(`${name} 必须是 HTTP(S) Origin，不含路径`);
}
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(extension, "src"), dist, { recursive: true });
const manifest = JSON.parse(
  await readFile(resolve(extension, "manifest.template.json"), "utf8"),
);
manifest.host_permissions = [
  `${new URL(supabaseUrl).origin}/*`,
  `${new URL(workbenchUrl).origin}/*`,
];
await writeFile(
  resolve(dist, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  resolve(dist, "config.mjs"),
  `export const CONFIG = Object.freeze(${JSON.stringify({ supabaseUrl, publishableKey, workbenchUrl }, null, 2)});\n`,
);
// The verified probe file is the single source of truth for PDF layout.
await cp(
  resolve(project, "..", "chrome-pdf-probe", "extension", "print-config.mjs"),
  resolve(dist, "print-config.mjs"),
);
console.log(`Built unpacked extension: ${dist}`);
