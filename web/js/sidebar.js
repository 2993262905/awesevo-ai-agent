import { S, $, el, esc, fmtTime, toast } from './store.js';
import { API } from './api.js';
import { renderSession } from './chat.js';
import { confirmDialog, promptDialog } from './ui-dialog.js';

/* ---------------- 时钟 ---------------- */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
let clockTimer = null;

function pad(n) { return String(n).padStart(2, '0'); }

function tickClock() {
  const d = new Date();
  const timeEl = $('#clockTime');
  const dateEl = $('#clockDate');
  if (timeEl) timeEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (dateEl) {
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    dateEl.textContent = `${y}年${m}月${day}日 · ${WEEKDAYS[d.getDay()]}`;
  }
}

export function initClock() {
  tickClock();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(tickClock, 1000);
}

/* ---------------- 会话列表 ---------------- */
export function renderSessions() {
  const box = $('#sessionList');
  if (!S.sessions.length) {
    box.innerHTML = `<div class="side-empty">还没有会话<br>在下面输入框里说点什么，<br>或者按 Ctrl+N 新建</div>`;
    return;
  }

  const groups = { 今天: [], 昨天: [], 更早: [] };
  const now = new Date();
  for (const s of S.sessions) {
    const d = new Date(s.updatedAt || s.createdAt);
    const dayDiff = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
    if (dayDiff <= 0) groups['今天'].push(s);
    else if (dayDiff === 1) groups['昨天'].push(s);
    else groups['更早'].push(s);
  }

  let html = '';
  for (const [label, list] of Object.entries(groups)) {
    if (!list.length) continue;
    html += `<div class="menu-label" style="padding-left:8px;padding-top:6px">${label}</div>`;
    for (const s of list) {
      const active = s.id === S.sessionId ? ' active' : '';
      html += `<div class="sess-item${active}" data-id="${esc(s.id)}">
        <div class="sess-body">
          <div class="sess-title">${esc(s.title || '新会话')}</div>
          <div class="sess-sub">${esc(s.model || '')} · ${fmtTime(s.updatedAt)}</div>
        </div>
        <button class="sess-del" data-del="${esc(s.id)}" title="删除">
          <svg><use href="#i-trash"/></svg>
        </button>
      </div>`;
    }
  }
  box.innerHTML = html;
}

export async function refreshSessions() {
  try {
    const { sessions } = await API.listSessions();
    S.sessions = sessions;
    renderSessions();
  } catch (e) {
    console.error(e);
  }
}

export async function openSession(id) {
  if (S.streaming) {
    toast('正在生成中，先停止再切换会话', 'err');
    return;
  }
  try {
    const { session } = await API.getSession(id);
    S.session = session;
    S.sessionId = session.id;
    // 工作区是全局设置，以 config 为准（避免老会话带着旧路径）
    S.workspace = S.config?.settings?.workspace || session.workspace;
    S.promptId = session.promptId;
    S.providerId = session.providerId;
    S.model = session.model;
    S.usage = session.usage || { promptTokens: 0, completionTokens: 0 };

    $('#sessionTitle').value = session.title;
    $('#sessionSub').textContent = session.model || '';
    history.replaceState(null, '', '#' + id);

    renderSession(session);
    renderSessions();
    document.dispatchEvent(new CustomEvent('awes:session-changed', { detail: session }));
  } catch (e) {
    toast('打开会话失败：' + e.message, 'err');
  }
}

/* ---------------- 会话操作 ---------------- */

function showCtxMenu(x, y, items) {
  document.querySelector('.ctx-menu')?.remove();
  const menu = el('div', 'ctx-menu');
  menu.innerHTML = items
    .map((it, i) =>
      it.sep
        ? '<div class="menu-sep"></div>'
        : `<div class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}">${esc(it.label)}</div>`
    )
    .join('');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';

  menu.addEventListener('click', (e) => {
    const i = e.target.dataset.i;
    if (i == null) return;
    menu.remove();
    items[Number(i)].run?.();
  });
  const onDown = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', onDown);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
}

