/**
 * 后台配置常量
 * ---------------------------------------------------------------------------
 * 仓库信息优先从当前访问地址自动推断：
 *   https://<owner>.github.io/<repo>/admin/  -> owner=<owner>, repo=<repo>
 *   https://<owner>.github.io/admin/         -> owner=<owner>, repo=<owner>.github.io
 * 本地 hexo server 访问时无法推断，使用下面 LOCAL_FALLBACK_REPO。
 * 推断结果可以在「设置」里手动覆盖（存 localStorage）。
 */

/** 本地开发时的兜底仓库（本地 hexo server 无法从 URL 推断） */
export const LOCAL_FALLBACK_REPO = 'zeropersan/my-fluid-blog';

/** 目标分支：推送即触发 GitHub Actions 部署 */
export const BRANCH = 'main';

/** 默认 OAuth App 的 Client ID。
 *  Client ID 是公开信息，可以安全地写在源码里。
 *  填好后登录页不再显示输入框，只剩一个「使用 GitHub 登录」按钮。
 *  留空则首次登录时需要手动填一次（之后会记住）。 */
export const DEFAULT_CLIENT_ID = 'Ov23liLSrq5yD9nJL4Nx';

/** Device Flow 需要的权限。仓库是公开的，public_repo 足够，
 *  不必申请全量 repo 权限，最小化授权范围。 */
export const OAUTH_SCOPE = 'public_repo';

/**
 * 允许登录的 GitHub 用户名白名单。
 * ---------------------------------------------------------------------------
 * 留空数组 [] = 不做限制（任何 GitHub 账号都能进到界面，但只有对该仓库有
 * 写权限的人才能保存——写操作最终由 GitHub 服务端把关）。
 * 填了则严格限制：不在名单内的账号即使授权成功也会被拒绝并立即清除 token，
 * 连界面都进不去。用户名不区分大小写。
 */
export const ALLOWED_USERS = ['zeropersan'];

/** 内容路径 */
export const PATHS = {
  posts: 'source/_posts',
  drafts: 'source/_drafts',
  pages: 'source',
  images: 'source/img',
  siteConfig: '_config.yml',
  themeConfig: '_config.fluid.yml',
};

/** 上传图片的存放位置与访问 URL（URL 相对于站点根目录） */
export const UPLOAD = {
  dir: 'source/img/uploads',
  urlBase: 'img/uploads',
  /** 超过该字节数会在上传前提示（GitHub Contents API 建议单文件 < 1MB） */
  warnBytes: 1024 * 1024,
  /** 硬上限，超过直接拒绝 */
  maxBytes: 8 * 1024 * 1024,
  /** 自动压缩：最长边像素上限与 JPEG 质量 */
  compressMaxEdge: 1920,
  compressQuality: 0.85,
};

/** localStorage 键名 */
export const LS = {
  token: 'fluid-admin-token',
  clientId: 'fluid-admin-client-id',
  colorScheme: 'fluid-admin-color-scheme',
  repo: 'fluid-admin-repo',
  compress: 'fluid-admin-compress',
  imgUrlMode: 'fluid-admin-img-url-mode',
  /** 进行中的 Device Flow，用于手机切换 App 后页面被回收时恢复轮询 */
  deviceFlow: 'fluid-admin-device-flow',
  /** 口令加密后的 Token 保险箱 */
  vault: 'fluid-admin-vault',
  autosave: (path) => `fluid-admin-autosave:${path}`,
};

/** 第三方库（UMD，从 CDN 加载；加载失败不影响除预览外的功能） */
export const CDN = {
  marked: 'https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js',
  yaml: 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js',
};

/**
 * 主题参数开关面板的定义。
 * path 为 _config.fluid.yml 中的嵌套路径；写入时按路径合并，不破坏其余配置。
 */
