import { S, $, $$, el, esc, toast, fmtNum, estimateTokens, debounce, copyText } from './store.js';
import { API } from './api.js';
import {
  send, renderSession, initScroll, initChatEvents, initConfirm,
  setStreamingUI, updateMeta, autoGrow, newSessionUI, renderStarters,
} from './chat.js';
import { initSidebar, refreshSessions, renderSessions, openSession, loadTree, updateWsLabel, listAllFiles } from './sidebar.js';
import {
  initInspector, reloadPrompts, loadPromptIntoEditor, renderPromptMenu,
  renderToolList, syncParamsUI, renderModeSwitch, initModeSwitch,
} from './inspector.js';
import { initSettings, initTheme, openSettings } from './settings.js';

/* ================= 顶栏 ================= */
function updateTopbarLabels() {
  const p = S.config?.providers?.find((x) => x.id === S.providerId);
  const modelLabel = S.model || '未选择模型';
  $('#modelLabel').textContent = modelLabel;
  $('#modelLabel').title = `${p?.name || ''} / ${modelLabel}`;
  $('#modelDot').classList.toggle('off', !p?.hasKey && !/127\.0\.0\.1|localhost/.test(p?.baseURL || ''));

  const tpl = S.prompts.find((x) => x.id === S.promptId);
  $('#promptLabel').textContent = tpl?.name || '未选择';

  $('#sessionSub').textContent = p
    ? `${p.name}${p.free ? ' · 30秒/次' : ''} · ${modelLabel}`
    : '';
  $('#input').placeholder = `给 ${modelLabel} 说点什么…  Enter 发送，@ 引用文件`;
}

function renderModelMenu() {
  const menu = $('#modelMenu');
  let html = '';
  for (const p of S.config?.providers || []) {
    if (!p.models?.length) {
      html += `<div class="menu-label">${esc(p.name)} · 还没有模型</div>
        <div class="menu-item" data-act="settings" style="color:var(--text-3)">
          <span style="opacity:.6">＋</span><span>去设置里加模型</span>
        </div>`;
      continue;
    }
    const tag = p.free ? ' · 无需 Key · 30秒/次' : p.hasKey ? '' : ' · 未配 Key';
    html += `<div class="menu-label">${esc(p.name)}${tag}</div>`;
    for (const m of p.models) {
      if (!m.id) continue;
      const active = p.id === S.providerId && m.id === S.model;
      html += `<div class="menu-item${active ? ' active' : ''}" data-pid="${esc(p.id)}" data-mid="${esc(m.id)}">
        <span>${esc(m.name || m.id)}</span>
        <span class="mi-sub">${p.free ? '免费' : esc(m.id)}</span>
      </div>`;
    }
    html += `<div class="menu-item fetch-models" data-pid="${esc(p.id)}" style="color:var(--text-3)">
      <span class="mi-sub" style="margin:0">⟳</span><span>获取可用模型</span>
    </div>`;
  }
  html += `<div class="menu-sep"></div>
    <div class="menu-item" data-act="settings"><span style="opacity:.7">⚙</span><span>管理模型与 API…</span></div>`;
  menu.innerHTML = html;
}

/** 从服务商实时拉模型列表 */
async function fetchModels(pid) {
  const menu = $('#modelMenu');
  menu.innerHTML = `<div class="menu-label">正在获取模型列表…</div>
    <div style="padding:4px 14px 12px;font-size:12px;color:var(--text-3)">需要等几秒</div>`;
  try {
    const r = await API.fetchModels({ providerId: pid, source: 'dropdown' });
    if (!r.ok) {
      menu.innerHTML = `<div class="menu-label" style="color:var(--err)">获取失败</div>
        <div style="padding:4px 14px 12px;font-size:12px;color:var(--text-2);line-height:1.6">
          ${esc(r.error)}<br>不是所有端点都开放模型列表，也可以手动添加。
        </div>`;
      return;
    }
    renderModelPicker(pid, r.models);
  } catch (e) {
    menu.innerHTML = `<div class="menu-label" style="color:var(--err)">${esc(e.message)}</div>`;
  }
}

function renderModelPicker(pid, models) {
  const menu = $('#modelMenu');
  const p = S.config.providers.find((x) => x.id === pid);
  if (!p) return;
  let html = `<div class="menu-label">${esc(p.name)} · 共 ${models.length} 个</div>`;
  for (const id of models.slice(0, 150)) {
    const has = (p.models || []).some((m) => m.id === id);
    const active = pid === S.providerId && id === S.model;
    html += `<div class="menu-item${active ? ' active' : ''} pick-model" data-pid="${esc(pid)}" data-mid="${esc(id)}">
      <span>${esc(id)}</span>
      ${has ? '<span class="mi-sub">已添加</span>' : ''}
    </div>`;
  }
  if (models.length > 150) html += `<div class="menu-label" style="opacity:.55">只显示前 150 个</div>`;
  menu.innerHTML = html;
}

