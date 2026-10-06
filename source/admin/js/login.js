/**
 * 登录页
 * ---------------------------------------------------------------------------
 * 三种入口，按推荐程度排列：
 *   1. 口令登录 —— 自设管理口令，GitHub Token 用口令经 PBKDF2 + AES-GCM 加密
 *      存在本机。日常只需输口令，**不联网、不依赖 github.com**，手机可用。
 *   2. Token 登录 —— 直接粘贴 Token，明文保存在本机（换设备或口令忘了时的退路）。
 *   3. GitHub 授权 —— OAuth Device Flow，走 github.com；部分移动网络会屏蔽该域名。
 *
 * 注意：GitHub 自 2020-11 起已移除 API 的密码认证，且强制 2FA，
 * 因此不存在「GitHub 账号密码登录」这条路；这里的「口令」是后台自己设的本地口令。
 */

import {
  DEFAULT_CLIENT_ID, LS, detectRepo, safeGet, safeRemove, safeSet, siteRoot,
} from './config.js';
import * as gh from './gh.js';
import {
  clearVault, decryptToken, encryptToken, hasVault, isSupported, readVault, saveVault,
} from './vault.js';
import { $, confirmDialog, copyText, esc, icon, toast } from './util.js';

/** 口令最短长度 */
const MIN_PASSWORD = 6;

/** 忙碌态：禁用按钮并显示转圈 */
function setBusy(btn, busy, text) {
  if (!btn) return;
  btn.disabled = busy;
  if (busy) {
    if (!btn.dataset.orig) btn.dataset.orig = btn.innerHTML;
    btn.innerHTML = `<span class="adm-spinner"></span><span>${esc(text || '处理中…')}</span>`;
  } else if (btn.dataset.orig) {
    btn.innerHTML = btn.dataset.orig;
    delete btn.dataset.orig;
  }
}

/**
 * 渲染登录页
 * @param {HTMLElement} root
 * @param {object} deps { ctx, renderApp, isAllowedUser, rejectLogin }
 */
