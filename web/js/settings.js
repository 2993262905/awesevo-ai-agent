import { S, $, $$, el, esc, toast } from './store.js';
import { API } from './api.js';
import { renderToolList, renderModeSwitch, syncParamsUI, reloadPrompts, loadPromptIntoEditor } from './inspector.js';

let draftProviders = [];
/** 本次刚导入的模型 ID，用于高亮提示 */
let newlyAddedModels = new Set();
let settingsTab = 'api';
let apiDelegatesBound = false;

export function openSettings(tab = 'api') {
  draftProviders = structuredClone(S.config.providers || []);
  settingsTab = tab;
  $('#settingsMask').classList.add('open');
  renderSettingsTabs();
  renderSettingsBody();
}

export function initSettings() {
  $('#btnSettings').addEventListener('click', () => openSettings('api'));
  $('#btnSettingsClose').addEventListener('click', closeSettings);
  $('#settingsMask').addEventListener('click', (e) => {
    if (e.target === $('#settingsMask')) closeSettings();
  });
  $('#settingsTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab-btn');
    if (!b) return;
    settingsTab = b.dataset.tab;
    renderSettingsTabs();
    renderSettingsBody();
  });
}

function closeSettings() {
  $('#settingsMask').classList.remove('open');
}

function renderSettingsTabs() {
  for (const b of $$('#settingsTabs .tab-btn')) {
    b.classList.toggle('active', b.dataset.tab === settingsTab);
  }
}

function renderSettingsBody() {
  const body = $('#settingsBody');
  if (settingsTab === 'api') body.innerHTML = apiHtml();
  else if (settingsTab === 'general') body.innerHTML = generalHtml();
  else if (settingsTab === 'runtime') body.innerHTML = runtimeHtml();
  else body.innerHTML = aboutHtml();

  if (settingsTab === 'api') bindApi();
  if (settingsTab === 'general') bindGeneral();
  if (settingsTab === 'runtime') bindRuntime();
  if (settingsTab === 'about') bindAbout();
}

/* ---------------- 模型与 API ---------------- */
function apiHtml() {
  return `
    <div class="settings-section">
      <h3>服务商</h3>
      <p class="hint" style="margin-top:-4px;margin-bottom:10px">
        支持任何 OpenAI 兼容接口以及 Anthropic 原生接口。API Key 只保存在本机 data/config.json。
      </p>
      <div class="preset-row">
        ${PRESETS.map((p) => `<button class="mini-btn preset-btn" data-preset="${p.key}">${esc(p.name)}</button>`).join('')}
        <button class="mini-btn" id="btnAddProv">+ 空白</button>
      </div>
      <p class="hint" style="margin:-4px 0 12px">点上面的名字快速添加，地址和模型会自动填好，你只要补 Key。</p>
      <div id="provList">
        ${draftProviders.map((p, i) => provCardHtml(p, i)).join('')}
      </div>
      <div class="row gap">
        <button class="mini-btn primary" id="btnSaveProv">保存全部</button>
      </div>
    </div>`;
}

/** 常见服务商预设：点一下就填好地址和模型名 */
const PRESETS = [
  {
    key: 'sensenova',
    name: '商汤日日新',
    baseURL: 'https://token.sensenova.cn/v1',
    models: ['sensenova-6.8-flash-lite'],
  },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    key: 'moonshot',
    name: 'Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview'],
  },
  {
    key: 'qwen',
    name: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max'],
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus'],
  },
  {
    key: 'siliconflow',
    name: '硅基流动',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3'],
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-3.5-sonnet'],
  },
];

/** 用户常把完整的 /chat/completions 粘进来，这里统一剥掉 */
function normalizeBaseURL(u) {
  let s = String(u || '').trim().replace(/\s+/g, '');
  if (!s) return s;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/(chat\/completions|completions|messages|responses)$/i, '');
  return s.replace(/\/+$/, '');
}