/** 选中实时拉到的模型：没加过就加进去，然后切换过去 */
async function pickModel(pid, mid) {
  const p = S.config.providers.find((x) => x.id === pid);
  if (!p) return;
  let models = p.models || [];
  if (!models.some((m) => m.id === mid)) models = [...models, { id: mid, name: mid }];
  try {
    const r = await API.setActive(pid, mid, models);
    S.config = r.config;
    S.providerId = pid;
    S.model = mid;
    closeAllMenus();
    updateTopbarLabels();
    renderToolList();
    updateMeta();
    toast(`已切换到 ${mid}`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function bindTopbar() {
  const toggleMenu = (wrapSel, menuSel) => {
    const menu = $(menuSel);
    const wasOpen = menu.classList.contains('open');
    closeAllMenus();
    if (!wasOpen) menu.classList.add('open');
  };

  $('#btnModel').addEventListener('click', (e) => {
    e.stopPropagation();
    renderModelMenu();
    toggleMenu('#modelSelectWrap', '#modelMenu');
  });

  $('#btnPrompt').addEventListener('click', (e) => {
    e.stopPropagation();
    renderPromptMenu();
    toggleMenu('#promptSelectWrap', '#promptMenu');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.pill-select')) closeAllMenus();
  });

  $('#modelMenu').addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    // 必须阻止冒泡：否则 document 上那个监听器会把菜单关掉，
    // 「获取可用模型」渲染出来的列表就看不见了（表现为点了没反应）
    e.stopPropagation();
    if (item.dataset.act === 'settings') {
      closeAllMenus();
      openSettings('api');
      return;
    }
    // 这两个动作要保留菜单，不能先关掉
    if (item.classList.contains('fetch-models')) {
      await fetchModels(item.dataset.pid);
      return;
    }
    if (item.classList.contains('pick-model')) {
      await pickModel(item.dataset.pid, item.dataset.mid);
      return;
    }
    closeAllMenus();
    await switchModel(item.dataset.pid, item.dataset.mid);
  });

  $('#promptMenu').addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    closeAllMenus();
    const pid = item.dataset.pid;
    if (pid === '__edit__') {
      $('#app').classList.remove('no-inspector');
      $('#btnInspector').classList.add('active');
      S.inspectorTab = 'prompt';
      for (const x of $('#inspTabs').children) x.classList.toggle('active', x.dataset.tab === 'prompt');
      for (const pane of $$('.insp-pane')) pane.classList.toggle('hidden', pane.dataset.pane !== 'prompt');
      loadPromptIntoEditor(S.editingPrompt?.id || S.promptId);
      return;
    }
    await switchPrompt(pid);
  });

  $('#sessionTitle').addEventListener('change', async (e) => {
    const v = e.target.value.trim() || '未命名会话';
    if (!S.sessionId) return;
    try {
      await API.patchSession(S.sessionId, { title: v });
      await refreshSessions();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#sessionTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
  });

  $('#btnSidebar').addEventListener('click', () => {
    $('#app').classList.toggle('no-sidebar');
  });

  $('#btnNew').addEventListener('click', newSessionUI);

  $('#btnWorkspace').addEventListener('click', () => {
    S.sideTab = 'files';
    $('#app').classList.remove('no-sidebar');
    for (const x of $('#sideTabs').children) x.classList.toggle('active', x.dataset.tab === 'files');
    $('#panelSessions').classList.add('hidden');
    $('#panelFiles').classList.remove('hidden');
    loadTree();
    $('#wsPath').focus();
  });
}

function closeAllMenus() {
  $$('.menu').forEach((m) => m.classList.remove('open'));
}

async function switchModel(providerId, model) {
  S.providerId = providerId;
  S.model = model;
  try {
    await API.saveConfig({ active: { providerId, model } });
    if (S.sessionId) await API.patchSession(S.sessionId, { providerId, model });
    if (S.session) {
      S.session.providerId = providerId;
      S.session.model = model;
    }
  } catch (e) {
    toast(e.message, 'err');
  }
  updateTopbarLabels();
  renderToolList();
  toast(`已切换到 ${model}`, 'ok');
}

