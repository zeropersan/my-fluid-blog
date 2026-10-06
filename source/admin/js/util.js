/**
 * 通用工具：DOM、图标、提示、对话框、front-matter 解析
 */

import { CDN } from './config.js';

/* ==========================================================================
   1. DOM
   ========================================================================== */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.prototype.slice.call(root.querySelectorAll(sel));

/** 创建元素 */
export function h(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  if (children === null || children === undefined) return;
  if (Array.isArray(children)) {
    children.forEach((c) => appendChildren(node, c));
    return;
  }
  node.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** HTML 转义：所有插入模板的用户数据都必须经过它 */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 事件委托：在 root 上监听 [data-act] 的点击 */
export function delegate(root, handlers) {
  root.addEventListener('click', (e) => {
    const target = e.target.closest('[data-act]');
    if (!target || !root.contains(target)) return;
    const fn = handlers[target.dataset.act];
    if (!fn) return;
    e.preventDefault();
    fn(target, e);
  });
}

/* ==========================================================================
   2. 图标
   —— 主题自带 iconfont 里已有的图标优先用它，保证与站点同一套字形；
      主题没有的（编辑、删除、上传、设置、部署等）用内联 SVG 补齐，
      统一 1em 尺寸 + currentColor，视觉上与 iconfont 对齐。
   ========================================================================== */

const FONT_ICONS = {
  posts: 'icon-articles',
  pages: 'icon-list',
  images: 'icon-eye',
  settings: 'icon-category',
  deploy: 'icon-chart',
  search: 'icon-search',
  user: 'icon-user-fill',
  home: 'icon-home-fill',
  draft: 'icon-archive-fill',
  date: 'icon-date',
  clock: 'icon-clock-fill',
  tags: 'icon-tags-fill',
  category: 'icon-category-fill',
  link: 'icon-link-fill',
  copy: 'icon-copy',
  success: 'icon-success',
  author: 'icon-author',
  list: 'icon-list',
  arrowup: 'icon-arrowup',
  arrowdown: 'icon-arrowdown',
  arrowleft: 'icon-arrowleft',
  arrowright: 'icon-arrowright',
  eye: 'icon-eye',
  dark: 'icon-dark',
  light: 'icon-light',
};

const SVG_ICONS = {
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  close: 'M18 6 6 18M6 6l12 12',
  menu: 'M3 6h18M3 12h18M3 18h18',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  image: 'M3 3h18v18H3zM9 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM21 15l-5-5L5 21',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.6-1H1.3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 3V2.9a2 2 0 1 1 4 0V3a1.7 1.7 0 0 0 2.9 1.2 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  rocket: 'M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.9.7-2.2-.1-3-.7-.8-2-.8-2.9 0ZM12 15l-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2a12.9 12.9 0 0 1-6.1 11 22 22 0 0 1-3.9 2ZM9 12H4s.5-2.8 2-4c1.7-1.3 5 0 5 0M12 15v5s2.8-.5 4-2c1.3-1.7 0-5 0-5',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2ZM17 21v-8H7v8M7 3v5h8',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  // Markdown 工具栏
  bold: 'M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z',
  italic: 'M19 4h-9M14 20H5M15 4 9 20',
  heading: 'M6 4v16M18 4v16M6 12h12',
  quote: 'M3 21c3 0 7-1 7-8V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h3M14 21c3 0 7-1 7-8V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h3',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  listUl: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  listOl: 'M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 16H4l2 2H4',
  table: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  hr: 'M3 12h18',
  linkIcon: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  minus: 'M5 12h14',
};

/** 返回图标 HTML 字符串 */
export function icon(name, extraClass) {
  const cls = 'adm-ico' + (extraClass ? ' ' + extraClass : '');
  if (FONT_ICONS[name]) {
    return `<i class="iconfont ${FONT_ICONS[name]} ${cls}" aria-hidden="true"></i>`;
  }
  const path = SVG_ICONS[name];
  if (!path) return `<i class="${cls}" aria-hidden="true"></i>`;
  return `<i class="${cls}" aria-hidden="true"><svg viewBox="0 0 24 24">${path
    .split('M')
    .filter(Boolean)
    .map((d) => `<path d="M${d.trim()}"/>`)
    .join('')}</svg></i>`;
}

/* ==========================================================================
   3. Toast / 对话框
   ========================================================================== */

let toastHost = null;

export function toast(message, type = 'info', timeout = 3600) {
  if (!toastHost) toastHost = document.getElementById('adm-toast');
  if (!toastHost) return;
  const node = h('div', { class: `adm-toast adm-toast-${type}`, text: message });
  toastHost.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

/**
 * 确认对话框
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, body, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('adm-modal');
    const titleEl = $('.adm-modal-title', modal);
    const bodyEl = $('.adm-modal-body', modal);
    const actions = $('.adm-modal-actions', modal);

    titleEl.textContent = title || '';
    bodyEl.innerHTML = body || '';
    clear(actions);

    const done = (val) => {
      modal.hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
    };

    actions.appendChild(h('button', {
      class: 'adm-btn adm-btn-ghost', type: 'button', text: cancelText,
      onclick: () => done(false),
    }));
    actions.appendChild(h('button', {
      class: 'adm-btn ' + (danger ? 'adm-btn-danger' : 'adm-btn-primary'),
      type: 'button', text: okText, onclick: () => done(true),
    }));

    modal.hidden = false;
    document.addEventListener('keydown', onKey);
    const focusTarget = $('.adm-btn-primary, .adm-btn-danger', actions);
    if (focusTarget) focusTarget.focus();

    // 点击遮罩关闭
    const mask = $('.adm-modal-mask', modal);
    mask.onclick = () => done(false);
  });
}

/* ==========================================================================
   4. front-matter
   ========================================================================== */

let yamlLib = null;

/** 按需加载 js-yaml；失败时返回 null，由调用方降级 */
export async function ensureYaml() {
  if (yamlLib) return yamlLib;
  if (window.jsyaml) { yamlLib = window.jsyaml; return yamlLib; }
  await loadScript(CDN.yaml);
  yamlLib = window.jsyaml || null;
  return yamlLib;
}

const FM_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/**
 * 解析 front-matter
 * 注意：使用 CORE_SCHEMA 让 `date: 2026-10-06 17:25:02` 保持字符串，
 * 否则 js-yaml 会按 UTC 解析成 Date，再转回本地时间会平白偏移 8 小时。
 * @returns {{data: object, body: string, hasFm: boolean}}
 */
export function parseFrontMatter(raw) {
  const text = String(raw == null ? '' : raw);

  let yamlText;
  let body;

  const m = FM_RE.exec(text);
  if (m) {
    yamlText = m[1];
    body = text.slice(m[0].length);
  } else {
    // 容错恢复：早期版本的正则缺陷会把结束分隔符粘到最后一个值后面
    // （date: 2026-10-06 18:52:14---），使 front-matter 永远闭合不了、
    // 整篇文章被当成正文。这里把它拆回来，已经写坏的文件仍可正常编辑。
    const recovered = recoverStuckDelimiter(text);
    if (!recovered) return { data: {}, body: text, hasFm: false };
    yamlText = recovered.yamlText;
    body = recovered.body;
  }

  const yaml = window.jsyaml;
  let data = {};
  if (yaml) {
    try {
      const parsed = yaml.load(yamlText, { schema: yaml.CORE_SCHEMA });
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch (e) {
      return { data: {}, body, hasFm: true, error: e.message };
    }
  }
  return { data, body, hasFm: true };
}

/**
 * 恢复「结束分隔符被粘在值末尾」的畸形 front-matter。
 * 只在前两层匹配尝试都失败后调用，且要求中间内容确实像 YAML（含 key: 行），
 * 避免把以 --- 开头的普通正文误判为 front-matter。
 */
function recoverStuckDelimiter(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return null;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const hit = /^(.*\S)[ \t]*---[ \t]*$/.exec(lines[i]);
    if (!hit || hit[1].trim() === '') continue;

    const yamlLines = lines.slice(1, i).concat(hit[1]);
    if (!yamlLines.some((l) => /^[A-Za-z_][\w-]*:/.test(l))) return null;

    return { yamlText: yamlLines.join('\n'), body: lines.slice(i + 1).join('\n') };
  }
  return null;
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;

/** 序列化 front-matter 与正文 */
export function buildFrontMatter(data, body) {
  const yaml = window.jsyaml;
  const clean = {};
  Object.keys(data || {}).forEach((k) => {
    const v = data[k];
    if (v === null || v === undefined) return;
    if (typeof v === 'string' && v.trim() === '') return;
    clean[k] = v;
  });

  if (!yaml || Object.keys(clean).length === 0) {
    return String(body == null ? '' : body);
  }

  let dumped;
  try {
    dumped = yaml.dump(clean, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
  } catch (e) {
    return String(body == null ? '' : body);
  }

  // 把形如日期的值还原成不带引号的写法，与 Hexo 习惯保持一致。
  // 注意必须用 [ \t] 而不是 \s：\s 包含换行符，贪婪匹配会把行尾的 \n 一起吃掉，
  // 导致结束分隔符被粘到值后面（date: 2026-10-06 18:52:14---），front-matter 再也闭合不了。
  dumped = dumped.replace(/^([ \t]*)(date|updated):[ \t]*(['"])([^'"]*)\3[ \t]*$/gm, (all, indent, key, q, val) => {
    return DATE_LIKE.test(val) ? `${indent}${key}: ${val}` : all;
  });

  return `---\n${dumped}---\n\n${String(body == null ? '' : body)}`;
}

/* ==========================================================================
   5. 杂项
   ========================================================================== */

/** 由标题生成文件名（保留中文，去掉文件系统非法字符） */
export function toFileName(title) {
  const base = String(title || '')
    .trim()
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (base || 'untitled') + '.md';
}

/** 本地时间 -> YYYY-MM-DD HH:mm:ss */
export function nowStamp(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ` +
         `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

/** 相对时间 */
export function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const diff = Math.floor((Date.now() - then) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 2592000) return Math.floor(diff / 86400) + ' 天前';
  return new Date(then).toLocaleDateString();
}

export function debounce(fn, wait) {
  let t = null;
  return function () {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 动态加载外部脚本，失败时 reject */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('load failed: ' + src)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error('load failed: ' + src));
    document.head.appendChild(s);
  });
}

/** 复制到剪贴板，带降级方案 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 落到降级方案 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}
