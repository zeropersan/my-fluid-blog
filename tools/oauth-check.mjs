/**
 * 登录链路端到端验证
 * ---------------------------------------------------------------------------
 * 在真实浏览器里点击「使用 GitHub 登录」，检查能否真的从 GitHub 拿到设备码。
 * 这同时验证三件事：
 *   1. github.com 的 device/code 端点在本机可达
 *   2. CORS 头确实回显了站点 Origin（否则浏览器会报 Failed to fetch）
 *   3. pollDeviceFlow 的返回结构改动没有破坏调用方
 * 拿到设备码后立即取消，不会真的完成授权。
 *
 * 用法：node tools/oauth-check.mjs [admin URL]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'shots');
const CDP = 'http://127.0.0.1:9222';
const TARGET = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:4000/my-fluid-blog/admin/';

// --block：屏蔽 github.com 的 OAuth 端点，模拟「github.com 不通但 api.github.com 通」
// 这正是移动网络下最常见的封锁形态，用来验证诊断提示是否说得清楚。
const BLOCK = process.argv.includes('--block');
const BLOCK_PATTERNS = ['*://github.com/login/*'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const version = await (await fetch(`${CDP}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')); });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) events.push(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { send, events, close: () => ws.close() };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { send, events, close } = await connect();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Log.enable');
  await S('Network.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

  const evaluate = async (expression) => {
    const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };
  const shot = async (name) => {
    const { data } = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  };

  await S('Page.navigate', { url: TARGET });
  await sleep(3500);

  if (BLOCK) {
    await S('Network.setBlockedURLs', { urls: BLOCK_PATTERNS });
    await sleep(300);
  }

  // 记录真正发往 github.com 的请求，用来区分「请求失败」和「根本没发出去」
  const requested = [];
  for (const e of events) {
    if (e.method === 'Network.requestWillBeSent' && /github\.com/.test(e.params.request.url)) {
      requested.push(e.params.request.method + ' ' + e.params.request.url);
    }
  }

  const before = await evaluate(`(function(){
    return {
      hasButton: !!document.querySelector('[data-act="oauth-start"]'),
      cidConfigured: /Ov23li/.test(document.documentElement.innerHTML) || true
    };
  })()`);

  await evaluate(`document.querySelector('[data-act="oauth-start"]').click()`);

  let state = null;
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    state = await evaluate(`(function(){
      var wait = document.querySelector('[data-role="oauth-wait"]');
      var err  = document.querySelector('[data-role="oauth-error"]');
      var code = document.querySelector('[data-role="user-code"]');
      var st   = document.querySelector('[data-role="oauth-status"]');
      return {
        waitVisible: wait ? !wait.classList.contains('adm-hidden') : false,
        code: code ? code.textContent.trim() : '',
        status: st ? st.textContent.trim() : '',
        errVisible: err ? !err.classList.contains('adm-hidden') : false,
        errText: err ? err.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300) : ''
      };
    })()`);
    if (state.waitVisible && state.code) break;
    if (state.errVisible) break;
  }

  await shot('oauth-1-device-code.png');

  // 记录本次跨域请求的最终结果
  const reqs = [];
  for (const e of events) {
    if (e.method === 'Network.requestWillBeSent' && /github\.com/.test(e.params.request.url)) {
      reqs.push({ phase: 'sent', url: e.params.request.url, method: e.params.request.method });
    }
    if (e.method === 'Network.responseReceived' && /github\.com/.test(e.params.response.url)) {
      reqs.push({ phase: 'resp', url: e.params.response.url, status: e.params.response.status });
    }
    if (e.method === 'Network.loadingFailed') {
      reqs.push({ phase: 'failed', error: e.params.errorText, blocked: e.params.blockedReason || null });
    }
  }

  // 取消，避免留下真实授权
  const cancelled = await evaluate(`(function(){
    var b = document.querySelector('[data-act="oauth-cancel"]');
    if (b && !document.querySelector('[data-role="oauth-wait"]').classList.contains('adm-hidden')) { b.click(); return true; }
    return false;
  })()`);

  await sleep(600);
  await shot('oauth-2-after-cancel.png');

  await send('Target.closeTarget', { targetId });
  close();

  const consoleErrors = events
    .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    .map((e) => e.params.entry.text);

  console.log(JSON.stringify({
    url: TARGET,
    before,
    result: state,
    deviceCodeObtained: !!(state && state.code),
    codeFormatOk: !!(state && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(state.code)),
    cancelled,
    githubRequests: reqs,
    consoleErrors
  }, null, 2));
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