async function switchPrompt(promptId) {
  S.promptId = promptId;
  try {
    await API.saveConfig({ activePromptId: promptId });
    if (S.sessionId) await API.patchSession(S.sessionId, { promptId });
    if (S.session) S.session.promptId = promptId;
  } catch (e) {
    toast(e.message, 'err');
  }
  updateTopbarLabels();
  loadPromptIntoEditor(promptId);
  const t = S.prompts.find((x) => x.id === promptId);
  toast(`提示词：${t?.name || promptId}`, 'ok');
}

/* ================= 输入框 ================= */
let fileCache = null;
let fileCacheAt = 0;

function bindComposer() {
  const input = $('#input');

  input.addEventListener('input', () => {
    autoGrow(input);
    updateMeta();
    updateMention();
  });

  input.addEventListener('keydown', (e) => {
    const pop = $('#mentionPop');
    const open = pop.classList.contains('open');

    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        S.mentionIndex = Math.min(S.mentionItems.length - 1, S.mentionIndex + 1);
        paintMentionSel();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        S.mentionIndex = Math.max(0, S.mentionIndex - 1);
        paintMentionSel();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        pop.classList.remove('open');
        return;
      }
    }

    const sendOnEnter = S.config?.settings?.sendOnEnter !== false;
    if (e.key === 'Enter') {
      if (e.isComposing) return;
      if (sendOnEnter && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        doSend();
      } else if (!sendOnEnter && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doSend();
      }
    }
  });

  input.addEventListener('paste', () => setTimeout(() => autoGrow(input), 0));

  $('#btnSend').addEventListener('click', () => {
    if (S.streaming) stopGeneration();
    else doSend();
  });

  // 拖拽文件到输入框：插入路径提示
  const wrap = $('#composer');
  wrap.addEventListener('dragover', (e) => e.preventDefault());
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    const names = files.map((f) => f.name).join('、');
    input.value += (input.value ? '\n' : '') + `（拖入的文件：${names}，请把文件放到工作区后再引用路径）`;
    autoGrow(input);
    input.focus();
  });
}

async function doSend() {
  if (S.streaming) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  $('#mentionPop').classList.remove('open');
  await send(text);
}

async function stopGeneration() {
  if (!S.sessionId) return;
  try {
    await API.stop(S.sessionId);
    S.abort?.abort();
  } catch {}
}

/* ---- @ 引用 ---- */
async function ensureFileCache() {
  if (fileCache && Date.now() - fileCacheAt < 30000) return fileCache;
  try {
    fileCache = await listAllFiles();
    fileCacheAt = Date.now();
  } catch {
    fileCache = [];
  }
  return fileCache;
}

async function updateMention() {
  const input = $('#input');
  const before = input.value.slice(0, input.selectionStart);
  const m = before.match(/(?:^|\s)@([^\s@]*)$/);
  const pop = $('#mentionPop');

  if (!m) {
    pop.classList.remove('open');
    return;
  }

  const q = m[1].toLowerCase();
  const files = await ensureFileCache();
  const items = files.filter((f) => f.toLowerCase().includes(q)).slice(0, 12);
  if (!items.length) {
    pop.classList.remove('open');
    return;
  }

  S.mentionItems = items;
  S.mentionIndex = 0;
  pop.innerHTML = items
    .map(
      (f, i) => `<div class="mention-item${i === 0 ? ' sel' : ''}" data-path="${esc(f)}">
        <svg><use href="#i-file"/></svg><span>${esc(f)}</span>
      </div>`
    )
    .join('');
  pop.classList.add('open');
}

function paintMentionSel() {
  const items = $$('#mentionPop .mention-item');
  items.forEach((n, i) => n.classList.toggle('sel', i === S.mentionIndex));
  items[S.mentionIndex]?.scrollIntoView({ block: 'nearest' });
}

function pickMention() {
  const path = S.mentionItems[S.mentionIndex];
  if (!path) return;
  const input = $('#input');
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const after = input.value.slice(pos);
  const replaced = before.replace(/@([^\s@]*)$/, `@${path} `);
  input.value = replaced + after;
  input.selectionStart = input.selectionEnd = replaced.length;
  $('#mentionPop').classList.remove('open');
  input.focus();
  autoGrow(input);
  updateMeta();
}

