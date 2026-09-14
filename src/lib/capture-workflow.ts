import type { Capture } from "./database.types.ts";

export class CaptureOperationError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

/** Upload object first, then commit metadata. Resolve ambiguous DB responses
 * before compensating: never remove a file whose row was actually committed. */
export async function commitCaptureUpload(
  row: Capture,
  operations: {
    upload: () => Promise<void>;
    insert: () => Promise<Capture>;
    find: () => Promise<Capture | null>;
    remove: () => Promise<void>;
  },
): Promise<Capture> {
  try {
    await operations.upload();
  } catch {
    // Upload may have succeeded but lost its response. No row was inserted here.
    try {
      await operations.remove();
    } catch {
      throw new CaptureOperationError(
        "上传结果未确认，文件清理失败。请保留此页面并重试清理。",
      );
    }
    throw new CaptureOperationError("留痕文件上传失败，未创建记录，请重试。");
  }
  try {
    return await operations.insert();
  } catch {
    let saved: Capture | null;
    try {
      saved = await operations.find();
    } catch {
      throw new CaptureOperationError(
        "无法确认留痕是否已保存，请刷新查询确认，不要重复上传。",
      );
    }
    if (saved?.storage_path === row.storage_path) return saved;
    try {
      await operations.remove();
    } catch {
      throw new CaptureOperationError(
        "记录保存失败，文件清理也失败。请保留此页面并重试清理。",
      );
    }
    if (saved) return saved; // same request won concurrently using another reservation
    throw new CaptureOperationError("记录保存失败，已清理上传文件，请重试。");
  }
}

/** Keep the row if object removal fails. If DB deletion fails, restore bytes.
 * A retry also handles a previously removed object and an extant row. */
export async function deleteCaptureConsistently(operations: {
  download: () => Promise<Blob | null>;
  removeFile: () => Promise<void>;
  deleteRow: () => Promise<void>;
  findRow: () => Promise<Capture | null>;
  restore: (blob: Blob) => Promise<void>;
}): Promise<void> {
  const backup = await operations.download();
  try {
    await operations.removeFile();
  } catch {
    // A failed HTTP response may still have deleted the object. Verify/restore.
    try {
      if (!(await operations.download()) && backup)
        await operations.restore(backup);
    } catch {
      throw new CaptureOperationError(
        "图片删除结果未确认，记录已保留，请重试删除以完成清理。",
      );
    }
    throw new CaptureOperationError("留痕文件删除失败，记录已保留，请重试。");
  }
  try {
    await operations.deleteRow();
  } catch {
    let remaining: Capture | null;
    try {
      remaining = await operations.findRow();
    } catch {
      throw new CaptureOperationError(
        "删除结果未确认，请刷新后重试删除以完成清理。",
      );
    }
    if (!remaining) return;
    if (backup) {
      try {
        await operations.restore(backup);
      } catch {
        throw new CaptureOperationError(
          "记录仍在，但留痕文件恢复失败。请重试删除以完成清理。",
        );
      }
    }
    throw new CaptureOperationError("记录删除失败，尚未完成删除，请重试。");
  }
}
