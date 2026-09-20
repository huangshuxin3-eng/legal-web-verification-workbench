import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVELOPMENT_WORKBENCH_URL,
  PRODUCTION_WORKBENCH_URL,
  buildModeFromArgs,
  httpOrigin,
  resolveWorkbenchUrl,
} from "../scripts/build-config.mjs";

test("production build uses the fixed public workbench origin", () => {
  const workbenchUrl = resolveWorkbenchUrl("production", {
    NEXT_PUBLIC_WORKBENCH_URL: DEVELOPMENT_WORKBENCH_URL,
  });
  assert.equal(workbenchUrl, PRODUCTION_WORKBENCH_URL);
  assert.deepEqual(
    [
      `${httpOrigin("supabaseUrl", "https://rcfjgjxwftwkdbiwsavy.supabase.co")}/*`,
      `${httpOrigin("workbenchUrl", workbenchUrl)}/*`,
    ],
    [
      "https://rcfjgjxwftwkdbiwsavy.supabase.co/*",
      "https://legal-web-verification-workbench.vercel.app/*",
    ],
  );
});

test("development build keeps env override and localhost fallback", () => {
  assert.equal(buildModeFromArgs([]), "development");
  assert.equal(
    resolveWorkbenchUrl("development", {}),
    DEVELOPMENT_WORKBENCH_URL,
  );
  assert.equal(
    resolveWorkbenchUrl("development", {
      NEXT_PUBLIC_WORKBENCH_URL: "https://preview.example.com",
    }),
    "https://preview.example.com",
  );
});

test("build mode and HTTP(S) origin validation fail closed", () => {
  assert.equal(buildModeFromArgs(["--mode", "production"]), "production");
  assert.throws(() => buildModeFromArgs(["--mode", "staging"]), /--mode/);
  for (const value of [
    "not a url",
    "ftp://example.com",
    "https://example.com/api",
    "https://example.com/?token=1",
    "https://example.com/#fragment",
  ])
    assert.throws(() => httpOrigin("workbenchUrl", value), /HTTP\(S\) Origin/);
});