/* ================= 快捷键 ================= */
function bindHotkeys() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newSessionUI();
    }
    if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      $('#app').classList.toggle('no-sidebar');
    }
    if (mod && e.key === ',') {
      e.preventDefault();
      openSettings('api');
    }
    if (e.key === 'Escape') {
      if ($('#settingsMask').classList.contains('open')) return;
      if ($('#fileMask').classList.contains('open')) {
        $('#fileMask').classList.remove('open');
        return;
      }
      if (S.streaming) stopGeneration();
    }
  });
}

/* ================= 热更新 ================= */
let cssToastAt = 0;

function initLiveReload() {
  if (!window.EventSource) return;
  const es = new EventSource('/api/watch');
  es.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data.type !== 'change') return;
    handleFileChange(data.files || []);
  };
  // 断线由浏览器自动重连，无需处理
}

function handleFileChange(files) {
  const css = files.filter((f) => f.toLowerCase().endsWith('.css'));
  const markup = files.filter((f) => /\.(html?|js|mjs)$/i.test(f));

  // 样式：直接换掉 <link>，不刷新、不丢状态，颜色立刻变
  if (css.length) {
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const u = new URL(link.href, location.origin);
      u.searchParams.set('v', Date.now());
      link.href = u.pathname + u.search;
    }
    if (Date.now() - cssToastAt > 1200) {
      cssToastAt = Date.now();
      toast('样式已实时更新', 'ok');
    }
  }

  // 结构/逻辑：刷新会中断对话，交给用户决定时机
  if (markup.length) {
    $('#reloadText').textContent = '界面结构有更新，刷新后生效';
    $('#reloadBar').classList.add('show');
  }
}

/* ================= 首次引导 ================= */
function fmtGB(n) {
  if (!n) return '0 GB';
  const gb = n / 1024 ** 3;
  return gb >= 1 ? gb.toFixed(0) + ' GB' : (n / 1024 ** 2).toFixed(0) + ' MB';
}

function initOnboard(force = false) {
  const box = $('#onboard');
  if (!box) return;
  if (!force && S.config?.settings?.onboarded) return;

  const home = S.config?.home || '';
  $('#onboardHome').textContent = home || '（读取不到用户目录）';

  const fallback = home ? home + '\\awes-workspace' : '';
  const cur = S.config?.settings?.workspace || '';
  // 没设置过、或者还停在应用自己目录，都当作"需要建议"
  const isDefault = !cur || cur === S.config?.appDir;
  $('#onboardWs').value = isDefault ? fallback : cur;
  $('#onboardDiskHint').textContent = '';

  // 异步探测磁盘：优先非 C 盘里剩余最多的
  API.disks()
    .then((r) => {
      if (!r.suggested) {
        if (r.disks?.length) $('#onboardDiskHint').textContent = '只有 C 盘可用，将放在用户目录下';
        return;
      }
      const input = $('#onboardWs');
      if (!input.value || input.value === fallback || isDefault) input.value = r.suggested;
      $('#onboardDiskHint').textContent = `建议放 ${r.suggestedDrive} 盘 · 剩余 ${fmtGB(r.suggestedFree)}`;
    })
    .catch(() => {});

  // 快捷路径
  const quick = $('#onboardQuick');
  const candidates = [
    { label: '用户目录', path: home },
    { label: '桌面', path: home ? home + '\\Desktop' : '' },
    { label: '文档', path: home ? home + '\\Documents' : '' },
  ].filter((c) => c.path);
  quick.innerHTML = candidates
    .map((c) => `<button class="mini-btn" data-p="${esc(c.path)}">${esc(c.label)}</button>`)
    .join('');
  quick.onclick = (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    $('#onboardWs').value = b.dataset.p;
    for (const c of box.querySelectorAll('.mode-card')) {
      c.classList.toggle('selected', c.dataset.mode === 'workspace');
    }
  };

  // 选模式
  box.onclick = (e) => {
    const card = e.target.closest('.mode-card');
    if (!card) return;
    for (const c of box.querySelectorAll('.mode-card')) c.classList.toggle('selected', c === card);
  };

  $('#btnOnboardGo').onclick = async () => {
    const mode = box.querySelector('.mode-card.selected')?.dataset.mode || 'workspace';
    const ws = $('#onboardWs').value.trim();
    if (mode === 'workspace' && !ws) return toast('先填一个工作区路径', 'err');

    const btn = $('#btnOnboardGo');
    btn.disabled = true;
    btn.textContent = '正在设置…';
    try {
      const r = await API.onboard({ mode, workspace: ws });
      S.config = r.config;
      S.workspace = r.config.settings.workspace;
      if (S.session) S.session.workspace = r.config.settings.workspace;
      box.classList.remove('show');
      updateWsLabel();
      updateTopbarLabels();
      toast(mode === 'full' ? '已开启全权模式' : '工作区已设定', 'ok');
      await refreshSessions();
      if (S.sideTab === 'files') loadTree();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '开始使用';
    }
  };

  box.classList.add('show');
}

