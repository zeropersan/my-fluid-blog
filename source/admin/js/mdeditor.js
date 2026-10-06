/**
 * Markdown 编辑器组件
 * ---------------------------------------------------------------------------
 * · 分屏实时预览，预览区复用主题的 .markdown-body，风格与站点一致
 * · 工具栏 / 快捷键 / 滚动同步
 * · 图片上传：点击选择、拖拽、直接粘贴（截图后 Ctrl+V）
 * · 预览内容经过净化：后台 token 存在 localStorage，
 *   若直接渲染外部粘贴来的 Markdown 里的 <script>/on* 属性，token 会被窃取。
 */

import { CDN, UPLOAD } from './config.js';
import { $, esc, icon, loadScript, toast } from './util.js';

/* ==========================================================================
   Markdown 渲染
   ========================================================================== */

let markedReady = false;
let markedTried = false;

async function ensureMarked() {
  if (markedReady) return true;
  if (markedTried && !window.marked) return false;
  markedTried = true;
  try {
    if (!window.marked) await loadScript(CDN.marked);
    if (window.marked && window.marked.setOptions) {
      window.marked.setOptions({ gfm: true, breaks: false, headerIds: true, mangle: false });
    }
    markedReady = !!window.marked;
  } catch (e) {
    markedReady = false;
  }
  return markedReady;
}

const DANGEROUS_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'base', 'svg'];

/** 净化预览 HTML，去掉可执行内容 */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll(DANGEROUS_TAGS.join(',')).forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    Array.prototype.slice.call(el.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value || '';
      if (name.startsWith('on')) { el.removeAttribute(attr.name); return; }
      if (/^(href|src|xlink:href|action|formaction)$/.test(name) && /^\s*(javascript|data:text\/html|vbscript):/i.test(value)) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}

export async function renderMarkdown(md) {
  if (!(await ensureMarked())) {
    return '<p class="adm-muted">预览组件（marked）加载失败，编辑与保存不受影响。</p>';
  }
  try {
    return sanitizeHtml(window.marked.parse(String(md || '')));
  } catch (e) {
    return '<p class="adm-muted">Markdown 渲染出错：' + esc(e.message) + '</p>';
  }
}

/* ==========================================================================
   图片压缩
   ========================================================================== */

const COMPRESSIBLE = /^image\/(jpeg|jpg|png|webp)$/i;

/**
 * 在浏览器端压缩图片（手机上直接传原图往往好几 MB）
 * @returns {Promise<Blob>} 压缩失败时原样返回
 */
export async function compressImage(file, maxEdge, quality) {
  if (!COMPRESSIBLE.test(file.type)) return file;
  const limit = maxEdge || UPLOAD.compressMaxEdge;
  const q = quality || UPLOAD.compressQuality;

  let bitmap;
  try {
    bitmap = await loadBitmap(file);
  } catch (e) {
    return file;
  }

  const { width, height } = bitmap;
  const scale = Math.min(1, limit / Math.max(width, height));
  // 本来就不大，再压收益有限
  if (scale === 1 && file.size < 400 * 1024) {
    if (bitmap.close) bitmap.close();
    return file;
  }

  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, q));
  if (!blob) return file;
  // 压完反而更大就用原图
  return blob.size < file.size ? blob : file;
}

function loadBitmap(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file).catch(() => loadImageElement(file));
  }
  return loadImageElement(file);
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

/* ==========================================================================
   编辑器
   ========================================================================== */

const TOOLS = [
  { act: 'bold', ico: 'bold',   title: '加粗 (Ctrl+B)' },
  { act: 'italic', ico: 'italic', title: '斜体 (Ctrl+I)' },
  { act: 'heading', ico: 'heading', title: '标题' },
  { act: 'quote', ico: 'quote', title: '引用' },
  { act: 'code', ico: 'code', title: '代码块' },
  { act: 'listUl', ico: 'listUl', title: '无序列表' },
  { act: 'listOl', ico: 'listOl', title: '有序列表' },
  { act: 'link', ico: 'linkIcon', title: '链接' },
  { act: 'table', ico: 'table', title: '表格' },
  { act: 'hr', ico: 'hr', title: '分割线' },
  { act: 'image', ico: 'image', title: '插入图片 / 上传' },
];

export class MarkdownEditor {
  /**
   * @param {HTMLElement} mount 容器
   * @param {object} opts
   *   value            初始 Markdown 正文
   *   onChange(text)   内容变化回调
   *   onImage(file)    上传图片，返回 Promise<{url, name, size}>
   *   compress         是否压缩上传
   */
  constructor(mount, opts = {}) {
    this.mount = mount;
    this.opts = opts;
    this.value = opts.value || '';
    this.uploading = 0;
    this.render();
    this.bind();
    this.refreshPreview();
  }

