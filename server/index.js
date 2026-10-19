import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ROOT, DATA_DIR, SESSION_DIR, getConfig, saveConfig, publicConfig, getProvider, allPrompts,
  getPrompt, upsertPrompt, deletePrompt, renderPrompt,
  createSession, readSession, writeSession, listSessions, deleteSession,
} from './lib/store.js';
import { runAgentTurn, buildSystemPrompt } from './lib/agent.js';
import { TOOL_DEFS, cleanupTrash } from './lib/tools/index.js';
import { joinURL } from './lib/llm/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(ROOT, 'web');
/** 运行日志：exe 没有控制台，启动信息和服务端日志都落到这里 */
const APP_LOG = path.join(DATA_DIR, 'app.log');
/** 是否单文件 exe 模式，首次查询时确定 */
let PACKAGED = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const activeRuns = new Map(); // sessionId -> { controller, res }
const pendingConfirms = new Map(); // token -> { resolve, timer }
const liveClients = new Set(); // 热更新 SSE 连接

/* --------------------------- 磁盘探测 --------------------------- */

let diskCache = null;
let diskCacheAt = 0;

function runQuiet(cmd, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || ''));
    });
  });
}

/** 列出本地固定磁盘及剩余空间（Windows 走 CIM，其他平台暂返回空） */
async function listDisks() {
  if (diskCache && Date.now() - diskCacheAt < 60000) return diskCache;
  if (process.platform !== 'win32') {
    diskCache = [];
    diskCacheAt = Date.now();
    return diskCache;
  }
  try {
    const out = await runQuiet('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress',
    ]);
    let data = JSON.parse(String(out).trim() || '[]');
    if (!Array.isArray(data)) data = [data];
    diskCache = data
      .map((d) => ({
        drive: String(d.DeviceID || '').toUpperCase(),
        total: Number(d.Size) || 0,
        free: Number(d.FreeSpace) || 0,
      }))
      .filter((d) => d.drive && d.total > 0);
  } catch {
    diskCache = [];
  }
  diskCacheAt = Date.now();
  return diskCache;
}

/* --------------------------- 前端文件热更新 --------------------------- */

function startWebWatcher() {
  let timer = null;
  const pending = new Set();
  try {
    fs.watch(WEB_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const f = String(filename).replace(/\\/g, '/');
      if (f.includes('.tmp') || f.endsWith('~') || f.startsWith('.')) return;
      pending.add(f);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pending];
        pending.clear();
        const payload = `data: ${JSON.stringify({ type: 'change', files, at: Date.now() })}\n\n`;
        for (const res of liveClients) {
          try {
            res.write(payload);
          } catch {}
        }
      }, 150);
    });
    console.log('  已监听 web/，改完文件界面会自动更新');
  } catch (e) {
    console.warn('  文件监听启动失败：' + e.message);
  }
}

/* ----------------------------- helpers ----------------------------- */

/** 默认端口，仅作 server.address() 拿不到时的兜底 */
let ACTUAL_PORT = Number(process.env.PORT) || 4173;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * /api 来源校验。port 传服务实际监听端口。
 * 挡住两类攻击：
 *  - CSRF：用户浏览器里任意网页用 JS 冒充调用本机接口
 *  - DNS rebinding：外网域名解析到 127.0.0.1，借此读取本机服务响应
 * 返回 'ok' 放行；'bad-host' Host 头不对；'bad-origin' Origin 不被允许。
 */
function checkLocalOrigin(req, port) {
  // 1) Host 头必须是 127.0.0.1:<port> 或 localhost:<port>
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'bad-host';

  // 2) 有 Origin 才校验；curl / 本机工具 / 同源导航没有 Origin，直接放行
  const origin = req.headers.origin;
  if (!origin) return 'ok';

  let u;
  try {
    u = new URL(origin);
  } catch {
    return 'bad-origin';
  }
  if (!LOCAL_HOSTS.has(u.hostname.toLowerCase())) return 'bad-origin';

  // 端口必须等于服务实际端口（Origin 省略端口时按协议默认端口算）
  const op = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (op !== port) return 'bad-origin';

  return 'ok';
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.socket) res.socket.setNoDelay(true);
  let closed = false;
  const timer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);
  return {
    send(ev) {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try {
        res.end();
      } catch {}
    },
  };
}

function autoTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '新会话';
  return t.length > 22 ? t.slice(0, 22) + '…' : t;
}

/* ----------------------------- static ----------------------------- */

async function serveStatic(req, res, pathname) {
  let relPath = decodeURIComponent(pathname);
  if (relPath === '/' || relPath === '') relPath = '/index.html';
  const abs = path.join(WEB_DIR, relPath);
  const rel = path.relative(WEB_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': st.size,
    });
    fs.createReadStream(abs).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

/* ----------------------------- API ----------------------------- */

async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const method = req.method || 'GET';
  const cfg = getConfig();

  // ---- config ----
  if (p === '/config' && method === 'GET') {
    return json(res, 200, {
      config: publicConfig(),
      tools: TOOL_DEFS.map((t) => ({ name: t.function.name, description: t.function.description })),
    });
  }

  if (p === '/config' && (method === 'PATCH' || method === 'POST')) {
    const patch = await readBody(req);
    // 处理 provider 的 apiKey：空字符串表示不改，__CLEAR__ 表示清空
    if (patch.providers) {
      const existing = new Map(cfg.providers.map((x) => [x.id, x]));
      patch.providers = patch.providers.map((np) => {
        const old = existing.get(np.id);
        let key = np.apiKey;
        if (key === '__CLEAR__') key = '';
        else if (key === '' || key == null) key = old?.apiKey || '';
        return { ...np, apiKey: key };
      });
    }
    const next = saveConfig(patch);
    return json(res, 200, { config: publicConfig(), ok: true });
  }

  // ---- 实时拉取服务商可用模型列表 ----
  if (p === '/fetch-models' && method === 'POST') {
    const body = await readBody(req);
    // 优先按 providerId 找已保存的配置（前端拿不到真 Key，publicConfig 抹空了）
    const provider = (body.providerId ? getProvider(body.providerId) : null) || body.provider;
    if (!provider?.baseURL) return json(res, 400, { error: '未配置 baseURL' });
    if (provider.format === 'anthropic') {
      return json(res, 200, { ok: false, error: 'Anthropic 原生接口不提供模型列表，请手动添加' });
    }
    // 前端可能刚改过 baseURL / Key 还没保存，允许覆盖
    const baseURL = String(body.baseURL || provider.baseURL).trim();
    const apiKey = body.apiKey || provider.apiKey || '';
    const base = baseURL.replace(/\/+$/, '').split('?')[0];
    const headers = { ...(provider.headers || {}) };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const t0 = Date.now();
    try {
      const r = await fetch(joinURL(base, '/models'), { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}（这个端点不开放模型列表）`);
      const data = await r.json();
      const models = (data.data || data.models || [])
        .map((m) => (typeof m === 'string' ? m : m.id || m.name))
        .filter(Boolean)
        .slice(0, 400);
      if (!models.length) throw new Error('服务端返回了空列表');
      return json(res, 200, { ok: true, models, ms: Date.now() - t0 });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, ms: Date.now() - t0 });
    }
  }

  // ---- 切换当前模型（可同时把模型加进 provider）----
  if (p === '/set-active' && method === 'POST') {
    const { providerId, model, models } = await readBody(req);
    const cf = getConfig();
    const idx = cf.providers.findIndex((p) => p.id === providerId);
    if (idx < 0) return json(res, 404, { error: '服务商不存在' });
    if (Array.isArray(models) && models.length) cf.providers[idx].models = models;
    saveConfig({ active: { providerId, model }, providers: cf.providers });
    return json(res, 200, { ok: true, config: publicConfig() });
  }

  // ---- 磁盘信息：引导时用来挑一个不占 C 盘的位置 ----
  if (p === '/disks' && method === 'GET') {
    const disks = await listDisks();
    // 排除 C 盘、至少留 2GB 空间，取剩余最多的
    const best =
      disks
        .filter((d) => !/^C:/i.test(d.drive) && d.free > 2 * 1024 ** 3)
        .sort((a, b) => b.free - a.free)[0] || null;
    return json(res, 200, {
      disks,
      suggested: best ? `${best.drive}\\awes-workspace` : '',
      suggestedDrive: best?.drive || '',
      suggestedFree: best?.free || 0,
    });
  }

  // ---- 首次引导：确定 AI 的活动范围 ----
  if (p === '/onboard' && method === 'POST') {
    const body = await readBody(req);
    const mode = body.mode === 'full' ? 'full' : 'workspace';
    const patch = { settings: { mode, onboarded: true } };

    if (mode === 'workspace') {
      const dir = String(body.workspace || '').trim();
      if (!dir) return json(res, 400, { error: '请先选一个工作区目录' });
      const abs = path.resolve(dir);
      try {
        const st = await fsp.stat(abs);
        if (!st.isDirectory()) return json(res, 400, { error: '这不是一个目录' });
      } catch {
        try {
          await fsp.mkdir(abs, { recursive: true });
        } catch (e) {
          return json(res, 400, { error: '目录不可用：' + e.message });
        }
      }
      patch.settings.workspace = abs;
    } else {
      patch.settings.workspace = os.homedir();
    }

    saveConfig(patch);
    await syncSessionWorkspaces(patch.settings.workspace);
    return json(res, 200, { ok: true, config: publicConfig(), home: os.homedir() });
  }

  // ---- prompts ----
  if (p === '/prompts' && method === 'GET') {
    return json(res, 200, { prompts: allPrompts(), activePromptId: cfg.activePromptId });
  }

  if (p === '/prompts' && method === 'POST') {
    const body = await readBody(req);
    const saved = upsertPrompt(body.prompt || body);
    return json(res, 200, { prompt: saved, prompts: allPrompts() });
  }

  if (p.startsWith('/prompts/') && method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/prompts/'.length));
    deletePrompt(id);
    return json(res, 200, { ok: true, prompts: allPrompts() });
  }

  if (p === '/prompts/preview' && method === 'POST') {
    const { system, promptId, workspace, vars } = await readBody(req);
    const src = system != null ? system : getPrompt(promptId).system;
    const rendered = renderPrompt(src, { workspace: workspace || cfg.settings.workspace, vars });
    return json(res, 200, { rendered });
  }

  // ---- sessions ----
  if (p === '/sessions' && method === 'GET') {
    return json(res, 200, { sessions: await listSessions() });
  }

  if (p === '/sessions' && method === 'POST') {
    const body = await readBody(req);
    const s = createSession(body);
    return json(res, 200, { session: s });
  }

  if (p.startsWith('/sessions/')) {
    const id = decodeURIComponent(p.slice('/sessions/'.length).split('/')[0]);
    if (method === 'GET') {
      const s = readSession(id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      return json(res, 200, { session: s });
    }
    if (method === 'PATCH') {
      const s = readSession(id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      const patch = await readBody(req);
      for (const k of ['title', 'promptId', 'providerId', 'model', 'workspace']) {
        if (patch[k] !== undefined) s[k] = patch[k];
      }
      writeSession(s);
      return json(res, 200, { session: s });
    }
    if (method === 'DELETE') {
      activeRuns.get(id)?.controller.abort();
      deleteSession(id);
      return json(res, 200, { ok: true });
    }
    // 截断到指定下标：用于「重试 / 删除这一轮 / 清空对话」
    if (method === 'POST' && p.endsWith('/truncate')) {
      const s = readSession(id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      const body = await readBody(req);
      const idx = Math.max(0, Math.min(Number(body.index) || 0, s.messages.length));
      s.messages = s.messages.slice(0, idx);
      writeSession(s);
      return json(res, 200, { session: s });
    }
  }

  // ---- chat (SSE) ----
  if (p === '/chat' && method === 'POST') {
    const body = await readBody(req);
    let session = body.sessionId ? readSession(body.sessionId) : null;
    if (!session) session = createSession({});

    const providerId = body.providerId || session.providerId;
    const provider = getProvider(providerId);
    const model = body.model || session.model;
    const params = { ...cfg.params, ...(body.params || {}) };

    if (body.promptId) session.promptId = body.promptId;
    if (body.providerId) session.providerId = body.providerId;
    if (model) session.model = model;
    if (body.workspace) session.workspace = body.workspace;

    const isFirst = session.messages.filter((m) => m.role === 'user').length === 0;
    if (isFirst) session.title = autoTitle(body.text);

    const stream = sse(res);
    const controller = new AbortController();
    activeRuns.set(session.id, { controller, res });

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      activeRuns.delete(session.id);
      try {
        writeSession(session);
      } catch {}
      stream.close();
    };

    // 客户端断开：中断 Agent。注意要区分「响应正常结束」和「连接被掐断」
    res.on('close', () => {
      if (!finished && !res.writableEnded) {
        controller.abort();
        finish();
      }
    });

    stream.send({ type: 'session', session: { id: session.id, title: session.title, workspace: session.workspace, model: session.model, promptId: session.promptId, providerId: session.providerId } });

    const confirm = ({ tool, args }) =>
      new Promise((resolve) => {
        const token = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingConfirms.delete(token);
          resolve(false);
        }, 300000);
        pendingConfirms.set(token, { resolve, timer });
        stream.send({ type: 'confirm_request', token, name: tool, args });
      });

    try {
      await runAgentTurn({
        session,
        userText: String(body.text || ''),
        provider,
        model,
        params,
        emit: (ev) => stream.send(ev),
        signal: controller.signal,
        confirm,
      });
      stream.send({ type: 'done', session: { id: session.id, title: session.title } });
    } catch (e) {
      if (e.name === 'AbortError' || controller.signal.aborted) {
        stream.send({ type: 'aborted' });
      } else {
        stream.send({ type: 'error', message: e.message || String(e) });
      }
    } finally {
      finish();
    }
    return;
  }

  if (p === '/stop' && method === 'POST') {
    const { sessionId } = await readBody(req);
    const run = activeRuns.get(sessionId);
    if (run) {
      run.controller.abort();
      return json(res, 200, { ok: true, stopped: true });
    }
    return json(res, 200, { ok: true, stopped: false });
  }

  if (p === '/confirm' && method === 'POST') {
    const { token, allow } = await readBody(req);
    const rec = pendingConfirms.get(token);
    if (!rec) return json(res, 200, { ok: false, reason: '已超时或不存在' });
    clearTimeout(rec.timer);
    pendingConfirms.delete(token);
    rec.resolve(!!allow);
    return json(res, 200, { ok: true });
  }

  // ---- 预览 system prompt ----
  if (p === '/preview-system' && method === 'POST') {
    const { sessionId, promptId, providerId, model } = await readBody(req);
    const s = sessionId ? readSession(sessionId) : null;
    const session = s || { workspace: cfg.settings.workspace, promptId: promptId || cfg.activePromptId };
    if (promptId) session.promptId = promptId;
    const provider = getProvider(providerId || cfg.active.providerId);
    const text = buildSystemPrompt({ session, provider, model: model || cfg.active.model, cfg });
    return json(res, 200, { system: text });
  }

  // ---- 文件系统（只读浏览）----
  if (p === '/fs/tree' && method === 'GET') {
    const ws = url.searchParams.get('workspace') || cfg.settings.workspace;
    const sub = url.searchParams.get('path') || '.';
    try {
      return json(res, 200, { tree: await readTree(ws, sub) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (p === '/fs/file' && method === 'GET') {
    const ws = url.searchParams.get('workspace') || cfg.settings.workspace;
    const relPath = url.searchParams.get('path') || '';
    try {
      const abs = safeJoin(ws, relPath);
      const st = await fsp.stat(abs);
      if (st.size > 1_500_000) return json(res, 400, { error: '文件过大，无法预览' });
      const content = await fsp.readFile(abs, 'utf8');
      return json(res, 200, { path: relPath, content, size: st.size });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (p === '/fs/workspace' && method === 'POST') {
    const { path: dir } = await readBody(req);
    const raw = String(dir || '').trim();
    if (!raw) return json(res, 400, { error: '路径不能为空' });
    const abs = path.resolve(raw);

    let created = false;
    try {
      const st = await fsp.stat(abs);
      if (!st.isDirectory()) return json(res, 400, { error: '这是一个文件，不是目录' });
    } catch {
      // 不存在就建一个
      try {
        await fsp.mkdir(abs, { recursive: true });
        created = true;
      } catch (e) {
        return json(res, 400, { error: '目录不存在，而且创建失败：' + e.message });
      }
    }

    saveConfig({ settings: { workspace: abs, mode: 'workspace' } });
    await syncSessionWorkspaces(abs);
    return json(res, 200, { ok: true, workspace: abs, created });
  }

  // ---- 测试模型连接 ----
  if (p === '/probe' && method === 'POST') {
    const body = await readBody(req);
    const provider = body.provider || getProvider(body.providerId);
    if (!provider?.baseURL) return json(res, 400, { error: '未配置 baseURL' });
    const t0 = Date.now();
    const base = String(provider.baseURL).replace(/\/+$/, '').split('?')[0];
    const headers = { 'Content-Type': 'application/json', ...(provider.headers || {}) };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

    try {
      if (provider.format === 'anthropic') {
        const model = body.model || provider.models?.[0]?.id;
        if (!model) throw new Error('先填一个模型 ID 再测试');
        const r = await fetch(joinURL(base, '/messages'), {
          method: 'POST',
          headers: {
            ...headers,
            'anthropic-version': '2023-06-01',
            'x-api-key': provider.apiKey || '',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
        });
        const txt = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 240)}`);
        return json(res, 200, {
          ok: true,
          ms: Date.now() - t0,
          models: (provider.models || []).map((m) => m.id),
        });
      }

      // 1) 先试着拉模型列表（不是所有端点都开放）
      let models = [];
      let listErr = '';
      try {
        const r = await fetch(joinURL(base, '/models'), { headers });
        if (r.ok) {
          const data = await r.json();
          models = (data.data || data.models || [])
            .map((m) => (typeof m === 'string' ? m : m.id || m.name))
            .filter(Boolean)
            .slice(0, 400);
        } else {
          listErr = `HTTP ${r.status}`;
        }
      } catch (e) {
        listErr = e.message;
      }

      // 2) 无论如何真发一次对话，确认能出字
      const model = body.model || provider.models?.[0]?.id || models[0];
      if (!model) throw new Error('还没有模型 ID，先在模型列表里加一个再测。');
      const cr = await fetch(joinURL(base, '/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 8,
          stream: false,
        }),
      });
      const ctxt = await cr.text();
      if (!cr.ok) throw new Error(`对话测试失败 HTTP ${cr.status}: ${ctxt.slice(0, 240)}`);
      let cjson = null;
      try {
        cjson = JSON.parse(ctxt);
      } catch {}
      if (cjson?.error) {
        const m = typeof cjson.error === 'string' ? cjson.error : cjson.error.message;
        throw new Error(String(m || JSON.stringify(cjson.error)).slice(0, 240));
      }

      return json(res, 200, {
        ok: true,
        ms: Date.now() - t0,
        models,
        note: listErr ? `该端点不开放模型列表（${listErr}），已用一次对话验证连通` : '',
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, ms: Date.now() - t0 });
    }
  }

  // ---- 导出会话 ----
  if (p === '/export' && method === 'GET') {
    const id = url.searchParams.get('sessionId');
    const s = readSession(id);
    if (!s) return json(res, 404, { error: '会话不存在' });
    const md = toMarkdown(s);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="awes-${id}.md"`,
    });
    return res.end(md);
  }

  if (p === '/health') return json(res, 200, { ok: true, version: '0.1.0' });

  // ---- 运行状态与日志（设置 → 后台）----
  // 打包成 exe 后没有控制台窗口，启动信息和服务端日志都写进 data/app.log，
  // 这里把它读出来给前端看。
  if (p === '/runtime' && method === 'GET') {
    if (PACKAGED === null) {
      try {
        const sea = await import('node:sea');
        PACKAGED = typeof sea.isSea === 'function' && sea.isSea();
      } catch {
        PACKAGED = false;
      }
    }
    let logSize = 0;
    try {
      logSize = fs.statSync(APP_LOG).size;
    } catch {}
    return json(res, 200, {
      ok: true,
      version: '0.1.0',
      node: process.version,
      pid: process.pid,
      port: ACTUAL_PORT,
      uptime: Math.round(process.uptime()),
      dataDir: DATA_DIR,
      logFile: APP_LOG,
      logSize,
      packaged: PACKAGED,
    });
  }

  if (p === '/logs' && method === 'GET') {
    const n = Math.min(Math.max(Number(url.searchParams.get('lines')) || 400, 20), 3000);
    let text = '';
    let size = 0;
    try {
      size = fs.statSync(APP_LOG).size;
      // 只读尾部 512KB，日志再大也不会卡住
      const from = Math.max(0, size - 512 * 1024);
      const fd = fs.openSync(APP_LOG, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch {}
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return json(res, 200, { ok: true, path: APP_LOG, size, lines: lines.slice(-n) });
  }

  if (p === '/logs' && method === 'DELETE') {
    try {
      fs.writeFileSync(APP_LOG, '');
    } catch {}
    return json(res, 200, { ok: true });
  }

  // ---- 在系统文件管理器里打开目录 ----
  if (p === '/open-dir' && method === 'POST') {
    const body = await readBody(req);
    const raw = String(body.path || '');
    const target = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
    const allowed = [ROOT, DATA_DIR, cfg.settings.workspace, os.homedir()]
      .filter(Boolean)
      .map((x) => path.resolve(x));
    if (!allowed.some((a) => target === a || target.startsWith(a + path.sep))) {
      return json(res, 403, { error: '只能打开应用目录或工作区' });
    }
    if (!fs.existsSync(target)) return json(res, 400, { error: '目录不存在' });
    const cmd =
      process.platform === 'win32'
        ? `explorer.exe "${target}"`
        : process.platform === 'darwin'
          ? `open "${target}"`
          : `xdg-open "${target}"`;
    exec(cmd, () => {});
    return json(res, 200, { ok: true });
  }

  // ---- 前端热更新事件流 ----
  if (p === '/watch' && method === 'GET') {
    const stream = sse(res);
    stream.send({ type: 'hello' });
    liveClients.add(res);
    const cleanup = () => {
      liveClients.delete(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return;
  }

  return json(res, 404, { error: 'Unknown API: ' + p });
}

/* ----------------------------- fs helpers ----------------------------- */

function safeJoin(ws, relPath) {
  const root = path.resolve(ws || '.');
  const abs = path.resolve(root, relPath || '.');
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径超出工作区');
  return abs;
}

const IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv',
  'venv', 'target', 'vendor', '.idea', '.vscode', 'coverage', '.cache',
]);

async function readTree(ws, sub = '.', depth = 0) {
  const abs = safeJoin(ws, sub);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries.slice(0, 300)) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (e.isDirectory() && IGNORE.has(e.name)) continue;
    const relPath = path.relative(path.resolve(ws), path.join(abs, e.name)).split(path.sep).join('/');
    const node = { name: e.name, path: relPath, type: e.isDirectory() ? 'dir' : 'file' };
    if (e.isDirectory() && depth < 2) {
      try {
        node.children = await readTree(ws, relPath, depth + 1);
      } catch {
        node.children = [];
      }
    } else if (e.isDirectory()) {
      node.children = null; // 懒加载
    }
    out.push(node);
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out;
}

function toMarkdown(s) {
  const lines = [`# ${s.title}`, '', `- 模型：${s.model}`, `- 工作区：${s.workspace}`, `- 创建：${s.createdAt}`, '', '---', ''];
  for (const m of s.messages) {
    if (m.role === 'user') lines.push(`## 🧑 用户`, '', m.content, '');
    else if (m.role === 'assistant') {
      if (m.content) lines.push(`## 🤖 助手`, '', m.content, '');
      for (const tc of m.tool_calls || []) {
        lines.push(`> 🔧 \`${tc.function.name}\` \`${(tc.function.arguments || '').slice(0, 200)}\``, '');
      }
    } else if (m.role === 'tool') {
      lines.push('<details><summary>工具结果</summary>', '', '```', String(m.content).slice(0, 2000), '```', '', '</details>', '');
    }
  }
  return lines.join('\n');
}

