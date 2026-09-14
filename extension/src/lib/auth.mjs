import { CONFIG } from "../config.mjs";
const KEY = "supabaseSession";
const headers = () => ({
  apikey: CONFIG.publishableKey,
  "Content-Type": "application/json",
});
export async function session() {
  return (await chrome.storage.local.get(KEY))[KEY] || null;
}
async function save(value) {
  await chrome.storage.local.set({ [KEY]: value });
  return value;
}
export async function signIn(email, password) {
  const response = await fetch(
    `${CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ email, password }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("登录失败，请检查邮箱、密码及账号状态。");
  return save({
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    user: body.user,
  });
}
async function refresh(current) {
  const response = await fetch(
    `${CONFIG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ refresh_token: current.refreshToken }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    await chrome.storage.local.remove(KEY);
    throw new Error("登录已失效，请重新登录。");
  }
  return save({
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    user: body.user,
  });
}
export async function validSession() {
  const current = await session();
  if (!current) throw new Error("请先登录。");
  return current.expiresAt - Date.now() < 60000 ? refresh(current) : current;
}
export async function signOut() {
  const current = await session();
  if (current)
    await fetch(`${CONFIG.supabaseUrl}/auth/v1/logout`, {
      method: "POST",
      headers: { ...headers(), Authorization: `Bearer ${current.accessToken}` },
    }).catch(() => {});
  await chrome.storage.local.remove([KEY, "recentSelection"]);
}
export async function authorizedFetch(url, options = {}, retry = true) {
  const current = await validSession();
  const requestHeaders = {
    ...options.headers,
    Authorization: `Bearer ${current.accessToken}`,
  };
  if (url.startsWith(CONFIG.supabaseUrl))
    requestHeaders.apikey = CONFIG.publishableKey;
  const response = await fetch(url, { ...options, headers: requestHeaders });
  if (response.status === 401 && retry) {
    await refresh(current);
    return authorizedFetch(url, options, false);
  }
  return response;
}
