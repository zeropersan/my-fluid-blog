/**
 * 内容类视图：文章列表 / 编辑器 / 图片库 / 独立页面
 *
 * 视图模块统一契约：
 *   { id, label, icon, needsAuth, load(ctx), render(ctx), mount(ctx, root) }
 * ctx 由 app.js 提供，包含仓库信息、缓存、设置与导航方法。
 */

import { BRANCH, LS, PATHS, UPLOAD, safeGet, siteRoot } from './config.js';
import * as gh from './gh.js';
import {
  $, $$, buildFrontMatter, clear, confirmDialog, copyText, debounce, ensureYaml, esc,
  formatBytes, icon, nowStamp, parseFrontMatter, relativeTime, toast, toFileName,
} from './util.js';
import { MarkdownEditor, compressImage } from './mdeditor.js';

/* ==========================================================================
   共享：文章元信息缓存
   列表页需要每篇文章的标题/日期/标签，若每次都全量拉取会非常慢。
   这里按 blob sha 缓存解析结果，只有内容变过的文件才重新拉取。
   ========================================================================== */

const META_CACHE_KEY = 'fluid-admin-meta-cache';
let metaCache = null;

function getMetaCache() {
  if (metaCache) return metaCache;
  metaCache = {};
  try {
    const raw = safeGet(META_CACHE_KEY);
    if (raw) metaCache = JSON.parse(raw) || {};
  } catch (e) { metaCache = {}; }
  return metaCache;
}

const flushMetaCache = debounce(() => {
  try {
    const keys = Object.keys(metaCache);
    // 防御性裁剪，避免无限增长
    if (keys.length > 600) {
      keys.slice(0, keys.length - 600).forEach((k) => delete metaCache[k]);
    }
    localStorage.setItem(META_CACHE_KEY, JSON.stringify(metaCache));
  } catch (e) { /* 配额满就放弃缓存 */ }
}, 800);

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

/** 读取单篇文章的元信息（带 sha 缓存） */
async function readPostMeta(ctx, path, sha) {
  await ensureYaml(); // js-yaml 是懒加载的，必须先就绪否则解析不出 front-matter
  const cache = getMetaCache();
  const hit = cache[path];
  if (hit && hit.sha === sha) return hit.meta;

  const file = await gh.getFileText(ctx.repoFull, path);
  const { data } = parseFrontMatter(file.text);
  const meta = {
    title: data.title || path.split('/').pop().replace(/\.md$/i, ''),
    date: data.date || '',
    updated: data.updated || '',
    tags: normalizeList(data.tags),
    categories: normalizeList(data.categories),
    sticky: data.sticky || 0,
    published: data.published !== false,
    description: data.description || '',
  };
  cache[path] = { sha: file.sha || sha, meta };
  flushMetaCache();
  return meta;
}

