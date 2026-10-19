import { S, $, el, esc, copyText, toast, fmtNum, estimateTokens } from './store.js';
import { renderMarkdown } from './markdown.js';
import { streamChat, API } from './api.js';
import { confirmDialog } from './ui-dialog.js';

const toolCards = new Map(); // toolId -> { root, statusEl, outEl, argsEl }
let cur = null; // 当前流式 assistant 块
let renderQueued = false;
let followBottom = true;

/* ---------------- 滚动 ---------------- */
export function initScroll() {
  const box = $('#messages');
  box.addEventListener('scroll', () => {
    const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
    followBottom = gap < 140;
    $('#btnJumpLatest')?.classList.toggle('show', gap > 420);
  });
  $('#btnJumpLatest')?.addEventListener('click', () => {
    followBottom = true;
    scrollToBottom(true);
  });
}

/* ---------------- 消息操作：重试 / 删除 / 编辑 ---------------- */

/**
 * 用 DOM 位置反推消息下标。
 * 不依赖 data-idx（流式渲染的节点可能没有），每次操作前先拉最新会话再对齐，最可靠。
 */
async function resolveIndex(node) {
  const msgEl = node?.closest?.('.msg');
  if (!msgEl) return -1;
  const all = [...$('#msgList').children].filter((n) => n.classList.contains('msg'));
  const pos = all.indexOf(msgEl);
  if (pos < 0) return -1;
  if (!S.sessionId) return -1;

  try {
    const { session } = await API.getSession(S.sessionId);
    S.session = session;
  } catch {
    return -1;
  }

  const msgs = S.session.messages || [];
  let count = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'tool') continue;
    count++;
    if (count === pos) return i;
  }
  return -1;
}

function findUserBefore(idx) {
  const msgs = S.session?.messages || [];
  for (let i = Math.min(idx, msgs.length - 1); i >= 0; i--) {
    if (msgs[i].role === 'user') return i;
  }
  return -1;
}

async function truncateTo(index) {
  const { session } = await API.truncate(S.sessionId, index);
  S.session = session;
  S.usage = session.usage || { promptTokens: 0, completionTokens: 0 };
  renderSession(session);
  updateMeta();
  return session;
}

async function retryAt(node) {
  if (S.streaming) return toast('正在生成中，先停止再重试', 'err');
  const idx = await resolveIndex(node);
  if (idx < 0) return toast('定位不到这条消息，刷新页面试试', 'err');
  const u = findUserBefore(idx);
  if (u < 0) return toast('这条消息前面没有你的提问，没法重试', 'err');
  const text = S.session.messages[u].content;
  await truncateTo(u);
  await send(text);
}

async function deleteRoundAt(node) {
  if (S.streaming) return toast('正在生成中，先停止再删除', 'err');
  const idx = await resolveIndex(node);
  if (idx < 0) return toast('定位不到这条消息，刷新页面试试', 'err');
  const u = findUserBefore(idx);
  if (u < 0) return toast('这条消息前面没有你的提问', 'err');
  await truncateTo(u);
  toast('已删除这一轮', 'ok');
}

async function editUserAt(node) {
  if (S.streaming) return toast('正在生成中，先停止再编辑', 'err');
  const idx = await resolveIndex(node);
  if (idx < 0) return toast('定位不到这条消息，刷新页面试试', 'err');
  const m = S.session.messages[idx];
  if (!m || m.role !== 'user') return toast('只能编辑你自己的消息', 'err');
  const text = m.content;
  await truncateTo(idx);
  const input = $('#input');
  input.value = text;
  autoGrow(input);
  updateMeta();
  input.focus();
  toast('已放回输入框，改完再发');
}

export async function clearCurrentSession() {
  if (!S.sessionId) return toast('当前没有打开的会话', '');
  if (S.streaming) return toast('正在生成中，先停止', 'err');
  const ok = await confirmDialog('清空对话', '清空当前会话的全部消息？会话本身会保留。', {
    okText: '清空',
    danger: true,
  });
  if (!ok) return;
  try {
    await truncateTo(0);
    toast('对话已清空', 'ok');
  } catch (e) {
    toast('清空失败：' + e.message, 'err');
  }
}