function provCardHtml(p, i) {
  const isActive = p.id === S.providerId;
  const models = (p.models || [])
    .map(
      (m) =>
        `<span class="model-chip${newlyAddedModels.has(m.id) ? ' chip-new' : ''}">${esc(m.id || '（空）')}<span class="x" data-rm="${i}" data-mid="${esc(m.id)}">×</span></span>`
    )
    .join('');
  const addChip = p._adding
    ? `<input class="model-add" data-addmodel="${i}" placeholder="模型 ID，回车确认，Esc 取消" />`
    : `<span class="model-chip add-chip" data-act="addmodel" data-idx="${i}">+ 添加</span>`;

  return `
  <div class="prov-card ${isActive ? 'active' : ''}" data-idx="${i}">
    <div class="prov-head">
      <span class="prov-name">${esc(p.name || '未命名')}</span>
      ${isActive ? '<span class="prov-badge on">当前使用</span>' : ''}
      ${p.free ? '<span class="prov-badge on">免费</span>' : ''}
      <span class="prov-badge">${p.format === 'anthropic' ? 'anthropic' : 'openai 兼容'}</span>
      <button class="mini-btn" data-act="test" data-idx="${i}">测试</button>
      <button class="icon-btn ghost" data-act="del" data-idx="${i}" title="删除"><svg><use href="#i-trash"/></svg></button>
    </div>
    <div class="prov-grid">
      <div class="field-mini">
        <label>名称</label>
        <input class="input" data-f="name" data-idx="${i}" value="${esc(p.name || '')}" />
      </div>
      <div class="field-mini">
        <label>接口格式</label>
        <select class="input" data-f="format" data-idx="${i}">
          <option value="openai" ${p.format !== 'anthropic' ? 'selected' : ''}>OpenAI 兼容</option>
          <option value="anthropic" ${p.format === 'anthropic' ? 'selected' : ''}>Anthropic</option>
        </select>
      </div>
      <div class="field-mini full">
        <label>Base URL <span style="opacity:.6;font-weight:400">（填到 /v1 就行，多粘的路径会自动去掉）</span></label>
        <input class="input" data-f="baseURL" data-idx="${i}" value="${esc(p.baseURL || '')}" placeholder="https://api.example.com/v1" />
      </div>
      <div class="field-mini full">
        <label>API Key ${
          p.free
            ? '<span style="color:var(--ok)">无需填写</span>'
            : p.hasKey
              ? `<span style="color:var(--ok)">已保存 ${esc(p.keyHint || '')}</span>`
              : '<span style="color:var(--warn)">未设置</span>'
        }</label>
        ${
          p.free
            ? `<input class="input" value="公共免费通道，不需要 Key" disabled style="opacity:.55" />`
            : `<input class="input" data-f="apiKey" data-idx="${i}" type="password" value="" placeholder="${p.hasKey ? '留空则保持不变' : 'sk-...'}" autocomplete="off" />`
        }
      </div>
      <div class="field-mini full">
        <label>模型列表</label>
        <div class="model-chips" data-chips="${i}">
          ${models}
          ${addChip}
        </div>
        <div class="row gap" style="margin-top:6px">
          <button class="mini-btn" data-fetch="${i}" title="向服务商实时请求一份可用模型列表">⟳ 获取模型列表</button>
        </div>
      </div>
    </div>
    <div class="probe-result" data-probe="${i}" style="display:none"></div>
  </div>`;
}

function bindApi() {
  const body = $('#settingsBody');

  // 委托事件只绑一次，否则每渲染一次就多叠一层，点一下触发好几遍
  if (!apiDelegatesBound) {
    apiDelegatesBound = true;
    bindApiDelegates(body);
  }

  // 这两个按钮每次渲染都是新元素，需要重新绑
  $('#btnAddProv')?.addEventListener('click', () => addProvider());
  $('#btnSaveProv')?.addEventListener('click', saveProviders);
}

