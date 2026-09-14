import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
export type UploadRecovery = { captureId: string; queryId: string };
export class CaptureClientError extends Error {
  constructor(
    message: string,
    public recovery?: UploadRecovery,
  ) {
    super(message);
  }
}
export async function captureRequest(
  db: SupabaseClient<Database>,
  path: string,
  options: RequestInit = {},
) {
  const { data, error } = await db.auth.getSession();
  if (error || !data.session)
    throw new CaptureClientError("请重新登录后操作。");
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      ...options.headers,
      Authorization: `Bearer ${data.session.access_token}`,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      recovery?: UploadRecovery;
    };
    throw new CaptureClientError(
      body.error || "留痕操作失败，请重试。",
      body.recovery,
    );
  }
  return response;
}