let lastScrollAt = 0;
function scrollToBottom(force = false) {
  if (!followBottom && !force) return;
  const box = $('#messages');
  const target = box.scrollHeight - box.clientHeight;
  if (target <= 0) return;
  // 流式跟随必须用即时滚动：scheduleRender 每帧都会调这里，
  // 用 behavior:smooth 会不停打断上一次动画，滚动永远停在起步阶段，看起来就是卡。
  // 每帧设一次 scrollTop 本身就是连续跟随，不需要缓动。
  if (force) {
    box.scrollTo({ top: target, behavior: 'smooth' });
    lastScrollAt = Date.now();
    return;
  }
  box.scrollTop = target;
  lastScrollAt = Date.now();
}

/* ---------------- 欢迎页 ---------------- */
const STARTERS = [
  { t: '读懂一个项目', d: '扫描工作区结构，说清它是干什么的、从哪读起', p: '先看一遍工作区的目录结构，判断这是什么项目、用什么技术栈，然后告诉我应该从哪几个文件开始读，并给出关键模块的职责说明。' },
  { t: '写个小工具', d: '描述需求，让 Agent 直接落地成可运行脚本', p: '在这个工作区里写一个 Python 脚本，功能是：批量把指定目录下的图片按拍摄时间重命名。要有参数说明、异常处理和用法示例。' },
  { t: '代码审查', d: '找出真实缺陷，按严重程度排序', p: '审查当前工作区的主要代码，找出正确性、边界条件和安全方面的问题。按严重程度排序，每个问题给出文件行号、原因和修改建议。' },
  { t: '整理待办', d: '扫代码里的 TODO，汇总成一份清单', p: '搜索整个工作区里所有 TODO / FIXME 注释，整理成一份清单，标注文件位置和大致工作量。' },
];

export function renderStarters() {
  const grid = $('#starterGrid');
  if (!grid || grid.dataset.done) return;
  grid.dataset.done = '1';
  grid.innerHTML = STARTERS.map(
    (s, i) => `<div class="starter" data-i="${i}"><b>${esc(s.t)}</b><span>${esc(s.d)}</span></div>`
  ).join('');
  grid.addEventListener('click', (e) => {
    const c = e.target.closest('.starter');
    if (!c) return;
    const input = $('#input');
    input.value = STARTERS[Number(c.dataset.i)].p;
    input.focus();
    autoGrow(input);
    updateMeta();
  });
}

/* ---------------- 历史消息渲染 ---------------- */
export function renderSession(session) {
  toolCards.clear();
  cur = null;
  const list = $('#msgList');
  list.innerHTML = '';
  const welcome = $('#welcome');

  const msgs = session?.messages || [];
  if (!msgs.length) {
    welcome.classList.remove('hidden');
    renderStarters();
    updateMeta();
    return;
  }
  welcome.classList.add('hidden');

  let lastAssistant = null;
  msgs.forEach((m, idx) => {
    if (m.role === 'user') {
      appendUser(m.content, idx);
    } else if (m.role === 'assistant') {
      lastAssistant = appendAssistantBlock(m, idx);
    } else if (m.role === 'tool') {
      const card = toolCards.get(m.tool_call_id);
      if (card) {
        updateToolCard(card, {
          ok: m.toolMeta?.ok ?? !String(m.content).startsWith('ERROR'),
          output: String(m.content).replace(/^(OK|ERROR)\n?/, ''),
          name: m.toolMeta?.name || m.name,
          args: m.toolMeta?.args,
          final: true,
        });
      }
    }
  });
  updateMeta();
  setTimeout(() => {
    followBottom = true;
    scrollToBottom(true);
  }, 30);
}

function appendUser(text, idx) {
  $('#welcome').classList.add('hidden');
  const node = el('div', 'msg msg-user');
  node.dataset.idx = idx ?? '';
  node.innerHTML = `
    <div class="user-tools">
      <button class="act-btn edit-msg" title="编辑后重发">编辑</button>
      <button class="act-btn copy-msg" title="复制">复制</button>
    </div>
    <div class="bubble">${esc(text)}</div>`;
  $('#msgList').appendChild(node);
  scrollToBottom();
  return node;
}

