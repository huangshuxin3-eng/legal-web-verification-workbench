import sharp from "sharp";
import type { CaptureExtension } from "../capture-names.ts";
import { CaptureOperationError } from "../capture-workflow.ts";

export async function validateCaptureFile(
  bytes: Buffer,
): Promise<CaptureExtension> {
  if (
    bytes.subarray(0, 5).toString("ascii") === "%PDF-" &&
    bytes
      .subarray(Math.max(0, bytes.length - 4096))
      .includes(Buffer.from("%%EOF"))
  )
    return "pdf";
  try {
    const image = sharp(bytes, {
      limitInputPixels: 25000000,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (
      !["png", "jpeg"].includes(metadata.format ?? "") ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error("format");
    await image.stats();
    return metadata.format === "png" ? "png" : "jpg";
  } catch {
    throw new CaptureOperationError(
      "留痕文件无效，仅支持完整的 PDF、PNG 或 JPG 文件；图片最多 2500 万像素。",
      400,
    );
  }
}
