/**
 * 配置类视图：站点配置 / 主题外观 / 主题开关 / 部署状态 / 设置
 */

import {
  DEFAULT_CLIENT_ID, LS, PATHS, SOCIAL_FIELDS, THEME_TOGGLES,
  detectRepo, safeGet, safeSet, siteRoot,
} from './config.js';
import * as gh from './gh.js';
import {
  $, $$, confirmDialog, ensureYaml, esc, formatBytes, icon, relativeTime, toast,
} from './util.js';
import { getIn, replaceYamlBlock, setYamlScalar, toFlowList } from './yamltext.js';

/* ==========================================================================
   共享：读取 / 保存 YAML 配置文件（保留注释）
   ========================================================================== */

async function loadYaml(ctx, path) {
  const file = await gh.getFileText(ctx.repoFull, path);
  let data = {};
  if (await ensureYaml()) {
    try { data = window.jsyaml.load(file.text, { schema: window.jsyaml.CORE_SCHEMA }) || {}; }
    catch (e) { data = {}; }
  }
  return { text: file.text, sha: file.sha, data };
}

async function saveYaml(ctx, path, text, sha, message) {
  const res = await gh.putFileText(ctx.repoFull, path, text, message, sha);
  ctx.startDeployWatch && ctx.startDeployWatch();
  return res;
}

/** 收集表单里所有 [data-yaml] 输入，逐个做文本替换 */
function applyYamlFields(originalText, root) {
  let text = originalText;
  let changed = 0;
  const failed = [];

  $$('[data-yaml]', root).forEach((el) => {
    const path = el.dataset.yaml;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.dataset.type === 'number') value = el.value === '' ? '' : Number(el.value);
    else value = el.value.trim();

    const res = setYamlScalar(text, path, value);
    if (res.changed) { text = res.text; changed++; }
    else if (String(value) !== '') failed.push(path);
  });

  return { text, changed, failed };
}

/* ==========================================================================
   站点配置（_config.yml）
   ========================================================================== */

const SITE_FIELDS = [
  { path: 'title', label: '站点标题' },
  { path: 'subtitle', label: '副标题' },
  { path: 'author', label: '作者' },
  { path: 'language', label: '语言', hint: 'zh-CN / en / ja / zh-TW …' },
  { path: 'description', label: '站点描述', full: true },
  { path: 'keywords', label: '关键词', hint: '英文逗号分隔，用于 SEO' },
  { path: 'timezone', label: '时区', hint: '如 Asia/Shanghai。留空则跟随构建机器（CI 上是 UTC），会导致文章时间漂移' },
  { path: 'url', label: '站点 URL', hint: '⚠ 改动会影响所有永久链接与搜索索引' },
];

export const siteView = {
  id: 'site',
  label: '站点配置',
  icon: 'gear',
  title: '站点配置',
  needsAuth: true,

  async load(ctx) {
    return loadYaml(ctx, PATHS.siteConfig);
  },

  render(ctx, state) {
    const d = state.data || {};
    const fields = SITE_FIELDS.map((f) => {
      const raw = getIn(d, f.path);
      const value = raw === undefined || raw === null ? '' : String(raw);
      return `
        <label class="adm-field${f.full ? ' adm-field-full' : ''}">
          <span class="adm-label">${esc(f.label)}</span>
          <input class="adm-input" data-yaml="${esc(f.path)}" value="${esc(value)}">
          <span class="adm-hint"><code>${esc(f.path)}</code>${f.hint ? ' · ' + esc(f.hint) : ''}</span>
        </label>`;
    }).join('');

    return `
      <div class="adm-toolbar">
        <button class="adm-btn adm-btn-ghost" data-act="reload">${icon('refresh')}<span>重新载入</span></button>
        <span class="adm-spacer"></span>
        <button class="adm-btn adm-btn-primary" data-act="save">${icon('save')}<span>保存并部署</span></button>
      </div>
      <div class="adm-card adm-card-pad">
        <div class="adm-fm-grid">${fields}</div>
        <p class="adm-hint" style="margin-top:.5rem">
          保存时只替换上表对应行的值，<strong>${esc(PATHS.siteConfig)} 里的注释与其余配置原样保留</strong>。
        </p>
      </div>`;
  },

  mount(ctx, root, state) {
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'reload') return ctx.reload();

      if (btn.dataset.act === 'save') {
        const { text, changed, failed } = applyYamlFields(state.text, root);
        if (!changed) return toast('没有检测到可写入的改动', 'info');
        if (failed.length) toast('以下键未在文件中找到，已跳过：' + failed.join('、'), 'err', 6000);
        btn.disabled = true;
        try {
          await saveYaml(ctx, PATHS.siteConfig, text, state.sha, 'chore(admin): 更新站点配置');
          toast('站点配置已保存，部署已触发', 'ok');
          ctx.reload();
        } catch (err) {
          toast('保存失败：' + err.message, 'err', 7000);
        } finally {
          btn.disabled = false;
        }
      }
    });
  },
};

