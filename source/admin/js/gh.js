/**
 * GitHub API 客户端
 * ---------------------------------------------------------------------------
 * · 认证：OAuth Device Flow（无需后端/客户端密钥）+ Personal Access Token 后备
 *   Device Flow 之所以能在纯静态页里跑通，是因为 GitHub 的
 *   /login/device/code 与 /login/oauth/access_token 都会回显站点 Origin 的
 *   CORS 头（已实测）。access_token 端点不需要 client_secret。
 * · Token 只保存在浏览器 localStorage，绝不写入仓库、不上传任何服务器。
 */

import { BRANCH, LS, OAUTH_SCOPE, safeGet, safeSet, safeRemove } from './config.js';

const API = 'https://api.github.com';
const OAUTH = 'https://github.com/login';

/* ==========================================================================
   Token 管理
   ========================================================================== */

let token = safeGet(LS.token) || '';
let currentUser = null;

export function getToken() { return token; }
export function getUser() { return currentUser; }
export function isLoggedIn() { return !!token; }

/**
 * 设置当前 Token
 * @param {string} value
 * @param {boolean} [persist=true] 是否写入 localStorage。
 *   用口令解锁时应传 false —— Token 已在内存中，明文不应再落盘，
 *   保险箱里的密文才是它唯一的持久化形式。
 */
export function setToken(value, persist = true) {
  token = value || '';
  if (!token || persist === false) {
    // 不持久化时，顺手清掉可能残留的明文
    safeRemove(LS.token);
    return;
  }
  safeSet(LS.token, token);
}

export function logout() {
  setToken('');
  currentUser = null;
}

/* ==========================================================================
   底层请求
   ========================================================================== */

export class GitHubError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.payload = payload || null;
  }
}

/* ==========================================================================
   网络层错误处理
   --------------------------------------------------------------------------
   fetch 只在「根本没拿到响应」时才抛 TypeError，浏览器统一报成 "Failed to fetch"。
   触发条件包括：DNS 解析失败、连接超时或被重置、被代理/防火墙拦截、
  CORS 预检被拒。这句话对用户毫无信息量，所以这里把它翻译成：
     · 明确指出是哪个域名连不上
     · 给出可操作的排查方向
   并用 err.network = true 打标，供 UI 决定是否引导切到 Token 方式。
   ========================================================================== */

function hostOf(url) {
  try { return new URL(url, location.href).host; } catch (e) { return url; }
}

function networkError(url, cause) {
  const host = hostOf(url);
  const err = new GitHubError(
    `无法连接 ${host}。` +
    '可能是：当前网络屏蔽了该域名、需要代理、移动数据与 Wi-Fi 表现不同、' +
    '或浏览器拦截了跨域请求。',
    0, null
  );
  err.network = true;
  err.host = host;
  err.cause = cause;
  return err;
}

/** 包一层 fetch：加超时 + 把网络层异常转成可读的 GitHubError */
async function safeFetch(url, init, timeoutMs = 20000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await fetch(url, ctrl ? Object.assign({}, init, { signal: ctrl.signal }) : init);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new GitHubError(`连接 ${hostOf(url)} 超时（${Math.round(timeoutMs / 1000)} 秒无响应）`, 0, null);
      err.network = true;
      err.timeout = true;
      err.host = hostOf(url);
      throw err;
    }
    throw networkError(url, e);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 探测 api.github.com 是否可达（该域名的 CORS 是 *，可以直接探）。
 * github.com 没有 CORS 开放的普通端点，只能在真正发起 OAuth 请求时才知道结果，
 * 所以这里只探 api，用于区分「整体断网」和「只有 github.com 不通」。
 */
export async function probeApiReachable() {
  try {
    const res = await fetch(`${API}/zen?t=${Date.now()}`, { cache: 'no-store' });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/**
 * 调用 GitHub REST API
 * @param {string} path  以 / 开头的路径，如 /repos/o/r/contents/x
 * @param {object} [opts] { method, body, headers, raw }
 */
export async function api(path, opts = {}) {
  const headers = Object.assign({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }, opts.headers || {});

  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined && !(opts.body instanceof ArrayBuffer)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await safeFetch(API + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined
      ? undefined
      : (opts.body instanceof ArrayBuffer ? opts.body : JSON.stringify(opts.body)),
  });

  if (opts.raw) return res;

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = { message: text }; }
  }

  if (!res.ok) {
    let msg = (data && data.message) || `请求失败（HTTP ${res.status}）`;
    if (res.status === 401) msg = '认证失败，Token 可能已失效或权限不足';
    if (res.status === 403) {
      const remaining = res.headers.get('X-RateLimit-Remaining');
      if (remaining === '0') {
        const reset = Number(res.headers.get('X-RateLimit-Reset')) * 1000;
        msg = `API 速率已用尽，将在 ${new Date(reset).toLocaleTimeString()} 后恢复`;
      } else {
        msg = '权限不足：' + msg;
      }
    }
    if (res.status === 404) msg = '资源不存在或 Token 无权访问该仓库';
    if (res.status === 409) msg = '内容冲突：远端文件已变更，请重新载入后再保存';
    throw new GitHubError(msg, res.status, data);
  }

  return data;
}

