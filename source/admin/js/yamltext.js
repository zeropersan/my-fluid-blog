/**
 * YAML 文本外科手术
 * ---------------------------------------------------------------------------
 * _config.fluid.yml 有上千行中英注释，是最有价值的文档。
 * 若「解析成对象 -> 改字段 -> 重新 dump」，注释会被整体抹掉。
 * 因此这里采用逐行定位、只替换目标值的做法：
 *   · 读取用 js-yaml 解析（注释无所谓）
 *   · 写入用本模块按路径定位行并替换，其余内容（含注释、空行、顺序）原样保留
 */

/** 按 a.b.c 取值 */
export function getIn(obj, path) {
  const parts = Array.isArray(path) ? path : String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

const KEY_RE = /^(\s*)([A-Za-z0-9_-]+):([ \t]|$)/;

/**
 * 定位某个路径对应的键所在行号。
 * 会跳过块标量（| 与 >）和多行引号字符串内部的内容，避免把正文误判为键。
 * @returns {number} 行号，找不到返回 -1
 */
export function findKeyLine(lines, path) {
  const parts = Array.isArray(path) ? path : String(path).split('.');
  const stack = [];
  let blockIndent = -1;
  let openQuote = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.length - line.replace(/^\s*/, '').length;

    // 处于块标量或多行引号内部
    if (blockIndent >= 0) {
      if (trimmed !== '' && indent <= blockIndent) blockIndent = -1;
      else continue;
    }
    if (openQuote) {
      if (line.indexOf(openQuote, line.indexOf(openQuote) + 1) >= 0 || /['"]\s*$/.test(line)) openQuote = null;
      continue;
    }

    const m = KEY_RE.exec(line);
    if (!m) continue;

    const key = m[2];
    const after = line.slice(m[0].length - (m[3] ? m[3].length : 0)).trim();

    // 记录块标量 / 多行引号起点
    if (/^[|>][-+]?\d*\s*$/.test(after)) {
      blockIndent = indent;
    } else if (after.length > 0) {
      const first = after[0];
      if ((first === '"' || first === "'")) {
        const rest = after.slice(1);
        if (rest.indexOf(first) < 0) openQuote = first;
      }
    }

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key });

    if (stack.length === parts.length && stack.every((s, k) => s.key === parts[k])) {
      return i;
    }
  }
  return -1;
}

/** 把 JS 值转成 YAML 行内标量 */
export function formatScalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);

  const s = String(value);
  const yaml = window.jsyaml;
  if (!yaml) {
    // 没有 js-yaml 时的保守兜底
    return /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .,/_-]*$/.test(s) ? s : JSON.stringify(s);
  }
  try {
    const dumped = yaml.dump(s, { lineWidth: -1, quotingType: '"', forceQuotes: false }).replace(/\n$/, '');
    // 多行内容无法写成行内标量，交给调用方用 replaceYamlBlock
    return dumped.indexOf('\n') >= 0 ? null : dumped;
  } catch (e) {
    return JSON.stringify(s);
  }
}

/**
 * 替换某路径的标量值，保留行尾注释
 * @returns {{text: string, changed: boolean}}
 */
export function setYamlScalar(text, path, value) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const hadTrailing = /\r?\n$/.test(text);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const idx = findKeyLine(lines, path);
  const scalar = formatScalar(value);
  if (scalar === null) return { text, changed: false };

  if (idx < 0) return { text, changed: false };

  const line = lines[idx];
  const m = KEY_RE.exec(line);
  const head = line.slice(0, m[0].length);
  const tailComment = extractTrailingComment(line.slice(m[0].length));
  // KEY_RE 的匹配已包含「键 + 空白」，这里避免再加一个空格造成 `title:  值` 这种双空格
  const sep = /[ \t]$/.test(head) ? '' : ' ';
  lines[idx] = `${head}${sep}${scalar}${tailComment}`;

  return {
    text: lines.join(eol) + (hadTrailing ? eol : ''),
    changed: true,
  };
}

/** 取出值后面的行尾注释（# 前需有空白，避免误伤值里的 #） */
function extractTrailingComment(rest) {
  const m = /\s(#.*)$/.exec(rest);
  return m ? ' ' + m[1] : '';
}

/**
 * 替换某个键下面的整个块（列表 / 映射），注释保留在块之前
 * @param {string[]} newLines 已包含缩进的完整行
 */
export function replaceYamlBlock(text, path, newLines) {
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const hadTrailing = /\r?\n$/.test(text);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const idx = findKeyLine(lines, path);
  if (idx < 0) return { text, changed: false };

  const keyIndent = lines[idx].length - lines[idx].replace(/^\s*/, '').length;

  // 找到块的结束：下一个缩进 <= keyIndent 且非空的行
  let end = idx + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === '') { end++; continue; }
    const ind = l.length - l.replace(/^\s*/, '').length;
    if (ind <= keyIndent) break;
    end++;
  }

  const next = lines.slice(0, idx + 1).concat(newLines, lines.slice(end));
  return {
    text: next.join(eol) + (hadTrailing ? eol : ''),
    changed: true,
  };
}

/** 把 JS 对象数组转成 flow 风格行，如 [{ key: "home", link: "/" }] */
export function toFlowList(items, indent, orderedKeys) {
  const pad = ' '.repeat(indent);
  return items.map((item) => {
    const keys = orderedKeys || Object.keys(item);
    const body = keys
      .filter((k) => item[k] !== undefined && item[k] !== null && item[k] !== '')
      .map((k) => `${k}: ${JSON.stringify(String(item[k]))}`)
      .join(', ');
    return `${pad}- { ${body} }`;
  });
}
