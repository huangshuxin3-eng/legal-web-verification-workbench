function part(value) {
  let result = String(value || "未命名")
    .normalize("NFC")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 50)
    .replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result))
    result = `_${result}`;
  return result || "未命名";
}
export function businessName(task, queryNo, captureNo, createdAt) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(createdAt))
    .replaceAll("-", "");
  return `${part(task.entity_name)}_${part(task.topic)}_${part(task.source_name)}_Q${String(queryNo).padStart(2, "0")}_${String(captureNo).padStart(3, "0")}_${date}.pdf`;
}