function bindApiDelegates(body) {
  body.addEventListener('input', (e) => {
    const f = e.target.dataset?.f;
    if (!f) return;
    const i = Number(e.target.dataset.idx);
    if (draftProviders[i]) draftProviders[i][f] = e.target.value;
  });

  body.addEventListener('change', (e) => {
    const f = e.target.dataset?.f;
    if (!f) return;
    const i = Number(e.target.dataset.idx);
    if (draftProviders[i]) draftProviders[i][f] = e.target.value;
  });

  // 模型 ID 内联输入框
  body.addEventListener('keydown', (e) => {
    const raw = e.target.dataset?.addmodel;
    if (raw == null) return;
    const i = Number(raw);
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = e.target.value.trim();
      draftProviders[i]._adding = false;
      if (v && !(draftProviders[i].models || []).some((m) => m.id === v)) {
        draftProviders[i].models = [...(draftProviders[i].models || []), { id: v, name: v }];
      }
      renderSettingsBody();
    } else if (e.key === 'Escape') {
      draftProviders[i]._adding = false;
      renderSettingsBody();
    }
  });

  body.addEventListener('click', async (e) => {
    // 获取模型列表：走委托，DOM 重绘多少次都不会失效
    const fetchBtn = e.target.closest('[data-fetch]');
    if (fetchBtn) {
      await fetchModelsIntoDraft(Number(fetchBtn.dataset.fetch), fetchBtn);
      return;
    }

    // 删模型
    const rm = e.target.dataset?.rm;
    if (rm != null) {
      const i = Number(rm);
      const mid = e.target.dataset.mid;
      draftProviders[i].models = (draftProviders[i].models || []).filter((m) => m.id !== mid);
      renderSettingsBody();
      return;
    }

    // 预设
    const presetBtn = e.target.closest('[data-preset]');
    if (presetBtn) {
      addPreset(presetBtn.dataset.preset);
      return;
    }

    const holder = e.target.closest('[data-act]');
    if (!holder) return;
    const act = holder.dataset.act;
    const i = Number(holder.dataset.idx);
    if (!draftProviders[i]) return;

    if (act === 'del') {
      if (draftProviders.length <= 1) return toast('至少保留一个服务商', 'err');
      draftProviders.splice(i, 1);
      renderSettingsBody();
      return;
    }

    if (act === 'addmodel') {
      draftProviders[i]._adding = true;
      renderSettingsBody();
      body.querySelector(`input[data-addmodel="${i}"]`)?.focus();
      return;
    }

    if (act === 'test') {
      const box = body.querySelector(`[data-probe="${i}"]`);
      const p = draftProviders[i];
      const keyInput = body.querySelector(`input[data-f="apiKey"][data-idx="${i}"]`);
      const payload = { ...p, apiKey: keyInput?.value || undefined, baseURL: normalizeBaseURL(p.baseURL) };
      box.style.display = 'block';
      box.innerHTML = '<span style="color:var(--text-3)">正在连接…</span>';
      try {
        const r = await API.probe(payload);
        if (r.ok) {
          const list = r.models || [];
          box.innerHTML = `<span style="color:var(--ok)">✓ 连接成功（${r.ms}ms）</span>
            ${r.note ? `<div style="margin-top:4px;font-size:11px;color:var(--text-3)">${esc(r.note)}</div>` : ''}
            ${list.length ? `<div style="margin-top:6px;font-size:11px;color:var(--text-3)">发现 ${list.length} 个模型，<a href="#" data-import="${i}" style="color:var(--accent)">全部导入</a></div>` : ''}`;
          box.dataset.models = JSON.stringify(list);
          box.querySelector('[data-import]')?.addEventListener('click', (ev) => {
            ev.preventDefault();
            const models = JSON.parse(box.dataset.models || '[]');
            draftProviders[i].models = models.map((id) => ({ id, name: id }));
            renderSettingsBody();
            toast(`已导入 ${models.length} 个模型`, 'ok');
          });
        } else {
          box.innerHTML = `<span style="color:var(--err)">✗ ${esc(r.error || '连接失败')}</span>`;
        }
      } catch (err) {
        box.innerHTML = `<span style="color:var(--err)">✗ ${esc(err.message)}</span>`;
      }
    }

  });
}