/* ==========================================================================
   主题外观（_config.fluid.yml）
   ========================================================================== */

const THEME_FIELDS = [
  { path: 'favicon', label: 'favicon', hint: '浏览器标签页图标' },
  { path: 'apple_touch_icon', label: 'Apple Touch 图标' },
  { path: 'navbar.blog_title', label: '导航栏标题' },
  { path: 'index.banner_img', label: '首页头图' },
  { path: 'index.banner_img_height', label: '首页头图高度', type: 'number', hint: '屏幕百分比 0-100' },
  { path: 'index.slogan.text', label: '首页副标题文字' },
  { path: 'post.banner_img', label: '文章页头图' },
  { path: 'post.banner_img_height', label: '文章页头图高度', type: 'number' },
  { path: 'about.avatar', label: '头像' },
  { path: 'about.name', label: '昵称' },
  { path: 'about.intro', label: '个人简介' },
];

export const themeView = {
  id: 'theme',
  label: '主题外观',
  icon: 'eye',
  title: '主题外观',
  needsAuth: true,

  async load(ctx) {
    return loadYaml(ctx, PATHS.themeConfig);
  },

  render(ctx, state) {
    const d = state.data || {};
    const fields = THEME_FIELDS.map((f) => {
      const raw = getIn(d, f.path);
      const value = raw === undefined || raw === null ? '' : String(raw);
      const type = f.type === 'number' ? 'number' : 'text';
      return `
        <label class="adm-field">
          <span class="adm-label">${esc(f.label)}</span>
          <input class="adm-input" type="${type}" data-yaml="${esc(f.path)}" value="${esc(value)}">
          <span class="adm-hint"><code>${esc(f.path)}</code>${f.hint ? ' · ' + esc(f.hint) : ''}</span>
        </label>`;
    }).join('');

    const menu = Array.isArray(d.navbar && d.navbar.menu) ? d.navbar.menu : [];
    const menuRows = menu.map((m, i) => menuRowHtml(m, i)).join('');

    return `
      <div class="adm-toolbar">
        <button class="adm-btn adm-btn-ghost" data-act="reload">${icon('refresh')}<span>重新载入</span></button>
        <span class="adm-spacer"></span>
        <button class="adm-btn adm-btn-primary" data-act="save">${icon('save')}<span>保存并部署</span></button>
      </div>

      <div class="adm-card adm-card-pad" style="margin-bottom:1rem">
        <h3 style="margin-top:0">基础外观</h3>
        <div class="adm-fm-grid">${fields}</div>
      </div>

      <div class="adm-card adm-card-pad">
        <div class="adm-row" style="margin-bottom:.5rem">
          <h3 style="margin:0">导航栏菜单</h3>
          <span class="adm-spacer"></span>
          <button class="adm-btn adm-btn-sm adm-btn-ghost" data-act="add-menu">${icon('plus')}<span>添加</span></button>
        </div>
        <p class="adm-hint" style="margin-top:0">
          <code>key</code> 用于关联主题语言包（如 home、archive、about），
          <code>name</code> 可强制指定显示名称，<code>icon</code> 填 CSS class。
        </p>
        <div data-role="menu">${menuRows}</div>
      </div>`;
  },

  mount(ctx, root, state) {
    const menuWrap = $('[data-role="menu"]', root);

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;

      if (act === 'reload') return ctx.reload();

      if (act === 'add-menu') {
        menuWrap.insertAdjacentHTML('beforeend', menuRowHtml({ key: '', link: '/', icon: '', name: '' }, Date.now()));
        return;
      }
      if (act === 'rm-menu') {
        const row = btn.closest('[data-menu-row]');
        if (row) row.remove();
        return;
      }

      if (act === 'save') {
        // 标量字段
        let { text, changed, failed } = applyYamlFields(state.text, root);

        // 菜单块
        const items = $$('[data-menu-row]', menuWrap).map((row) => ({
          key: $('[data-mk="key"]', row).value.trim(),
          link: $('[data-mk="link"]', row).value.trim(),
          icon: $('[data-mk="icon"]', row).value.trim(),
          name: $('[data-mk="name"]', row).value.trim(),
        })).filter((m) => m.key || m.link);

        // 计算 menu 键所在缩进，生成对应缩进的列表行
        const indent = detectMenuIndent(state.text) || 4;
        const block = toFlowList(items, indent, ['key', 'link', 'icon', 'name']);
        const res = replaceYamlBlock(text, 'navbar.menu', block);
        if (res.changed) { text = res.text; changed++; }

        if (!changed) return toast('没有检测到可写入的改动', 'info');
        if (failed.length) toast('以下键未在文件中找到，已跳过：' + failed.join('、'), 'err', 6000);

        btn.disabled = true;
        try {
          await saveYaml(ctx, PATHS.themeConfig, text, state.sha, 'chore(admin): 更新主题外观配置');
          toast('主题配置已保存，部署已触发', 'ok');
          ctx.reload();
        } catch (err) {
          toast('保存失败：' + err.message, 'err', 7000);
        } finally {
          btn.disabled = false;
        }
      }
    });
  },
};

