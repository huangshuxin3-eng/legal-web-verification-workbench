import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  PRODUCTION_WORKBENCH_URL,
  assertDistEntries,
  assertProductionArtifacts,
  betaArchiveName,
  betaPackagePaths,
} from "../scripts/package-beta-config.mjs";

const productionManifest = {
  version: "8.1.0",
  host_permissions: [
    "https://rcfjgjxwftwkdbiwsavy.supabase.co/*",
    "https://legal-web-verification-workbench.vercel.app/*",
  ],
};

test("Beta archive name comes from manifest version", () => {
  assert.equal(
    betaArchiveName(productionManifest),
    "nonlit-web-verification-helper-8.1.0-beta.zip",
  );
});

test("Beta package accepts only Production config and permissions", () => {
  assert.doesNotThrow(() =>
    assertProductionArtifacts(
      `"workbenchUrl": "${PRODUCTION_WORKBENCH_URL}"`,
      productionManifest,
    ),
  );
  assert.throws(
    () =>
      assertProductionArtifacts(
        '"workbenchUrl": "http://localhost:3000"',
        productionManifest,
      ),
    /Production|localhost/,
  );
  assert.throws(
    () =>
      assertProductionArtifacts(
        `"workbenchUrl": "${PRODUCTION_WORKBENCH_URL}"`,
        {
          ...productionManifest,
          host_permissions: ["http://localhost:3000/*"],
        },
      ),
    /host permission|localhost/,
  );
});

test("Beta package source is fixed to extension/dist", () => {
  const projectRoot = resolve("workspace");
  const paths = betaPackagePaths(projectRoot);
  assert.equal(paths.source, resolve(projectRoot, "extension", "dist"));
  assert.equal(paths.release, resolve(projectRoot, "release"));
});

test("Beta package requires root manifest and excludes development paths", () => {
  const required = [
    "manifest.json",
    "config.mjs",
    "sidepanel.html",
    "worker.mjs",
  ];
  assert.doesNotThrow(() => assertDistEntries(required));
  assert.throws(
    () => assertDistEntries(["dist/manifest.json", ...required.slice(1)]),
    /根目录缺少 manifest\.json/,
  );
  for (const forbidden of [
    ".env.local",
    "tests/example.test.mjs",
    "node_modules/package/index.js",
    ".git/config",
    "../README.md",
  ])
    assert.throws(
      () => assertDistEntries([...required, forbidden]),
      /禁止的路径/,
    );
});