function appendAssistantBlock(m, idx) {
  const node = el('div', 'msg msg-assistant');
  node.dataset.idx = idx ?? '';
  node.innerHTML = `
    <div class="avatar">A</div>
    <div class="msg-body">
      ${m.reasoning ? reasoningHtml(m.reasoning) : ''}
      <div class="md"></div>
      <div class="tools"></div>
      <div class="msg-actions">
        <button class="act-btn copy-msg"><svg><use href="#i-copy"/></svg>复制</button>
        <button class="act-btn retry-msg" title="重新生成这一轮"><svg><use href="#i-spark"/></svg>重试</button>
        <button class="act-btn del-msg" title="删除这一轮"><svg><use href="#i-trash"/></svg>删除</button>
      </div>
    </div>`;
  const md = $('.md', node);
  md.innerHTML = renderMarkdown(m.content || '');
  node.dataset.text = m.content || '';

  const toolsWrap = $('.tools', node);
  for (const tc of m.tool_calls || []) {
    const card = createToolCard(tc.id, tc.function?.name, safeParse(tc.function?.arguments));
    toolsWrap.appendChild(card.root);
  }
  $('#msgList').appendChild(node);
  scrollToBottom();
  return node;
}

function reasoningHtml(text) {
  return `<div class="reasoning">
    <div class="reasoning-head"><svg><use href="#i-chev"/></svg><span>思考过程 · ${fmtNum(estimateTokens(text))} tokens</span></div>
    <div class="reasoning-body"><div class="fold-inner"><div class="reasoning-text">${esc(text)}</div></div></div>
  </div>`;
}

function safeParse(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/* ---------------- 工具卡片 ---------------- */
function argSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  switch (name) {
    case 'read_file':
      return args.path + (args.offset ? ` :${args.offset}` : '');
    case 'write_file':
      return args.path;
    case 'edit_file':
      return args.path;
    case 'list_dir':
      return args.path || '.';
    case 'glob':
      return args.pattern;
    case 'grep':
      return '/' + (args.pattern || '') + '/';
    case 'run_command':
      return args.command;
    case 'todo_write':
      return (args.todos || []).length + ' 项';
    default:
      return JSON.stringify(args).slice(0, 80);
  }
}

function createToolCard(id, name, args) {
  if (name === 'todo_write') {
    const root = el('div', 'todo-card');
    root.innerHTML = `<div class="todo-title">执行计划</div>` + todoItemsHtml(args?.todos || []);
    const card = { root, isTodo: true };
    toolCards.set(id, card);
    return card;
  }

  const root = el('div', 'tool-card running');
  root.innerHTML = `
    <div class="tool-head">
      <div class="tool-ico"><svg><use href="#i-tool"/></svg></div>
      <span class="tool-name">${esc(name || 'tool')}</span>
      <span class="tool-arg">${esc(argSummary(name, args))}</span>
      <span class="tool-status run"><span class="spinner"></span></span>
    </div>
    <div class="tool-body"><div class="fold-inner">
      <pre class="tool-args-block">${esc(JSON.stringify(args || {}, null, 2))}</pre>
      <pre class="tool-out">执行中…</pre>
    </div></div>`;
  const card = {
    root,
    statusEl: $('.tool-status', root),
    outEl: $('.tool-out', root),
    argsEl: $('.tool-args-block', root),
  };
  toolCards.set(id, card);
  return card;
}

function todoItemsHtml(todos) {
  return (todos || [])
    .map((t) => {
      const done = t.status === 'completed';
      const active = t.status === 'in_progress';
      return `<div class="todo-item ${done ? 'done' : active ? 'active' : ''}">
        <span class="box">${done ? '<svg><use href="#i-check"/></svg>' : ''}</span>
        <span>${esc(t.content)}</span>
      </div>`;
    })
    .join('');
}