/* ================= 启动 ================= */
async function boot() {
  // 任何没被 catch 的错误都弹出来，别再"点了没反应"
  window.addEventListener('unhandledrejection', (e) => {
    console.error('未处理的异步错误', e.reason);
    const msg = e.reason?.message || String(e.reason || '未知错误');
    if (!/AbortError|aborted/i.test(msg)) toast('出错了：' + msg, 'err');
  });
  window.addEventListener('error', (e) => {
    console.error('页面错误', e.error || e.message);
  });

  try {
    const { config, tools } = await API.getConfig();
    S.config = config;
    S.tools = tools || [];
    S.workspace = config.settings.workspace || '';
    S.providerId = config.active?.providerId || config.providers[0]?.id;
    S.model = config.active?.model || config.providers[0]?.models?.[0]?.id;
    S.params = { ...config.params };
    S.promptId = config.activePromptId || 'builtin-coding';
    // 动画开关：默认开，只有明确设成 false 才关
    document.documentElement.dataset.anim = config.settings.animations === false ? 'off' : 'on';
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-family:system-ui">
      <h2>无法连接本地服务</h2><p style="color:#888">${esc(e.message)}</p>
      <p style="color:#888">请确认服务已启动：<code>node server/index.js</code></p></div>`;
    return;
  }

  // 基础 UI
  initTheme();
  initScroll();
  initChatEvents();
  initConfirm();
  initSidebar();
  initInspector();
  initSettings();
  initModeSwitch();
  bindTopbar();
  bindComposer();
  bindHotkeys();
  initLiveReload();
  setStreamingUI(false);

  // 数据
  await reloadPrompts();
  loadPromptIntoEditor(S.promptId);
  renderToolList();
  syncParamsUI();
  renderModeSwitch();
  updateWsLabel();
  updateTopbarLabels();
  renderStarters();

  // 侧栏折叠按钮初始态
  $('#btnInspector').classList.add('active');

  await refreshSessions();

  // 事件
  document.addEventListener('awes:config-changed', () => {
    updateTopbarLabels();
    renderToolList();
    document.documentElement.dataset.anim = S.config?.settings?.animations === false ? 'off' : 'on';
  });
  document.addEventListener('awes:workspace-changed', () => {
    updateWsLabel();
    fileCache = null;
    if (S.sideTab === 'files') loadTree();
  });
  document.addEventListener('awes:session-changed', (e) => {
    const s = e.detail;
    S.workspace = s.workspace;
    updateWsLabel();
    updateTopbarLabels();
    loadPromptIntoEditor(s.promptId);
    fileCache = null;
  });

  // 恢复会话
  const hashId = location.hash.replace('#', '').trim();
  if (hashId) {
    try {
      await openSession(hashId);
    } catch {
      newSessionUI();
    }
  } else {
    newSessionUI();
  }

  // 文件预览关闭
  $('#btnFileClose').addEventListener('click', () => $('#fileMask').classList.remove('open'));
  $('#btnFileCopy').addEventListener('click', async () => {
    const p = $('#fileTitle').textContent || '';
    if (!p) return;
    if (await copyText(p)) toast('路径已复制', 'ok');
  });
  $('#fileMask').addEventListener('click', (e) => {
    if (e.target === $('#fileMask')) $('#fileMask').classList.remove('open');
  });
  $('#settingsMask').addEventListener('click', (e) => {
    if (e.target === $('#settingsMask')) $('#settingsMask').classList.remove('open');
  });

  // 热更新提示条
  $('#btnReload').addEventListener('click', () => location.reload());
  $('#btnReloadClose').addEventListener('click', () => $('#reloadBar').classList.remove('show'));

  // 首次使用提示
  const curProv = S.config.providers.find((p) => p.id === S.providerId);
  if (curProv?.free) {
    setTimeout(() => {
      toast('已接好免费体验通道，直接发消息就能聊（每 30 秒 1 次）', 'ok');
    }, 800);
  } else if (!S.config.providers.some((p) => p.hasKey)) {
    setTimeout(() => {
      toast('还没有配置 API Key，点右上角齿轮填一下就能用了', '');
    }, 900);
  }

  // 首次引导：先定 AI 的活动范围
  initOnboard();
  document.addEventListener('awes:show-onboard', () => initOnboard(true));
}

boot();