export function renderLogin(root, deps) {
  const { ctx, renderApp, isAllowedUser, rejectLogin } = deps;

  const repo = detectRepo();
  const clientId = safeGet(LS.clientId) || DEFAULT_CLIENT_ID;
  const vault = readVault();
  const vaultReady = !!vault;
  const cryptoOk = isSupported();
  const canUseVault = cryptoOk;

  // 存档存在时必须先解锁；否则默认引导到口令设置
  const activeTab = canUseVault ? 'vault' : 'pat';

  root.innerHTML = `
    <div class="adm-login">
      <div class="adm-card adm-login-card">
        <div class="adm-login-head">
          ${icon('posts')}
          <h1>博客后台</h1>
          <p class="adm-small adm-muted"><span class="adm-mono">${esc(repo.full)}</span></p>
        </div>

        <div class="adm-tabs" role="tablist">
          <button class="adm-tab${activeTab === 'vault' ? ' is-active' : ''}" data-tab="vault" role="tab">
            ${vaultReady ? '口令登录' : '首次设置'}
          </button>
          <button class="adm-tab${activeTab === 'pat' ? ' is-active' : ''}" data-tab="pat" role="tab">Token</button>
          <button class="adm-tab${activeTab === 'oauth' ? ' is-active' : ''}" data-tab="oauth" role="tab">GitHub 授权</button>
        </div>

        <div data-pane="vault" class="${activeTab === 'vault' ? '' : 'adm-hidden'}">
          ${vaultReady ? unlockHtml() : setupHtml(cryptoOk)}
          <div data-role="vault-msg" class="adm-neterr adm-hidden"></div>
        </div>

        <div data-pane="pat" class="${activeTab === 'pat' ? '' : 'adm-hidden'}">
          <label class="adm-field">
            <span class="adm-label">Personal Access Token</span>
            <input class="adm-input adm-mono" type="password" data-role="pat" placeholder="github_pat_... 或 ghp_..." autocomplete="off">
            <span class="adm-hint">
              建议用 <strong>fine-grained token</strong>，仅授权本仓库：Contents 读写、Actions 读写。
              这种方式会<strong>明文保存在本机</strong>，建议随后在「设置」里启用管理口令。
            </span>
          </label>
          <button class="adm-btn adm-btn-primary adm-btn-block" data-act="pat-login">
            ${icon('check')}<span>验证并登录</span>
          </button>
        </div>

        <div data-pane="oauth" class="${activeTab === 'oauth' ? '' : 'adm-hidden'}">
          <div data-role="oauth-start">
            ${clientId ? `
              <button class="adm-btn adm-btn-primary adm-btn-block" data-act="oauth-start">
                ${icon('user')}<span>使用 GitHub 登录</span>
              </button>
              <p class="adm-hint" style="text-align:center;margin-top:.6rem">
                需要能访问 github.com；部分移动网络会屏蔽该域名
              </p>
            ` : `
              <label class="adm-field">
                <span class="adm-label">OAuth App Client ID</span>
                <input class="adm-input adm-mono" data-role="cid" placeholder="Iv1.xxxx 或 Ov23li...">
                <span class="adm-hint">只需填写一次，之后会记住。</span>
              </label>
              <button class="adm-btn adm-btn-primary adm-btn-block" data-act="oauth-start">
                ${icon('user')}<span>开始 GitHub 授权</span>
              </button>
            `}
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

          <div data-role="oauth-error" class="adm-neterr adm-hidden"></div>
        </div>
      </div>
    </div>`;

  const el = (sel) => $(sel, root);

  const setVaultMsg = (html, kind) => {
    const box = el('[data-role="vault-msg"]');
    if (!box) return;
    if (!html) { box.classList.add('adm-hidden'); box.innerHTML = ''; return; }
    box.style.borderLeftColor = kind === 'ok' ? '#28a745' : '#d9534f';
    box.innerHTML = html;
    box.classList.remove('adm-hidden');
  };

  /**
   * 统一的登录收尾：写入 Token、校验身份与写权限
   * @param {string} tokenValue
   * @param {boolean} persist 是否明文持久化（口令解锁时为 false）
   */
  async function completeLogin(tokenValue, persist) {
    gh.setToken(tokenValue, persist);
    ctx.repoFull = detectRepo().full;
    try {
      const user = await gh.fetchUser();
      if (!isAllowedUser(user.login)) {
        rejectLogin(user.login, '不在允许名单内，已拒绝登录');
        return false;
      }
      const repoInfo = await gh.getRepoInfo(ctx.repoFull);
      if (!(repoInfo.permissions && repoInfo.permissions.push)) {
        gh.logout();
        toast(`账号 ${user.login} 对该仓库没有写权限`, 'err', 9000);
        return false;
      }
      toast('登录成功，欢迎 ' + user.login, 'ok');
      renderApp(document.getElementById('adm-root'));
      return true;
    } catch (e) {
      gh.logout();
      const why = e.network
        ? `连不上 ${esc(e.host || 'api.github.com')}，请检查网络`
        : e.message;
      toast('验证失败：' + why, 'err', 9000);
      return false;
    }
  }

  /* ---------- GitHub 授权（Device Flow） ---------- */
  let cancelled = false;
  let verifyUri = 'https://github.com/login/device';

  const showStart = () => {
    const wait = el('[data-role="oauth-wait"]');
    const start = el('[data-role="oauth-start"]');
    if (wait) wait.classList.add('adm-hidden');
    if (start) start.classList.remove('adm-hidden');
  };
  const showWait = (userCode, statusText) => {
    const start = el('[data-role="oauth-start"]');
    const wait = el('[data-role="oauth-wait"]');
    if (start) start.classList.add('adm-hidden');
    if (wait) wait.classList.remove('adm-hidden');
    const codeEl = el('[data-role="user-code"]');
    if (codeEl) codeEl.textContent = userCode;
    const st = el('[data-role="oauth-status"]');
    if (st) st.textContent = statusText;
  };
  const showNetError = (html) => {
    const box = el('[data-role="oauth-error"]');
    if (!box) return;
    box.innerHTML = html;
    box.classList.remove('adm-hidden');
  };
  const hideNetError = () => {
    const box = el('[data-role="oauth-error"]');
    if (box) { box.classList.add('adm-hidden'); box.innerHTML = ''; }
  };

  const readPending = () => {
    try {
      const raw = safeGet(LS.deviceFlow);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !o.deviceCode || !o.expiresAt) return null;
      if (o.expiresAt <= Date.now()) { safeRemove(LS.deviceFlow); return null; }
      return o;
    } catch (e) { return null; }
  };
  const savePending = (o) => safeSet(LS.deviceFlow, JSON.stringify(o));
  const clearPending = () => safeRemove(LS.deviceFlow);

  async function runFlow(cid, resume) {
    hideNetError();

    let flow = resume;
    if (!flow) {
      const dev = await gh.startDeviceFlow(cid);
      flow = {
        clientId: cid,
        deviceCode: dev.device_code,
        userCode: dev.user_code,
        verificationUri: dev.verification_uri,
        interval: dev.interval,
        expiresAt: Date.now() + dev.expires_in * 1000,
      };
      savePending(flow);
    }

    verifyUri = flow.verificationUri || verifyUri;
    const remainMin = Math.max(0, Math.round((flow.expiresAt - Date.now()) / 60000));
    showWait(flow.userCode, `等待授权…（设备码还有约 ${remainMin} 分钟有效）`);

    cancelled = false;
    const remainSec = Math.max(10, Math.round((flow.expiresAt - Date.now()) / 1000));
    const result = await gh.pollDeviceFlow(
      flow.clientId, flow.deviceCode, flow.interval, remainSec,
      (state) => {
        if (cancelled) return;
        const st = el('[data-role="oauth-status"]');
        if (!st) return;
        if (state === 'slow_down') st.textContent = '请求过于频繁，正在放慢轮询…';
        else if (state === 'network') st.textContent = '网络抖动，正在重试…';
        else st.textContent = '仍在等待你在 GitHub 上确认…';
      }
    );
    if (cancelled) return;

    clearPending();
    // 走 GitHub 授权拿到的 Token 先在内存里；只有没设口令时才明文落盘
    const ok = await completeLogin(result.accessToken, !hasVault());
    if (!ok) { showStart(); return; }
    if (!hasVault() && isSupported()) {
      toast('提示：可到「设置」里启用管理口令，把 Token 加密保存', 'info', 7000);
    }
  }

  async function diagnoseNetwork(err) {
    const host = err.host || 'github.com';
    showStart();
    const st = el('[data-role="oauth-status"]');
    if (st) st.textContent = '正在检测网络…';

    const apiOk = await gh.probeApiReachable();
    const headline = apiOk
      ? `连不上 <code>${esc(host)}</code>，但 <code>api.github.com</code> 是通的。`
      : `连不上 <code>${esc(host)}</code>，<code>api.github.com</code> 也连不上。`;

    const causes = apiOk
      ? ['当前网络屏蔽了 github.com 这个域名（移动数据、公司或校园网常见）',
         '浏览器的广告拦截 / 云加速 / 代理插件拦截了跨域请求',
         '该设备没有走代理，而 github.com 需要代理才能访问']
      : ['设备当前似乎整体断网', '需要检查 Wi-Fi 或移动数据连接'];

    const advice = apiOk
      ? (canUseVault ? '改用「口令」或「Token」方式登录，它们只走 api.github.com。' : '改用「Token」方式登录，它只走 api.github.com。')
      : '先恢复网络再重试。';

    showNetError(`
      <strong>${headline}</strong>
      <p class="adm-small" style="margin:.5rem 0 .35rem">可能的原因：</p>
      <ul class="adm-steps" style="margin:0 0 .6rem">${causes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <p class="adm-small" style="margin:0 0 .6rem"><strong>建议</strong>：${advice}</p>
      <div class="adm-row adm-row-wrap">
        <button class="adm-btn adm-btn-sm adm-btn-primary" data-act="goto-vault">改用它登录</button>
        <button class="adm-btn adm-btn-sm adm-btn-ghost" data-act="oauth-start">重试</button>
      </div>`);
    toast('登录失败：' + err.message, 'err', 9000);
  }

  if (readPending()) {
    const pending = readPending();
    runFlow(pending.clientId, pending).catch((e) => {
      if (e.network) diagnoseNetwork(e);
      else { showStart(); toast('授权失败：' + e.message, 'err', 9000); }
    });
  }

  /* ---------- 事件 ---------- */
  // 监听挂在登录容器上：登录成功后 root.innerHTML 被主界面替换，监听随之销毁
  const box = $('.adm-login', root);
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act], [data-tab]');
    if (!btn) return;

    if (btn.dataset.tab) {
      root.querySelectorAll('.adm-tab').forEach((t) => t.classList.toggle('is-active', t === btn));
      root.querySelectorAll('[data-pane]').forEach((p) => {
        p.classList.toggle('adm-hidden', p.dataset.pane !== btn.dataset.tab);
      });
      return;
    }

    const act = btn.dataset.act;

    /* ---------- 口令解锁 ---------- */
    if (act === 'unlock') {
      const pwEl = el('[data-role="unlock-pw"]');
      const pw = pwEl ? pwEl.value : '';
      if (!pw) return toast('请输入管理口令', 'err');
      setVaultMsg('');
      setBusy(btn, true, '解锁中…');
      try {
        const tokenValue = await decryptToken(vault, pw);
        const ok = await completeLogin(tokenValue, false);
        if (!ok) {
          setVaultMsg('解密成功，但该 Token 已失效或被撤销。<br>请点下方「忘记口令 / 重置」后重新设置。');
        }
      } catch (err) {
        if (err.code === 'WRONG_PASSWORD') setVaultMsg('口令不正确，请重试。');
        else setVaultMsg('解锁失败：' + esc(err.message));
      } finally {
        setBusy(btn, false);
      }
      return;
    }

    /* ---------- 首次设置口令 ---------- */
    if (act === 'setup') {
      const tk = (el('[data-role="setup-token"]') || {}).value || '';
      const pw = (el('[data-role="setup-pw"]') || {}).value || '';
      const pw2 = (el('[data-role="setup-pw2"]') || {}).value || '';
      const tokenValue = tk.trim();
      if (!tokenValue) return toast('请填入 GitHub Token', 'err');
      if (pw.length < MIN_PASSWORD) return toast(`口令至少 ${MIN_PASSWORD} 位`, 'err');
      if (pw !== pw2) return toast('两次输入的口令不一致', 'err');
      if (!cryptoOk) return toast('当前环境不支持加密，请改用 Token 登录', 'err');

      setVaultMsg('');
      setBusy(btn, true, '校验中…');
      try {
        // 先确认 Token 有效且有写权限，再加密保存，避免存下一个坏 Token
        const check = await gh.validatePat(tokenValue, detectRepo().full);
        if (!isAllowedUser(check.user.login)) {
          rejectLogin(check.user.login, '不在允许名单内，已拒绝登录');
          return;
        }
        if (!check.canWrite) {
          gh.logout();
          toast('该 Token 对仓库没有写权限', 'err', 8000);
          return;
        }
        setBusy(btn, true, '加密中…');
        const v = await encryptToken(tokenValue, pw);
        saveVault(v);
        gh.setToken(tokenValue, false);
        toast('已创建管理口令，Token 已加密保存', 'ok');
        renderApp(document.getElementById('adm-root'));
      } catch (err) {
        setVaultMsg('设置失败：' + esc(err.message));
      } finally {
        setBusy(btn, false);
      }
      return;
    }

    /* ---------- 重置保险箱 ---------- */
    if (act === 'forget') {
      const ok = await confirmDialog({
        title: '重置管理口令',
        body: '将删除本机保存的加密 Token 与口令。<br>' +
              '<span class="adm-small">之后需要重新粘贴一次 GitHub Token 才能进入。</span>',
        okText: '重置', danger: true,
      });
      if (!ok) return;
      clearVault();
      gh.logout();
      toast('已重置，请重新设置', 'info');
      renderLogin(root, deps);
      return;
    }

    /* ---------- 直接粘贴 Token ---------- */
    if (act === 'pat-login') {
      const pat = ((el('[data-role="pat"]') || {}).value || '').trim();
      if (!pat) return toast('请填入 Token', 'err');
      setBusy(btn, true, '验证中…');
      try {
        await completeLogin(pat, true);
      } finally {
        setBusy(btn, false);
      }
      return;
    }

    /* ---------- GitHub 授权 ---------- */
    if (act === 'oauth-start') {
      const cidEl = el('[data-role="cid"]');
      const cid = (cidEl ? cidEl.value : (safeGet(LS.clientId) || DEFAULT_CLIENT_ID)).trim();
      if (!cid) return toast('请先填写 Client ID', 'err');
      safeSet(LS.clientId, cid);

      btn.disabled = true;
      try {
        await runFlow(cid, null);
      } catch (err) {
        if (cancelled) showStart();
        else if (err.network) await diagnoseNetwork(err);
        else { showStart(); toast('授权失败：' + err.message, 'err', 9000); }
      } finally {
        btn.disabled = false;
      }
      return;
    }

    if (act === 'goto-vault') {
      const t = root.querySelector(`[data-tab="${canUseVault ? 'vault' : 'pat'}"]`);
      if (t) t.click();
      return;
    }

    if (act === 'copy-code') {
      const code = (el('[data-role="user-code"]') || {}).textContent.trim();
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
      clearPending();
      showStart();
      toast('已取消授权', 'info');
    }
  });

  // 回车即提交
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const pane = e.target.closest('[data-pane]');
    if (!pane || pane.classList.contains('adm-hidden')) return;
    const primary = pane.querySelector('.adm-btn-primary');
    if (primary) { e.preventDefault(); primary.click(); }
  });

  // 记住最近一次打开的口令标签
  if (vaultReady) {
    const pwEl = el('[data-role="unlock-pw"]');
    if (pwEl) setTimeout(() => pwEl.focus(), 50);
  }
}