/** 拉取模型列表并合并进草稿；btn 可选，用于显示进行中状态 */
async function fetchModelsIntoDraft(i, btn) {
  const p = draftProviders[i];
  if (!p) return toast('找不到这个服务商，重开一次设置页试试', 'err');
  if (!p.baseURL) return toast('先填 Base URL', 'err');

  const old = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '正在获取…';
  }

  try {
    // 传 providerId，让服务端用它保存的真 Key；baseURL/apiKey 允许用刚填还没保存的
    const r = await API.fetchModels({
      providerId: p.id,
      baseURL: p.baseURL,
      apiKey: p.apiKey || undefined,
      source: 'settings',
    });

    if (!r.ok) {
      toast('获取失败：' + r.error, 'err');
      if (btn) {
        btn.innerHTML = '✗ 失败';
        setTimeout(() => {
          btn.innerHTML = old;
          btn.disabled = false;
        }, 1600);
      }
      return;
    }

    const before = new Set((p.models || []).map((m) => m.id));
    const added = r.models.filter((id) => !before.has(id));
    p.models = r.models.map((id) =>
      before.has(id) ? p.models.find((m) => m.id === id) : { id, name: id }
    );
    newlyAddedModels = new Set(added);
    toast(
      `已获取 ${r.models.length} 个模型${added.length ? `，新增 ${added.length} 个` : ''}（${r.ms}ms）`,
      'ok'
    );
    renderSettingsBody(); // 重绘后 btn 已失效，不用再恢复
    setTimeout(() => {
      newlyAddedModels = new Set();
    }, 2500);
  } catch (e) {
    toast('获取失败：' + e.message, 'err');
    if (btn) {
      btn.innerHTML = '✗ 失败';
      setTimeout(() => {
        btn.innerHTML = old;
        btn.disabled = false;
      }, 1600);
    }
  }
}

function addProvider() {
  draftProviders.push({
    id: 'p_' + Date.now().toString(36),
    name: '新服务商',
    format: 'openai',
    baseURL: '',
    apiKey: '',
    headers: {},
    models: [],
  });
  renderSettingsBody();
}

function addPreset(key) {
  const p = PRESETS.find((x) => x.key === key);
  if (!p) return;
  if (draftProviders.some((x) => normalizeBaseURL(x.baseURL) === p.baseURL)) {
    toast(`${p.name} 已经在列表里了`, '');
    return;
  }
  draftProviders.push({
    id: 'p_' + Date.now().toString(36),
    name: p.name,
    format: 'openai',
    baseURL: p.baseURL,
    apiKey: '',
    headers: {},
    models: (p.models || []).map((id) => ({ id, name: id })),
  });
  renderSettingsBody();
  toast(`已添加 ${p.name}，补上 Key 后点「测试」`, 'ok');
}

async function saveProviders() {
  try {
    let fixed = false;
    // hasKey / keyHint 是界面字段，_adding 是临时状态，都不写回配置。
    // apiKey 留空时必须**整个字段都不发**，否则会把已保存的 Key 抹掉。
    const clean = draftProviders.map(({ hasKey, keyHint, _adding, apiKey, ...p }) => {
      const nb = normalizeBaseURL(p.baseURL);
      if (nb !== p.baseURL) fixed = true;
      const out = { ...p, baseURL: nb };
      if (apiKey) out.apiKey = apiKey;
      return out;
    });

    const { config } = await API.saveConfig({ providers: clean });
    S.config = config;

    // 当前模型若被删了就回退
    const provider = config.providers.find((p) => p.id === S.providerId);
    if (!provider || !provider.models?.some((m) => m.id === S.model)) {
      const first = config.providers.find((p) => p.models?.length);
      if (first) {
        S.providerId = first.id;
        S.model = first.models[0].id;
        await API.saveConfig({ active: { providerId: S.providerId, model: S.model } });
      }
    }
    toast(fixed ? '已保存（顺手修正了 Base URL）' : '已保存', 'ok');
    closeSettings();
    document.dispatchEvent(new CustomEvent('awes:config-changed'));
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  }
}

