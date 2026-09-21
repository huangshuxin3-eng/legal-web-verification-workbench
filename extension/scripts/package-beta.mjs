import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";
import {
  assertDistEntries,
  assertProductionArtifacts,
  betaArchiveName,
  betaPackagePaths,
} from "./package-beta-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const { source, release } = betaPackagePaths(projectRoot);

async function relativeFilesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory())
      files.push(
        ...(await relativeFilesUnder(join(directory, entry.name), next)),
      );
    else files.push(next);
  }
  return files;
}

const configText = await readFile(join(source, "config.mjs"), "utf8");
const manifest = JSON.parse(
  await readFile(join(source, "manifest.json"), "utf8"),
);
assertProductionArtifacts(configText, manifest);

const entries = await relativeFilesUnder(source);
assertDistEntries(entries);
for (const entry of entries) {
  const content = await readFile(join(source, entry));
  if (content.toString("utf8").includes("http://localhost:3000"))
    throw new Error(`Production dist 仍包含 localhost：${entry}`);
}

await mkdir(release, { recursive: true });
const archivePath = join(release, betaArchiveName(manifest));
await rm(archivePath, { force: true });

await new Promise((resolveArchive, rejectArchive) => {
  const output = createWriteStream(archivePath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  output.on("close", resolveArchive);
  output.on("error", rejectArchive);
  archive.on("warning", rejectArchive);
  archive.on("error", rejectArchive);
  archive.pipe(output);
  archive.directory(source, false);
  archive.finalize();
});

console.log(`Created External Beta package: ${archivePath}`);