function menuRowHtml(m, i) {
  return `
    <div class="adm-menu-row" data-menu-row style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr)) auto;gap:.4rem;margin-bottom:.4rem">
      <input class="adm-input adm-input-sm" data-mk="key" placeholder="key 如 about" value="${esc(m.key || '')}">
      <input class="adm-input adm-input-sm" data-mk="link" placeholder="链接 /about/" value="${esc(m.link || '')}">
      <input class="adm-input adm-input-sm" data-mk="icon" placeholder="图标 class（可空）" value="${esc(m.icon || '')}">
      <input class="adm-input adm-input-sm" data-mk="name" placeholder="强制名称（可空）" value="${esc(m.name || '')}">
      <button class="adm-btn adm-iconbtn adm-btn-danger" data-act="rm-menu" title="删除该菜单项" aria-label="删除该菜单项">${icon('trash')}</button>
    </div>`;
}

/** 从现有文本推断 navbar.menu 列表项的缩进 */
function detectMenuIndent(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let inMenu = false;
  for (const line of lines) {
    if (/^\s*menu:\s*$/.test(line)) { inMenu = true; continue; }
    if (inMenu) {
      const m = /^(\s*)-\s/.exec(line);
      if (m) return m[1].length;
      if (line.trim() !== '' && !/^\s/.test(line)) break;
    }
  }
  return 4;
}

/* ==========================================================================
   主题开关面板
   ========================================================================== */

