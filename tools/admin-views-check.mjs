/**
 * 后台「已登录」状态验证
 * ---------------------------------------------------------------------------
 * 无法使用真实凭据，因此在页面加载前注入一个 GitHub API 的 fetch mock，
 * 让后台以已登录状态运行，逐个视图真实渲染并截图。
 *
 * 重点验证：站点配置保存时，_config.fluid.yml 的注释是否被保留。
 * 这是本后台最容易造成破坏的操作（主题配置文件有上千行文档注释）。
 *
 * 用法：node tools/admin-views-check.mjs [admin URL]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'shots');
const CDP = 'http://127.0.0.1:9222';
const TARGET = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:4000/my-fluid-blog/admin/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 注入到页面的 mock ---------- */

const POST_MD = `---
title: 用 Fluid 搭建博客
date: 2026-10-06 17:25:02
tags:
  - Hexo
  - 教程
categories:
  - 前端
description: 一篇用于验证后台渲染的示例文章
sticky: 100
---

## 概述

这是**正文**内容，包含 \`行内代码\`。

\`\`\`js
console.log('hello fluid');
\`\`\`

## 二级标题

- 列表项 A
- 列表项 B
`;

// 带注释的配置文件，用于验证保存后注释是否还在
const SITE_YML = `# Hexo Configuration
## Docs: https://hexo.io/docs/configuration.html

# Site
title: Hexo
subtitle: ''
author: John Doe
language: zh-CN

# URL
## Set your site url here
url: https://zeropersan.github.io/my-fluid-blog
root: /my-fluid-blog/
`;

const THEME_YML = `# 主题配置
# Theme configuration

# 导航栏
navbar:
  # 导航栏左侧的标题
  blog_title: "Fluid"

  # 导航栏菜单
  menu:
    - { key: "home", link: "/", icon: "iconfont icon-home-fill" }
    - { key: "archive", link: "/archives/", icon: "iconfont icon-archive-fill" }

# 首页
index:
  # 头图高度，屏幕百分比
  banner_img_height: 100

# 文章
post:
  banner_img_height: 70
`;

function mockScript() {
  return `(function () {
  var SITE = ${JSON.stringify(SITE_YML)};
  var THEME = ${JSON.stringify(THEME_YML)};
  var POST = ${JSON.stringify(POST_MD)};

  function b64(s) { return btoa(unescape(encodeURIComponent(s))); }

  var FILES = {
    'source/_posts': [
      { type: 'file', name: 'hello-world.md', path: 'source/_posts/hello-world.md', sha: 'sha_post_1', size: POST.length }
    ],
    'source/_drafts': [
      { type: 'file', name: 'wip.md', path: 'source/_drafts/wip.md', sha: 'sha_draft_1', size: 120 }
    ]
  };

  var TREE = { tree: [
    { type: 'blob', path: 'source/_posts/hello-world.md', sha: 'sha_post_1', size: POST.length },
    { type: 'blob', path: 'source/img/fluid.png', sha: 's1', size: 20480 },
    { type: 'blob', path: 'source/img/avatar.png', sha: 's2', size: 30720 },
    { type: 'blob', path: 'source/img/uploads/2026/10/photo.jpg', sha: 's3', size: 512000 },
    { type: 'blob', path: 'source/about/index.md', sha: 's4', size: 800 },
    { type: 'blob', path: 'source/links/index.md', sha: 's5', size: 900 }
  ]};

  window.__lastPut = null;

  function json(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  var realFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('https://api.github.com') !== 0) return realFetch(input, init);

    var method = (init && init.method) || 'GET';
    var body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) {}

    // 记录写入，供验证脚本检查
    if (method === 'PUT' || method === 'DELETE') {
      window.__lastPut = { url: url, method: method, body: body };
      return json({ content: { sha: 'new_sha' }, commit: { sha: 'c1' } });
    }

    var p = url.replace('https://api.github.com', '');

    if (p === '/user') return json({ login: 'zeropersan', name: 'zeropersan', avatar_url: '' });
    if (/^\\/repos\\/[^/]+\\/[^/]+$/.test(p)) {
      return json({ full_name: 'zeropersan/my-fluid-blog', default_branch: 'main', permissions: { push: true, admin: true } });
    }
    if (p.indexOf('/actions/runs') >= 0) {
      return json({ workflow_runs: [
        { id: 1, name: 'Deploy to GitHub Pages', status: 'completed', conclusion: 'success',
          created_at: new Date(Date.now() - 120000).toISOString(), html_url: '#',
          head_commit: { message: 'chore(admin): 更新站点配置' } },
        { id: 2, name: 'Deploy to GitHub Pages', status: 'in_progress', conclusion: null,
          created_at: new Date(Date.now() - 20000).toISOString(), html_url: '#',
          head_commit: { message: 'update(admin): 文章 用 Fluid 搭建博客' } },
        { id: 3, name: 'Deploy to GitHub Pages', status: 'completed', conclusion: 'failure',
          created_at: new Date(Date.now() - 86400000).toISOString(), html_url: '#',
          head_commit: { message: 'ci: 触发 Pages 首次部署' } }
      ]});
    }
    if (p.indexOf('/git/trees/') >= 0) return json(TREE);

    var mContents = /^\\/repos\\/[^/]+\\/[^/]+\\/contents\\/(.+?)(\\?.*)?$/.exec(p);
    if (mContents) {
      var path = decodeURIComponent(mContents[1]);
      if (FILES[path]) return json(FILES[path]);
      if (path === 'source/_posts/hello-world.md' || path === 'source/_drafts/wip.md') {
        return json({ type: 'file', name: path.split('/').pop(), path: path, sha: 'sha_post_1',
                      size: POST.length, content: b64(POST) });
      }
      if (path === '_config.yml') return json({ type: 'file', path: path, sha: 'sha_cfg', size: SITE.length, content: b64(SITE) });
      if (path === '_config.fluid.yml') return json({ type: 'file', path: path, sha: 'sha_theme', size: THEME.length, content: b64(THEME) });
      return json({ message: 'Not Found' }, 404);
    }

    return json({ message: 'unmocked: ' + p }, 404);
  };

  try { localStorage.setItem('fluid-admin-token', 'mock-token-for-ui-verification'); } catch (e) {}
})();`;
}