async function renameSession(id, oldTitle) {
  const t = await promptDialog('重命名会话', oldTitle || '', '新的名称');
  if (!t || !t.trim()) return;
  try {
    await API.patchSession(id, { title: t.trim() });
    if (S.sessionId === id) $('#sessionTitle').value = t.trim();
    await refreshSessions();
    toast('已重命名', 'ok');
  } catch (e) {
    toast('重命名失败：' + e.message, 'err');
  }
}

async function clearSessionMessages(id) {
  const ok = await confirmDialog('清空对话', '清空这个会话的所有消息？会话本身会保留。', {
    okText: '清空',
    danger: true,
  });
  if (!ok) return;
  try {
    await API.truncate(id, 0);
    if (S.sessionId === id) {
      const { session } = await API.getSession(id);
      S.session = session;
      S.usage = session.usage || { promptTokens: 0, completionTokens: 0 };
      const mod = await import('./chat.js');
      mod.renderSession(session);
    }
    await refreshSessions();
    toast('对话已清空', 'ok');
  } catch (e) {
    toast('清空失败：' + e.message, 'err');
  }
}

async function removeSession(id) {
  const ok = await confirmDialog('删除会话', '删除后不可恢复，确定吗？', { okText: '删除', danger: true });
  if (!ok) return;
  try {
    await API.deleteSession(id);
    if (S.sessionId === id) {
      const mod = await import('./chat.js');
      mod.newSessionUI();
    }
    await refreshSessions();
    toast('已删除', 'ok');
  } catch (e) {
    toast('删除失败：' + e.message, 'err');
  }
}

export function initSidebar() {
  initClock();
  $('#sessionList').addEventListener('click', async (e) => {
    const del = e.target.closest('.sess-del');
    if (del) {
      e.stopPropagation();
      await removeSession(del.dataset.del);
      return;
    }
    const item = e.target.closest('.sess-item');
    if (item) openSession(item.dataset.id);
  });

  // 右键：重命名 / 导出 / 清空 / 删除
  $('#sessionList').addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.sess-item');
    if (!item) return;
    e.preventDefault();
    const id = item.dataset.id;
    const s = S.sessions.find((x) => x.id === id);
    showCtxMenu(e.clientX, e.clientY, [
      { label: '重命名', run: () => renameSession(id, s?.title) },
      {
        label: '导出为 Markdown',
        run: () => window.open('/api/export?sessionId=' + encodeURIComponent(id), '_blank'),
      },
      { label: '清空对话', run: () => clearSessionMessages(id) },
      { sep: true },
      { label: '删除会话', danger: true, run: () => removeSession(id) },
    ]);
  });

  // 侧栏 tab
  $('#sideTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    S.sideTab = b.dataset.tab;
    for (const x of $('#sideTabs').children) x.classList.toggle('active', x === b);
    $('#panelSessions').classList.toggle('hidden', S.sideTab !== 'sessions');
    $('#panelFiles').classList.toggle('hidden', S.sideTab !== 'files');
    if (S.sideTab === 'files') loadTree();
  });

  $('#wsApply').addEventListener('click', () => {
    const p = $('#wsPath').value.trim();
    if (!p) return;
    applyWorkspace(p);
  });

  $('#wsApp').addEventListener('click', async () => {
    const ws = S.config?.settings?.workspace;
    // 当前工作区在 C 盘（或没设置）时，自动跳去空闲最多的盘
    if (!ws || /^C:/i.test(ws)) {
      try {
        const r = await API.disks();
        if (r.suggested) {
          applyWorkspace(r.suggested);
          toast(`已切到 ${r.suggested}（空闲最多的盘）`, 'ok');
          return;
        }
      } catch {}
      if (!ws) return toast('还没有设置工作区', 'err');
    }
    applyWorkspace(ws);
  });

  $('#wsPath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#wsApply').click();
  });
}

