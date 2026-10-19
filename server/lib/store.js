import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PROMPTS } from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SESSION_DIR = path.join(DATA_DIR, 'sessions');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** 内置免费通道：公共网关，无需 Key，每 IP 30 秒 1 次 */
const FREE_PROVIDER = {
  id: 'free',
  name: '免费体验通道',
  format: 'openai',
  baseURL: 'https://text.pollinations.ai/openai',
  apiKey: '',
  headers: {},
  query: { referrer: 'awesevo' },
  free: true,
  noTools: true, // 该通道模型工具调用不稳定，只做纯对话
  note: '公共免费通道，无需 Key，每 30 秒 1 次请求；仅支持对话',
  models: [{ id: 'openai-fast', name: 'GPT-OSS 20B（免费）', contextWindow: 32000 }],
};

const DEFAULT_CONFIG = {
  version: 7,
  providers: [FREE_PROVIDER],
  active: { providerId: 'free', model: 'openai-fast' },
  params: { temperature: 0.7, maxTokens: 4096, topP: 1, frequencyPenalty: 0, presencePenalty: 0 },
  prompts: [],
  activePromptId: 'builtin-coding',
  vars: { language: '自动识别', project: '' },
  settings: {
    theme: 'light',
    permissionMode: 'auto',
    mode: 'workspace', // 'workspace' = 只在一个目录内；'full' = 用户主目录全权
    onboarded: false, // 是否走完首次引导
    maxSteps: 24,
    sendOnEnter: true,
    autoApproveTools: ['read_file', 'list_dir', 'glob', 'grep', 'todo_write'],
    enabledTools: {
      read_file: true,
      write_file: true,
      edit_file: true,
      list_dir: true,
      glob: true,
      grep: true,
      run_command: true,
      todo_write: true,
      move_file: true,
      copy_file: true,
      delete_file: true,
      file_info: true,
    },
    workspace: '',
    compactAfter: 60,
  },
};

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

export function defaultWorkspace() {
  // 默认就让 Agent 待在本应用目录里：用户可以"让 AwesEvo 改 AwesEvo 自己"
  return ROOT;
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === 'object' && base && typeof base === 'object') {
    const out = { ...base };
    for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
    return out;
  }
  return patch === undefined ? base : patch;
}

let cache = null;

/* ---------------- API Key 本地加密 ---------------- */
// 用「本机 + 当前账户」派生密钥，配置文件拷到别的设备就解不开。
// 原则：加密失败一律回退明文——宁可不加密，也不能让应用打不开。

const ENC_PREFIX = 'enc:v1:';
/**
 * 设备种子的候选列表，按优先级排列。
 * primary：主机名 + 第一块物理网卡 MAC —— 换扩展坞/虚拟网卡增减不影响
 * legacy ：主机名 + 全部 MAC 排序 —— 兼容早期版本加密的数据
 */
function seedCandidates() {
  const VIRTUAL =
    /vEthernet|VMware|VirtualBox|Loopback|Bluetooth|Teredo|isatap|WSL|Hyper-V|TAP|Tailscale|VPN|Radmin|ZeroTier|Hamachi/i;
  // 真实网卡优先，避免 VPN/虚拟网卡被选中
  const PREFERRED = /^(以太网|本地连接|Ethernet|WLAN|Wi-?Fi|无线)/i;
  const physical = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    const a = (addrs || []).find(
      (x) => x && !x.internal && x.mac && x.mac !== '00:00:00:00:00:00'
    );
    if (a) physical.push({ name, mac: a.mac.toLowerCase() });
  }
  physical.sort((a, b) => {
    const pa = PREFERRED.test(a.name) ? 0 : 1;
    const pb = PREFERRED.test(b.name) ? 0 : 1;
    return pa - pb || a.name.localeCompare(b.name);
  });

  const allMacs = [
    ...new Set(
      Object.values(os.networkInterfaces())
        .flat()
        .filter((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00')
        .map((n) => n.mac.toLowerCase())
    ),
  ].sort();

  const host = os.hostname();
  const seeds = [];
  if (physical.length) seeds.push(`${host}|${physical[0].mac}`);
  seeds.push(`${host}|${allMacs.join(',')}`);
  return [...new Set(seeds)];
}

let machineKey = null;

/** 主密钥：只用第一块物理网卡，网卡增减不影响 */
function getMachineKey() {
  if (!machineKey) machineKey = crypto.scryptSync(seedCandidates()[0], 'awesevo-config-v1', 32);
  return machineKey;
}

export function encryptSecret(plain) {
  if (!plain || typeof plain !== 'string' || plain.startsWith(ENC_PREFIX)) return plain;
  try {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', getMachineKey(), iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  } catch {
    return plain; // 加密不可用就存明文，保证功能不挂
  }
}

const keyCache = new Map();
function keyFor(seed) {
  let k = keyCache.get(seed);
  if (!k) {
    k = crypto.scryptSync(seed, 'awesevo-config-v1', 32);
    keyCache.set(seed, k);
  }
  return k;
}

export function decryptSecret(stored) {
  if (!stored || typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) return stored || '';
  const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  // 依次用主种子、旧种子试，保证早期加密的数据还能打开
  for (const seed of seedCandidates()) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', keyFor(seed), iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(body), d.final()]).toString('utf8');
    } catch {}
  }
  // 换了设备或网卡：解不开就当没配过，让用户重填
  return '';
}

