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
  const repo = detectRepo();
  const clientId = safeGet(LS.clientId) || DEFAULT_CLIENT_ID;
  const hasClientId = !!clientId;

  root.innerHTML = `
    <div class="adm-login">
      <div class="adm-card adm-login-card">
        <div class="adm-login-head">
          ${icon('posts')}
          <h1>博客后台</h1>
          <p class="adm-small adm-muted">
            <span class="adm-mono">${esc(repo.full)}</span>
          </p>
        </div>

        <div class="adm-tabs" role="tablist">
          <button class="adm-tab is-active" data-tab="oauth" role="tab">使用 GitHub 登录</button>
          <button class="adm-tab" data-tab="pat" role="tab">用 Token 登录</button>
        </div>

        <div data-pane="oauth">
          <div data-role="oauth-start">
            ${hasClientId ? `
              <button class="adm-btn adm-btn-primary adm-btn-block" data-act="oauth-start">
                ${icon('user')}<span>使用 GitHub 登录</span>
              </button>
              <p class="adm-hint" style="text-align:center;margin-top:.6rem">
                会显示一个设备码，在 GitHub 上确认即可
              </p>
            ` : `
              <label class="adm-field">
                <span class="adm-label">OAuth App Client ID</span>
                <input class="adm-input adm-mono" data-role="cid" placeholder="Iv1.xxxx 或 Ov23li...">
                <span class="adm-hint">只需填写一次，之后会记住。也可以先去「设置」填好，这里就不会再问。</span>
              </label>
              <button class="adm-btn adm-btn-primary adm-btn-block" data-act="oauth-start">
                ${icon('user')}<span>开始 GitHub 授权</span>
              </button>
            `}
            <details style="margin-top:1rem">
              <summary class="adm-small" style="cursor:pointer">还没有 OAuth App？点这里看创建步骤</summary>
              <ol class="adm-steps" style="margin-top:.5rem">
                <li>GitHub <strong>Settings → Developer settings → OAuth Apps → New OAuth App</strong></li>
                <li>Homepage URL：<code>${esc(location.origin + siteRoot())}</code></li>
                <li>Redirect URI：<code>${esc(location.origin + siteRoot() + 'admin/')}</code>（Device Flow 不会用到，填了只是为了让表单能提交）</li>
                <li><strong>勾选 Enable Device Flow</strong>（关键，不勾无法登录）</li>
                <li>把生成的 Client ID 填到「设置」里</li>
              </ol>
            </details>
          </div>

          <div data-role="oauth-wait" class="adm-hidden">
            <p class="adm-small">请在 GitHub 页面输入下面的设备码：</p>
            <code class="adm-device-code" data-role="user-code"></code>
            <div class="adm-row" style="margin-bottom:1rem">
              <button class="adm-btn adm-btn-ghost adm-btn-sm" data-act="copy-code">${icon('copy')}<span>复制设备码</span></button>
              <button class="adm-btn adm-btn-ghost adm-btn-sm" data-act="open-verify">${icon('external')}<span>打开授权页</span></button>
            </div>
            <p class="adm-small adm-muted" data-role="oauth-status">等待授权…</p>
            <button class="adm-btn adm-btn-ghost adm-btn-block" data-act="oauth-cancel" style="margin-top:.75rem">取消</button>
          </div>
        </div>

        <div data-pane="pat" class="adm-hidden">
          <label class="adm-field">
            <span class="adm-label">Personal Access Token</span>
            <input class="adm-input adm-mono" type="password" data-role="pat" placeholder="github_pat_... 或 ghp_..." autocomplete="off">
            <span class="adm-hint">
              建议用 <strong>Fine-grained token</strong>，仅授权本仓库，权限：
              Contents 读写、Actions 读写、Workflows（如需手动重部署）。
            </span>
          </label>
          <button class="adm-btn adm-btn-primary adm-btn-block" data-act="pat-login">
            ${icon('check')}<span>验证并登录</span>
          </button>
        </div>
      </div>
    </div>`;

  let cancelled = false;
  let verifyUri = 'https://github.com/login/device';

  /** 从「等待授权」退回「开始授权」 */
  const showStart = () => {
    const wait = $('[data-role="oauth-wait"]', root);
    const start = $('[data-role="oauth-start"]', root);
    if (wait) wait.classList.add('adm-hidden');
    if (start) start.classList.remove('adm-hidden');
  };

  // 监听挂在登录容器上而不是 root 上：
  // 登录成功后 root.innerHTML 会被主界面替换，旧的监听器随之一起销毁，
  // 否则登录页的处理器会一直留在 root 上继续响应主界面的点击。
  const box = $('.adm-login', root);
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act], [data-tab]');
    if (!btn) return;

    // 切换标签
    if (btn.dataset.tab) {
      root.querySelectorAll('.adm-tab').forEach((t) => t.classList.toggle('is-active', t === btn));
      root.querySelectorAll('[data-pane]').forEach((p) => {
        p.classList.toggle('adm-hidden', p.dataset.pane !== btn.dataset.tab);
      });
      return;
    }

    const act = btn.dataset.act;

    /* ---------- PAT 登录 ---------- */
    if (act === 'pat-login') {
      const input = $('[data-role="pat"]', root);
      const pat = input.value.trim();
      if (!pat) return toast('请填入 Token', 'err');
      btn.disabled = true;
      try {
        const res = await gh.validatePat(pat, detectRepo().full);
        if (!isAllowedUser(res.user.login)) {
          rejectLogin(res.user.login, '不在允许名单内，已拒绝登录');
          return;
        }
        if (!res.canWrite) {
          gh.logout();
          toast('该 Token 对仓库没有写权限', 'err', 7000);
          return;
        }
        gh.setToken(pat);
        ctx.repoFull = detectRepo().full;
        toast('登录成功，欢迎 ' + res.user.login, 'ok');
        renderApp(document.getElementById('adm-root'));
      } catch (err) {
        toast('登录失败：' + err.message, 'err', 7000);
      } finally {
        btn.disabled = false;
      }
      return;
    }

    /* ---------- 发起 Device Flow ---------- */
    if (act === 'oauth-start') {
      // Client ID 已配置时登录页不渲染输入框，此时从配置/本地读取
      const cidEl = $('[data-role="cid"]', root);
      const cid = (cidEl ? cidEl.value : (safeGet(LS.clientId) || DEFAULT_CLIENT_ID)).trim();
      if (!cid) return toast('请先填写 Client ID', 'err');
      safeSet(LS.clientId, cid);

      btn.disabled = true;
      try {
        const dev = await gh.startDeviceFlow(cid);
        verifyUri = dev.verification_uri || verifyUri;
        $('[data-role="oauth-start"]', root).classList.add('adm-hidden');
        $('[data-role="oauth-wait"]', root).classList.remove('adm-hidden');
        $('[data-role="user-code"]', root).textContent = dev.user_code;
        $('[data-role="oauth-status"]', root).textContent =
          `等待授权…（设备码 ${Math.round(dev.expires_in / 60)} 分钟内有效）`;

        cancelled = false;
        const token = await gh.pollDeviceFlow(cid, dev.device_code, dev.interval, dev.expires_in, (state) => {
          if (cancelled) return;
          $('[data-role="oauth-status"]', root).textContent =
            state === 'slow_down' ? '请求过于频繁，正在放慢轮询…' : '仍在等待你在 GitHub 上确认…';
        });
        if (cancelled) return;

        gh.setToken(token);
        ctx.repoFull = detectRepo().full;

        const user = await gh.fetchUser();
        if (!isAllowedUser(user.login)) {
          rejectLogin(user.login, '不在允许名单内，已拒绝登录');
          showStart();
          return;
        }
        // 与 PAT 路径保持一致：确认对该仓库确有写权限
        const repoInfo = await gh.getRepoInfo(ctx.repoFull);
        if (!(repoInfo.permissions && repoInfo.permissions.push)) {
          gh.logout();
          showStart();
          toast(`账号 ${user.login} 对该仓库没有写权限`, 'err', 9000);
          return;
        }

        toast('登录成功，欢迎 ' + user.login, 'ok');
        renderApp(document.getElementById('adm-root'));
      } catch (err) {
        if (!cancelled) toast('授权失败：' + err.message, 'err', 8000);
        showStart();
      } finally {
        btn.disabled = false;
      }
      return;
    }

    if (act === 'copy-code') {
      const code = $('[data-role="user-code"]', root).textContent.trim();
      const ok = await copyText(code);
      toast(ok ? '设备码已复制' : '复制失败，请手动输入', ok ? 'ok' : 'err');
      return;
    }

    if (act === 'open-verify') {
      window.open(verifyUri, '_blank', 'noopener');
      return;
    }

    if (act === 'oauth-cancel') {
      cancelled = true;
      $('[data-role="oauth-wait"]', root).classList.add('adm-hidden');
      $('[data-role="oauth-start"]', root).classList.remove('adm-hidden');
      toast('已取消授权', 'info');
    }
  });
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

  if (!gh.isLoggedIn()) {
    renderLogin(root);
    return;
  }

  // 已有 token：先静默校验，失效或不在名单内则回到登录页
  try {
    const user = await gh.fetchUser();
    if (!isAllowedUser(user.login)) {
      rejectLogin(user.login, '不在允许名单内，已自动退出');
      renderLogin(root);
      return;
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