function updateToolCard(card, { ok, output, args, name, final }) {
  if (card.isTodo) {
    if (args?.todos) card.root.innerHTML = `<div class="todo-title">执行计划</div>` + todoItemsHtml(args.todos);
    return;
  }
  card.root.classList.remove('running');
  if (!ok) card.root.classList.add('err');
  if (args) card.argsEl.textContent = JSON.stringify(args, null, 2);
  if (output != null) card.outEl.textContent = output || '(无输出)';

  const status = card.statusEl;
  if (final) {
    status.className = 'tool-status ' + (ok ? 'ok' : 'err');
    status.innerHTML = ok
      ? '<svg style="width:11px;height:11px"><use href="#i-check"/></svg>完成'
      : '失败';
  }
}

/* ---------------- 流式渲染 ---------------- */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!cur) return;
    // 跟着刷新率走（rAF），不人为限帧。
    // 之前为了省开销限到 55ms（约 18fps），反而让出字看起来一顿一顿的。
    cur.mdEl.innerHTML = renderMarkdown(cur.text) + '<span class="cursor-blink"></span>';
    if (cur.reasonEl) {
      cur.reasonBody.textContent = cur.reasoning;
      const label = cur.reasonEl.querySelector('.reasoning-head span');
      if (label) label.textContent = `思考过程 · ${fmtNum(estimateTokens(cur.reasoning))} tokens`;
    }
    scrollToBottom();
  });
}

function ensureAssistant(id) {
  if (cur && cur.id === id) return cur;
  $('#welcome').classList.add('hidden');

  const node = el('div', 'msg msg-assistant');
  node.innerHTML = `
    <div class="avatar">A</div>
    <div class="msg-body">
      <div class="reason-slot"></div>
      <div class="md"><span class="cursor-blink"></span></div>
      <div class="tools"></div>
      <div class="msg-actions">
        <button class="act-btn copy-msg"><svg><use href="#i-copy"/></svg>复制</button>
        <button class="act-btn retry-msg" title="重新生成这一轮"><svg><use href="#i-spark"/></svg>重试</button>
        <button class="act-btn del-msg" title="删除这一轮"><svg><use href="#i-trash"/></svg>删除</button>
      </div>
    </div>`;
  $('#msgList').appendChild(node);

  cur = {
    id,
    node,
    mdEl: $('.md', node),
    toolsEl: $('.tools', node),
    reasonSlot: $('.reason-slot', node),
    text: '',
    reasoning: '',
    reasonEl: null,
    reasonBody: null,
  };
  scrollToBottom();
  return cur;
}

/* ---------------- 发送 ---------------- */
export async function send(text) {
  if (S.streaming) return;
  const content = String(text || '').trim();
  if (!content) return;

  const provider = S.config?.providers?.find((p) => p.id === S.providerId);
  if (!provider?.baseURL) {
    toast('当前模型没配置 API 地址，先去设置里填一下', 'err');
    openSettings('api');
    return;
  }

  appendUser(content);
  const input = $('#input');
  input.value = '';
  autoGrow(input);
  updateMeta();

  S.streaming = true;
  setStreamingUI(true);
  cur = null;
  toolCards.clear();
  const controller = new AbortController();
  S.abort = controller;

  const payload = {
    sessionId: S.sessionId,
    text: content,
    providerId: S.providerId,
    model: S.model,
    promptId: S.promptId,
    params: S.params,
  };

  let gotError = false;

  try {
    await streamChat(
      payload,
      (ev) => handleEvent(ev),
      controller.signal
    );
  } catch (e) {
    if (e.name === 'AbortError') {
      appendNotice('已停止生成。');
    } else {
      gotError = true;
      appendNotice('请求失败：' + e.message, 'err');
    }
  } finally {
    S.streaming = false;
    S.abort = null;
    setStreamingUI(false);
    if (cur) {
      cur.mdEl.innerHTML = renderMarkdown(cur.text);
      cur = null;
    }
    await refreshSessionsQuiet();
    syncSessionIndices();
    if (!gotError) setTimeout(() => scrollToBottom(), 50);
  }
}