  render() {
    const tools = TOOLS.map((t) =>
      `<button type="button" class="adm-btn adm-iconbtn adm-btn-sm" data-md="${t.act}" title="${esc(t.title)}" aria-label="${esc(t.title)}">${icon(t.ico)}</button>`
    ).join('');

    this.mount.innerHTML = `
      <div class="adm-editor-grid">
        <div class="adm-pane adm-card">
          <div class="adm-pane-head">
            ${icon('edit')}<span>编辑</span>
            <span class="adm-spacer"></span>
            <span class="adm-small adm-muted" data-role="count"></span>
          </div>
          <div class="adm-editor-toolbar">${tools}</div>
          <div class="adm-editor-body">
            <textarea class="adm-editor-textarea" data-role="input"
              placeholder="在此撰写正文，支持 Markdown。可直接粘贴或拖入图片上传。"
              spellcheck="false"></textarea>
          </div>
        </div>
        <div class="adm-pane adm-card">
          <div class="adm-pane-head">${icon('eye')}<span>预览</span></div>
          <div class="adm-preview markdown-body" data-role="preview"></div>
        </div>
      </div>
      <input type="file" accept="image/*" multiple hidden data-role="file">
    `;

    this.input = $('[data-role="input"]', this.mount);
    this.preview = $('[data-role="preview"]', this.mount);
    this.fileInput = $('[data-role="file"]', this.mount);
    this.countEl = $('[data-role="count"]', this.mount);
    this.input.value = this.value;
  }

