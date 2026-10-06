/**
 * 后台入口：应用外壳、登录、路由
 */

import {
  ALLOWED_USERS, BRANCH, DEFAULT_CLIENT_ID, LS, OAUTH_SCOPE,
  detectRepo, safeGet, safeSet, safeRemove, siteRoot,
} from './config.js';
import * as gh from './gh.js';
import { $, clear, confirmDialog, copyText, esc, h, icon, toast } from './util.js';
import { editorView, imagesView, newPostView, pagesView, postsView } from './views-content.js';
import { deployView, settingsView, siteView, themeView, toggleView } from './views-config.js';
import { renderLogin as renderLoginImpl } from './login.js';
import { hasVault, isSupported } from './vault.js';

/* ==========================================================================
   路由表
   ========================================================================== */

const VIEWS = [postsView, pagesView, imagesView, siteView, themeView, toggleView, deployView, settingsView];

const EXTRA_ROUTES = {
  '/new': newPostView,
  '/edit': editorView,
};

/* ==========================================================================
   应用上下文
   ========================================================================== */

const ctx = {
  repoFull: '',
  branch: BRANCH,
  settings: { compress: safeGet(LS.compress) !== '0' },
  cache: { treeStale: true, imageNames: [] },
  posts: [],
  pages: [],
  images: [],
  runs: [],
  _view: null,
  _param: '',
  _seq: 0,

  navigate(hash) {
    if (location.hash === hash) this.route();
    else location.hash = hash;
  },

  /** 重新载入当前视图 */
  reload(opts) {
    return this.route(opts || {});
  },

  /** 内容提交后盯一会儿部署状态，完成后给个提示 */
  startDeployWatch() {
    if (this._watchTimer) clearInterval(this._watchTimer);
    const started = Date.now();
    let seen = false;
    this._watchTimer = setInterval(async () => {
      if (Date.now() - started > 3 * 60 * 1000) {
        clearInterval(this._watchTimer);
        this._watchTimer = null;
        return;
      }
      try {
        const data = await gh.listWorkflowRuns(this.repoFull, 1);
        const run = data && data.workflow_runs && data.workflow_runs[0];
        if (!run) return;
        if (run.status === 'in_progress' || run.status === 'queued') {
          if (!seen) { seen = true; toast('部署进行中…', 'info', 2600); }
          return;
        }
        clearInterval(this._watchTimer);
        this._watchTimer = null;
        if (run.conclusion === 'success') toast('部署完成，站点已更新', 'ok', 5000);
        else toast('部署未成功：' + (run.conclusion || '未知'), 'err', 7000);
        if (this._view === 'deploy') this.route();
      } catch (e) { /* 忽略轮询错误 */ }
    }, 6000);
  },
};

/* ==========================================================================
   配色切换（复刻主题的三态：跟随系统 / 浅色 / 深色）
   ========================================================================== */

function applyColorScheme(mode) {
  if (mode === 'dark' || mode === 'light') {
    document.documentElement.setAttribute('data-user-color-scheme', mode);
    safeSet(LS.colorScheme, mode);
  } else {
    document.documentElement.removeAttribute('data-user-color-scheme');
    safeRemove(LS.colorScheme);
  }
}

function currentScheme() {
  return safeGet(LS.colorScheme) || 'auto';
}

function nextScheme() {
  const order = ['auto', 'light', 'dark'];
  return order[(order.indexOf(currentScheme()) + 1) % order.length];
}

function schemeButtonHtml() {
  const mode = currentScheme();
  const ico = mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : 'eye';
  const label = mode === 'dark' ? '深色' : mode === 'light' ? '浅色' : '跟随系统';
  return `${icon(ico)}<span class="adm-sr">配色：${label}</span>`;
}

/* ==========================================================================
   用户白名单
   ========================================================================== */

/** 用户名是否在允许名单内；名单为空表示不限制 */
function isAllowedUser(login) {
  if (!ALLOWED_USERS.length) return true;
  const name = String(login || '').toLowerCase();
  return ALLOWED_USERS.some((u) => String(u).toLowerCase() === name);
}