export const THEME_TOGGLES = [
  {
    group: '外观',
    items: [
      { path: 'dark_mode.enable', label: '暗色模式', hint: '按系统偏好或用户选择切换深浅色' },
      { path: 'navbar.ground_glass.enable', label: '导航栏毛玻璃', hint: '滚动时导航栏半透明模糊' },
      { path: 'scroll_top_arrow.enable', label: '返回顶部按钮', hint: '桌面端右下角悬浮按钮' },
      { path: 'fun_features.typed.enable', label: '首页打字机副标题', hint: '副标题逐字打出效果' },
    ],
  },
  {
    group: '文章',
    items: [
      { path: 'post.toc.enable', label: '文章目录', hint: '宽屏右侧栏显示目录' },
      { path: 'post.copyright.enable', label: '版权声明', hint: '文末显示转载协议' },
      { path: 'post.prev_next.enable', label: '上一篇 / 下一篇', hint: '文末导航' },
      { path: 'post.wordcount.enable', label: '字数统计', hint: '显示文章字数与阅读时长' },
      { path: 'post.comments.enable', label: '评论', hint: '需要另行配置评论服务' },
    ],
  },
  {
    group: '功能',
    items: [
      { path: 'search.enable', label: '本地搜索', hint: '基于 local-search.xml 的离线搜索' },
      { path: 'code.highlight.enable', label: '代码高亮', hint: '代码块语法着色与行号' },
      { path: 'code.copy.enable', label: '代码复制按钮', hint: '代码块右上角一键复制' },
      { path: 'lazyload.enable', label: '图片懒加载', hint: '滚动到可见区域再加载' },
      { path: 'math.enable', label: '数学公式', hint: 'KaTeX 渲染' },
      { path: 'mermaid.enable', label: 'Mermaid 图表', hint: '流程图 / 时序图' },
    ],
  },
];

/** 常用社交链接字段（站点配置页用） */
export const SOCIAL_FIELDS = [
  { key: 'github', label: 'GitHub' },
  { key: 'twitter', label: 'Twitter / X' },
  { key: 'weibo', label: '微博' },
  { key: 'zhihu', label: '知乎' },
  { key: 'juejin', label: '掘金' },
  { key: 'bilibili', label: 'Bilibili' },
  { key: 'email', label: '邮箱' },
  { key: 'rss', label: 'RSS' },
];

/**
 * 从当前地址推断 GitHub 仓库。
 * @returns {{owner: string, repo: string, full: string, inferred: boolean}}
 */
export function detectRepo() {
  const override = safeGet(LS.repo);
  if (override && /^[^/\s]+\/[^/\s]+$/.test(override)) {
    return { owner: override.split('/')[0], repo: override.split('/')[1], full: override, inferred: false };
  }

  const host = location.hostname;
  const seg = location.pathname.split('/').filter(Boolean);

  // *.github.io
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(host);
  if (m) {
    const owner = m[1];
    // 第一段是仓库名则为项目页，否则是用户页
    if (seg.length >= 1 && !/^admin$/i.test(seg[0])) {
      return { owner, repo: seg[0], full: `${owner}/${seg[0]}`, inferred: true };
    }
    return { owner, repo: `${owner}.github.io`, full: `${owner}/${owner}.github.io`, inferred: true };
  }

  const [owner, repo] = LOCAL_FALLBACK_REPO.split('/');
  return { owner, repo, full: LOCAL_FALLBACK_REPO, inferred: false };
}

/** 站点根路径（用于拼接图片访问地址），始终以 / 结尾 */
export function siteRoot() {
  const seg = location.pathname.split('/').filter(Boolean);
  // 去掉末尾的 admin
  if (seg.length && /^admin$/i.test(seg[seg.length - 1])) seg.pop();
  // github.io 用户页没有额外路径段
  const isUserPage = /^([a-z0-9-]+)\.github\.io$/i.test(location.hostname)
    && seg.length === 0;
  if (isUserPage || seg.length === 0) return '/';
  return '/' + seg.join('/') + '/';
}

/* ---------- 小工具：localStorage 安全读写（隐私模式下会抛错） ---------- */

export function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

export function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) { /* 忽略 */ }
}

export function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) { /* 忽略 */ }
}