function normalizeList(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

/** 并发受限的 map，避免一次性打爆浏览器连接数 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ==========================================================================
   共享：图片上传
   ========================================================================== */

function pad2(n) { return String(n).padStart(2, '0'); }

/** 生成不冲突的文件名 */
function uniqueName(original, taken) {
  const dot = original.lastIndexOf('.');
  const base = (dot > 0 ? original.slice(0, dot) : original)
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'image';
  const ext = (dot > 0 ? original.slice(dot) : '.png').toLowerCase();
  let name = base + ext;
  let i = 1;
  while (taken && taken.has(name)) {
    name = `${base}-${i++}${ext}`;
  }
  return name;
}

/** 根据设置生成插入到 Markdown 里的图片地址 */
export function imageUrlFor(relPath) {
  const mode = safeGet(LS.imgUrlMode) || 'absolute';
  if (mode === 'relative') return '/' + relPath;
  return location.origin + siteRoot() + relPath;
}

/**
 * 上传图片并返回可写入 Markdown 的信息
 * @returns {Promise<{url,name,size,originalSize,compressed}>}
 */
export async function uploadImage(ctx, file) {
  let blob = file;
  let compressed = false;

  if (ctx.settings.compress) {
    const out = await compressImage(file);
    if (out && out !== file && out.size < file.size) {
      blob = out;
      compressed = true;
    }
  }

  if (blob.size > UPLOAD.maxBytes) {
    throw new Error(`图片 ${formatBytes(blob.size)} 超过上限 ${formatBytes(UPLOAD.maxBytes)}`);
  }
  if (blob.size > UPLOAD.warnBytes) {
    toast(`图片 ${formatBytes(blob.size)} 偏大，提交会慢一些`, 'info');
  }

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = pad2(now.getMonth() + 1);
  const relDir = `${UPLOAD.urlBase}/${yyyy}/${mm}`;
  const taken = new Set(ctx.cache.imageNames || []);
  const name = uniqueName(file.name || 'image.png', taken);
  const repoPath = `${UPLOAD.dir}/${yyyy}/${mm}/${name}`;

  const buffer = await blob.arrayBuffer();
  await gh.putFileBinary(ctx.repoFull, repoPath, buffer, `chore(admin): 上传图片 ${name}`);

  if (ctx.cache.imageNames) ctx.cache.imageNames.push(name);
  ctx.cache.treeStale = true;

  return {
    url: imageUrlFor(`${relDir}/${name}`),
    name,
    size: formatBytes(blob.size),
    originalSize: formatBytes(file.size),
    compressed,
  };
}

/* ==========================================================================
   文章列表
   ========================================================================== */

export const postsView = {
  id: 'posts',
  label: '文章',
  icon: 'posts',
  title: '文章',

  async load(ctx) {
    const [published, drafts] = await Promise.all([
      gh.listDir(ctx.repoFull, PATHS.posts),
      gh.listDir(ctx.repoFull, PATHS.drafts),
    ]);

    const posts = published
      .filter((f) => f.type === 'file' && /\.md$/i.test(f.name))
      .map((f) => ({ name: f.name, path: f.path, sha: f.sha, size: f.size, kind: 'post' }));
    const draftFiles = drafts
      .filter((f) => f.type === 'file' && /\.md$/i.test(f.name))
      .map((f) => ({ name: f.name, path: f.path, sha: f.sha, size: f.size, kind: 'draft' }));

    // 并行取元信息（带 sha 缓存）
    ctx.posts = await mapLimit(posts.concat(draftFiles), 6, async (item) => {
      try {
        const meta = await readPostMeta(ctx, item.path, item.sha);
        return Object.assign({}, item, meta);
      } catch (e) {
        return Object.assign({}, item, {
          title: item.name, tags: [], categories: [], error: e.message,
        });
      }
    });
    ctx.posts.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return ctx.posts;
  },

  render(ctx) {
    return `
      <div class="adm-toolbar">
        <label class="adm-searchbox">
          <span class="adm-sr">搜索文章</span>
          ${icon('search')}
          <input type="search" class="adm-input" data-role="filter" placeholder="按标题 / 标签 / 文件名筛选" autocomplete="off">
        </label>
        <button class="adm-btn adm-btn-ghost" data-act="refresh">${icon('refresh')}<span>刷新</span></button>
        <button class="adm-btn adm-btn-primary" data-act="new">${icon('plus')}<span>新建文章</span></button>
      </div>
      <div class="adm-card" data-role="list-wrap"></div>
    `;
  },

  mount(ctx, root) {
    const wrap = $('[data-role="list-wrap"]', root);
    const filterInput = $('[data-role="filter"]', root);

    function paint() {
      const q = (filterInput.value || '').trim().toLowerCase();
      const items = (ctx.posts || []).filter((p) => {
        if (!q) return true;
        return [p.title, p.name, (p.tags || []).join(' '), (p.categories || []).join(' ')]
          .join(' ').toLowerCase().indexOf(q) >= 0;
      });

      if (!items.length) {
        wrap.innerHTML = `<div class="adm-empty">${icon('posts')}
          <p>${ctx.posts && ctx.posts.length ? '没有匹配的文章' : '还没有文章'}</p>
          <button class="adm-btn adm-btn-primary" data-act="new">${icon('plus')}<span>新建文章</span></button>
        </div>`;
        return;
      }

      wrap.innerHTML = `<ul class="adm-list">${items.map(rowHtml).join('')}</ul>`;
    }

    function rowHtml(p) {
      const badges = [];
      if (p.kind === 'draft') badges.push('<span class="adm-badge adm-badge-draft">草稿</span>');
      if (p.published === false) badges.push('<span class="adm-badge adm-badge-draft">未发布</span>');
      if (p.error) badges.push('<span class="adm-badge adm-badge-err">读取失败</span>');

      const tags = (p.tags || []).slice(0, 4)
        .map((t) => `<span>${icon('tags')}${esc(t)}</span>`).join('');

      return `
        <li class="adm-list-item">
          <div class="adm-list-main">
            <span class="adm-list-title">${esc(p.title)} ${badges.join(' ')}</span>
            <div class="adm-list-meta">
              <span>${icon('date')}${esc(String(p.date || '无日期').slice(0, 16))}</span>
              ${tags}
              <span class="adm-mono">${esc(p.name)}</span>
            </div>
          </div>
          <div class="adm-list-actions">
            <button class="adm-btn adm-iconbtn" data-act="edit" data-path="${esc(p.path)}" title="编辑" aria-label="编辑">${icon('edit')}</button>
            <button class="adm-btn adm-iconbtn adm-btn-danger" data-act="del" data-path="${esc(p.path)}" data-title="${esc(p.title)}" data-sha="${esc(p.sha)}" title="删除" aria-label="删除">${icon('trash')}</button>
          </div>
        </li>`;
    }

    filterInput.addEventListener('input', debounce(paint, 120));

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;

      if (act === 'new') {
        ctx.navigate('#/new');
      } else if (act === 'edit') {
        ctx.navigate('#/edit/' + encodeURIComponent(btn.dataset.path));
      } else if (act === 'del') {
        const ok = await confirmDialog({
          title: '删除文章',
          body: `确定删除《${esc(btn.dataset.title)}》？<br><span class="adm-small">该操作会提交一次删除，历史仍可在 Git 中找回。</span>`,
          okText: '删除', danger: true,
        });
        if (!ok) return;
        try {
          await gh.deleteFile(ctx.repoFull, btn.dataset.path, btn.dataset.sha, `chore(admin): 删除文章 ${btn.dataset.path.split('/').pop()}`);
          toast('已删除，部署将在片刻后开始', 'ok');
          ctx.cache.treeStale = true;
          ctx.reload();
        } catch (err) {
          toast('删除失败：' + err.message, 'err', 6000);
        }
      } else if (act === 'refresh') {
        ctx.reload();
      }
    });

    paint();
  },
};

