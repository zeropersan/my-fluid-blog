/**
 * 口令保险箱加解密测试
 * Node 24 自带 WebCrypto 与 btoa/atob，可直接跑。
 *
 * 用法：node tools/vault-test.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// vault.js 依赖 config.js，config.js 里会读 localStorage；Node 下补一个最小实现
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = {};
globalThis.location = { href: 'https://example.com/', hostname: 'example.com', pathname: '/' };

const vault = await import('file://' + join(ROOT, 'source/admin/js/vault.js').replace(/\\/g, '/'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

const TOKEN = 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789';
const PW = '我的口令-Str0ng!';

console.log('\n[1] WebCrypto 可用性');
check('isSupported() 为 true', vault.isSupported() === true);

console.log('\n[2] 加密 -> 解密 往返');
const v1 = await vault.encryptToken(TOKEN, PW);
check('保险箱含必要字段', !!(v1.ct && v1.salt && v1.iv && v1.iter && v1.kdf), JSON.stringify(Object.keys(v1)));
check('记录了 KDF 与迭代次数', v1.kdf === 'PBKDF2-SHA256' && v1.iter >= 100000, JSON.stringify({ kdf: v1.kdf, iter: v1.iter }));
check('密文不等于明文', v1.ct !== TOKEN);
check('密文中不含明文片段', !v1.ct.includes('github_pat_'));
const back = await vault.decryptToken(v1, PW);
check('正确口令可解出原 Token', back === TOKEN, JSON.stringify(back));

console.log('\n[3] 错误口令必须失败');
let wrongErr = null;
try { await vault.decryptToken(v1, '错误口令'); } catch (e) { wrongErr = e; }
check('抛出异常', !!wrongErr);
check('错误码为 WRONG_PASSWORD', wrongErr && wrongErr.code === 'WRONG_PASSWORD', wrongErr && wrongErr.message);

console.log('\n[4] 每次加密应使用不同 salt / IV');
const v2 = await vault.encryptToken(TOKEN, PW);
check('salt 不同', v2.salt !== v1.salt);
check('iv 不同', v2.iv !== v1.iv);
check('密文不同', v2.ct !== v1.ct);
check('但都能解回同一 Token', (await vault.decryptToken(v2, PW)) === TOKEN);

console.log('\n[5] 篡改检测（AES-GCM 完整性）');
const tampered = Object.assign({}, v1);
const raw = atob(v1.ct);
const bytes = new Uint8Array(raw.length);
for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
bytes[0] ^= 0xff;                       // 翻一个 bit
let bin = '';
for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
tampered.ct = btoa(bin);

let tamperErr = null;
try { await vault.decryptToken(tampered, PW); } catch (e) { tamperErr = e; }
check('篡改后解密失败', !!tamperErr, tamperErr ? '' : '竟然解开了');

console.log('\n[6] 存取与清除');
check('初始无保险箱', vault.hasVault() === false);
vault.saveVault(v1);
check('保存后 hasVault 为 true', vault.hasVault() === true);
check('读回内容一致', vault.readVault().ct === v1.ct);
check('记录了创建时间', vault.vaultCreatedAt() instanceof Date);
vault.clearVault();
check('清除后 hasVault 为 false', vault.hasVault() === false);

console.log('\n[7] 异常输入');
check('空保险箱返回 null', vault.readVault() === null);
let bad = null;
try { await vault.decryptToken({}, PW); } catch (e) { bad = e; }
check('残缺保险箱抛错', !!bad);

// 顺带记录一次真实的解锁耗时，供评估手机上是否可接受
const t0 = Date.now();
await vault.decryptToken(v1, PW);
console.log(`\n（单次解锁耗时约 ${Date.now() - t0} ms，迭代 ${v1.iter} 次）`);

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
