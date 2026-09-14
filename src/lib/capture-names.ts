export const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
export type CaptureExtension = "pdf" | "png" | "jpg";
export function captureExtension(storagePath: string): CaptureExtension {
  if (/\.pdf$/i.test(storagePath)) return "pdf";
  if (/\.png$/i.test(storagePath)) return "png";
  return "jpg";
}
export function captureMimeType(extension: CaptureExtension) {
  if (extension === "pdf") return "application/pdf";
  return extension === "png" ? "image/png" : "image/jpeg";
}
export function captureLabel(value: number) {
  return String(value).padStart(3, "0");
}

// Business filenames are generated at display/download time, never stored.
// Storage uses a separate UUID filename to meet Supabase's ASCII key rules.
export function filenamePart(value: string): string {
  const normalized = value
    .normalize("NFC")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/g, "");
  let result = "";
  for (const character of normalized || "未命名") {
    if (result.length + character.length > 50) break;
    result += character;
  }
  result = result.replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result))
    result = `_${result}`;
  return result;
}
export function generatedCaptureName(
  input: {
    entity_name: string;
    topic: string;
    source_name: string;
    query_no: number;
    capture_no: number;
  },
  extension: CaptureExtension,
  now = new Date(),
) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .replaceAll("-", "");
  return `${filenamePart(input.entity_name)}_${filenamePart(input.topic)}_${filenamePart(input.source_name)}_Q${String(input.query_no).padStart(2, "0")}_${captureLabel(input.capture_no)}_${date}.${extension}`;
}
