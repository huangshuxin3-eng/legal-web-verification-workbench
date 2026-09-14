import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commitCaptureUpload,
  deleteCaptureConsistently,
} from "../src/lib/capture-workflow.ts";
import {
  generatedCaptureName,
  filenamePart,
} from "../src/lib/capture-names.ts";
import type { Capture } from "../src/lib/database.types.ts";

const row: Capture = {
  id: "id",
  query_id: "query",
  capture_no: 1,
  storage_path: "owner/project/task/query/id.png",
  source_url: "https://example.com",
  created_at: "2026-09-14T00:00:00Z",
};
const failure = async () => {
  throw new Error("injected failure");
};

test("business filename is Chinese, deterministic and Windows safe", () => {
  assert.equal(
    generatedCaptureName(
      {
        entity_name: "北京木锐机器人有限公司",
        topic: "知识产权",
        source_name: "国家知识产权局",
        query_no: 1,
        capture_no: 1,
      },
      "png",
      new Date("2026-09-13T16:00:00Z"),
    ),
    "北京木锐机器人有限公司_知识产权_国家知识产权局_Q01_001_20260914.png",
  );
  assert.equal(filenamePart('a<>:"/\\|?*\n. '), "a__________");
  assert.equal(filenamePart("CON"), "_CON");
  assert.ok(filenamePart("中".repeat(100)).length <= 50);
  assert.ok(
    generatedCaptureName(
      {
        entity_name: "公司",
        topic: "事项",
        source_name: "网站",
        query_no: 100,
        capture_no: 1000,
      },
      "jpg",
    ).includes("_Q100_1000_"),
  );
  assert.ok(
    generatedCaptureName(
      {
        entity_name: "公司",
        topic: "执行",
        source_name: "执行信息网",
        query_no: 1,
        capture_no: 1,
      },
      "pdf",
      new Date("2026-09-13T16:00:00Z"),
    ).endsWith("_Q01_001_20260914.pdf"),
  );
});
test("upload failure cleans object and never inserts a record", async () => {
  const calls: string[] = [];
  await assert.rejects(
    commitCaptureUpload(row, {
      upload: failure,
      insert: async () => {
        calls.push("insert");
        return row;
      },
      find: async () => null,
      remove: async () => {
        calls.push("remove");
      },
    }),
    /上传失败/,
  );
  assert.deepEqual(calls, ["remove"]);
});
test("record insertion failure removes the uploaded file", async () => {
  const calls: string[] = [];
  await assert.rejects(
    commitCaptureUpload(row, {
      upload: async () => {
        calls.push("upload");
      },
      insert: failure,
      find: async () => null,
      remove: async () => {
        calls.push("remove");
      },
    }),
    /已清理/,
  );
  assert.deepEqual(calls, ["upload", "remove"]);
});
test("lost DB response is reconciled without deleting a committed image", async () => {
  let removed = false;
  assert.deepEqual(
    await commitCaptureUpload(row, {
      upload: async () => {},
      insert: failure,
      find: async () => row,
      remove: async () => {
        removed = true;
      },
    }),
    row,
  );
  assert.equal(removed, false);
});
test("unknown commit outcome does not delete potentially committed bytes", async () => {
  let removed = false;
  await assert.rejects(
    commitCaptureUpload(row, {
      upload: async () => {},
      insert: failure,
      find: failure,
      remove: async () => {
        removed = true;
      },
    }),
    /无法确认/,
  );
  assert.equal(removed, false);
});
test("cleanup failure is reported as unfinished, never as success", async () => {
  await assert.rejects(
    commitCaptureUpload(row, {
      upload: async () => {},
      insert: failure,
      find: async () => null,
      remove: failure,
    }),
    /清理也失败/,
  );
});
test("file delete failure preserves database row", async () => {
  let deleted = false;
  await assert.rejects(
    deleteCaptureConsistently({
      download: async () => new Blob(["image"]),
      removeFile: failure,
      deleteRow: async () => {
        deleted = true;
      },
      findRow: async () => row,
      restore: async () => {},
    }),
    /记录已保留/,
  );
  assert.equal(deleted, false);
});
test("lost file-delete response restores bytes when removal actually succeeded", async () => {
  const bytes = new Blob(["image"]);
  let reads = 0;
  let restored = false;
  let deleted = false;
  await assert.rejects(
    deleteCaptureConsistently({
      download: async () => (++reads === 1 ? bytes : null),
      removeFile: failure,
      deleteRow: async () => {
        deleted = true;
      },
      findRow: async () => row,
      restore: async () => {
        restored = true;
      },
    }),
    /记录已保留/,
  );
  assert.equal(restored, true);
  assert.equal(deleted, false);
});
test("database deletion failure restores original image bytes", async () => {
  const bytes = new Blob(["image"]);
  let restored: Blob | null = null;
  await assert.rejects(
    deleteCaptureConsistently({
      download: async () => bytes,
      removeFile: async () => {},
      deleteRow: failure,
      findRow: async () => row,
      restore: async (blob) => {
        restored = blob;
      },
    }),
    /尚未完成/,
  );
  assert.equal(restored, bytes);
});
test("lost delete response is recognized as success without restoring orphan bytes", async () => {
  let restored = false;
  await deleteCaptureConsistently({
    download: async () => new Blob(["image"]),
    removeFile: async () => {},
    deleteRow: failure,
    findRow: async () => null,
    restore: async () => {
      restored = true;
    },
  });
  assert.equal(restored, false);
});
test("retry can remove a dangling record after prior object removal", async () => {
  let deleted = false;
  await deleteCaptureConsistently({
    download: async () => null,
    removeFile: async () => {},
    deleteRow: async () => {
      deleted = true;
    },
    findRow: async () => null,
    restore: async () => {},
  });
  assert.equal(deleted, true);
});
test("restoration failure remains an explicit retryable failure", async () => {
  await assert.rejects(
    deleteCaptureConsistently({
      download: async () => new Blob(["image"]),
      removeFile: async () => {},
      deleteRow: failure,
      findRow: async () => row,
      restore: failure,
    }),
    /恢复失败/,
  );
});