/** 流式结束后把 S.session 和 DOM 上的 data-idx 对齐，保证「重试/编辑」指向正确的消息 */
async function syncSessionIndices() {
  if (!S.sessionId) return;
  try {
    const { session } = await API.getSession(S.sessionId);
    S.session = session;
    const nodes = [...$('#msgList').children].filter((n) => n.classList.contains('msg'));
    let mi = 0;
    for (const n of nodes) {
      while (mi < session.messages.length && session.messages[mi].role === 'tool') mi++;
      if (mi >= session.messages.length) break;
      n.dataset.idx = mi;
      mi++;
    }
  } catch {}
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'session': {
      S.sessionId = ev.session.id;
      if (!$('#sessionTitle').matches(':focus')) {
        $('#sessionTitle').value = ev.session.title;
      }
      history.replaceState(null, '', '#' + ev.session.id);
      break;
    }
    case 'delta': {
      const a = ensureAssistant(ev.id);
      a.text += ev.text;
      scheduleRender();
      break;
    }
    case 'reasoning': {
      const a = ensureAssistant(ev.id);
      a.reasoning += ev.text;
      if (!a.reasonEl) {
        a.reasonSlot.innerHTML = reasoningHtml('');
        a.reasonEl = $('.reasoning', a.reasonSlot);
        a.reasonEl.classList.add('open');
        a.reasonBody = $('.reasoning-text', a.reasonEl);
      }
      scheduleRender();
      break;
    }
    case 'tool_start': {
      const a = ensureAssistant(ev.messageId || (cur && cur.id) || 'x');
      const card = createToolCard(ev.id, ev.name, ev.args);
      a.toolsEl.appendChild(card.root);
      scrollToBottom();
      break;
    }
    case 'tool_end': {
      const card = toolCards.get(ev.id);
      if (card) {
        updateToolCard(card, { ok: ev.ok, output: ev.output, args: ev.args, name: ev.name, final: true });
      }
      // 模型改了文件，左侧文件树跟着刷新
      if (ev.ok && (ev.name === 'write_file' || ev.name === 'edit_file')) {
        import('./sidebar.js').then((m) => m.refreshTreeIfVisible()).catch(() => {});
      }
      break;
    }
    case 'notice': {
      appendNotice(ev.text, ev.level === 'warn' ? '' : ev.level);
      break;
    }
    case 'usage': {
      S.usage = ev.usage;
      updateMeta();
      break;
    }
    case 'confirm_request': {
      showConfirm(ev);
      break;
    }
    case 'error': {
      appendNotice(ev.message, 'err');
      break;
    }
    case 'aborted': {
      appendNotice('已停止生成。');
      break;
    }
    case 'assistant_done': {
      if (cur && ev.message?.id === cur.id) {
        cur.mdEl.innerHTML = renderMarkdown(cur.text);
      }
      break;
    }
    case 'turn_done':
    case 'done': {
      if (cur) cur.mdEl.innerHTML = renderMarkdown(cur.text);
      break;
    }
  }
}

function appendNotice(text, kind = '') {
  const node = el('div', 'notice ' + (kind === 'err' ? 'err' : ''), esc(text));
  const list = $('#msgList');
  // 挂在当前 assistant 的工具区末尾，视觉上更贴合
  if (cur) cur.toolsEl.appendChild(node);
  else list.appendChild(node);
  scrollToBottom();
}

/* ---------------- 确认框 ---------------- */
function showConfirm(ev) {
  S.pendingConfirm = ev.token;
  $('#confirmTool').textContent = ev.name;
  $('#confirmArgs').textContent = JSON.stringify(ev.args || {}, null, 2);
  $('#confirmMask').classList.add('open');
  setTimeout(() => $('#btnConfirmYes').focus(), 50);
}

export function initConfirm() {
  const close = async (allow) => {
    const token = S.pendingConfirm;
    S.pendingConfirm = null;
    $('#confirmMask').classList.remove('open');
    if (token) {
      try {
        await API.confirm(token, allow);
      } catch {}
    }
    if (!allow) appendNotice('你拒绝了这次操作，Agent 会换一种方式。');
  };
  $('#btnConfirmYes').addEventListener('click', () => close(true));
  $('#btnConfirmNo').addEventListener('click', () => close(false));
}

/* ---------------- UI 状态 ---------------- */
export function setStreamingUI(on) {
  const btn = $('#btnSend');
  btn.classList.toggle('stop', on);
  btn.innerHTML = on ? '<svg><use href="#i-stop"/></svg>' : '<svg><use href="#i-send"/></svg>';
  btn.title = on ? '停止' : '发送';
  $('#composerHint').textContent = on ? 'Agent 正在工作… 点击右侧按钮可中断' : '';
}

