import {
  apiError,
  cleanupCaptureUpload,
  captureContext,
  missingObject,
  ownedQuery,
  validId,
} from "@/lib/server/capture-api";
import { captureMimeType, MAX_CAPTURE_BYTES } from "@/lib/capture-names";
import { validateCaptureFile } from "@/lib/server/capture-file";
import {
  CaptureOperationError,
  commitCaptureUpload,
} from "@/lib/capture-workflow";
import { safeWebsite } from "@/lib/tasks";
export const runtime = "nodejs";

async function boundedForm(request: Request) {
  if (!request.body) throw new CaptureOperationError("请选择留痕文件。", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_CAPTURE_BYTES + 65536) {
      await reader.cancel();
      throw new CaptureOperationError("留痕文件不能超过 20 MB。", 413);
    }
    chunks.push(value);
  }
  try {
    return await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw new CaptureOperationError("上传表单格式无效。", 400);
  }
}
export async function POST(request: Request) {
  let recovery: { captureId: string; queryId: string } | undefined;
  try {
    const { userDb } = await captureContext(request);
    const form = await boundedForm(request);
    const queryId = String(form.get("query_id") ?? "");
    await ownedQuery(userDb, queryId);
    const requestId = String(form.get("request_id") ?? "");
    if (requestId && !validId(requestId))
      throw new CaptureOperationError("留痕请求标识无效。", 400);
    const sourceInput = String(form.get("source_url") ?? "").trim();
    const sourceUrl = sourceInput ? safeWebsite(sourceInput) : null;
    if (sourceInput && !sourceUrl)
      throw new CaptureOperationError(
        "网页地址必须是有效的 HTTP(S) 地址。",
        400,
      );
    const file = form.get("file");
    if (!(file instanceof File) || !file.size || file.size > MAX_CAPTURE_BYTES)
      throw new CaptureOperationError(
        "请选择不超过 20 MB 的 PDF、PNG 或 JPG 留痕文件。",
        400,
      );
    const bytes = Buffer.from(await file.arrayBuffer());
    const extension = await validateCaptureFile(bytes);
    const { data: reservations, error } = await userDb.rpc(
      "reserve_capture_upload",
      {
        p_query_id: queryId,
        p_source_url: sourceUrl,
        p_extension: extension,
        ...(requestId ? { p_capture_id: requestId } : {}),
      },
    );
    if (error || !reservations?.[0])
      throw new CaptureOperationError(
        "无法分配留痕编号，请确认 Milestone 4 migration 已执行。",
      );
    const row = reservations[0];
    const id = row.id;
    recovery = { captureId: id, queryId };
    const bucket = userDb.storage.from("captures");
    const alreadySaved = await userDb
      .from("captures")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (alreadySaved.error) throw alreadySaved.error;
    if (alreadySaved.data)
      return Response.json(alreadySaved.data, {
        headers: { "Cache-Control": "no-store" },
      });

    // A retry may arrive after Storage accepted the previous request but its
    // response was lost. Commit that exact reservation instead of re-uploading.
    const existingObject = await bucket.download(row.storage_path);
    if (existingObject.data) {
      const finished = await userDb
        .rpc("finish_capture_upload", {
          p_query_id: queryId,
          p_capture_id: id,
        })
        .single();
      if (finished.error) throw finished.error;
      return Response.json(finished.data, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (existingObject.error && !missingObject(existingObject.error))
      throw new CaptureOperationError(
        "无法确认上次上传结果，请使用同一请求安全重试。",
        503,
      );
    const result = await commitCaptureUpload(row, {
      upload: async () => {
        const { error } = await bucket.upload(row.storage_path, bytes, {
          contentType: captureMimeType(extension),
          upsert: false,
        });
        if (error) throw error;
      },
      insert: async () => {
        const { data, error } = await userDb
          .rpc("finish_capture_upload", {
            p_query_id: queryId,
            p_capture_id: id,
          })
          .single();
        if (error) throw error;
        return data;
      },
      find: async () => {
        const { data, error } = await userDb
          .from("captures")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        return data;
      },
      remove: async () => {
        await cleanupCaptureUpload(userDb, queryId, id);
      },
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, recovery);
  }
}
