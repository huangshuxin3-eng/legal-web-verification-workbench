import { CONFIG } from "./config.mjs";
import { authorizedFetch } from "./lib/auth.mjs";
const params = new URL(location.href).searchParams;
const id = params.get("id");
const name = params.get("name") || "留痕预览";
document.getElementById("name").textContent = name;
let blobUrl;
try {
  const response = await authorizedFetch(
    `${CONFIG.workbenchUrl}/api/captures/${encodeURIComponent(id)}`,
  );
  if (!response.ok) throw new Error("留痕不存在、登录已失效或无权访问。");
  blobUrl = URL.createObjectURL(await response.blob());
  const frame = document.getElementById("preview");
  frame.src = blobUrl;
  frame.hidden = false;
} catch (error) {
  document.getElementById("error").textContent = error.message;
}
window.addEventListener("pagehide", () => {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});