/* ---------- CDP ---------- */

async function connect() {
  const version = await (await fetch(`${CDP}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')); });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) events.push(msg);
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

  await S('Page.addScriptToEvaluateOnNewDocument', { source: mockScript() });

  const evaluate = async (expression) => {
    const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };
  const shot = async (name) => {
    const { data } = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  };

  await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url: TARGET });
  await sleep(4000);

  const results = {};

  results.shell = await evaluate(`(function(){
    return {
      hasShell: !!document.querySelector('.adm-shell'),
      navItems: document.querySelectorAll('[data-nav]').length,
      navLabels: Array.prototype.map.call(document.querySelectorAll('[data-nav] span'), function(s){return s.textContent;}),
      posts: document.querySelectorAll('.adm-list-item').length,
      firstTitle: (document.querySelector('.adm-list-title') || {}).textContent,
      user: (document.querySelector('.adm-user-name') || {}).textContent
    };
  })()`);
  await shot('admin-v1-posts-desktop.png');

  // 逐个视图
  const views = [
    ['images', 'admin-v2-images.png'],
    ['site', 'admin-v3-site.png'],
    ['theme', 'admin-v4-theme.png'],
    ['toggles', 'admin-v5-toggles.png'],
    ['deploy', 'admin-v6-deploy.png'],
    ['pages', 'admin-v7-pages.png'],
    ['settings', 'admin-v8-settings.png'],
  ];
  results.views = {};
  for (const [id, file] of views) {
    await evaluate(`location.hash = '#/${id}'`);
    await sleep(1800);
    const info = await evaluate(`(function(){
      var c = document.querySelector('[data-role="content"]');
      return {
        cards: c ? c.querySelectorAll('.adm-card').length : 0,
        empty: !!(c && c.querySelector('.adm-empty')),
        failing: !!(c && c.textContent.indexOf('载入失败') >= 0),
        text: c ? c.textContent.replace(/\\s+/g,' ').trim().slice(0, 90) : ''
      };
    })()`);
    results.views[id] = info;
    await shot(file);
  }

  // 编辑器
  await evaluate(`location.hash = '#/edit/' + encodeURIComponent('source/_posts/hello-world.md')`);
  await sleep(2500);
  results.editor = await evaluate(`(function(){
    var c = document.querySelector('[data-role="content"]');
    var ta = document.querySelector('.adm-editor-textarea');
    var pv = document.querySelector('.adm-preview');
    return {
      hasTextarea: !!ta,
      textareaLen: ta ? ta.value.length : 0,
      titleValue: (document.querySelector('[data-fm="title"]') || {}).value,
      hasPreview: !!pv,
      previewHtmlLen: pv ? pv.innerHTML.length : 0,
      previewHasH2: pv ? !!pv.querySelector('h2') : false,
      previewHasCode: pv ? !!pv.querySelector('pre code') : false
    };
  })()`);
  await shot('admin-v9-editor-desktop.png');

  // 移动端编辑器：应是单栏，且「编辑 / 预览」用标签切换
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(1500);

  results.editorMobile = await evaluate(`(function(){
    var grid = document.querySelector('.adm-editor-grid');
    var tabs = document.querySelector('.adm-editor-tabs');
    var editPane = document.querySelector('.adm-pane-edit');
    var prevPane = document.querySelector('.adm-pane-preview');
    var cs = grid ? getComputedStyle(grid).gridTemplateColumns : null;
    return {
      columns: cs,
      singleColumn: cs ? cs.trim().split(/\\s+/).length === 1 : null,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      tabsVisible: tabs ? getComputedStyle(tabs).display !== 'none' : false,
      initialPane: grid ? grid.dataset.mobilePane : null,
      editVisible: editPane ? getComputedStyle(editPane).display !== 'none' : null,
      previewHidden: prevPane ? getComputedStyle(prevPane).display === 'none' : null
    };
  })()`);
  await shot('admin-v10-editor-mobile-edit-tab.png');

  // 切到预览标签
  const tabSwitch = await evaluate(`(function(){
    var t = document.querySelector('[data-mdtab="preview"]');
    if (!t) return null;
    t.click();
    var grid = document.querySelector('.adm-editor-grid');
    var editPane = document.querySelector('.adm-pane-edit');
    var prevPane = document.querySelector('.adm-pane-preview');
    return {
      paneAttr: grid.dataset.mobilePane,
      editHidden: getComputedStyle(editPane).display === 'none',
      previewVisible: getComputedStyle(prevPane).display !== 'none',
      activeTab: (document.querySelector('.adm-editor-tabs .adm-tab.is-active') || {}).dataset
        ? document.querySelector('.adm-editor-tabs .adm-tab.is-active').dataset.mdtab : null,
      previewHasContent: !!prevPane.querySelector('h2')
    };
  })()`);
  await sleep(600);
  results.editorMobileTabSwitch = tabSwitch;
  await shot('admin-v11-editor-mobile-preview-tab.png');

  // 切回编辑标签，确认可逆
  results.editorMobileTabBack = await evaluate(`(function(){
    document.querySelector('[data-mdtab="edit"]').click();
    var grid = document.querySelector('.adm-editor-grid');
    return {
      paneAttr: grid.dataset.mobilePane,
      editVisible: getComputedStyle(document.querySelector('.adm-pane-edit')).display !== 'none'
    };
  })()`);

  // 宽屏下标签栏应隐藏、两个面板都显示
  await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  results.editorDesktop = await evaluate(`(function(){
    var tabs = document.querySelector('.adm-editor-tabs');
    var editPane = document.querySelector('.adm-pane-edit');
    var prevPane = document.querySelector('.adm-pane-preview');
    var cs = getComputedStyle(document.querySelector('.adm-editor-grid')).gridTemplateColumns;
    return {
      tabsHidden: tabs ? getComputedStyle(tabs).display === 'none' : null,
      columns: cs,
      twoColumns: cs.trim().split(/\\s+/).length === 2,
      editVisible: getComputedStyle(editPane).display !== 'none',
      previewVisible: getComputedStyle(prevPane).display !== 'none'
    };
  })()`);

  await sleep(600);

  /* ---------- 关键：站点配置保存后注释是否保留 ---------- */
  await evaluate(`location.hash = '#/site'`);
  await sleep(2000);
  await evaluate(`(function(){
    var el = document.querySelector('[data-yaml="title"]');
    el.value = '我的技术博客';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate(`document.querySelector('[data-act="save"]').click()`);
  await sleep(2500);

  results.yamlSave = await evaluate(`(function(){
    if (!window.__lastPut) return { captured: false };
    var content = window.__lastPut.body && window.__lastPut.body.content;
    return { captured: true, path: window.__lastPut.url, method: window.__lastPut.method, content: content };
  })()`);

  await send('Target.closeTarget', { targetId });
  close();

  // 解码并在 Node 侧检查注释保留情况
  let decoded = null;
  if (results.yamlSave.captured && results.yamlSave.content) {
    decoded = Buffer.from(results.yamlSave.content, 'base64').toString('utf8');
    results.yamlSave.decoded = decoded;
    results.yamlSave.commentLinesKept = (decoded.match(/^#/gm) || []).length;
    results.yamlSave.titleReplaced = /^title: .*我的技术博客/m.test(decoded);
    results.yamlSave.otherKeysIntact = /^root: \/my-fluid-blog\/$/m.test(decoded);
  }

  const errors = events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => (e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text);
  const logErrors = events
    .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    .map((e) => e.params.entry.text);

  results.consoleErrors = errors.concat(logErrors);

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