/* ==========================================================================
   登录：PAT
   ========================================================================== */

/** 用 Token 拉取当前用户并校验有效性 */
export async function fetchUser() {
  currentUser = await api('/user');
  return currentUser;
}

/** 校验 PAT 是否可用（并确认对目标仓库有写权限） */
export async function validatePat(pat, repoFull) {
  const prev = token;
  token = pat;
  try {
    const user = await fetchUser();
    const repo = await api(`/repos/${repoFull}`);
    const canWrite = !!(repo.permissions && repo.permissions.push);
    return { user, repo, canWrite };
  } finally {
    // 校验失败时不要把坏 token 留下
    if (!currentUser) token = prev;
  }
}

/* ==========================================================================
   登录：OAuth Device Flow
   ========================================================================== */

/**
 * 第一步：申请设备码
 * 用 form-urlencoded 发送（属于 CORS 简单请求，不会触发预检）
 * 移动网络容易抖动，这里对网络层失败自动重试一次。
 */
export async function startDeviceFlow(clientId, opts = {}) {
  const body = new URLSearchParams({ client_id: clientId, scope: OAUTH_SCOPE }).toString();
  const init = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  };

  let res;
  try {
    res = await safeFetch(`${OAUTH}/device/code`, init, opts.timeout || 25000);
  } catch (e) {
    if (e.network && !e.timeout) {
      // 再给一次机会，短暂丢包很常见
      await new Promise((r) => setTimeout(r, 1200));
      res = await safeFetch(`${OAUTH}/device/code`, init, opts.timeout || 25000);
    } else {
      throw e;
    }
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) {
    throw new GitHubError(
      (data && (data.error_description || data.error)) ||
        '无法获取设备码，请检查 Client ID 是否正确、OAuth App 是否已启用 Device Flow',
      res.status, data
    );
  }
  return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

/**
 * 第二步：轮询换取 token
 * @param {string} clientId
 * @param {string} deviceCode
 * @param {number} interval      秒
 * @param {number} expiresIn     秒
 * @param {(state:string)=>void} onState  用于 UI 反馈
 */
export async function pollDeviceFlow(clientId, deviceCode, interval, expiresIn, onState) {
  const deadline = Date.now() + expiresIn * 1000;
  let wait = Math.max(interval || 5, 5);
  let netFails = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait * 1000));

    let res;
    try {
      res = await safeFetch(`${OAUTH}/oauth/access_token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
      }, 20000);
      netFails = 0;
    } catch (e) {
      // 轮询期间偶发断网不应终结整个授权流程（尤其在手机上切来切去的时候）
      netFails++;
      if (netFails >= 3) throw e;
      if (onState) onState('network');
      continue;
    }

    const data = await res.json().catch(() => null);
    if (!data) continue;

    if (data.access_token) {
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresIn: data.expires_in || null,
        scope: data.scope || null,
      };
    }

    switch (data.error) {
      case 'authorization_pending':
        if (onState) onState('pending');
        break;
      case 'slow_down':
        wait += 5;
        if (onState) onState('slow_down');
        break;
      case 'expired_token':
        throw new GitHubError('设备码已过期，请重新发起登录', 0, data);
      case 'access_denied':
        throw new GitHubError('你取消了授权', 0, data);
      case 'incorrect_client_credentials':
        throw new GitHubError('Client ID 不正确', 0, data);
      case 'device_flow_disabled':
        throw new GitHubError('该 OAuth App 未启用 Device Flow，请在 GitHub 设置里勾选启用', 0, data);
      default:
        throw new GitHubError(data.error_description || data.error || '授权失败', 0, data);
    }
  }
  throw new GitHubError('设备码已过期，请重新发起登录', 0, null);
}

/* ==========================================================================
   仓库 / 内容
   ========================================================================== */

export function getRepoInfo(repoFull) {
  return api(`/repos/${repoFull}`);
}

/** 列出目录（返回 [] 表示目录不存在，交给上层当作空处理） */
export async function listDir(repoFull, path) {
  try {
    const data = await api(`/repos/${repoFull}/contents/${encodeURI(path)}?ref=${BRANCH}`);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

/** 一次拿到整棵文件树（列图片库用，比逐层列目录省很多请求） */
export async function listTree(repoFull) {
  const data = await api(`/repos/${repoFull}/git/trees/${BRANCH}?recursive=1`);
  return (data && data.tree) || [];
}

/** 读取文本文件 */
export async function getFileText(repoFull, path) {
  const data = await api(`/repos/${repoFull}/contents/${encodeURI(path)}?ref=${BRANCH}`);
  if (Array.isArray(data)) throw new GitHubError('目标是一个目录，不是文件', 0, null);
  const content = decodeBase64Utf8(data.content || '');
  return { text: content, sha: data.sha, path: data.path, size: data.size };
}

/** 读取文件元信息（不取内容） */
export async function getFileMeta(repoFull, path) {
  try {
    const data = await api(`/repos/${repoFull}/contents/${encodeURI(path)}?ref=${BRANCH}`);
    if (Array.isArray(data)) return null;
    return { sha: data.sha, size: data.size, path: data.path };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** 写入 / 更新文本文件（UTF-8） */
export async function putFileText(repoFull, path, text, message, sha) {
  const body = {
    message,
    content: encodeBase64Utf8(text),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const data = await api(`/repos/${repoFull}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    body,
  });
  return { sha: data.content ? data.content.sha : null, commit: data.commit };
}