/* ---------------- 通用 ---------------- */
function generalHtml() {
  const s = S.config.settings || {};
  return `
    <div class="settings-section">
      <h3>外观</h3>
      <div class="kv-row">
        <div>
          <div class="kv-label">主题</div>
          <div class="kv-desc">浅色更适合白天和投屏</div>
        </div>
        <div class="mode-switch" id="themeSwitch">
          <button data-theme="light" class="${s.theme !== 'dark' ? 'active' : ''}">浅色</button>
          <button data-theme="dark" class="${s.theme === 'dark' ? 'active' : ''}">深色</button>
        </div>
      </div>
      <div class="kv-row">
        <div>
          <div class="kv-label">Enter 直接发送</div>
          <div class="kv-desc">关闭后 Enter 换行，Ctrl+Enter 发送</div>
        </div>
        <input type="checkbox" class="switch" id="gEnter" ${s.sendOnEnter !== false ? 'checked' : ''} />
      </div>
      <div class="kv-row">
        <div>
          <div class="kv-label">界面动画</div>
          <div class="kv-desc">菜单、折叠、滚动跟随等过渡效果；关掉会更干脆</div>
        </div>
        <input type="checkbox" class="switch" id="gAnim" ${s.animations !== false ? 'checked' : ''} />
      </div>
    </div>

    <div class="settings-section">
      <h3>工作区</h3>
      <div class="kv-row">
        <div>
          <div class="kv-label">AI 活动范围</div>
          <div class="kv-desc">${s.mode === 'full' ? '全权模式 · 整个用户目录' : '工作区模式 · 仅限指定目录'}</div>
        </div>
        <button class="mini-btn" id="btnChangeMode">重新选择</button>
      </div>
      <div class="field-mini" style="margin-top:10px">
        <label>Agent 只能在这个目录内读写文件</label>
        <input class="input" id="gWorkspace" value="${esc(s.workspace || '')}" />
      </div>
      <div class="row gap">
        <button class="mini-btn" id="btnSaveWs">保存工作区</button>
        <button class="mini-btn" id="btnExport">导出当前会话为 Markdown</button>
      </div>
    </div>

    <div class="settings-section">
      <h3>数据</h3>
      <div class="kv-row">
        <div>
          <div class="kv-label">存储位置</div>
          <div class="kv-desc">配置、会话、提示词都存在这里，纯本地 JSON</div>
        </div>
        <code style="font-size:11px;color:var(--text-3)">data/</code>
      </div>
      <div class="kv-row">
        <div>
          <div class="kv-label">会话数量</div>
          <div class="kv-desc">删除会话请到左侧列表</div>
        </div>
        <b style="font-family:var(--mono)">${S.sessions.length}</b>
      </div>
    </div>`;
}

