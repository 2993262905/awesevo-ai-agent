/* 全局状态与通用工具 */

export const S = {
  config: null,
  tools: [],
  prompts: [],
  sessions: [],
  session: null, // 当前会话完整对象
  streaming: false,
  abort: null,
  sessionId: null,
  workspace: '',
  providerId: '',
  model: '',
  promptId: '',
  params: { temperature: 0.7, topP: 1, maxTokens: 4096, frequencyPenalty: 0, presencePenalty: 0 },
  usage: { promptTokens: 0, completionTokens: 0 },
  inspectorTab: 'prompt',
  sideTab: 'sessions',
  editingPrompt: null,
  draftPrompt: null,
  pendingConfirm: null,
  mentionIndex: 0,
  mentionItems: [],
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
export function toast(msg, type = '') {
  const wrap = $('#toastWrap');
  const t = el('div', 'toast ' + type, esc(msg));
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(6px)';
    t.style.transition = 'all .25s';
    setTimeout(() => t.remove(), 260);
  }, 2400);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400 && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (diff < 86400 * 2) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function fmtNum(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}

export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  return Math.ceil(cjk * 1.05 + (s.length - cjk) / 3.6);
}

export function activeProvider() {
  return S.config?.providers?.find((p) => p.id === S.providerId) || null;
}

export function allModels() {
  const out = [];
  for (const p of S.config?.providers || []) {
    for (const m of p.models || []) {
      if (!m.id) continue;
      out.push({ providerId: p.id, providerName: p.name, modelId: m.id, modelName: m.name || m.id, hasKey: p.hasKey });
    }
  }
  return out;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
