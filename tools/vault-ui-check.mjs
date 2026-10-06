/**
 * 管理口令（保险箱）端到端验证
 * ---------------------------------------------------------------------------
 * 在真实浏览器里走完整流程，重点确认「设了口令之后明文 Token 真的没了」：
 *   1. 首次进入 → 显示设置表单
 *   2. 填 Token + 口令 → 创建并登录
 *   3. 检查 localStorage：密文存在、明文 Token 已被删除
 *   4. 刷新页面 → 必须显示解锁表单（不能自动进入）
 *   5. 输错口令 → 被拒绝且不进入
 *   6. 输对口令 → 进入后台
 *
 * 用法：node tools/vault-ui-check.mjs [admin URL]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'shots');
const CDP = 'http://127.0.0.1:9222';
const TARGET = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:4000/my-fluid-blog/admin/';

const TOKEN = 'github_pat_TESTONLY_abcdefghijklmnopqrstuvwxyz0123456789';
const PASSWORD = 'test-pass-1234';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockScript(token) {
  return `(function () {
  window.__apiCalls = [];
  function json(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: status || 200, headers: { 'Content-Type': 'application/json' }
    }));
  }
  var real = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('https://api.github.com') !== 0) return real(input, init);
    var method = (init && init.method) || 'GET';
    window.__apiCalls.push(method + ' ' + url.replace('https://api.github.com', ''));
    var p = url.replace('https://api.github.com', '');
    // 只有带上我们那个测试 Token 才认可，用来确认真的用了 Token
    var auth = (init && init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
    var ok = auth.indexOf(${JSON.stringify(token)}) >= 0;
    if (p === '/user') return ok ? json({ login: 'zeropersan', avatar_url: '' }) : json({ message: 'Bad credentials' }, 401);
    if (/^\\/repos\\/[^/]+\\/[^/]+$/.test(p)) return ok ? json({ full_name: 'zeropersan/my-fluid-blog', permissions: { push: true } }) : json({ message: 'Not Found' }, 404);
    if (p.indexOf('/contents/') >= 0) return ok ? json([]) : json({ message: 'Not Found' }, 404);
    if (p.indexOf('/git/trees/') >= 0) return ok ? json({ tree: [] }) : json({ message: 'Not Found' }, 404);
    if (p.indexOf('/actions/runs') >= 0) return ok ? json({ workflow_runs: [] }) : json({ message: 'Not Found' }, 404);
    return ok ? json({}) : json({ message: 'Not Found' }, 404);
  };
})();`;
}

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
  await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: mockScript(TOKEN) });

  const evaluate = async (expression) => {
    const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };
  const shot = async (name) => {
    const { data } = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  };
  const reload = async () => { await S('Page.navigate', { url: TARGET }); await sleep(2600); };

  const R = {};

  await S('Page.navigate', { url: TARGET });
  await sleep(3000);

  /* 1. 首次进入应显示设置表单 */
  R.step1_setupForm = await evaluate(`(function(){
    return {
      tabs: Array.prototype.map.call(document.querySelectorAll('.adm-tab'), function(t){return t.textContent.trim();}),
      hasTokenField: !!document.querySelector('[data-role="setup-token"]'),
      hasPwField: !!document.querySelector('[data-role="setup-pw"]'),
      hasUnlockField: !!document.querySelector('[data-role="unlock-pw"]'),
      cryptoSupported: !!(window.crypto && window.crypto.subtle)
    };
  })()`);
  await shot('vault-1-setup.png');

  /* 2. 填写并创建 */
  await evaluate(`(function(){
    document.querySelector('[data-role="setup-token"]').value = ${JSON.stringify(TOKEN)};
    document.querySelector('[data-role="setup-pw"]').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('[data-role="setup-pw2"]').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('[data-act="setup"]').click();
  })()`);

  let loggedIn = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    loggedIn = await evaluate(`!!document.querySelector('.adm-shell')`);
    if (loggedIn) break;
  }
  R.step2_loggedIn = loggedIn;
  await shot('vault-2-logged-in.png');

  /* 3. 存储检查：密文存在、明文删除 */
  R.step3_storage = await evaluate(`(function(){
    var vault = localStorage.getItem('fluid-admin-vault');
    var plain = localStorage.getItem('fluid-admin-token');
    var parsed = null; try { parsed = JSON.parse(vault); } catch(e) {}
    return {
      vaultExists: !!vault,
      vaultKeys: parsed ? Object.keys(parsed).sort() : null,
      vaultKdf: parsed ? parsed.kdf : null,
      vaultIter: parsed ? parsed.iter : null,
      /** 密文里绝不能出现明文 Token */
      vaultLeaksToken: vault ? vault.indexOf(${JSON.stringify(TOKEN)}) >= 0 : false,
      plaintextToken: plain,
      plaintextRemoved: plain === null
    };
  })()`);

  /* 4. 刷新后必须要求解锁 */
  await reload();
  R.step4_afterReload = await evaluate(`(function(){
    return {
      shellPresent: !!document.querySelector('.adm-shell'),
      unlockFormShown: !!document.querySelector('[data-role="unlock-pw"]'),
      setupFormShown: !!document.querySelector('[data-role="setup-token"]'),
      firstTabLabel: (document.querySelector('.adm-tab') || {}).textContent
    };
  })()`);
  await shot('vault-3-locked.png');

  /* 5. 错误口令 */
  await evaluate(`(function(){
    document.querySelector('[data-role="unlock-pw"]').value = '完全错误的口令';
    document.querySelector('[data-act="unlock"]').click();
  })()`);
  await sleep(2500);
  R.step5_wrongPassword = await evaluate(`(function(){
    var msg = document.querySelector('[data-role="vault-msg"]');
    return {
      shellPresent: !!document.querySelector('.adm-shell'),
      message: msg ? msg.textContent.replace(/\\s+/g,' ').trim() : null
    };
  })()`);

  /* 6. 正确口令 */
  await evaluate(`(function(){
    document.querySelector('[data-role="unlock-pw"]').value = ${JSON.stringify(PASSWORD)};
    document.querySelector('[data-act="unlock"]').click();
  })()`);
  let unlocked = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    unlocked = await evaluate(`!!document.querySelector('.adm-shell')`);
    if (unlocked) break;
  }
  R.step6_unlocked = unlocked;

  /* 7. 解锁后明文仍不应落盘 */
  R.step7_afterUnlock = await evaluate(`(function(){
    return {
      plaintextToken: localStorage.getItem('fluid-admin-token'),
      vaultStillThere: !!localStorage.getItem('fluid-admin-vault')
    };
  })()`);

  await shot('vault-4-unlocked.png');

  await send('Target.closeTarget', { targetId });
  close();

  R.consoleErrors = events
    .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    .map((e) => e.params.entry.text)
    .filter((t) => !/404/.test(t));

  console.log(JSON.stringify(R, null, 2));
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