function bindGeneral() {
  $('#themeSwitch').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    applyTheme(b.dataset.theme);
    await API.saveConfig({ settings: { theme: b.dataset.theme } });
    for (const x of $('#themeSwitch').children) x.classList.toggle('active', x === b);
  });

  $('#gEnter').addEventListener('change', async (e) => {
    await API.saveConfig({ settings: { sendOnEnter: e.target.checked } });
    S.config.settings.sendOnEnter = e.target.checked;
    $('#swEnter').checked = e.target.checked;
  });

  $('#gAnim')?.addEventListener('change', async (e) => {
    const on = e.target.checked;
    await API.saveConfig({ settings: { animations: on } });
    S.config.settings.animations = on;
    document.documentElement.dataset.anim = on ? 'on' : 'off';
    toast(on ? '动画已开启' : '动画已关闭', 'ok');
  });

  $('#btnChangeMode')?.addEventListener('click', () => {
    closeSettings();
    document.dispatchEvent(new CustomEvent('awes:show-onboard'));
  });

  $('#btnSaveWs').addEventListener('click', async () => {
    const p = $('#gWorkspace').value.trim();
    try {
      const r = await API.setWorkspace(p);
      S.workspace = r.workspace;
      toast('工作区已更新', 'ok');
      document.dispatchEvent(new CustomEvent('awes:workspace-changed', { detail: r.workspace }));
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  $('#btnExport').addEventListener('click', () => {
    if (!S.sessionId) return toast('当前没有打开的会话', 'err');
    window.open('/api/export?sessionId=' + encodeURIComponent(S.sessionId), '_blank');
  });
}

/* ---------------- 后台 ---------------- */
function runtimeHtml() {
  return `
    <div class="settings-section">
      <h3>运行状态</h3>
      <div class="rt-grid" id="rtGrid">
        <div class="rt-item wide"><span>状态</span><b>读取中…</b></div>
      </div>
    </div>

    <div class="settings-section">
      <h3>运行日志</h3>
      <p class="hint" style="margin-top:-4px;margin-bottom:10px">
        程序启动信息和后端输出。打包成 exe 后没有控制台窗口，启动过程、端口、错误都记在这里。
      </p>
      <div class="row gap" style="margin-bottom:10px">
        <button class="mini-btn" id="btnLogRefresh">刷新</button>
        <button class="mini-btn" id="btnLogClear">清空</button>
        <button class="mini-btn" id="btnLogCopy">复制</button>
      </div>
      <pre class="log-view" id="logView">加载中…</pre>
    </div>`;
}

let runtimeTimer = null;

function bindRuntime() {
  const grid = $('#rtGrid');
  const view = $('#logView');

  const fmtUptime = (s) => {
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
  };
  const fmtSize = (n) =>
    n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

  const loadRuntime = async () => {
    try {
      const r = await API.getRuntime();
      grid.innerHTML = `
        <div class="rt-item"><span>运行方式</span><b>${r.packaged ? '单文件 exe' : '源码运行'}</b></div>
        <div class="rt-item"><span>端口</span><b>${r.port}</b></div>
        <div class="rt-item"><span>进程 ID</span><b>${r.pid}</b></div>
        <div class="rt-item"><span>已运行</span><b>${fmtUptime(r.uptime)}</b></div>
        <div class="rt-item"><span>Node</span><b>${esc(r.node)}</b></div>
        <div class="rt-item"><span>版本</span><b>${esc(r.version)}</b></div>
        <div class="rt-item wide"><span>数据目录</span><b class="mono">${esc(r.dataDir)}</b></div>
        <div class="rt-item wide"><span>日志文件</span><b class="mono">${esc(r.logFile)} · ${fmtSize(r.logSize)}</b></div>`;
    } catch (e) {
      grid.innerHTML = `<div class="rt-item wide"><span>状态</span><b style="color:var(--err)">${esc(e.message)}</b></div>`;
    }
  };

  const loadLogs = async (silent) => {
    try {
      const r = await API.getLogs(400);
      if (!r.lines || !r.lines.length) {
        view.textContent = '（还没有日志）';
        return;
      }
      // 用户往上翻的时候不要强行拉到底
      const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
      view.textContent = r.lines.join('\n');
      if (atBottom || !silent) view.scrollTop = view.scrollHeight;
    } catch (e) {
      view.textContent = '读取失败：' + e.message;
    }
  };

  loadRuntime();
  loadLogs(false);

  $('#btnLogRefresh').addEventListener('click', async () => {
    await loadRuntime();
    await loadLogs(false);
    toast('已刷新', 'ok');
  });

  $('#btnLogClear').addEventListener('click', async () => {
    try {
      await API.clearLogs();
      view.textContent = '（还没有日志）';
      toast('日志已清空', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  $('#btnLogCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(view.textContent);
      toast('已复制', 'ok');
    } catch {
      toast('复制失败，请手动选中', 'err');
    }
  });

  // 开着这个页时自动跟进；切走或关掉设置就停，不在后台空转
  clearInterval(runtimeTimer);
  runtimeTimer = setInterval(() => {
    if (settingsTab !== 'runtime' || !$('#settingsMask').classList.contains('open')) {
      clearInterval(runtimeTimer);
      runtimeTimer = null;
      return;
    }
    loadLogs(true);
  }, 3000);
}

/* ---------------- 关于 ---------------- */
function aboutHtml() {
  return `
    <div class="settings-section">
      <h3>AwesEvo</h3>
      <p class="hint" style="font-size:12.5px;line-height:1.8">
        一个可以自己接 API 的本地 Agent 工作台。核心是三件事：<br>
        <b>① 模型随便换</b> —— 任何 OpenAI 兼容端点或 Anthropic 原生接口，Key 只存本机。<br>
        <b>② 提示词是一等公民</b> —— 模板库、变量、一键切换，改完立刻生效。<br>
        <b>③ 真正的 Agent</b> —— 能读能写能跑命令，工具可逐个开关，权限分三档。
      </p>
    </div>
    <div class="settings-section">
      <h3>快捷键</h3>
      <div class="kv-row"><span class="kv-label">发送</span><code style="font-size:11px">Enter</code></div>
      <div class="kv-row"><span class="kv-label">换行</span><code style="font-size:11px">Shift + Enter</code></div>
      <div class="kv-row"><span class="kv-label">新会话</span><code style="font-size:11px">Ctrl + N</code></div>
      <div class="kv-row"><span class="kv-label">切换侧栏</span><code style="font-size:11px">Ctrl + B</code></div>
      <div class="kv-row"><span class="kv-label">停止生成</span><code style="font-size:11px">Esc</code></div>
      <div class="kv-row"><span class="kv-label">引用文件</span><code style="font-size:11px">@</code></div>
    </div>
    <div class="settings-section">
      <h3>快捷操作</h3>
      <div class="row gap">
        <button class="mini-btn" id="btnOpenData">打开数据目录</button>
        <button class="mini-btn" id="btnOpenApp">打开应用目录</button>
      </div>
      <p class="hint">数据目录里是 config.json 和所有会话记录，可以直接备份。</p>
    </div>
    <div class="settings-section">
      <h3>版本</h3>
      <div class="kv-row"><span class="kv-label">AwesEvo</span><b style="font-family:var(--mono)">0.1.0</b></div>
      <div class="kv-row"><span class="kv-label">运行方式</span><span style="font-size:12px;color:var(--text-3)">本地 Node 服务 + 浏览器界面</span></div>
    </div>`;
}

function bindAbout() {
  $('#btnOpenData')?.addEventListener('click', async () => {
    try {
      await API.openDir('data');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  $('#btnOpenApp')?.addEventListener('click', async () => {
    try {
      await API.openDir(S.config?.appDir || '.');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

/* ---------------- 主题 ---------------- */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  $('#themeLabel').textContent = theme === 'dark' ? '深色' : '浅色';
  try {
    localStorage.setItem('awes-theme', theme);
  } catch {}
}

export function initTheme() {
  let t = 'light';
  try {
    t = localStorage.getItem('awes-theme') || S.config?.settings?.theme || 'light';
  } catch {
    t = S.config?.settings?.theme || 'light';
  }
  applyTheme(t);
  $('#btnTheme').addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    await API.saveConfig({ settings: { theme: next } });
  });
}