async function applyWorkspace(dir) {
  try {
    const r = await API.setWorkspace(dir);
    S.workspace = r.workspace;
    $('#wsPath').value = r.workspace;
    updateWsLabel();
    await loadTree();
    if (S.sessionId) {
      await API.patchSession(S.sessionId, { workspace: r.workspace });
      if (S.session) S.session.workspace = r.workspace;
    }
    toast(r.created ? `已新建并切换：${r.workspace}` : `已切换到 ${r.workspace}`, 'ok');
    document.dispatchEvent(new CustomEvent('awes:workspace-changed', { detail: r.workspace }));
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- 文件树 ---------------- */
let treeLoading = false;

export async function loadTree(silent = false) {
  if (treeLoading) return;
  treeLoading = true;
  const box = $('#fileTree');
  if (!silent) box.innerHTML = '<div class="side-empty">加载中…</div>';
  try {
    const { tree } = await API.tree(S.workspace);
    box.innerHTML = '';
    if (!tree.length) {
      box.innerHTML = '<div class="side-empty">这个目录是空的</div>';
    } else {
      for (const node of tree) box.appendChild(renderNode(node, 1));
    }
  } catch (e) {
    box.innerHTML = `<div class="side-empty">读取失败：${esc(e.message)}</div>`;
  } finally {
    treeLoading = false;
  }
}

/** 模型写完文件后，文件树跟着更新（只在文件页可见时） */
export function refreshTreeIfVisible() {
  if (S.sideTab === 'files') loadTree(true);
}

function renderNode(node, depth) {
  const wrap = el('div', 'tree-node');
  wrap.dataset.path = node.path;

  const isDir = node.type === 'dir';
  const open = isDir && depth <= 2 && node.children?.length;
  if (open) wrap.classList.add('open');

  const row = el('div', 'tree-row');
  row.innerHTML = `
    ${isDir ? '<svg class="tree-caret"><use href="#i-chev"/></svg>' : '<span style="width:13px;flex:none"></span>'}
    <svg class="tree-file-icon"><use href="#${isDir ? 'i-folder' : 'i-file'}"/></svg>
    <span class="tree-name">${esc(node.name)}</span>`;
  wrap.appendChild(row);

  if (isDir) {
    const children = el('div', 'tree-children');
    if (node.children?.length) {
      for (const c of node.children) children.appendChild(renderNode(c, depth + 1));
    }
    wrap.appendChild(children);

    row.addEventListener('click', async () => {
      const isOpen = wrap.classList.toggle('open');
      if (isOpen && !children.childElementCount) {
        children.innerHTML = '<div class="tree-row" style="color:var(--text-3)">加载中…</div>';
        try {
          const { tree } = await API.tree(S.workspace, node.path);
          children.innerHTML = '';
          for (const c of tree) children.appendChild(renderNode(c, depth + 1));
        } catch (e) {
          children.innerHTML = `<div class="tree-row" style="color:var(--err)">${esc(e.message)}</div>`;
        }
      }
    });
  } else {
    row.addEventListener('click', () => previewFile(node.path));
  }
  return wrap;
}

export async function previewFile(path) {
  $('#fileTitle').textContent = path;
  $('#filePreview').textContent = '加载中…';
  $('#fileMask').classList.add('open');
  try {
    const { content } = await API.file(S.workspace, path);
    $('#filePreview').textContent = content;
  } catch (e) {
    $('#filePreview').textContent = '读取失败：' + e.message;
  }
}

export function updateWsLabel() {
  const short = String(S.workspace || '').split(/[\\/]/).filter(Boolean).pop() || '未设置';
  $('#wsLabel').textContent = short;
  $('#wsPath').value = S.workspace || '';
  $('#wsLabel').parentElement.title = S.workspace || '';
}

/* ---------------- 文件引用列表（@ 用） ---------------- */
export async function listAllFiles() {
  const out = [];
  async function walk(path, depth) {
    if (depth > 3 || out.length > 500) return;
    try {
      const { tree } = await API.tree(S.workspace, path);
      for (const n of tree) {
        if (n.type === 'file') out.push(n.path);
        else if (depth < 3) await walk(n.path, depth + 1);
      }
    } catch {}
  }
  await walk('.', 0);
  return out;
}