/** 拒绝登录：清掉 token 并给出提示 */
function rejectLogin(login, reason) {
  gh.logout();
  toast(`账号 ${login} ${reason}`, 'err', 9000);
}

/* ==========================================================================
   登录页
   ========================================================================== */

function renderLogin(root) {
  // 实现见 js/login.js：口令登录 / Token 登录 / GitHub 授权三种入口
  return renderLoginImpl(root, { ctx, renderApp, isAllowedUser, rejectLogin });
}
/* ==========================================================================
   主界面
   ========================================================================== */

function navHtml(activeId) {
  return VIEWS.map((v) => `
    <li>
      <button class="adm-nav-item${v.id === activeId ? ' is-active' : ''}" data-nav="${v.id}">
        ${icon(v.icon)}<span>${esc(v.label)}</span>
      </button>
    </li>`).join('');
}

function renderShell(root) {
  const user = gh.getUser();
  root.innerHTML = `
    <div class="adm-shell" data-role="shell">
      <div class="adm-sidebar-mask" data-act="close-nav"></div>
      <aside class="adm-sidebar">
        <a class="adm-brand" href="${esc(siteRoot())}" target="_blank" rel="noopener">
          ${icon('posts')}
          <span>博客后台<span class="adm-brand-sub">${esc(detectRepo().full)}</span></span>
        </a>
        <nav><ul class="adm-nav" data-role="nav">${navHtml('')}</ul></nav>
        <div class="adm-side-foot">
          <div class="adm-user">
            ${user && user.avatar_url
              ? `<img class="adm-avatar" src="${esc(user.avatar_url)}" alt="">`
              : `<span class="adm-avatar"></span>`}
            <span class="adm-user-name">${esc(user ? user.login : '已登录')}</span>
          </div>
          <button class="adm-nav-item" data-act="logout">${icon('logout')}<span>退出登录</span></button>
        </div>
      </aside>

      <div class="adm-main">
        <header class="adm-topbar">
          <button class="adm-btn adm-iconbtn adm-menubtn" data-act="open-nav" aria-label="打开菜单">${icon('menu')}</button>
          <h2 class="adm-title" data-role="title"></h2>
          <span class="adm-spacer"></span>
          <a class="adm-btn adm-iconbtn" href="${esc(siteRoot())}" target="_blank" rel="noopener" title="打开站点">${icon('home')}</a>
          <button class="adm-btn adm-iconbtn" data-act="scheme" title="切换配色">${schemeButtonHtml()}</button>
        </header>
        <main class="adm-content" data-role="content"></main>
      </div>
    </div>`;

  const shell = $('[data-role="shell"]', root);
  const content = $('[data-role="content"]', root);
  const navWrap = $('[data-role="nav"]', root);
  const titleEl = $('[data-role="title"]', root);

  // 同 renderLogin：挂在 .adm-shell 上，替换 root 内容时监听一并销毁
  shell.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act], [data-nav]');
    if (!btn) return;

    if (btn.dataset.nav) {
      ctx.navigate('#/' + btn.dataset.nav);
      shell.classList.remove('is-nav-open');
      return;
    }

    switch (btn.dataset.act) {
      case 'open-nav': shell.classList.add('is-nav-open'); break;
      case 'close-nav': shell.classList.remove('is-nav-open'); break;
      case 'scheme': {
        const next = nextScheme();
        applyColorScheme(next);
        btn.innerHTML = schemeButtonHtml();
        toast('配色：' + (next === 'auto' ? '跟随系统' : next === 'dark' ? '深色' : '浅色'), 'info', 1600);
        break;
      }
      case 'logout': {
        const ok = await confirmDialog({
          title: '退出登录', body: '将从本浏览器清除 Token。', okText: '退出', danger: true,
        });
        if (!ok) return;
        gh.logout();
        location.reload();
        break;
      }
      default: break;
    }
  });

  return { content, navWrap, titleEl, root };
}