/* ----------------------------- server ----------------------------- */

export function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // /api 统一走来源校验，静态文件不受影响
    if (url.pathname.startsWith('/api/')) {
      const port = server.address()?.port || ACTUAL_PORT;
      if (checkLocalOrigin(req, port) !== 'ok') {
        return json(res, 403, { error: 'forbidden origin' });
      }
      // 只对通过校验的 Origin 回显，不再用通配符 *
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.setHeader('Vary', 'Origin');
      }
      // 预检同样已过校验，直接放行
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message || String(e) });
      else {
        try {
          res.end();
        } catch {}
      }
    }
  });
  return server;
}

/** 工作区是全局的：改了就把所有会话的 workspace 一起同步 */
async function syncSessionWorkspaces(dir) {
  if (!dir) return;
  try {
    for (const f of await fsp.readdir(SESSION_DIR)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(SESSION_DIR, f);
      try {
        const s = JSON.parse(await fsp.readFile(fp, 'utf8'));
        if (s.workspace !== dir) {
          s.workspace = dir;
          await fsp.writeFile(fp, JSON.stringify(s, null, 2), 'utf8');
        }
      } catch {}
    }
  } catch {}
}

/** 旧会话如果指着一个空目录，跟着配置一起搬到新工作区 */
async function fixLegacySessionWorkspaces() {
  const cfg = getConfig();
  const target = cfg.settings.workspace;
  if (!target) return;
  const isEmpty = (p) => {
    try {
      return fs.readdirSync(p).length === 0;
    } catch {
      return false;
    }
  };
  try {
    for (const f of await fsp.readdir(SESSION_DIR)) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(SESSION_DIR, f);
      try {
        const s = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (s.workspace && s.workspace !== target && isEmpty(s.workspace)) {
          s.workspace = target;
          await fsp.writeFile(file, JSON.stringify(s, null, 2), 'utf8');
        }
      } catch {}
    }
  } catch {}
}

