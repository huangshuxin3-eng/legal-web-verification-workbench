export const DEVELOPMENT_WORKBENCH_URL = "http://localhost:3000";
export const PRODUCTION_WORKBENCH_URL =
  "https://legal-web-verification-workbench.vercel.app";

export function buildModeFromArgs(args) {
  const modeIndex = args.indexOf("--mode");
  if (modeIndex === -1) return "development";
  const mode = args[modeIndex + 1];
  if (mode === "development" || mode === "production") return mode;
  throw new Error("--mode 必须是 development 或 production");
}

export function httpOrigin(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 必须是合法的 HTTP(S) Origin`);
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(`${name} 必须是 HTTP(S) Origin，不含路径`);
  return url.origin;
}

export function resolveWorkbenchUrl(mode, environment) {
  return mode === "production"
    ? PRODUCTION_WORKBENCH_URL
    : environment.NEXT_PUBLIC_WORKBENCH_URL || DEVELOPMENT_WORKBENCH_URL;
}
