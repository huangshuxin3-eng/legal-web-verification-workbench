import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../database.types";
import { captureExtension, captureMimeType } from "../capture-names";
import {
  CaptureOperationError,
  deleteCaptureConsistently,
} from "../capture-workflow";

export function validId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
export async function captureContext(request: Request) {
  const token = request.headers.get("authorization");
  if (!token?.startsWith("Bearer "))
    throw new CaptureOperationError("请先登录。", 401);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new CaptureOperationError("Supabase 配置缺失。", 503);
  const userDb = createClient<Database>(url, key, {
    global: { headers: { Authorization: token } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userDb.auth.getUser(token.slice(7));
  if (error || !data.user)
    throw new CaptureOperationError("登录已失效，请重新登录。", 401);
  return { userDb, userId: data.user.id };
}
export async function ownedQuery(userDb: SupabaseClient<Database>, id: string) {
  if (!validId(id))
    throw new CaptureOperationError("查询不存在或无权访问。", 404);
  const { data, error } = await userDb
    .from("queries")
    .select("*, tasks(*)")
    .eq("id", id)
    .single();
  if (error || !data)
    throw new CaptureOperationError("查询不存在或无权访问。", 404);
  return data;
}
export async function ownedCapture(
  userDb: SupabaseClient<Database>,
  id: string,
) {
  if (!validId(id))
    throw new CaptureOperationError("留痕不存在或无权访问。", 404);
  const { data, error } = await userDb
    .from("captures")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !data)
    throw new CaptureOperationError("留痕不存在或无权访问。", 404);
  return data;
}
export function missingObject(error: {
  statusCode?: string | number;
  message?: string;
  code?: string;
}) {
  return (
    String(error.statusCode) === "404" ||
    ["NoSuchKey", "not_found"].includes(error.code ?? "") ||
    error.message === "Object not found"
  );
}
export async function removeCapture(
  userDb: SupabaseClient<Database>,
  capture: Database["public"]["Tables"]["captures"]["Row"],
) {
  const prepared = await userDb
    .rpc("prepare_capture_delete", { p_capture_id: capture.id })
    .single();
  if (prepared.error) throw prepared.error;
  const bucket = userDb.storage.from("captures");
  await deleteCaptureConsistently({
    download: async () => {
      const { data, error } = await bucket.download(capture.storage_path);
      if (error && !missingObject(error))
        throw new CaptureOperationError(
          "留痕文件读取失败，未执行删除，请重试。",
        );
      return data;
    },
    removeFile: async () => {
      const { error } = await bucket.remove([capture.storage_path]);
      if (error) throw error;
    },
    deleteRow: async () => {
      const { error } = await userDb.rpc("finish_capture_delete", {
        p_query_id: capture.query_id,
        p_capture_id: capture.id,
      });
      if (error) throw error;
    },
    findRow: async () => {
      const { data, error } = await userDb
        .from("captures")
        .select("*")
        .eq("id", capture.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    restore: async (blob) => {
      const { error } = await bucket.upload(capture.storage_path, blob, {
        contentType:
          blob.type || captureMimeType(captureExtension(capture.storage_path)),
        upsert: false,
      });
      if (error) throw error;
    },
  });
}
export async function cleanupCaptureUpload(
  userDb: SupabaseClient<Database>,
  queryId: string,
  captureId: string,
) {
  const cancelled = await userDb.rpc("cancel_capture_upload", {
    p_query_id: queryId,
    p_capture_id: captureId,
  });
  if (cancelled.error) throw cancelled.error;
  const pending = cancelled.data?.[0];
  if (!pending) return; // Already committed or cleaned; never delete committed bytes.
  const { error } = await userDb.storage
    .from("captures")
    .remove([pending.storage_path]);
  if (error) throw error;
  const finished = await userDb.rpc("finish_capture_delete", {
    p_query_id: queryId,
    p_capture_id: captureId,
  });
  if (finished.error) throw finished.error;
}
export function apiError(
  error: unknown,
  recovery?: { captureId: string; queryId: string },
) {
  return Response.json(
    {
      error:
        error instanceof CaptureOperationError
          ? error.message
          : "留痕操作失败，请检查网络后重试。",
      ...(recovery ? { recovery } : {}),
    },
    {
      status: error instanceof CaptureOperationError ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