/** 启动时探测本机 Ollama，有就自动接进模型列表 */
async function detectLocalOllama() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return;
    const data = await r.json();
    const models = (data.models || [])
      .map((m) => ({ id: m.name, name: m.name, contextWindow: 32768 }))
      .filter((m) => m.id);
    if (!models.length) return;

    const cfg = getConfig();
    const idx = cfg.providers.findIndex((p) => p.id === 'ollama');
    if (idx < 0) return;
    if (JSON.stringify(cfg.providers[idx].models) === JSON.stringify(models)) return;

    const providers = cfg.providers.slice();
    providers[idx] = { ...providers[idx], name: 'Ollama（本地·已连接）', models };
    saveConfig({ providers });
    console.log(`  检测到本地 Ollama，已接入 ${models.length} 个模型`);
  } catch {
    // 没装或没启动，忽略
  }
}

export async function startServer(port = Number(process.env.PORT) || 4173) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = server.address().port;
  ACTUAL_PORT = actual; // 兜底值，正常路径用 server.address() 拿端口
  fixLegacySessionWorkspaces();
  detectLocalOllama();
  startWebWatcher();
  cleanupTrash(30);
  return { server, port: actual, url: `http://127.0.0.1:${actual}` };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { url } = await startServer();
  console.log('');
  console.log('  \x1b[1mAwesEvo\x1b[0m');
  console.log('  ' + url);
  console.log('  数据目录: ' + DATA_DIR);
  console.log('');
}