/** 删除文件 */
export async function deleteFile(repoFull, path, sha, message) {
  return api(`/repos/${repoFull}/contents/${encodeURI(path)}`, {
    method: 'DELETE',
    body: { message, sha, branch: BRANCH },
  });
}

/* ==========================================================================
   图片上传
   ========================================================================== */

/**
 * 上传二进制文件。
 * 小于 1MB 走 Contents API；超过则改走 Git Data API
 * （Contents API 对 >1MB 的文件不可靠，官方建议用 Git Data API）。
 * @param {ArrayBuffer} buffer
 */
export async function putFileBinary(repoFull, path, buffer, message, sha) {
  if (buffer.byteLength <= 1024 * 1024 && sha) {
    // 覆盖已有小文件
    return api(`/repos/${repoFull}/contents/${encodeURI(path)}`, {
      method: 'PUT',
      body: { message, content: arrayBufferToBase64(buffer), branch: BRANCH, sha },
    });
  }
  if (buffer.byteLength <= 1024 * 1024) {
    return api(`/repos/${repoFull}/contents/${encodeURI(path)}`, {
      method: 'PUT',
      body: { message, content: arrayBufferToBase64(buffer), branch: BRANCH },
    });
  }
  return putFileBinaryViaGitData(repoFull, path, buffer, message);
}

async function putFileBinaryViaGitData(repoFull, path, buffer, message) {
  // 1. 建 blob
  const blob = await api(`/repos/${repoFull}/git/blobs`, {
    method: 'POST',
    body: { content: arrayBufferToBase64(buffer), encoding: 'base64' },
  });

  // 2. 取当前 commit 与 tree
  const ref = await api(`/repos/${repoFull}/git/ref/heads/${BRANCH}`);
  const parentSha = ref.object.sha;
  const parentCommit = await api(`/repos/${repoFull}/git/commits/${parentSha}`);

  // 3. 新 tree
  const tree = await api(`/repos/${repoFull}/git/trees`, {
    method: 'POST',
    body: {
      base_tree: parentCommit.tree.sha,
      tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
    },
  });

  // 4. 新 commit
  const commit = await api(`/repos/${repoFull}/git/commits`, {
    method: 'POST',
    body: { message, tree: tree.sha, parents: [parentSha] },
  });

  // 5. 推进分支
  await api(`/repos/${repoFull}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: { sha: commit.sha },
  });

  return { commit };
}

/* ==========================================================================
   Actions（部署状态）
   ========================================================================== */

export function listWorkflowRuns(repoFull, perPage = 10) {
  return api(`/repos/${repoFull}/actions/runs?per_page=${perPage}`);
}

export function listRunJobs(repoFull, runId) {
  return api(`/repos/${repoFull}/actions/runs/${runId}/jobs`);
}

export async function rerunWorkflow(repoFull, runId) {
  const res = await api(`/repos/${repoFull}/actions/runs/${runId}/rerun`, {
    method: 'POST',
    raw: true,
  });
  // 201 = 已接受
  if (res.status !== 201 && res.status !== 204) {
    const t = await res.text();
    throw new GitHubError('重新部署失败（HTTP ' + res.status + '）' + (t ? '：' + t : ''), res.status, null);
  }
  return true;
}

/* ==========================================================================
   编解码
   ========================================================================== */

function decodeBase64Utf8(b64) {
  const clean = String(b64).replace(/\s/g, '');
  if (!clean) return '';
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function encodeBase64Utf8(str) {
  return arrayBufferToBase64(new TextEncoder().encode(str).buffer);
}

/** 分块转 base64，避免大文件时 String.fromCharCode(...) 参数过多而栈溢出 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