export function updateMeta() {
  const input = $('#input');
  const t = estimateTokens(input?.value || '');
  const total = (S.usage?.promptTokens || 0) + (S.usage?.completionTokens || 0);
  const parts = [];
  const prov = S.config?.providers?.find((p) => p.id === S.providerId);
  if (prov?.free) parts.push('免费通道 · 30秒/次');
  if (t) parts.push(`输入 ~${fmtNum(t)}`);
  if (total) parts.push(`本会话 ${fmtNum(total)} tokens`);
  $('#ctxMeta').textContent = parts.join(' · ');
}

export function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(240, ta.scrollHeight) + 'px';
}

async function refreshSessionsQuiet() {
  try {
    const { sessions } = await API.listSessions();
    S.sessions = sessions;
    const mod = await import('./sidebar.js');
    mod.renderSessions();
  } catch {}
}

/* ---------------- 事件绑定（消息区） ---------------- */
export function initChatEvents() {
  document.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('.code-copy');
    if (copyBtn) {
      const pre = copyBtn.closest('.code-block')?.querySelector('pre code');
      if (pre) {
        const ok = await copyText(pre.textContent);
        copyBtn.innerHTML = ok ? '<svg><use href="#i-check"/></svg>已复制' : '复制失败';
        setTimeout(() => (copyBtn.innerHTML = '<svg><use href="#i-copy"/></svg>复制'), 1400);
      }
      return;
    }
    const msgCopy = e.target.closest('.copy-msg');
    if (msgCopy) {
      const body = msgCopy.closest('.msg-body');
      const bubble = msgCopy.closest('.msg-user')?.querySelector('.bubble');
      const text = body?.querySelector('.md')?.textContent || bubble?.textContent || '';
      const ok = await copyText(text);
      if (ok) toast('已复制', 'ok');
      return;
    }
    const retryBtn = e.target.closest('.retry-msg');
    if (retryBtn) {
      try {
        await retryAt(retryBtn);
      } catch (err) {
        toast('重试失败：' + err.message, 'err');
      }
      return;
    }
    const delBtn = e.target.closest('.del-msg');
    if (delBtn) {
      try {
        await deleteRoundAt(delBtn);
      } catch (err) {
        toast('删除失败：' + err.message, 'err');
      }
      return;
    }
    const editBtn = e.target.closest('.edit-msg');
    if (editBtn) {
      try {
        await editUserAt(editBtn);
      } catch (err) {
        toast('编辑失败：' + err.message, 'err');
      }
      return;
    }
    const toolHead = e.target.closest('.tool-head');
    if (toolHead) {
      toggleFold(toolHead.closest('.tool-card'));
      return;
    }
    const reasonHead = e.target.closest('.reasoning-head');
    if (reasonHead) {
      toggleFold(reasonHead.closest('.reasoning'));
      return;
    }
  });
}

/**
 * 折叠展开。
 * 展开：高度直接到位，框做 opacity/transform 动画（合成层，不重排）。
 * 收起：先让框淡出 110ms，再把高度归零，避免「啪一下消失」。
 */
function toggleFold(card) {
  clearTimeout(card._foldTimer);
  if (card.classList.contains('open')) {
    card.classList.add('closing');
    card._foldTimer = setTimeout(() => card.classList.remove('open', 'closing'), 110);
  } else {
    card.classList.remove('closing');
    card.classList.add('open');
  }
}

export function newSessionUI() {
  S.sessionId = null;
  S.session = null;
  S.usage = { promptTokens: 0, completionTokens: 0 };
  cur = null;
  toolCards.clear();
  $('#msgList').innerHTML = '';
  $('#welcome').classList.remove('hidden');
  $('#sessionTitle').value = '新会话';
  $('#sessionSub').textContent = '';
  history.replaceState(null, '', location.pathname);
  updateMeta();
  renderStarters();
  const mod = import('./sidebar.js');
  mod.then((m) => m.renderSessions());
}