/** 密文 → 明文（内存里始终是明文，业务代码不用关心） */
function decryptProviders(cfg) {
  for (const p of cfg.providers || []) {
    if (typeof p.apiKey === 'string' && p.apiKey.startsWith(ENC_PREFIX)) {
      p.apiKey = decryptSecret(p.apiKey);
    }
  }
}

/** 明文 → 密文（只用于写盘，不碰内存） */
function configForDisk(cfg) {
  const copy = structuredClone(cfg);
  for (const p of copy.providers || []) {
    if (p.apiKey) p.apiKey = encryptSecret(p.apiKey);
  }
  return copy;
}

function writeConfigFile(cfg) {
  ensureDirs();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(configForDisk(cfg), null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

/** 配置迁移：补上内置免费通道 */
function migrate(cfg) {
  let changed = false;
  if (!Array.isArray(cfg.providers) || !cfg.providers.length) {
    cfg.providers = structuredClone(DEFAULT_CONFIG.providers);
    changed = true;
  }
  if ((Number(cfg.version) || 1) < 2) {
    if (!cfg.providers.some((p) => p.id === 'free')) {
      cfg.providers.unshift(structuredClone(FREE_PROVIDER));
    }
    cfg.version = 2;
    changed = true;
  }
  // v3：没配过真实 Key 的，默认走免费通道（Ollama 的占位 key 不算）
  if ((Number(cfg.version) || 1) < 3) {
    const hasRealKey = cfg.providers.some(
      (p) => p.id !== 'free' && p.apiKey && p.apiKey !== 'ollama'
    );
    const activeP = cfg.providers.find((p) => p.id === cfg.active?.providerId);
    if (!hasRealKey && activeP?.id !== 'free') {
      cfg.active = { providerId: 'free', model: 'openai-fast' };
    }
    cfg.version = 3;
    changed = true;
  }
  // v4：默认工作区改为应用自身目录（原来指向一个空文件夹，Agent 找不到代码）
  if ((Number(cfg.version) || 1) < 4) {
    const oldDefault = path.join(os.homedir(), 'awes-workspace');
    const cur = String(cfg.settings?.workspace || '');
    if (!cur || cur === oldDefault) {
      let empty = true;
      try {
        empty = fs.readdirSync(cur || oldDefault).length === 0;
      } catch {
        empty = true;
      }
      if (empty) cfg.settings.workspace = ROOT;
    }
    cfg.version = 4;
    changed = true;
  }
  // v5：免费通道标记为纯对话（工具调用不稳定）
  if ((Number(cfg.version) || 1) < 5) {
    const f = cfg.providers.find((p) => p.id === 'free');
    if (f) f.noTools = true;
    cfg.version = 5;
    changed = true;
  }
  // v6：加入「全权 / 工作区」两种模式 + 首次引导标记
  if ((Number(cfg.version) || 1) < 6) {
    if (!cfg.settings.mode) cfg.settings.mode = 'workspace';
    if (cfg.settings.onboarded === undefined) cfg.settings.onboarded = false;
    cfg.version = 6;
    changed = true;
  }
  // v7：默认只留免费通道，清理掉没配过 Key 的预置服务商
  if ((Number(cfg.version) || 1) < 7) {
    const PRESET_IDS = new Set(['deepseek', 'openai', 'anthropic', 'ollama', 'custom']);
    const isDefaultOllama = (p) =>
      p.id === 'ollama' &&
      /^https?:\/\/127\.0\.0\.1:11434/.test(p.baseURL || '') &&
      (p.models || []).length === 1 &&
      p.models[0]?.id === 'qwen2.5-coder:7b';
    cfg.providers = (cfg.providers || []).filter(
      (p) => p.free || !PRESET_IDS.has(p.id) || (p.apiKey && !isDefaultOllama(p))
    );
    if (!cfg.providers.some((p) => p.id === 'free')) {
      cfg.providers.unshift(structuredClone(FREE_PROVIDER));
    }
    if (!cfg.providers.some((p) => p.id === cfg.active?.providerId)) {
      const first = cfg.providers.find((p) => p.models?.length);
      if (first) cfg.active = { providerId: first.id, model: first.models[0].id };
    }
    cfg.version = 7;
    changed = true;
  }
  return changed;
}

export function getConfig() {
  ensureDirs();
  if (cache) return cache;
  if (!fs.existsSync(CONFIG_FILE)) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.settings.workspace = defaultWorkspace();
    writeConfigFile(cfg);
    cache = cfg;
    return cfg;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cache = deepMerge(structuredClone(DEFAULT_CONFIG), raw);
    decryptProviders(cache); // 密文 → 明文，进内存
    const needMigrate = migrate(cache);
    // 迁移过、或者发现还有明文 Key，就顺手加密写回（一次性迁移）
    const hasPlainKey = (cache.providers || []).some(
      (p) => p.apiKey && !String(p.apiKey).startsWith(ENC_PREFIX)
    );
    if (needMigrate || hasPlainKey) writeConfigFile(cache);
  } catch {
    cache = structuredClone(DEFAULT_CONFIG);
    cache.settings.workspace = defaultWorkspace();
  }
  return cache;
}

export function saveConfig(patch) {
  const cfg = getConfig();
  const next = deepMerge(cfg, patch || {});
  cache = next;
  writeConfigFile(next); // 落盘时加密 apiKey
  return next;
}

export function publicConfig() {
  const cfg = getConfig();
  // 打码 API Key，前端只显示末四位
  return {
    ...cfg,
    appDir: ROOT,
    home: os.homedir(),
    providers: cfg.providers.map((p) => ({
      ...p,
      apiKey: '',
      hasKey: !!p.apiKey,
      keyHint: p.apiKey ? '••••' + p.apiKey.slice(-4) : '',
    })),
    prompts: allPrompts(),
  };
}

export function getProvider(providerId) {
  const cfg = getConfig();
  return cfg.providers.find((p) => p.id === providerId) || null;
}

/* ---------------- 提示词模板 ---------------- */

export function allPrompts() {
  const cfg = getConfig();
  const overrides = new Map(cfg.prompts.map((p) => [p.id, p]));
  const out = [];
  for (const b of BUILTIN_PROMPTS) {
    out.push(overrides.has(b.id) ? { ...b, ...overrides.get(b.id), builtin: true } : { ...b, builtin: true });
    overrides.delete(b.id);
  }
  for (const p of overrides.values()) out.push({ ...p, builtin: false });
  return out;
}

export function getPrompt(id) {
  return allPrompts().find((p) => p.id === id) || BUILTIN_PROMPTS[0];
}

export function upsertPrompt(prompt) {
  const cfg = getConfig();
  const id = prompt.id || 'p_' + crypto.randomBytes(4).toString('hex');
  const list = cfg.prompts.slice();
  const idx = list.findIndex((p) => p.id === id);
  const rec = { ...prompt, id };
  if (idx >= 0) list[idx] = { ...list[idx], ...rec };
  else list.push(rec);
  saveConfig({ prompts: list });
  return getPrompt(id);
}

export function deletePrompt(id) {
  const cfg = getConfig();
  const builtin = BUILTIN_PROMPTS.some((p) => p.id === id);
  const list = cfg.prompts.filter((p) => p.id !== id);
  saveConfig({ prompts: list });
  // 内置模板的"删除"= 恢复默认（移除覆盖）
  return { ok: true, restored: builtin };
}

/* ---------------- 变量渲染 ---------------- */

export function renderPrompt(text, ctx = {}) {
  const cfg = getConfig();
  const now = new Date();
  const vars = {
    workspace: ctx.workspace || cfg.settings.workspace || '',
    date: now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    model: ctx.model || cfg.active.model || '',
    provider: ctx.provider || '',
    ...(cfg.vars || {}),
    ...(ctx.vars || {}),
  };
  return String(text || '').replace(/\{\{\s*([\w\u4e00-\u9fa5-]+)\s*\}\}/g, (m, k) => {
    if (k in vars && vars[k] !== '' && vars[k] != null) return String(vars[k]);
    return m;
  });
}

/* ---------------- 会话 ---------------- */

export function sessionPath(id) {
  return path.join(SESSION_DIR, `${id}.json`);
}

export function createSession(init = {}) {
  const cfg = getConfig();
  const id = 's_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const now = new Date().toISOString();
  const s = {
    id,
    title: init.title || '新会话',
    createdAt: now,
    updatedAt: now,
    workspace: init.workspace || cfg.settings.workspace,
    promptId: init.promptId || cfg.activePromptId,
    providerId: init.providerId || cfg.active.providerId,
    model: init.model || cfg.active.model,
    messages: [],
    usage: { promptTokens: 0, completionTokens: 0 },
  };
  writeSession(s);
  return s;
}

export function writeSession(s) {
  ensureDirs();
  s.updatedAt = new Date().toISOString();
  const tmp = sessionPath(s.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, sessionPath(s.id));
  return s;
}

export function readSession(id) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export async function listSessions() {
  ensureDirs();
  const files = await fsp.readdir(SESSION_DIR);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(await fsp.readFile(path.join(SESSION_DIR, f), 'utf8'));
      out.push({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        model: s.model,
        messageCount: (s.messages || []).length,
        workspace: s.workspace,
      });
    } catch {}
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

export function deleteSession(id) {
  const p = sessionPath(id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { ok: true };
}