  bind() {
    const previewDebounced = debounceByRaf(() => this.refreshPreview());

    this.input.addEventListener('input', () => {
      this.value = this.input.value;
      updateCount(this.countEl, this.value);
      if (this.opts.onChange) this.opts.onChange(this.value);
      previewDebounced();
    });

    // 工具栏（含键盘可达性）
    this.mount.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-md]');
      if (!btn) return;
      e.preventDefault();
      this.runTool(btn.dataset.md);
    });

    // 快捷键
    this.input.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); this.runTool('bold'); }
      else if (k === 'i') { e.preventDefault(); this.runTool('italic'); }
      else if (k === 'k') { e.preventDefault(); this.runTool('link'); }
    });

    // 拖拽上传
    ['dragenter', 'dragover'].forEach((ev) => {
      this.input.addEventListener(ev, (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        this.input.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      this.input.addEventListener(ev, () => this.input.classList.remove('is-dragover'));
    });
    this.input.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.handleFiles(Array.from(e.dataTransfer.files));
    });

    // 粘贴上传（截图直接 Ctrl+V）
    this.input.addEventListener('paste', (e) => {
      const files = e.clipboardData ? Array.from(e.clipboardData.files || []) : [];
      if (files.length) {
        e.preventDefault();
        this.handleFiles(files);
      }
    });

    this.fileInput.addEventListener('change', () => {
      this.handleFiles(Array.from(this.fileInput.files || []));
      this.fileInput.value = '';
    });

    // 滚动同步
    this.input.addEventListener('scroll', () => {
      const denom = this.input.scrollHeight - this.input.clientHeight;
      if (denom <= 0) return;
      const ratio = this.input.scrollTop / denom;
      const pdenom = this.preview.scrollHeight - this.preview.clientHeight;
      if (pdenom <= 0) return;
      this.preview.scrollTop = ratio * pdenom;
    });

    updateCount(this.countEl, this.value);
  }

  /* ---------- 编辑操作 ---------- */

  runTool(act) {
    switch (act) {
      case 'bold': return this.wrap('**', '**', '加粗文字');
      case 'italic': return this.wrap('*', '*', '斜体文字');
      case 'heading': return this.prefixLines('## ');
      case 'quote': return this.prefixLines('> ');
      case 'listUl': return this.prefixLines('- ');
      case 'listOl': return this.prefixLines('1. ');
      case 'code': return this.codeBlock();
      case 'link': return this.wrap('[', '](https://)', '链接文字');
      case 'hr': return this.insert('\n\n---\n\n');
      case 'table': return this.insert('\n\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n\n');
      case 'image': return this.fileInput.click();
      default: return undefined;
    }
  }

  wrap(before, after, placeholder) {
    const { selectionStart: s, selectionEnd: e } = this.input;
    const text = this.input.value;
    const selected = text.slice(s, e) || placeholder || '';
    const next = text.slice(0, s) + before + selected + after + text.slice(e);
    this.applyValue(next, s + before.length, s + before.length + selected.length);
  }

  prefixLines(prefix) {
    const { selectionStart: s, selectionEnd: e } = this.input;
    const text = this.input.value;
    const lineStart = text.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = text.indexOf('\n', e);
    if (lineEnd === -1) lineEnd = text.length;

    const block = text.slice(lineStart, lineEnd);
    const replaced = block.split('\n').map((l) => (l.trim() ? prefix + l : l)).join('\n');
    const next = text.slice(0, lineStart) + replaced + text.slice(lineEnd);
    this.applyValue(next, lineStart, lineStart + replaced.length);
  }

  codeBlock() {
    const { selectionStart: s, selectionEnd: e } = this.input;
    const text = this.input.value;
    const selected = text.slice(s, e);
    const block = '\n```\n' + (selected || '') + '\n```\n';
    const next = text.slice(0, s) + block + text.slice(e);
    this.applyValue(next, s + 4, s + 4 + (selected ? selected.length : 0));
  }

  insert(str) {
    const { selectionStart: s, selectionEnd: e } = this.input;
    const text = this.input.value;
    const next = text.slice(0, s) + str + text.slice(e);
    this.applyValue(next, s + str.length, s + str.length);
  }

  /** 在光标处插入文本（供图片上传后调用） */
  insertAtCursor(str) {
    this.insert(str);
  }

  applyValue(next, selStart, selEnd) {
    this.input.value = next;
    this.value = next;
    this.input.focus();
    if (selStart !== undefined) this.input.setSelectionRange(selStart, selEnd === undefined ? selStart : selEnd);
    updateCount(this.countEl, next);
    if (this.opts.onChange) this.opts.onChange(next);
    this.refreshPreview();
  }

  async refreshPreview() {
    const html = await renderMarkdown(this.value);
    if (!this.preview) return;
    this.preview.innerHTML = html;
  }

  /* ---------- 图片上传 ---------- */

  async handleFiles(files) {
    const images = files.filter((f) => /^image\//i.test(f.type));
    if (!images.length) {
      toast('只能上传图片文件', 'err');
      return;
    }
    if (!this.opts.onImage) {
      toast('当前上下文不支持上传图片', 'err');
      return;
    }

    for (const file of images) {
      await this.uploadOne(file);
    }
  }

  async uploadOne(file) {
    const placeholder = `![上传中 ${file.name}]()`;
    this.insert(placeholder);
    this.uploading++;

    try {
      const result = await this.opts.onImage(file);
      // 用真实地址替换占位符
      const current = this.input.value;
      const idx = current.indexOf(placeholder);
      const md = `![${result.name || ''}](${result.url})`;
      if (idx >= 0) {
        this.input.value = current.slice(0, idx) + md + current.slice(idx + placeholder.length);
        this.value = this.input.value;
        if (this.opts.onChange) this.opts.onChange(this.value);
        this.refreshPreview();
      } else {
        this.insertAtCursor('\n' + md + '\n');
      }
      const extra = result.compressed
        ? `（已压缩 ${result.originalSize} → ${result.size}）`
        : '';
      toast(`已上传 ${result.name}${extra}`, 'ok');
    } catch (e) {
      const current = this.input.value;
      const idx = current.indexOf(placeholder);
      if (idx >= 0) {
        this.input.value = current.slice(0, idx) + current.slice(idx + placeholder.length);
        this.value = this.input.value;
        if (this.opts.onChange) this.opts.onChange(this.value);
        this.refreshPreview();
      }
      toast('图片上传失败：' + e.message, 'err', 6000);
    } finally {
      this.uploading--;
    }
  }

  /** 当前是否还有上传在进行 */
  isBusy() { return this.uploading > 0; }

  getValue() { return this.input.value; }

  setValue(text) {
    this.input.value = text || '';
    this.value = this.input.value;
    updateCount(this.countEl, this.value);
    this.refreshPreview();
  }
}

/* ==========================================================================
   辅助
   ========================================================================== */

function hasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types) {
    for (let i = 0; i < dt.types.length; i++) {
      if (dt.types[i] === 'Files') return true;
    }
  }
  return false;
}

function updateCount(el, text) {
  if (!el) return;
  const chars = text.length;
  const lines = text ? text.split('\n').length : 0;
  el.textContent = `${chars} 字符 · ${lines} 行`;
}

function debounceByRaf(fn) {
  let scheduled = false;
  return function () {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}
