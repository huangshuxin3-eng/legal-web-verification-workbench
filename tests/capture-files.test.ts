import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { validateCaptureFile } from "../src/lib/server/capture-file.ts";

test("capture file detection uses bytes, not user filename or MIME", async () => {
  assert.equal(
    await validateCaptureFile(
      Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"),
    ),
    "pdf",
  );
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  assert.equal(await validateCaptureFile(png), "png");
  await assert.rejects(
    validateCaptureFile(Buffer.from("%PDF-1.7\nmissing eof")),
    /仅支持完整的 PDF/,
  );
});
