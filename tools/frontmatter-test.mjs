/**
 * front-matter 编解码回归测试
 * ---------------------------------------------------------------------------
 * 针对一个真实踩过的 bug：日期去引号的正则用了 \s*$，
 * \s 包含换行符，把行尾换行吃掉后导致结束分隔符粘到值后面：
 *     date: 2026-10-06 18:52:14---
 * 于是 front-matter 永远闭合不了，整篇文章被当成正文。
 *
 * 用法：node tools/frontmatter-test.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 浏览器模块依赖 window.jsyaml 与少量 DOM，这里做最小 shim
const yaml = require('js-yaml');
globalThis.window = { jsyaml: yaml, isSecureContext: false };
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }),
  getElementById: () => null,
};

const { parseFrontMatter, buildFrontMatter } = await import(
  'file://' + join(ROOT, 'source/admin/js/util.js').replace(/\\/g, '/')
);

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

/* ---------- 1. 核心回归：日期后面必须换行再接分隔符 ---------- */
console.log('\n[1] 日期 + 结束分隔符不能粘连');

const built = buildFrontMatter(
  { title: 'Hello World', published: true, date: '2026-10-06 18:52:14' },
  '**正文**\n'
);

check(
  '生成的 date 行以换行结束',
  /\ndate: 2026-10-06 18:52:14\r?\n---/.test(built),
  JSON.stringify(built)
);
check(
  '不存在 "值---" 粘连',
  !/\S---[ \t]*(\r?\n|$)/.test(built),
  JSON.stringify(built)
);
check('日期未被加引号', /date: 2026-10-06 18:52:14/.test(built), JSON.stringify(built));

/* ---------- 2. 往返一致性 ---------- */
console.log('\n[2] 序列化 -> 解析 往返一致');

const parsed = parseFrontMatter(built);
check('能解析出 front-matter', parsed.hasFm === true);
check('title 正确', parsed.data.title === 'Hello World', JSON.stringify(parsed.data));
check('published 为布尔 true', parsed.data.published === true, JSON.stringify(parsed.data));
check('date 保持字符串且格式不变', parsed.data.date === '2026-10-06 18:52:14', JSON.stringify(parsed.data));
check('正文正确剥离', parsed.body.trim() === '**正文**', JSON.stringify(parsed.body));

/* ---------- 3. 数组 / 中文 / 特殊字符 ---------- */
console.log('\n[3] 标签、分类、中文、含冒号的值');

const built2 = buildFrontMatter(
  {
    title: '用 Fluid 搭建博客',
    date: '2026-10-06 17:25:02',
    tags: ['Hexo', '教程'],
    categories: ['前端'],
    description: '摘要：含中文冒号和 # 井号',
  },
  '## 概述\n\n内容\n'
);
const parsed2 = parseFrontMatter(built2);
check('标签数组往返一致', JSON.stringify(parsed2.data.tags) === JSON.stringify(['Hexo', '教程']), JSON.stringify(parsed2.data.tags));
check('分类数组往返一致', JSON.stringify(parsed2.data.categories) === JSON.stringify(['前端']), JSON.stringify(parsed2.data.categories));
check('含冒号的中文描述往返一致', parsed2.data.description === '摘要：含中文冒号和 # 井号', JSON.stringify(parsed2.data.description));
check('标题往返一致', parsed2.data.title === '用 Fluid 搭建博客', JSON.stringify(parsed2.data.title));
check('正文往返一致', parsed2.body.trim() === '## 概述\n\n内容', JSON.stringify(parsed2.body));
check('二次生成仍无粘连', !/\S---[ \t]*(\r?\n|$)/.test(buildFrontMatter(parsed2.data, parsed2.body)));

/* ---------- 4. 容错恢复：已被旧版本写坏的文件 ---------- */
console.log('\n[4] 已损坏文件（分隔符粘连）的恢复');

const corrupted = '---\ntitle: Hello World\npublished: true\ndate: 2026-10-06 18:52:14---\n\n**后台部署可用性测试**\n![x](y.jpg)\n';
const rec = parseFrontMatter(corrupted);
check('能识别为 front-matter', rec.hasFm === true);
check('标题被救回', rec.data.title === 'Hello World', JSON.stringify(rec.data));
check('日期被救回', rec.data.date === '2026-10-06 18:52:14', JSON.stringify(rec.data));
check('正文不再包含 front-matter', !rec.body.includes('title:'), JSON.stringify(rec.body));
check('正文内容完整', rec.body.includes('后台部署可用性测试') && rec.body.includes('![x](y.jpg)'), JSON.stringify(rec.body));

/* ---------- 5. 不应误判普通正文 ---------- */
console.log('\n[5] 不以 --- 开头的普通正文不受影响');

const plain = '# 标题\n\n---\n\n分割线之后\n';
const p5 = parseFrontMatter(plain);
check('无 front-matter 时 hasFm=false', p5.hasFm === false);
check('正文原样返回', p5.body === plain);

/* ---------- 6. 空值与缺省 ---------- */
console.log('\n[6] 边界情况');

check('空 front-matter 数据只输出正文', buildFrontMatter({}, 'body').trim() === 'body');
const empty = parseFrontMatter('');
check('空文本不抛异常', empty.hasFm === false && empty.body === '');
check('null 不抛异常', parseFrontMatter(null).body === '');

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