export const toggleView = {
  id: 'toggles',
  label: '主题开关',
  icon: 'settings',
  title: '主题开关',
  needsAuth: true,

  async load(ctx) {
    return loadYaml(ctx, PATHS.themeConfig);
  },

  render(ctx, state) {
    const d = state.data || {};
    const groups = THEME_TOGGLES.map((g) => `
      <div class="adm-card adm-card-pad" style="margin-bottom:1rem">
        <h3 style="margin-top:0">${esc(g.group)}</h3>
        ${g.items.map((it) => {
          const val = getIn(d, it.path);
          return `
            <label class="adm-switch">
              <input type="checkbox" data-yaml="${esc(it.path)}" data-type="bool"${val === true ? ' checked' : ''}>
              <span class="adm-switch-track"></span>
              <span class="adm-switch-text">
                <strong>${esc(it.label)}</strong>
                <span class="adm-hint" style="margin-top:0"><code>${esc(it.path)}</code> · ${esc(it.hint)}</span>
              </span>
            </label>`;
        }).join('')}
      </div>`).join('');

    return `
      <div class="adm-toolbar">
        <button class="adm-btn adm-btn-ghost" data-act="reload">${icon('refresh')}<span>重新载入</span></button>
        <span class="adm-spacer"></span>
        <button class="adm-btn adm-btn-primary" data-act="save">${icon('save')}<span>保存并部署</span></button>
      </div>
      ${groups}`;
  },

  mount(ctx, root, state) {
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'reload') return ctx.reload();
      if (btn.dataset.act !== 'save') return;

      let text = state.text;
      let changed = 0;
      const failed = [];

      $$('[data-yaml]', root).forEach((el) => {
        const path = el.dataset.yaml;
        const current = getIn(state.data || {}, path);
        const next = el.checked;
        if (current === next) return; // 没变就不动文件
        const res = setYamlScalar(text, path, next);
        if (res.changed) { text = res.text; changed++; }
        else failed.push(path);
      });

      if (!changed) return toast('没有检测到改动', 'info');
      if (failed.length) toast('以下键未找到：' + failed.join('、'), 'err', 6000);

      btn.disabled = true;
      try {
        await saveYaml(ctx, PATHS.themeConfig, text, state.sha, 'chore(admin): 更新主题开关');
        toast('已保存，部署已触发', 'ok');
        ctx.reload();
      } catch (err) {
        toast('保存失败：' + err.message, 'err', 7000);
      } finally {
        btn.disabled = false;
      }
    });
  },
};

/* ==========================================================================
   部署状态
   ========================================================================== */

function runBadge(run) {
  if (run.status === 'in_progress' || run.status === 'queued') {
    return `<span class="adm-badge adm-badge-run">${run.status === 'queued' ? '排队中' : '部署中'}</span>`;
  }
  if (run.conclusion === 'success') return '<span class="adm-badge adm-badge-ok">成功</span>';
  if (run.conclusion === 'failure') return '<span class="adm-badge adm-badge-err">失败</span>';
  if (run.conclusion === 'cancelled') return '<span class="adm-badge adm-badge-draft">已取消</span>';
  return `<span class="adm-badge">${esc(run.conclusion || run.status || '')}</span>`;
}

