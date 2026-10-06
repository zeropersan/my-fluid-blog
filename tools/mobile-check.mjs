/**
 * 移动端阅读增强验证脚本 / Mobile reading UI verification
 * ---------------------------------------------------------------------------
 * 通过 Edge 的 CDP 接口加载 Hexo 预览站的文章页，模拟 390x844 手机视口，
 * 截图并导出关键状态，用于确认目录按钮 / 返回顶部按钮的实际渲染效果。
 *
 * 用法：node tools/mobile-check.mjs [文章URL]
 * 依赖：Edge 已以 --remote-debugging-port=9222 启动；Node >= 22（内置 WebSocket）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'shots');
const CDP = 'http://127.0.0.1:9222';

const POST_URL = process.argv.find((a) => a.startsWith('http'))
  || 'http://127.0.0.1:4000/2026/10/06/hello-world/';

// --dark：以 prefers-color-scheme: dark 模拟暗色模式
const DARK = process.argv.includes('--dark');
// --desktop：以桌面视口验证主题原生交互未被影响
const DESKTOP = process.argv.includes('--desktop');
const PREFIX = DESKTOP ? 'desktop' : (DARK ? 'dark' : 'light');

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const version = await (await fetch(`${CDP}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  return { send, close: () => ws.close() };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { send, close } = await connect();

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', DESKTOP
    ? { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }
    : { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await S('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });

  if (DARK) {
    await S('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
  }

  await S('Page.navigate', { url: POST_URL });

  const evaluate = async (expression) => {
    const r = await S('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面内脚本异常: ' + JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  };

  const shot = async (name) => {
    const { data } = await S('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, name);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  };

  // 等待目录按钮就绪（tocbot 由 CDN 异步载入）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    ready = await evaluate(`(function(){
      var b = document.getElementById('mobile-reading-toc');
      return !!b && !b.classList.contains('is-hidden');
    })()`);
    if (ready) break;
  }

  const diagnostics = await evaluate(`(function(){
    var q = function(s){ return document.querySelector(s); };
    var toc = q('#toc'), tocBtn = q('#mobile-reading-toc'), topBtn = q('#mobile-reading-top');
    var btn = tocBtn || topBtn;
    var cs = btn ? getComputedStyle(btn) : null;
    return {
      viewportWidth: window.innerWidth,
      isMobileQuery: window.matchMedia('(max-width: 991.98px)').matches,
      actionsPresent: !!q('#mobile-reading-actions'),
      actionsDisplay: q('#mobile-reading-actions') ? getComputedStyle(q('#mobile-reading-actions')).display : null,
      tocButtonPresent: !!tocBtn,
      tocButtonVisible: tocBtn ? !tocBtn.classList.contains('is-hidden') : false,
      topButtonPresent: !!topBtn,
      topButtonVisible: topBtn ? !topBtn.classList.contains('is-hidden') : false,
      tocItemCount: toc ? toc.querySelectorAll('.toc-list-item').length : 0,
      tocParentId: toc ? (toc.parentElement.id || toc.parentElement.className) : null,
      closeButtonPresent: !!q('.mobile-toc-close'),
      themeScrollTopBtnDisplay: q('#scroll-top-button') ? getComputedStyle(q('#scroll-top-button')).display : null,
      btnBackground: cs ? cs.backgroundColor : null,
      btnColor: cs ? cs.color : null,
      btnRadius: cs ? cs.borderRadius : null,
      btnBoxShadow: cs ? cs.boxShadow : null,
      boardBgVar: getComputedStyle(document.documentElement)
        .getPropertyValue('--board-bg-color').trim(),
      colorMode: getComputedStyle(document.documentElement)
        .getPropertyValue('--color-mode').trim()
    };
  })()`);

  await shot(`${PREFIX}-1-top.png`);

  // 打开目录抽屉
  const opened = await evaluate(`(function(){
    var b = document.getElementById('mobile-reading-toc');
    if (!b) return false;
    b.click();
    return true;
  })()`);

  let drawerOpen = false;
  if (opened) {
    await sleep(700);
    drawerOpen = await evaluate(
      `!!document.querySelector('.mobile-toc-drawer.is-open')`
    );
    await shot(`${PREFIX}-2-toc-open.png`);
  }

  // 关闭抽屉并滚动，检查返回顶部按钮
  await evaluate(`(function(){
    var c = document.querySelector('.mobile-toc-close');
    if (c) c.click();
  })()`);
  await sleep(500);

  await evaluate(`window.scrollTo(0, 1600)`);
  await sleep(900);

  const afterScroll = await evaluate(`(function(){
    var t = document.getElementById('mobile-reading-top');
    return {
      scrollY: Math.round(window.pageYOffset),
      topButtonVisible: t ? !t.classList.contains('is-hidden') : false,
      drawerOpen: !!document.querySelector('.mobile-toc-drawer.is-open'),
      bodyLocked: document.body.classList.contains('mobile-toc-open')
    };
  })()`);

  await shot(`${PREFIX}-3-scrolled.png`);

  await send('Target.closeTarget', { targetId });
  close();

  console.log(JSON.stringify({
    url: POST_URL,
    dark: DARK,
    tocReady: ready,
    drawerOpen,
    diagnostics,
    afterScroll,
    shots: [
      `${PREFIX}-1-top.png`,
      `${PREFIX}-2-toc-open.png`,
      `${PREFIX}-3-scrolled.png`,
    ],
  }, null, 2));
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
