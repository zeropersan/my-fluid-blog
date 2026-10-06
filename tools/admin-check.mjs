/**
 * 后台管理页面验证脚本
 * ---------------------------------------------------------------------------
 * 通过 Edge CDP 加载 /admin/，捕获控制台错误与失败请求，
 * 校验登录页渲染、标签切换，并输出桌面端与移动端截图。
 *
 * 用法：node tools/admin-check.mjs [admin URL]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'shots');
const CDP = 'http://127.0.0.1:9222';

const URL_ARG = process.argv.find((a) => a.startsWith('http'));
const TARGET = URL_ARG || 'http://127.0.0.1:4000/admin/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const version = await (await fetch(`${CDP}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP 连接失败'));
  });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
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

  const evaluate = async (expression) => {
    const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };

  const shot = async (name) => {
    const { data } = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  };

  /* ---------- 桌面视口 ---------- */
  await S('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await S('Page.navigate', { url: TARGET });
  await sleep(3500);

  const desktop = await evaluate(`(function(){
    var root = document.getElementById('adm-root');
    var cs = getComputedStyle(document.documentElement);
    var login = document.querySelector('.adm-login');
    var btn = document.querySelector('.adm-btn-primary');
    return {
      title: document.title,
      hasLogin: !!login,
      tabCount: document.querySelectorAll('.adm-tab').length,
      hasDeviceTab: !!document.querySelector('[data-pane="oauth"]'),
      hasPatTab: !!document.querySelector('[data-pane="pat"]'),
      hasClientIdInput: !!document.querySelector('[data-role="cid"]'),
      bodyBgVar: cs.getPropertyValue('--board-bg-color').trim(),
      h1: login ? (login.querySelector('h1') || {}).textContent : null,
      rootChildren: root ? root.children.length : -1,
      primaryBtnBg: btn ? getComputedStyle(btn).backgroundColor : null
    };
  })()`);

  await shot('admin-1-desktop-login.png');

  /* ---------- 切到 PAT 标签 ---------- */
  const patTab = await evaluate(`(function(){
    var t = document.querySelector('[data-tab="pat"]');
    if (!t) return null;
    t.click();
    var pane = document.querySelector('[data-pane="pat"]');
    return {
      patHidden: pane ? pane.classList.contains('adm-hidden') : null,
      oauthHidden: document.querySelector('[data-pane="oauth"]').classList.contains('adm-hidden'),
      hasPatInput: !!document.querySelector('[data-role="pat"]')
    };
  })()`);
  await sleep(400);
  await shot('admin-2-desktop-pat.png');

  /* ---------- 移动视口 ---------- */
  await S('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await S('Page.navigate', { url: TARGET });
  await sleep(2500);

  const mobile = await evaluate(`(function(){
    var card = document.querySelector('.adm-login-card');
    var r = card ? card.getBoundingClientRect() : null;
    return {
      viewportWidth: window.innerWidth,
      cardWidth: r ? Math.round(r.width) : null,
      cardFits: r ? (r.left >= 0 && r.right <= window.innerWidth + 1) : null,
      hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth
    };
  })()`);
  await shot('admin-3-mobile-login.png');

  /* ---------- 汇总错误 ---------- */
  const errors = [];
  const failedRequests = [];
  for (const e of events) {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text || 'unknown');
    }
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      errors.push(e.params.entry.text + (e.params.entry.url ? ' @ ' + e.params.entry.url : ''));
    }
    if (e.method === 'Network.loadingFailed') {
      failedRequests.push(e.params.errorText + ' (' + (e.params.type || '') + ')');
    }
  }

  await send('Target.closeTarget', { targetId });
  close();

  console.log(JSON.stringify({
    url: TARGET,
    desktop,
    patTab,
    mobile,
    consoleErrors: errors,
    failedRequests,
    shots: ['admin-1-desktop-login.png', 'admin-2-desktop-pat.png', 'admin-3-mobile-login.png'],
  }, null, 2));
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