export const deployView = {
  id: 'deploy',
  label: '部署',
  icon: 'rocket',
  title: '部署状态',
  needsAuth: true,

  async load(ctx) {
    const data = await gh.listWorkflowRuns(ctx.repoFull, 10);
    ctx.runs = (data && data.workflow_runs) || [];
    return ctx.runs;
  },

  render(ctx) {
    const runs = ctx.runs || [];
    const site = location.origin + siteRoot();

    return `
      <div class="adm-toolbar">
        <button class="adm-btn adm-btn-ghost" data-act="reload">${icon('refresh')}<span>刷新</span></button>
        <span class="adm-spacer"></span>
        <a class="adm-btn adm-btn-ghost" href="${esc(site)}" target="_blank" rel="noopener">${icon('external')}<span>打开站点</span></a>
      </div>

      <div class="adm-card adm-card-pad" style="margin-bottom:1rem">
        <dl class="adm-kv">
          <dt>仓库</dt><dd class="adm-mono">${esc(ctx.repoFull)}</dd>
          <dt>分支</dt><dd class="adm-mono">${esc(ctx.branch)}</dd>
          <dt>站点地址</dt><dd><a href="${esc(site)}" target="_blank" rel="noopener">${esc(site)}</a></dd>
        </dl>
        <p class="adm-hint">
          任何一次内容提交都会自动触发部署。下面的状态每 10 秒自动刷新一次。
        </p>
      </div>

      <div class="adm-card">
        ${runs.length ? `<ul class="adm-list">${runs.map((r) => `
          <li class="adm-list-item">
            <div class="adm-list-main">
              <span class="adm-list-title">${runBadge(r)} <span style="font-weight:400">${esc(r.name || 'workflow')}</span></span>
              <div class="adm-list-meta">
                <span>${icon('clock')}${esc(relativeTime(r.created_at))}</span>
                <span class="adm-mono">${esc((r.head_commit && r.head_commit.message || '').split('\n')[0].slice(0, 60))}</span>
              </div>
            </div>
            <div class="adm-list-actions">
              <a class="adm-btn adm-iconbtn" href="${esc(r.html_url)}" target="_blank" rel="noopener" title="查看日志">${icon('external')}</a>
              <button class="adm-btn adm-iconbtn" data-act="rerun" data-id="${r.id}" title="重新部署">${icon('refresh')}</button>
            </div>
          </li>`).join('')}</ul>`
        : `<div class="adm-empty">${icon('rocket')}<p>还没有任何部署记录</p></div>`}
      </div>`;
  },

  mount(ctx, root) {
    let timer = null;

    const tick = async () => {
      if (document.hidden) return;
      try {
        await deployView.load(ctx);
        const running = (ctx.runs || []).some((r) => r.status === 'in_progress' || r.status === 'queued');
        // 只在有运行时重绘，避免打断用户操作
        if (running) ctx.reload({ keepScroll: true });
      } catch (e) { /* 静默 */ }
    };

    const start = () => { timer = setInterval(tick, 10000); };
    const stop = () => { if (timer) clearInterval(timer); };
    start();
    window.addEventListener('hashchange', stop, { once: true });

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'reload') return ctx.reload();
      if (btn.dataset.act === 'rerun') {
        const ok = await confirmDialog({
          title: '重新部署',
          body: '将重新运行该次 GitHub Actions 工作流。',
          okText: '重新部署',
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          await gh.rerunWorkflow(ctx.repoFull, btn.dataset.id);
          toast('已触发重新部署', 'ok');
          setTimeout(() => ctx.reload(), 2500);
        } catch (err) {
          toast('触发失败：' + err.message + '（Token 可能需要 workflow 或 actions 权限）', 'err', 8000);
        } finally {
          btn.disabled = false;
        }
      }
    });

    window.addEventListener('hashchange', stop, { once: true });
  },
};

/* ==========================================================================
   设置
   ========================================================================== */