async function renderApp(root) {
  const shellRefs = renderShell(root);
  ctx._shell = shellRefs;
  await ctx.route();
}

/* ==========================================================================
   路由
   ========================================================================== */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = raw.split('/');
  return { head: head || 'posts', param: rest.join('/') };
}

ctx.route = async function route(opts) {
  const refs = ctx._shell;
  if (!refs) return;

  const { head, param } = parseHash();
  const routeKey = '/' + head;
  const view = EXTRA_ROUTES[routeKey] || VIEWS.find((v) => v.id === head) || postsView;
  const decoded = param ? decodeURIComponent(param) : '';

  const seq = ++ctx._seq;
  ctx._view = view.id;
  ctx._param = decoded;

  // 导航高亮：编辑器/新建都归到「文章」
  const activeNav = view.id === 'editor' || view.id === 'new' ? 'posts' : view.id;
  refs.navWrap.innerHTML = navHtml(activeNav);
  refs.titleEl.textContent = view.title || view.label;

  const scrollTop = opts && opts.keepScroll ? refs.content.scrollTop : 0;
  refs.content.innerHTML = `<div class="adm-empty"><span class="adm-spinner" style="display:inline-block"></span><p>载入中…</p></div>`;

  let state = null;
  try {
    state = await view.load(ctx, decoded);
    if (seq !== ctx._seq) return; // 已经切到别的视图了
  } catch (e) {
    if (e.status === 401) {
      gh.logout();
      toast('登录已失效，请重新登录', 'err');
      renderLogin(document.getElementById('adm-root'));
      return;
    }
    refs.content.innerHTML = `<div class="adm-card adm-card-pad">
      <div class="adm-empty">${icon('alert')}
        <p>载入失败：${esc(e.message)}</p>
        <button class="adm-btn adm-btn-ghost" data-act="retry">${icon('refresh')}<span>重试</span></button>
      </div></div>`;
    refs.content.querySelector('[data-act="retry"]').addEventListener('click', () => ctx.route());
    return;
  }

  if (seq !== ctx._seq) return;

  refs.content.innerHTML = view.render(ctx, state);
  if (view.mount) view.mount(ctx, refs.content, state);
  refs.content.scrollTop = scrollTop;
};

/* ==========================================================================
   启动
   ========================================================================== */

async function boot() {
  const root = document.getElementById('adm-root');
  ctx.repoFull = detectRepo().full;

  // 配色
  applyColorScheme(currentScheme());

  // 已经设过管理口令：一律先解锁。
  // 同时清掉可能残留的明文 Token —— 保险箱存在时明文就不该再起作用，
  // 否则「设了口令」只是形式，绕过口令依旧能直接进入。
  if (hasVault()) {
    gh.logout();
    renderLogin(root);
    return;
  }

  if (!gh.isLoggedIn()) {
    renderLogin(root);
    return;
  }

  // 没有口令、但本机存有明文 Token（旧版遗留或直接粘贴登录）：
  // 继续可用，但提示去设置口令
  try {
    const user = await gh.fetchUser();
    if (!isAllowedUser(user.login)) {
      rejectLogin(user.login, '不在允许名单内，已自动退出');
      renderLogin(root);
      return;
    }
    if (isSupported()) {
      toast('提示：可到「设置」启用管理口令，把 Token 加密保存', 'info', 7000);
    }
  } catch (e) {
    gh.logout();
    renderLogin(root);
    toast('登录状态已过期，请重新登录', 'info');
    return;
  }

  if (!location.hash) location.hash = '#/posts';
  await renderApp(root);
}

window.addEventListener('hashchange', () => {
  if (gh.isLoggedIn() && ctx._shell) ctx.route();
});

boot().catch((e) => {
  const root = document.getElementById('adm-root');
  if (root) {
    root.innerHTML = `<div class="adm-login"><div class="adm-card adm-login-card">
      <div class="adm-empty">${icon('alert')}<p>后台启动失败：${esc(e.message)}</p></div>
    </div></div>`;
  }
});
