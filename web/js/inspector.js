import { S, $, $$, el, esc, toast } from './store.js';
import { API } from './api.js';
import { confirmDialog, promptDialog } from './ui-dialog.js';

/* ---------------- Tab ---------------- */
export function initInspector() {
  $('#inspTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    S.inspectorTab = b.dataset.tab;
    for (const x of $('#inspTabs').children) x.classList.toggle('active', x === b);
    for (const pane of $$('.insp-pane')) {
      pane.classList.toggle('hidden', pane.dataset.pane !== S.inspectorTab);
    }
  });

  $('#btnInspClose').addEventListener('click', () => {
    $('#app').classList.add('no-inspector');
    $('#btnInspector').classList.remove('active');
  });
  $('#btnInspector').addEventListener('click', () => {
    const app = $('#app');
    app.classList.toggle('no-inspector');
    $('#btnInspector').classList.toggle('active', !app.classList.contains('no-inspector'));
  });

  initPromptPane();
  initParamsPane();
  initToolsPane();
}

/* ---------------- 提示词 ---------------- */
function initPromptPane() {
  $('#inspPromptSelect').addEventListener('change', (e) => {
    loadPromptIntoEditor(e.target.value);
  });

  $('#promptEditor').addEventListener('input', () => {
    S.draftPrompt = $('#promptEditor').value;
    $('#renderedPreview').hidden = true;
  });

  // Tab 插入两个空格
  $('#promptEditor').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + 2;
      S.draftPrompt = ta.value;
    }
  });

  $('#btnPromptSave').addEventListener('click', async () => {
    const p = S.editingPrompt;
    if (!p) return;
    const vars = readVarInputs();
    try {
      const { prompt } = await API.savePrompt({
        id: p.id,
        name: p.name,
        icon: p.icon,
        description: p.description,
        tags: p.tags,
        vars: p.vars || [],
        system: $('#promptEditor').value,
      });
      await API.saveConfig({ vars });
      S.config.vars = vars;
      await reloadPrompts();
      toast('提示词已保存', 'ok');
      document.dispatchEvent(new CustomEvent('awes:prompt-saved'));
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
    }
  });

  $('#btnPromptRevert').addEventListener('click', async () => {
    const p = S.editingPrompt;
    if (!p) return;
    const ok = await confirmDialog(
      '恢复默认模板',
      `把「${p.name}」恢复成内置默认版本？你的修改会丢失。`,
      { okText: '恢复', danger: true }
    );
    if (!ok) return;
    try {
      await API.deletePrompt(p.id);
      await reloadPrompts();
      loadPromptIntoEditor(p.id);
      toast('已恢复默认', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  $('#btnPromptDelete').addEventListener('click', async () => {
    const p = S.editingPrompt;
    if (!p) return;
    if (p.builtin) return toast('内置模板不能删除，可以用「恢复默认」', '');
    const ok = await confirmDialog('删除模板', `删除模板「${p.name}」？`, {
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    await API.deletePrompt(p.id);
    await reloadPrompts();
    toast('已删除', 'ok');
  });

  $('#btnPromptNew').addEventListener('click', async () => {
    const name = await promptDialog('新建模板', '我的模板', '模板名称');
    if (!name || !name.trim()) return;
    try {
      const { prompt } = await API.savePrompt({
        name,
        icon: '◆',
        description: '自定义模板',
        tags: ['自定义'],
        vars: [],
        system: '你是一个得力的助手。\n\n当前工作区：{{workspace}}\n当前日期：{{date}}\n',
      });
      await reloadPrompts();
      loadPromptIntoEditor(prompt.id);
      toast('已创建', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  $('#btnPreviewSystem').addEventListener('click', async () => {
    const box = $('#renderedPreview');
    if (!box.hidden) {
      box.hidden = true;
      return;
    }
    try {
      const { system } = await API.previewSystem({
        sessionId: S.sessionId,
        promptId: S.editingPrompt?.id,
        providerId: S.providerId,
        model: S.model,
      });
      // 把编辑器里未保存的改动也算进去
      const draft = $('#promptEditor').value;
      const rendered = await API.previewPrompt({ system: draft, workspace: S.workspace });
      box.textContent = rendered.rendered + '\n\n────────────\n\n' + system.split('\n').slice(0, 200).join('\n');
      box.hidden = false;
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

export async function reloadPrompts() {
  const { prompts } = await API.getPrompts();
  S.prompts = prompts;
  renderPromptSelect();
  renderPromptMenu();
}

function renderPromptSelect() {
  const sel = $('#inspPromptSelect');
  sel.innerHTML = S.prompts
    .map((p) => `<option value="${esc(p.id)}">${esc(p.icon || '')} ${esc(p.name)}${p.builtin ? '' : ' （自定义）'}</option>`)
    .join('');
  if (S.editingPrompt) sel.value = S.editingPrompt.id;
}

export function renderPromptMenu() {
  const menu = $('#promptMenu');
  menu.innerHTML =
    `<div class="menu-label">提示词模板</div>` +
    S.prompts
      .map(
        (p) => `<div class="menu-item${p.id === S.promptId ? ' active' : ''}" data-pid="${esc(p.id)}">
          <span style="font-family:var(--mono);opacity:.7">${esc(p.icon || '·')}</span>
          <span>${esc(p.name)}</span>
          ${p.builtin ? '' : '<span class="mi-sub">自定义</span>'}
        </div>`
      )
      .join('') +
    `<div class="menu-sep"></div>
     <div class="menu-item" data-pid="__edit__"><span style="opacity:.7">✎</span><span>编辑当前模板…</span></div>`;
}

export function loadPromptIntoEditor(id) {
  const p = S.prompts.find((x) => x.id === id) || S.prompts[0];
  if (!p) return;
  S.editingPrompt = p;
  S.draftPrompt = p.system || '';
  $('#inspPromptSelect').value = p.id;
  $('#promptEditor').value = p.system || '';
  $('#promptDesc').textContent = p.description || '';
  $('#btnPromptDelete').style.display = p.builtin ? 'none' : '';
  $('#btnPromptRevert').style.display = p.builtin ? '' : 'none';
  renderVars(p);
  $('#renderedPreview').hidden = true;
}

function renderVars(p) {
  const box = $('#varList');
  const sysVars = [
    { key: 'workspace', label: '工作区', readonly: true },
    { key: 'date', label: '日期', readonly: true },
    { key: 'model', label: '模型', readonly: true },
  ];
  const custom = p.vars || [];
  const values = S.config?.vars || {};

  box.innerHTML =
    sysVars
      .map(
        (v) => `<div class="var-row">
          <span class="var-key">{{${v.key}}}</span>
          <input class="input" value="自动" disabled style="opacity:.55" />
        </div>`
      )
      .join('') +
    custom
      .map(
        (v) => `<div class="var-row" data-var="${esc(v.key)}">
          <span class="var-key" title="点击插入">&#123;&#123;${esc(v.key)}&#125;&#125;</span>
          <input class="input var-input" data-key="${esc(v.key)}" value="${esc(values[v.key] ?? v.value ?? '')}" placeholder="${esc(v.label || v.key)}" />
          <button class="var-del" data-delvar="${esc(v.key)}" title="删除变量">×</button>
        </div>`
      )
      .join('') +
    `<div class="var-row var-add">
       <input class="input var-new-key" placeholder="变量名" />
       <input class="input var-new-val" placeholder="值" />
       <button class="mini-btn" id="btnAddVar">添加</button>
     </div>`;

  // 点击变量名插入到编辑器
  box.querySelectorAll('.var-key').forEach((k) => {
    k.addEventListener('click', () => {
      const name = k.textContent.replace(/[{}]/g, '').trim();
      insertAtCursor($('#promptEditor'), `{{${name}}}`);
    });
  });

  // 删除变量
  box.querySelectorAll('.var-del').forEach((b) => {
    b.addEventListener('click', () => {
      const key = b.dataset.delvar;
      p.vars = (p.vars || []).filter((v) => v.key !== key);
      renderVars(p);
      toast('已移除变量，记得点保存', '');
    });
  });

  // 新增变量
  $('#btnAddVar')?.addEventListener('click', () => {
    const keyEl = box.querySelector('.var-new-key');
    const valEl = box.querySelector('.var-new-val');
    const key = keyEl.value.trim().replace(/[^\w\u4e00-\u9fa5-]/g, '');
    if (!key) return toast('变量名不能为空', 'err');
    if ((p.vars || []).some((v) => v.key === key)) return toast('这个变量已经有了', 'err');
    p.vars = [...(p.vars || []), { key, label: key, value: valEl.value }];
    S.config.vars = { ...(S.config.vars || {}), [key]: valEl.value };
    renderVars(p);
    toast('已添加，记得点保存', 'ok');
  });
}

function readVarInputs() {
  const vars = { ...(S.config?.vars || {}) };
  $$('#varList .var-input').forEach((i) => {
    vars[i.dataset.key] = i.value;
  });
  return vars;
}

function insertAtCursor(ta, text) {
  const s = ta.selectionStart;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(ta.selectionEnd);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
  S.draftPrompt = ta.value;
}

/* ---------------- 参数 ---------------- */
function initParamsPane() {
  const bind = (id, key, label) => {
    const input = $(id);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      S.params[key] = v;
      if (label) $(label).textContent = v;
    });
  };
  bind('#pTemp', 'temperature', '#valTemp');
  bind('#pTopP', 'topP', '#valTopP');

  $('#btnParamsReset').addEventListener('click', () => {
    const def = { temperature: 0.7, topP: 1, maxTokens: 4096, frequencyPenalty: 0, presencePenalty: 0 };
    S.params = { ...def };
    $('#pTemp').value = def.temperature;
    $('#valTemp').textContent = def.temperature;
    $('#pTopP').value = def.topP;
    $('#valTopP').textContent = def.topP;
    $('#pMaxTokens').value = def.maxTokens;
    $('#pFreq').value = def.frequencyPenalty;
    $('#pPres').value = def.presencePenalty;
    $('#pMaxSteps').value = 24;
    toast('已恢复默认值，点「应用参数」生效');
  });

  $('#btnParamsSave').addEventListener('click', async () => {
    const patch = {
      params: {
        temperature: Number($('#pTemp').value),
        topP: Number($('#pTopP').value),
        maxTokens: Number($('#pMaxTokens').value) || 4096,
        frequencyPenalty: Number($('#pFreq').value) || 0,
        presencePenalty: Number($('#pPres').value) || 0,
      },
      settings: { maxSteps: Number($('#pMaxSteps').value) || 24 },
    };
    try {
      const { config } = await API.saveConfig(patch);
      S.config = config;
      S.params = { ...config.params };
      toast('参数已应用', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

export function syncParamsUI() {
  const p = S.params || {};
  $('#pTemp').value = p.temperature ?? 0.7;
  $('#valTemp').textContent = p.temperature ?? 0.7;
  $('#pTopP').value = p.topP ?? 1;
  $('#valTopP').textContent = p.topP ?? 1;
  $('#pMaxTokens').value = p.maxTokens ?? 4096;
  $('#pFreq').value = p.frequencyPenalty ?? 0;
  $('#pPres').value = p.presencePenalty ?? 0;
  $('#pMaxSteps').value = S.config?.settings?.maxSteps ?? 24;
}

/* ---------------- 工具 ---------------- */
function initToolsPane() {
  $('#swEnter').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      const { config } = await API.saveConfig({ settings: { sendOnEnter: on } });
      S.config = config;
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

export function renderToolList() {
  const box = $('#toolList');
  const enabled = S.config?.settings?.enabledTools || {};
  const prov = S.config?.providers?.find((p) => p.id === S.providerId);
  const banner = prov?.noTools
    ? `<div class="notice" style="margin-bottom:10px">当前通道（${esc(prov.name)}）不支持工具调用，只能纯对话。要让它真的读写文件、跑命令，请在顶部切换到自己的模型。</div>`
    : '';
  const descs = {
    read_file: '读取文件内容',
    write_file: '创建 / 覆盖文件',
    edit_file: '精确替换文件片段',
    list_dir: '浏览目录结构',
    glob: '按文件名模式查找',
    grep: '按内容正则搜索',
    run_command: '执行 shell 命令',
    todo_write: '维护任务清单',
    move_file: '移动 / 重命名',
    copy_file: '复制文件或目录',
    delete_file: '移到回收站（可还原）',
    file_info: '查看大小与修改时间',
  };
  const enabledCount = (S.tools || []).filter((t) => enabled[t.name] !== false).length;
  const bulk = `<div class="row gap" style="margin-bottom:10px">
    <button class="mini-btn" id="btnToolsAll">全开</button>
    <button class="mini-btn" id="btnToolsNone">全关</button>
    <span class="hint" style="margin:0 0 0 4px">${enabledCount}/${(S.tools || []).length} 启用</span>
  </div>`;

  box.innerHTML =
    banner +
    bulk +
    (S.tools || [])
      .map(
        (t) => `<div class="tool-row">
        <div>
          <div class="tr-name">${esc(t.name)}</div>
          <div class="tr-desc">${esc(descs[t.name] || t.description?.slice(0, 40) || '')}</div>
        </div>
        <input type="checkbox" class="switch tool-switch" data-tool="${esc(t.name)}" ${enabled[t.name] !== false ? 'checked' : ''} />
      </div>`
      )
      .join('');

  box.querySelectorAll('.tool-switch').forEach((sw) => {
    sw.addEventListener('change', async () => {
      const map = { ...(S.config?.settings?.enabledTools || {}) };
      map[sw.dataset.tool] = sw.checked;
      try {
        const { config } = await API.saveConfig({ settings: { enabledTools: map } });
        S.config = config;
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  });

  $('#swEnter').checked = S.config?.settings?.sendOnEnter !== false;

  $('#btnToolsAll')?.addEventListener('click', () => setAllTools(true));
  $('#btnToolsNone')?.addEventListener('click', () => setAllTools(false));
}

async function setAllTools(on) {
  if (!on) {
    const ok = await confirmDialog(
      '关闭全部工具',
      '全部关闭后 Agent 就只能聊天，不能读写文件、跑命令。确定吗？',
      { okText: '全部关闭', danger: true }
    );
    if (!ok) return;
  }
  const map = {};
  for (const t of S.tools || []) map[t.name] = on;
  try {
    const { config } = await API.saveConfig({ settings: { enabledTools: map } });
    S.config = config;
    renderToolList();
    toast(on ? '已全部开启' : '已全部关闭', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- 权限模式 ---------------- */
export function renderModeSwitch() {
  const mode = S.config?.settings?.permissionMode || 'auto';
  for (const b of $$('#modeSwitch button')) {
    b.classList.toggle('active', b.dataset.mode === mode);
  }
}

export function initModeSwitch() {
  $('#modeSwitch').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      const { config } = await API.saveConfig({ settings: { permissionMode: b.dataset.mode } });
      S.config = config;
      renderModeSwitch();
      toast(
        { readonly: '只读模式：只能读，不能改', ask: '确认模式：写操作前会问你', auto: '自动模式：工具直接执行' }[b.dataset.mode],
        ''
      );
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}