/* ==========================================================================
   编辑器（新建 / 编辑文章与页面）
   ========================================================================== */

const FM_FIELDS = [
  { key: 'title', label: '标题', type: 'text', required: true, full: true },
  { key: 'date', label: '发布日期', type: 'text', hint: '格式 YYYY-MM-DD HH:mm:ss' },
  { key: 'updated', label: '更新日期', type: 'text', hint: '留空则由 Hexo 按文件时间生成' },
  { key: 'tags', label: '标签', type: 'list', hint: '英文逗号分隔' },
  { key: 'categories', label: '分类', type: 'list', hint: '英文逗号分隔' },
  { key: 'description', label: '摘要', type: 'text', full: true },
  { key: 'keywords', label: '关键词', type: 'text', hint: '英文逗号分隔，用于 SEO' },
  { key: 'banner_img', label: '封面图', type: 'text', hint: '形如 /img/xxx.png 或完整网址' },
  { key: 'sticky', label: '置顶权重', type: 'number', hint: '数字越大越靠前，0 为不置顶' },
];

const TOC_CHOICES = [
  { value: '', label: '跟随主题设置' },
  { value: 'true', label: '显示目录' },
  { value: 'false', label: '隐藏目录' },
];

export const editorView = {
  id: 'editor',
  label: '编辑',
  icon: 'edit',
  needsAuth: true,

  /** @param {object} ctx  @param {string} param 文章路径（新建时为空） */
  async load(ctx, param) {
    const isNew = !param;
    let data = {};
    let body = '';
    let sha = null;
    let path = param || '';

    if (isNew) {
      data = { title: '', date: nowStamp(), tags: [], categories: [] };
      body = '';
    } else {
      const file = await gh.getFileText(ctx.repoFull, path);
      sha = file.sha;
      await ensureYaml();
      const parsed = parseFrontMatter(file.text);
      data = parsed.data || {};
      body = parsed.body || '';
      if (parsed.error) toast('Front-matter 解析失败，已按纯文本载入：' + parsed.error, 'err', 7000);
    }

    // 草稿还是正式文章
    const kind = path.indexOf(PATHS.drafts) === 0 ? 'draft' : 'post';
    const other = Object.keys(data).filter((k) => !FM_FIELDS.some((f) => f.key === k) && k !== 'toc');

    return { isNew, path, sha, data, body, kind, otherKeys: other, original: body };
  },

  render(ctx, state) {
    const d = state.data || {};
    const isDraft = state.kind === 'draft';

    const fields = FM_FIELDS.map((f) => {
      const raw = d[f.key];
      let value = '';
      if (f.type === 'list') value = normalizeList(raw).join(', ');
      else if (raw !== undefined && raw !== null) value = String(raw);
      if (f.key === 'sticky' && (value === '' || value === '0')) value = '';
      return `
        <label class="adm-field${f.full ? ' adm-field-full' : ''}">
          <span class="adm-label">${esc(f.label)}</span>
          <input class="adm-input" type="${f.type === 'number' ? 'number' : 'text'}"
                 data-fm="${f.key}" value="${esc(value)}"
                 ${f.required ? 'required' : ''}
                 placeholder="${esc(f.hint || '')}">
          ${f.hint ? `<span class="adm-hint">${esc(f.hint)}</span>` : ''}
        </label>`;
    }).join('');

    const tocVal = d.toc === undefined || d.toc === null ? '' : String(d.toc);

    return `
      <div class="adm-toolbar">
        <button class="adm-btn adm-btn-ghost" data-act="back">${icon('arrowleft')}<span>返回</span></button>
        <span class="adm-spacer"></span>
        <span class="adm-small adm-muted" data-role="autosave"></span>
        <button class="adm-btn adm-btn-ghost" data-act="preview-site" title="在站点中查看">${icon('external')}<span class="adm-hide-sm">查看</span></button>
        <button class="adm-btn adm-btn-ghost" data-act="save-draft">${icon('save')}<span>存为草稿</span></button>
        <button class="adm-btn adm-btn-primary" data-act="publish">${icon('check')}<span>发布</span></button>
      </div>

      <div class="adm-card adm-card-pad" style="margin-bottom:1rem">
        <div class="adm-row" style="margin-bottom:.75rem">
          <strong data-role="heading">${state.isNew ? '新建文章' : esc(d.title || state.path)}</strong>
          ${isDraft ? '<span class="adm-badge adm-badge-draft">草稿</span>' : '<span class="adm-badge adm-badge-ok">已发布</span>'}
          <span class="adm-spacer"></span>
          <button class="adm-btn adm-btn-sm adm-btn-ghost" data-act="toggle-fm">
            ${icon('list')}<span>Front-matter</span>
          </button>
        </div>

        <div data-role="fm" class="adm-fm-grid">
          ${fields}
          <label class="adm-field">
            <span class="adm-label">目录</span>
            <select class="adm-select" data-fm="toc">
              ${TOC_CHOICES.map((c) => `<option value="${c.value}"${c.value === tocVal ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
            </select>
          </label>
          <label class="adm-field">
            <span class="adm-label">发布状态</span>
            <select class="adm-select" data-fm="published">
              <option value="true"${d.published !== false ? ' selected' : ''}>正常发布</option>
              <option value="false"${d.published === false ? ' selected' : ''}>暂不发布（published: false）</option>
            </select>
          </label>
          ${state.otherKeys.length ? `
          <label class="adm-field adm-field-full">
            <span class="adm-label">其他字段（原样保留）</span>
            <textarea class="adm-textarea adm-mono" data-fm-other rows="3">${esc(
              state.otherKeys.map((k) => `${k}: ${JSON.stringify(d[k])}`).join('\n')
            )}</textarea>
            <span class="adm-hint">这些字段不在上面的表单里，保存时按 YAML 原样写回</span>
          </label>` : ''}
        </div>
      </div>

      <div data-role="editor"></div>
    `;
  },

  mount(ctx, root, state) {
    const fmWrap = $('[data-role="fm"]', root);
    const heading = $('[data-role="heading"]', root);
    const autosaveLabel = $('[data-role="autosave"]', root);
    fmWrap.style.display = 'none';

    let currentPath = state.path;
    let currentSha = state.sha;
    let dirty = false;

    const editor = new MarkdownEditor($('[data-role="editor"]', root), {
      value: state.body,
      onChange: () => { dirty = true; scheduleAutosave(); },
      onImage: (file) => uploadImage(ctx, file),
    });

    /* ---------- 自动保存（localStorage，防丢失） ---------- */
    const AUTOSAVE_KEY = LS.autosave(currentPath || '__new__');

    function collect() {
      const data = readForm();
      return { data, body: editor.getValue(), path: currentPath, at: Date.now() };
    }

    function scheduleAutosave() {
      autosaveSoon();
    }

    const autosaveSoon = debounce(() => {
      try {
        const payload = collect();
        safeSetLocal(AUTOSAVE_KEY, JSON.stringify(payload));
        autosaveLabel.textContent = '本地已暂存 ' + new Date().toLocaleTimeString();
      } catch (e) { /* 配额问题忽略 */ }
    }, 1500);

    // 若存在未提交的本地暂存，提示恢复
    const stale = readAutosave(AUTOSAVE_KEY);
    if (stale && stale.body && stale.body !== state.original) {
      confirmDialog({
        title: '发现未提交的本地暂存',
        body: `保存于 ${new Date(stale.at).toLocaleString()}，是否恢复？<br><span class="adm-small">选择「取消」将丢弃该暂存。</span>`,
        okText: '恢复', cancelText: '丢弃',
      }).then((ok) => {
        if (ok) {
          applyForm(stale.data || {});
          editor.setValue(stale.body || '');
          toast('已恢复本地暂存', 'ok');
        } else {
          clearAutosave(AUTOSAVE_KEY);
        }
      });
    }

    /* ---------- 表单读写 ---------- */
    function readForm() {
      const data = {};
      // 保留未在表单里的字段
      state.otherKeys.forEach((k) => { data[k] = state.data[k]; });

      $$('[data-fm]', fmWrap).forEach((el) => {
        const key = el.dataset.fm;
        let v = el.value;
        if (key === 'tags' || key === 'categories' || key === 'keywords') {
          const list = String(v).split(',').map((s) => s.trim()).filter(Boolean);
          if (list.length) data[key] = list;
          return;
        }
        if (key === 'toc') {
          if (v === 'true') data.toc = true;
          else if (v === 'false') data.toc = false;
          return;
        }
        if (key === 'published') { data.published = v === 'true'; return; }
        if (key === 'sticky') {
          const n = Number(v);
          if (v !== '' && !isNaN(n) && n !== 0) data.sticky = n;
          return;
        }
        v = String(v).trim();
        if (v !== '') data[key] = v;
      });

      // 其他字段的 YAML 文本
      const otherEl = $('[data-fm-other]', fmWrap);
      if (otherEl && window.jsyaml) {
        try {
          const parsed = window.jsyaml.load(otherEl.value, { schema: window.jsyaml.CORE_SCHEMA });
          if (parsed && typeof parsed === 'object') Object.assign(data, parsed);
        } catch (e) {
          toast('「其他字段」YAML 语法有误，已忽略该部分', 'err');
        }
      }
      return data;
    }

    function applyForm(data) {
      $$('[data-fm]', fmWrap).forEach((el) => {
        const key = el.dataset.fm;
        const raw = data[key];
        if (key === 'tags' || key === 'categories' || key === 'keywords') {
          el.value = normalizeList(raw).join(', ');
          return;
        }
        if (key === 'toc') {
          el.value = raw === undefined || raw === null ? '' : String(raw);
          return;
        }
        if (key === 'published') { el.value = raw === false ? 'false' : 'true'; return; }
        el.value = raw === undefined || raw === null ? '' : String(raw);
      });
    }

    /* ---------- 保存 ---------- */
    async function save(target) {
      const data = readForm();
      const title = String(data.title || '').trim();
      if (!title) {
        toast('请先填写标题', 'err');
        fmWrap.style.display = '';
        const t = $('[data-fm="title"]', fmWrap);
        if (t) t.focus();
        return;
      }
      if (editor.isBusy()) {
        toast('图片仍在上传，请稍候', 'info');
        return;
      }
      if (!data.date) data.date = nowStamp();

      const body = editor.getValue();
      const content = buildFrontMatter(data, body);

      // 目标路径：草稿 -> _drafts，正式 -> _posts
      const dir = target === 'draft' ? PATHS.drafts : PATHS.posts;
      let path = currentPath;

      if (!path) {
        path = `${dir}/${toFileName(title)}`;
      } else {
        const inDrafts = path.indexOf(PATHS.drafts) === 0;
        const wantDrafts = target === 'draft';
        if (inDrafts !== wantDrafts) {
          // 在草稿与正式之间移动：先写新文件，再删旧文件
          const newPath = `${dir}/${path.split('/').pop()}`;
          await gh.putFileText(ctx.repoFull, newPath, content, `feat(admin): ${wantDrafts ? '转为草稿' : '发布'} ${title}`);
          await gh.deleteFile(ctx.repoFull, path, currentSha, `chore(admin): 移动 ${path.split('/').pop()}`);
          currentPath = newPath;
          currentSha = null;
          finishSave(newPath, title, target);
          return;
        }
      }

      const res = await gh.putFileText(
        ctx.repoFull, path, content,
        `${state.isNew ? 'feat' : 'update'}(admin): ${target === 'draft' ? '草稿' : '文章'} ${title}`,
        currentSha
      );
      currentPath = path;
      currentSha = res.sha;
      finishSave(path, title, target);
    }

    function finishSave(path, title, target) {
      clearAutosave(AUTOSAVE_KEY);
      state.isNew = false;
      state.path = path;
      dirty = false;
      heading.textContent = title;
      autosaveLabel.textContent = '';
      ctx.cache.treeStale = true;
      const cache = getMetaCache();
      delete cache[path];
      flushMetaCache();
      toast(target === 'draft' ? '草稿已保存' : '已发布，部署将在片刻后开始', 'ok');
      ctx.startDeployWatch && ctx.startDeployWatch();
    }

    async function doSave(target) {
      const btns = $$('[data-act]', root).filter((b) => /save-draft|publish/.test(b.dataset.act));
      btns.forEach((b) => { b.disabled = true; });
      try {
        await save(target);
      } catch (e) {
        toast('保存失败：' + e.message, 'err', 7000);
      } finally {
        btns.forEach((b) => { b.disabled = false; });
      }
    }

    /* ---------- 事件 ---------- */
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      switch (btn.dataset.act) {
        case 'back':
          if (dirty) {
            const ok = await confirmDialog({
              title: '放弃未保存的修改？',
              body: '当前修改尚未提交到仓库。',
              okText: '放弃并返回', danger: true,
            });
            if (!ok) return;
          }
          ctx.navigate('#/posts');
          break;
        case 'toggle-fm': {
          const shown = fmWrap.style.display !== 'none';
          fmWrap.style.display = shown ? 'none' : '';
          break;
        }
        case 'save-draft': await doSave('draft'); break;
        case 'publish': await doSave('publish'); break;
        case 'preview-site': {
          const slug = (currentPath || '').split('/').pop().replace(/\.md$/i, '');
          window.open(siteRoot() + 'archives/', '_blank', 'noopener');
          break;
        }
        default: break;
      }
    });

    // 标题变化时同步顶部
    const titleEl = $('[data-fm="title"]', fmWrap);
    if (titleEl) {
      titleEl.addEventListener('input', () => {
        dirty = true;
        heading.textContent = titleEl.value || (state.isNew ? '新建文章' : state.path);
        scheduleAutosave();
      });
    }

    // 离开前提醒
    window.addEventListener('beforeunload', (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    state.editorDirty = () => dirty;
  },
};

function safeSetLocal(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* 忽略 */ }
}

function readAutosave(key) {
  try {
    const raw = safeGet(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function clearAutosave(key) {
  try { localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
}

export const newPostView = {
  id: 'new',
  label: '新建文章',
  icon: 'plus',
  needsAuth: true,
  async load(ctx) {
    return editorView.load(ctx, '');
  },
  render(ctx, state) {
    return editorView.render(ctx, state);
  },
  mount(ctx, root, state) {
    return editorView.mount(ctx, root, state);
  },
};

/* ==========================================================================
   图片库
   ========================================================================== */

export const imagesView = {
  id: 'images',
  label: '图片',
  icon: 'images',
  title: '图片库',

  async load(ctx) {
    const tree = await gh.listTree(ctx.repoFull);
    ctx.cache.tree = tree;
    ctx.cache.treeStale = false;
    ctx.cache.imageNames = tree
      .filter((n) => n.type === 'blob' && n.path.indexOf(PATHS.images + '/') === 0)
      .map((n) => n.path.split('/').pop());

    const images = tree
      .filter((n) => n.type === 'blob' && n.path.indexOf(PATHS.images + '/') === 0 && IMAGE_RE.test(n.path))
      .map((n) => ({
        path: n.path,
        name: n.path.split('/').pop(),
        size: n.size,
        rel: n.path.replace(/^source\//, ''),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));

    // mount() 读取的是 ctx.images，这里必须回写，否则图片库永远显示为空
    ctx.images = images;
    return images;
  },

  render(ctx) {
    return `
      <div class="adm-toolbar">
        <label class="adm-searchbox">
          <span class="adm-sr">搜索图片</span>
          ${icon('search')}
          <input type="search" class="adm-input" data-role="filter" placeholder="按文件名筛选" autocomplete="off">
        </label>
        <button class="adm-btn adm-btn-ghost" data-act="refresh">${icon('refresh')}<span>刷新</span></button>
        <button class="adm-btn adm-btn-primary" data-act="upload">${icon('upload')}<span>上传图片</span></button>
        <input type="file" accept="image/*" multiple hidden data-role="file">
      </div>

      <div class="adm-drop" data-role="drop" style="margin-bottom:1rem">
        ${icon('image')}
        <p>把图片拖到这里，或点击上方按钮上传</p>
        <p class="adm-small adm-muted">图片会提交到 <code>${esc(PATHS.images)}/uploads/年/月/</code>，上传前自动压缩</p>
      </div>

      <div class="adm-card adm-card-pad" data-role="grid-wrap"></div>
    `;
  },

  mount(ctx, root) {
    const gridWrap = $('[data-role="grid-wrap"]', root);
    const filterInput = $('[data-role="filter"]', root);
    const fileInput = $('[data-role="file"]', root);
    const drop = $('[data-role="drop"]', root);
    let items = ctx.images || [];

    function paint() {
      const q = (filterInput.value || '').trim().toLowerCase();
      const list = items.filter((i) => !q || i.name.toLowerCase().indexOf(q) >= 0);

      if (!list.length) {
        gridWrap.innerHTML = `<div class="adm-empty">${icon('image')}
          <p>${items.length ? '没有匹配的图片' : '图片目录还是空的'}</p></div>`;
        return;
      }

      gridWrap.innerHTML = `<div class="adm-img-grid">${list.map((i) => `
        <button class="adm-img-cell" data-act="pick" data-url="${esc(imageUrlFor(i.rel))}" data-name="${esc(i.name)}" title="${esc(i.name)}（${formatBytes(i.size)}）">
          <img src="${esc(imageUrlFor(i.rel))}" alt="${esc(i.name)}" loading="lazy">
          <span class="adm-img-name">${esc(i.name)}</span>
        </button>`).join('')}</div>
        <p class="adm-small adm-muted" style="margin:1rem 0 0">共 ${list.length} 张 · 点击复制 Markdown</p>`;
    }

    async function doUpload(files) {
      const imgs = files.filter((f) => /^image\//i.test(f.type));
      if (!imgs.length) { toast('只能上传图片文件', 'err'); return; }
      for (const f of imgs) {
        try {
          const r = await uploadImage(ctx, f);
          toast(`已上传 ${r.name}${r.compressed ? `（压缩 ${r.originalSize} → ${r.size}）` : ''}`, 'ok');
        } catch (e) {
          toast(`上传 ${f.name} 失败：` + e.message, 'err', 7000);
        }
      }
      ctx.reload();
    }

    filterInput.addEventListener('input', debounce(paint, 120));
    fileInput.addEventListener('change', () => { doUpload(Array.from(fileInput.files || [])); fileInput.value = ''; });

    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      doUpload(Array.from((e.dataTransfer && e.dataTransfer.files) || []));
    });

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'upload') fileInput.click();
      else if (btn.dataset.act === 'refresh') ctx.reload();
      else if (btn.dataset.act === 'pick') {
        const md = `![${btn.dataset.name}](${btn.dataset.url})`;
        const ok = await copyText(md);
        toast(ok ? '已复制 Markdown 引用' : '复制失败，请手动选择', ok ? 'ok' : 'err');
      }
    });

    paint();
  },
};

/* ==========================================================================
   独立页面（关于、友链等）
   ========================================================================== */

export const pagesView = {
  id: 'pages',
  label: '页面',
  icon: 'pages',
  title: '独立页面',

  async load(ctx) {
    const tree = await gh.listTree(ctx.repoFull);
    const pages = tree
      .filter((n) => n.type === 'blob' && /^source\/[^/]+\/index\.md$/i.test(n.path))
      .filter((n) => !/^source\/_(posts|drafts)\//.test(n.path))
      .map((n) => ({ path: n.path, name: n.path.split('/')[1], sha: n.sha, size: n.size }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // 同上：mount() 读取 ctx.pages
    ctx.pages = pages;
    return pages;
  },

  render() {
    return `<div class="adm-card adm-card-pad">
      <p class="adm-muted adm-small" style="margin-top:0">
        这里列出 <code>source/&lt;名称&gt;/index.md</code> 形式的独立页面。
        新建页面请先在本地执行 <code>hexo new page &lt;名称&gt;</code>，或直接在上方文章中改用页面路径。
      </p>
      <div data-role="list"></div>
    </div>`;
  },

  mount(ctx, root) {
    const wrap = $('[data-role="list"]', root);
    const list = ctx.pages || [];

    if (!list.length) {
      wrap.innerHTML = `<div class="adm-empty">${icon('file')}<p>还没有独立页面</p></div>`;
      return;
    }

    wrap.innerHTML = `<ul class="adm-list">${list.map((p) => `
      <li class="adm-list-item">
        <div class="adm-list-main">
          <span class="adm-list-title">${esc(p.name)}</span>
          <div class="adm-list-meta"><span class="adm-mono">${esc(p.path)}</span></div>
        </div>
        <div class="adm-list-actions">
          <button class="adm-btn adm-iconbtn" data-act="edit" data-path="${esc(p.path)}" title="编辑">${icon('edit')}</button>
          <a class="adm-btn adm-iconbtn" href="${esc(siteRoot() + p.name + '/')}" target="_blank" rel="noopener" title="查看">${icon('external')}</a>
        </div>
      </li>`).join('')}</ul>`;

    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="edit"]');
      if (btn) ctx.navigate('#/edit/' + encodeURIComponent(btn.dataset.path));
    });
  },
};