/* ==========================================================================
   两个面板的 HTML
   ========================================================================== */

function unlockHtml() {
  return `
    <div data-role="vault-unlock">
      <label class="adm-field">
        <span class="adm-label">管理口令</span>
        <input class="adm-input" type="password" data-role="unlock-pw"
               autocomplete="current-password" placeholder="输入你设置的口令">
        <span class="adm-hint">Token 已用该口令加密保存在本机，解锁过程不联网。</span>
      </label>
      <button class="adm-btn adm-btn-primary adm-btn-block" data-act="unlock">
        ${icon('check')}<span>解锁并进入</span>
      </button>
      <button class="adm-btn adm-btn-ghost adm-btn-block" data-act="forget" style="margin-top:.6rem">
        ${icon('trash')}<span>忘记口令 / 重置</span>
      </button>
    </div>`;
}

function setupHtml(cryptoOk) {
  return `
    <div data-role="vault-setup">
      ${cryptoOk ? '' : `
        <div class="adm-neterr" style="margin:0 0 1rem">
          当前环境不支持 WebCrypto（需要 https 或 localhost），无法加密保存。
          请改用「Token」标签直接登录。
        </div>`}
      <p class="adm-small adm-muted" style="margin-top:0">
        设置一个管理口令，GitHub Token 会用它加密后保存在本机。
        以后打开后台<strong>只需输入口令</strong>，不必再走 GitHub 授权。
      </p>
      <label class="adm-field">
        <span class="adm-label">GitHub Token</span>
        <input class="adm-input adm-mono" type="password" data-role="setup-token"
               placeholder="github_pat_..." autocomplete="off">
        <span class="adm-hint">fine-grained token，仅授权本仓库：Contents 读写、Actions 读写。</span>
      </label>
      <label class="adm-field">
        <span class="adm-label">设置管理口令</span>
        <input class="adm-input" type="password" data-role="setup-pw"
               autocomplete="new-password" placeholder="至少 ${MIN_PASSWORD} 位">
      </label>
      <label class="adm-field">
        <span class="adm-label">确认口令</span>
        <input class="adm-input" type="password" data-role="setup-pw2" autocomplete="new-password">
      </label>
      <button class="adm-btn adm-btn-primary adm-btn-block" data-act="setup"${cryptoOk ? '' : ' disabled'}>
        ${icon('check')}<span>创建并登录</span>
      </button>
      <p class="adm-hint">
        口令本身<strong>不保存、不上传</strong>，仅用于派生加密密钥。
        忘记口令只能重置后重新粘贴 Token。
      </p>
    </div>`;
}
