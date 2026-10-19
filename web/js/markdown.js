/* 轻量 Markdown 渲染器：够用、安全、支持流式未闭合代码块 */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CODE_SPAN = '\u0000';

function inline(text) {
  let s = escapeHtml(text);

  // 行内代码优先，先抽出来
  const spans = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    spans.push(code);
    return `${CODE_SPAN}${spans.length - 1}${CODE_SPAN}`;
  });

  // 图片 / 链接
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%;border-radius:6px">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 裸链接
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(?<!\w)__([^_]+)__(?!\w)/g, '<strong>$1</strong>');

  // 还原行内代码
  s = s.replace(new RegExp(`${CODE_SPAN}(\\d+)${CODE_SPAN}`, 'g'), (_, i) => {
    return `<code class="inline">${spans[Number(i)]}</code>`;
  });

  return s;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

export function renderMarkdown(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let listStack = []; // {indent, tag}

  const closeLists = (indent = -1) => {
    while (listStack.length && listStack[listStack.length - 1].indent > indent) {
      out.push(`</${listStack.pop().tag}>`);
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      closeLists();
      const marker = fence[1];
      const lang = fence[2] || '';
      const buf = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      out.push(
        `<div class="code-block"><div class="code-head"><span>${escapeHtml(lang || 'text')}</span>` +
          `<button class="code-copy"><svg><use href="#i-copy"/></svg>复制</button></div>` +
          `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre></div>`
      );
      if (!closed) break;
      continue;
    }

    // 空行
    if (!line.trim()) {
      closeLists();
      i++;
      continue;
    }

    // 水平线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeLists();
      out.push('<hr>');
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const lv = Math.min(6, h[1].length);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      closeLists();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of rows) {
        out.push('<tr>' + head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('') + '</tr>');
      }
      out.push('</tbody></table>');
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      closeLists();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 列表
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const indent = li[1].replace(/\t/g, '  ').length;
      const ordered = /\d/.test(li[2]);
      const tag = ordered ? 'ol' : 'ul';

      while (listStack.length && listStack[listStack.length - 1].indent > indent) {
        out.push(`</${listStack.pop().tag}>`);
      }
      const top = listStack[listStack.length - 1];
      if (!top || top.indent < indent) {
        listStack.push({ indent, tag });
        out.push(`<${tag}>`);
      } else if (top.tag !== tag) {
        out.push(`</${top.tag}>`);
        listStack.pop();
        listStack.push({ indent, tag });
        out.push(`<${tag}>`);
      }
      // 任务列表
      let content = li[3];
      let cls = '';
      const task = content.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        const done = task[1].toLowerCase() === 'x';
        cls = done ? ' class="task done"' : ' class="task"';
        content = (done ? '☑ ' : '☐ ') + task[2];
      }
      out.push(`<li${cls}>${inline(content)}</li>`);
      i++;
      continue;
    }

    // 段落（合并连续行）
    closeLists();
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]) && !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  while (listStack.length) out.push(`</${listStack.pop().tag}>`);
  return out.join('\n');
}