export const settingsView = {
  id: 'settings',
  label: '设置',
  icon: 'gear',
  title: '设置',
  needsAuth: true,

  async load(ctx) { return null; },

  render(ctx) {
    const info = detectRepo();
    const clientId = safeGet(LS.clientId) || DEFAULT_CLIENT_ID;
    const imgMode = safeGet(LS.imgUrlMode) || 'absolute';
    const compress = safeGet(LS.compress) !== '0';

    return `
      <div class="adm-card adm-card-pad" style="margin-bottom:1rem">
        <h3 style="margin-top:0">仓库</h3>
        <label class="adm-field">
          <span class="adm-label">目标仓库</span>
          <input class="adm-input adm-mono" data-role="repo" value="${esc(info.full)}" placeholder="owner/repo">
          <span class="adm-hint">当前${info.inferred ? '由访问地址自动推断' : '使用本地兜底值'}。填写 owner/repo 可手动覆盖。</span>
        </label>
      </div>

      <div class="adm-card adm-card-pad" style="margin-bottom:1rem">
        <h3 style="margin-top:0">登录</h3>
        <label class="adm-field">
          <span class="adm-label">OAuth App Client ID</span>
          <input class="adm-input adm-mono" data-role="client-id" value="${esc(clientId)}" placeholder="Iv1.xxxxxxxxxxxx 或 Ov23li...">
          <span class="adm-hint">填入后登录页会出现「使用 GitHub 登录」。Client ID 是公开信息，可安全保存在本地。</span>
        </label>
        <details>
          <summary class="adm-small" style="cursor:pointer">如何创建 OAuth App（点击展开）</summary>
          <ol class="adm-steps" style="margin-top:.5rem">
            <li>打开 GitHub <strong>Settings → Developer settings → OAuth Apps → New OAuth App</strong></li>
            <li>Application name 随意，如 <code>博客后台</code></li>
            <li>Homepage URL 填 <code>${esc(location.origin + siteRoot())}</code></li>
            <li>Authorization callback URL 填 <code>${esc(location.origin + siteRoot() + 'admin/')}</code></li>
            <li><strong>务必勾选 Enable Device Flow</strong>，否则无法登录</li>
            <li>创建后复制 <strong>Client ID</strong> 填到上面</li>
          </ol>
        </details>
      </div>

      <div class="adm-card adm-card-pad" style="margin-bottom:1rem">
        <h3 style="margin-top:0">编辑与上传</h3>
        <label class="adm-field">
          <span class="adm-label">插入图片时的链接格式</span>
          <select class="adm-select" data-role="img-mode">
            <option value="absolute"${imgMode === 'absolute' ? ' selected' : ''}>绝对地址（推荐，子路径部署最稳）</option>
            <option value="relative"${imgMode === 'relative' ? ' selected' : ''}>站内根路径 /img/...（仅在域名根目录部署时可用）</option>
          </select>
          <span class="adm-hint">站点部署在 <code>/my-fluid-blog/</code> 子路径下时，<code>/img/...</code> 会指向错误位置。</span>
        </label>
        <label class="adm-switch">
          <input type="checkbox" data-role="compress"${compress ? ' checked' : ''}>
          <span class="adm-switch-track"></span>
          <span class="adm-switch-text">
            <strong>上传前自动压缩图片</strong>
            <span class="adm-hint" style="margin-top:0">最长边 1920px、JPEG 质量 0.85，手机原图可显著减小</span>
          </span>
        </label>
      </div>

      <div class="adm-card adm-card-pad">
        <h3 style="margin-top:0">会话</h3>
        <p class="adm-small adm-muted">
          Token 仅保存在本浏览器的 localStorage，不会写入仓库或发送到任何第三方。
          在公共设备上使用后请务必退出。
        </p>
        <button class="adm-btn adm-btn-danger" data-act="logout">${icon('logout')}<span>退出登录</span></button>
      </div>`;
  },

  mount(ctx, root) {
    const repoEl = $('[data-role="repo"]', root);
    const cidEl = $('[data-role="client-id"]', root);
    const modeEl = $('[data-role="img-mode"]', root);
    const compressEl = $('[data-role="compress"]', root);

    repoEl.addEventListener('change', () => {
      const v = repoEl.value.trim();
      if (!v) { safeSet(LS.repo, ''); toast('已清除覆盖，回到自动推断', 'ok'); }
      else if (!/^[^/\s]+\/[^/\s]+$/.test(v)) { toast('格式应为 owner/repo', 'err'); return; }
      else { safeSet(LS.repo, v); toast('仓库已更新，即将重新载入', 'ok'); }
      setTimeout(() => location.reload(), 700);
    });

    cidEl.addEventListener('change', () => {
      safeSet(LS.clientId, cidEl.value.trim());
      toast('Client ID 已保存', 'ok');
    });

    modeEl.addEventListener('change', () => {
      safeSet(LS.imgUrlMode, modeEl.value);
      toast('图片链接格式已更新', 'ok');
    });

    compressEl.addEventListener('change', () => {
      safeSet(LS.compress, compressEl.checked ? '1' : '0');
      ctx.settings.compress = compressEl.checked;
      toast(compressEl.checked ? '已开启自动压缩' : '已关闭自动压缩', 'ok');
    });

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act="logout"]');
      if (!btn) return;
      const ok = await confirmDialog({
        title: '退出登录',
        body: '将从本浏览器清除 Token。', okText: '退出', danger: true,
      });
      if (!ok) return;
      gh.logout();
      location.reload();
    });
  },
};
