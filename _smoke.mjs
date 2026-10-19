/**
 * Awes Agent 冒烟测试
 * 覆盖：语法、模块导入、全部 API、12 个工具、安全校验、静态资源
 * 用法：node _smoke.mjs
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath; // 用当前运行的 node，换环境也不会指向别人机器上的路径

let pass = 0;
let fail = 0;
let skipped = 0;
const failed = [];
const ok = (name, extra = '') => {
  pass++;
  console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
};
const bad = (name, why = '') => {
  fail++;
  failed.push(name);
  console.log(`  ✗ ${name}${why ? '  ' + why : ''}`);
};
const skip = (name, why = '') => {
  skipped++;
  console.log(`  ⊘ ${name}${why ? '  ' + why : ''}（跳过）`);
};
const check = (name, cond, extra = '') => (cond ? ok(name, extra) : bad(name, extra));
const sec = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** 递归收集 JS 文件，不依赖 git（解压出来的干净副本也能跑） */
function listJsFiles(root) {
  const out = [];
  const skipDirs = new Set([
    'node_modules', '.git', 'data', 'dist', 'build', '_pkg', '_verify',
    '.playwright-cli', 'coverage', '.cache',
  ]);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skipDirs.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) out.push(path.relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

function isGitRepo(dir) {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 1. 语法 ---------------- */
sec('1. 语法检查');
{
  const files = listJsFiles(ROOT);
  let allOk = true;
  for (const f of files) {
    try {
      execSync(`"${NODE}" --check "${f}"`, { cwd: ROOT, stdio: 'pipe' });
    } catch {
      allOk = false;
      bad(`语法 ${f}`);
    }
  }
  if (allOk) ok(`${files.length} 个 JS 文件全部通过`);
}

/* ---------------- 2. 模块导入 ---------------- */
sec('2. 模块导入导出');
{
  const dirs = ['web/js', 'server', 'server/lib', 'server/lib/llm', 'server/lib/tools'];
  const exportsMap = {};
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.js'))) {
      const s = fs.readFileSync(path.join(abs, f), 'utf8');
      const names = new Set();
      for (const m of s.matchAll(
        /export\s+(?:async\s+)?function\s*\*\s*([\w$]+)|export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)/g
      ))
        names.add(m[1] || m[2]);
      for (const m of s.matchAll(/export\s*\{([^}]+)\}/g))
        m[1].split(',').forEach((x) => names.add(x.trim().split(/\s+as\s+/).pop().trim()));
      exportsMap[`${d}/${f}`] = names;
    }
  }
  let badCount = 0;
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.js'))) {
      const s = fs.readFileSync(path.join(abs, f), 'utf8');
      for (const m of s.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"]/g)) {
        for (const w of m[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split(/\s+as\s+/)[0])) {
          if (!exportsMap[`${d}/${m[2]}`]?.has(w)) {
            bad(`导入缺失 ${d}/${f} → ${w} @ ${m[2]}`);
            badCount++;
          }
        }
      }
    }
  }
  if (!badCount) ok('所有具名导入都能找到对应导出');
}

/* ---------------- 3. 起服务 ---------------- */
sec('3. 启动服务（随机端口）');
const mod = await import(pathToFileURL(path.join(ROOT, 'server/index.js')).href);
const srv = mod.createServer();
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BASE = `http://127.0.0.1:${PORT}/api`;
ok(`监听 127.0.0.1:${PORT}`);

const ORIGIN = { Origin: `http://127.0.0.1:${PORT}` };
const j = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const api = (p, opts = {}) => fetch(BASE + p, { ...opts, headers: { ...ORIGIN, ...(opts.headers || {}) } });
const raw = (hostHeader, p) =>
  new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write(`GET ${p} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    let b = '';
    s.on('data', (d) => (b += d));
    s.on('end', () => resolve(b));
  });

/* ---------------- 4. API ---------------- */
sec('4. API 接口');
{
  const r = await api('/health');
  check('GET /api/health', r.status === 200);

  const cfg = await j(await api('/config'));
  check('GET /api/config', r.status === 200 && cfg.config?.settings);
  check('工具数 = 12', cfg.tools?.length === 12, `实际 ${cfg.tools?.length}`);
  check('免费通道存在', cfg.config.providers.some((p) => p.free));

  const s = await j(await api('/sessions', { method: 'POST', body: JSON.stringify({ title: '冒烟测试' }), headers: { 'Content-Type': 'application/json' } }));
  check('POST /api/sessions', !!s.session?.id, s.session?.id);
  const SID = s.session.id;

  check('GET /api/sessions', (await api('/sessions')).status === 200);
  check('GET /api/sessions/:id', (await api('/sessions/' + SID)).status === 200);

  await api('/sessions/' + SID, { method: 'PATCH', body: JSON.stringify({ title: '冒烟测试2' }), headers: { 'Content-Type': 'application/json' } });
  const patched = await j(await api('/sessions/' + SID));
  check('PATCH /api/sessions/:id', patched.session.title === '冒烟测试2');

  const tr = await api('/sessions/' + SID + '/truncate', { method: 'POST', body: JSON.stringify({ index: 0 }), headers: { 'Content-Type': 'application/json' } });
  check('POST /api/sessions/:id/truncate', tr.status === 200);

  check('GET /api/fs/tree', (await api('/fs/tree?workspace=' + encodeURIComponent(cfg.config.settings.workspace))).status === 200);
  // 前端就是这样调的：workspace 与 path 都传
  check(
    'GET /api/fs/file',
    (await api(`/fs/file?workspace=${encodeURIComponent(ROOT)}&path=${encodeURIComponent('package.json')}`)).status === 200
  );

  const ws = await j(await api('/fs/workspace', { method: 'POST', body: JSON.stringify({ path: cfg.config.settings.workspace }), headers: { 'Content-Type': 'application/json' } }));
  check('POST /api/fs/workspace（原值，不改动）', ws.ok === true);

  const pr = await j(await api('/prompts'));
  check('GET /api/prompts', Array.isArray(pr.prompts) || Array.isArray(pr), `${(pr.prompts || pr || []).length} 个模板`);
  const list = pr.prompts || pr || [];
  check('内置模板在其中', list.some((p) => p.builtin));
  check('POST /api/prompts/preview', (await api('/prompts/preview', { method: 'POST', body: JSON.stringify({ id: 'builtin-coding', vars: {} }), headers: { 'Content-Type': 'application/json' } })).status === 200);

  const pb = await j(await api('/probe', { method: 'POST', body: JSON.stringify({ provider: cfg.config.providers[0] }), headers: { 'Content-Type': 'application/json' } }));
  check('POST /api/probe', pb.ok === true, pb.ok ? `${pb.ms}ms` : pb.error);

  const dk = await j(await api('/disks'));
  check('GET /api/disks', Array.isArray(dk.disks) && dk.disks.length > 0, `${dk.disks.length} 块盘，建议 ${dk.suggestedDrive || '无'}`);

  // 只有配了 Key 的服务商才测真实拉取；没配就跳过，不要记成失败
  const keyed = cfg.config.providers.find((p) => !p.free && p.hasKey);
  if (!keyed) {
    skip('POST /api/fetch-models（真实通道）', '没有配置带 Key 的服务商');
  } else {
    const fm = await j(
      await api('/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ providerId: keyed.id }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    if (!fm.ok) {
      // 网络不通 / 端点不开放模型列表，都不是代码问题
      skip('POST /api/fetch-models（真实通道）', fm.error);
    } else {
      ok('POST /api/fetch-models（真实通道）', `${fm.models.length} 个模型 ${fm.ms}ms`);
    }
  }

  // 越界路径按平台取，别拿 Windows 路径去测 Linux
  const outside = process.platform === 'win32' ? 'C:/Windows' : '/etc';
  const od = await api('/open-dir', {
    method: 'POST',
    body: JSON.stringify({ path: outside }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('POST /api/open-dir 拒绝越界目录', od.status === 403, `用 ${outside}`);

  const ex = await fetch(`http://127.0.0.1:${PORT}/api/export?sessionId=${SID}`, { headers: ORIGIN });
  check('GET /api/export', ex.status === 200);

  await api('/sessions/' + SID, { method: 'DELETE' });
  check('DELETE /api/sessions/:id', (await api('/sessions/' + SID)).status === 404);

  const w = await fetch(`http://127.0.0.1:${PORT}/api/watch`, { headers: ORIGIN });
  check('GET /api/watch（SSE）', w.status === 200 && (w.headers.get('content-type') || '').includes('event-stream'));
  w.body?.cancel();
}

/* ---------------- 5. 安全校验 ---------------- */
sec('5. 安全校验');
{
  const evil = await fetch(BASE + '/health', { headers: { Origin: 'https://evil.example.com' } });
  check('恶意 Origin → 403', evil.status === 403);
  check('403 响应体正确', (await evil.text()).trim() === '{"error":"forbidden origin"}');

  const noOrigin = await fetch(BASE + '/health');
  check('无 Origin 放行', noOrigin.status === 200);

  const good = await fetch(BASE + '/health', { headers: ORIGIN });
  check('合法 Origin 放行', good.status === 200);
  check('CORS 回显该 Origin', good.headers.get('access-control-allow-origin') === `http://127.0.0.1:${PORT}`);
  check('Vary: Origin', (good.headers.get('vary') || '').includes('Origin'));
  check('无 Origin 不发 CORS 头', !noOrigin.headers.get('access-control-allow-origin'));

  const pre = await fetch(BASE + '/health', { method: 'OPTIONS', headers: ORIGIN });
  check('OPTIONS 预检（合法）→ 204', pre.status === 204);
  const preBad = await fetch(BASE + '/health', { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } });
  check('OPTIONS 预检（恶意）→ 403', preBad.status === 403);

  const hosts = [
    ['evil.com', 403],
    ['evil.com:' + PORT, 403],
    ['127.0.0.1:9999', 403],
    ['localhost', 403],
    ['127.0.0.1:' + PORT, 200],
    ['localhost:' + PORT, 200],
  ];
  for (const [h, want] of hosts) {
    const out = await raw(h, '/api/health');
    const st = Number(/^HTTP\/1\.1 (\d+)/.exec(out)?.[1] || 0);
    check(`Host: ${h} → ${want}`, st === want, `实际 ${st}`);
  }
}

/* ---------------- 6. 12 个工具 ---------------- */
sec('6. 工具执行（12 个）');
{
  const WS = path.join(ROOT, 'data/_smoke');
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
  const ctx = { roots: [WS], workspace: WS, mode: 'workspace' };
  const T = async (name, args) => mod.__toolForTest ? null : (await import(pathToFileURL(path.join(ROOT, 'server/lib/tools/index.js')).href));

  const tools = await import(pathToFileURL(path.join(ROOT, 'server/lib/tools/index.js')).href);
  const run = async (name, args) => {
    const r = await tools.executeTool(name, args, ctx);
    return r;
  };

  const w = await run('write_file', { path: 'src/a.txt', content: 'hello\nworld\n' });
  check('write_file', w.ok === true, w.output.split('\n')[0]);

  const rd = await run('read_file', { path: 'src/a.txt' });
  check('read_file', rd.ok && rd.output.includes('hello'));

  const ed = await run('edit_file', { path: 'src/a.txt', old_string: 'world', new_string: 'awes' });
  check('edit_file', ed.ok && (await run('read_file', { path: 'src/a.txt' })).output.includes('awes'));

  const ld = await run('list_dir', { path: '.' });
  check('list_dir', ld.ok && ld.output.includes('src'));

  const gl = await run('glob', { pattern: '**/*.txt' });
  check('glob', gl.ok && gl.output.includes('a.txt'));

  const gp = await run('grep', { pattern: 'hello' });
  check('grep', gp.ok && gp.output.includes('a.txt'));

  const fi = await run('file_info', { path: 'src/a.txt' });
  check('file_info', fi.ok && fi.output.includes('大小'));

  const cp = await run('copy_file', { src: 'src/a.txt', dest: 'src/b.txt' });
  check('copy_file', cp.ok && fs.existsSync(path.join(WS, 'src/b.txt')));

  const mv = await run('move_file', { src: 'src/b.txt', dest: 'src/c.txt' });
  check('move_file', mv.ok && fs.existsSync(path.join(WS, 'src/c.txt')) && !fs.existsSync(path.join(WS, 'src/b.txt')));

  const cp2 = await run('copy_file', { src: 'src/a.txt', dest: 'src/c.txt' });
  check('copy_file 冲突拒绝', cp2.ok === false && cp2.output.includes('已存在'));

  const dl = await run('delete_file', { path: 'src/c.txt' });
  check('delete_file（回收站）', dl.ok === true && !fs.existsSync(path.join(WS, 'src/c.txt')), dl.output);

  const rc = await run('run_command', { command: 'echo smoke-ok' });
  check('run_command', rc.ok && rc.output.includes('smoke-ok'));

  const tw = await run('todo_write', { todos: [] });
  check('todo_write', tw.ok === true);

  const deny = await run('write_file', { path: '../../escape.txt', content: 'x' });
  check('路径穿越被拒', deny.ok === false);

  fs.rmSync(WS, { recursive: true, force: true });
}

/* ---------------- 7. 静态资源 ---------------- */
sec('7. 静态资源');
{
  for (const [p, type] of [
    ['/', 'text/html'],
    ['/index.html', 'text/html'],
    ['/css/app.css', 'text/css'],
    ['/js/app.js', 'javascript'],
    ['/js/ui-dialog.js', 'javascript'],
    ['/js/chat.js', 'javascript'],
    ['/js/sidebar.js', 'javascript'],
    ['/js/settings.js', 'javascript'],
    ['/js/inspector.js', 'javascript'],
  ]) {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
    check(`${p} → 200 ${type}`, r.status === 200 && (r.headers.get('content-type') || '').includes(type));
  }
  const miss = await fetch(`http://127.0.0.1:${PORT}/nope.js`);
  check('不存在文件 → 404', miss.status === 404);
}

/* ---------------- 8. git ---------------- */
sec('8. 版本控制');
{
  if (!isGitRepo(ROOT)) {
    skip('版本控制检查', '不在 git 仓库里（解压副本 / 干净目录）');
  } else {
    const st = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
    check('工作区干净（无未提交改动）', st === '', st ? st.slice(0, 80) : '');
    const n = execSync('git rev-list --count HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
    ok(`共 ${n} 个提交`);
    const ignored = execSync('git check-ignore -v data/config.json', { cwd: ROOT, encoding: 'utf8' }).trim();
    check('data/ 已被忽略（Key 不会入库）', ignored.includes('data/'), ignored.split('\n')[0]);
  }
}

srv.close();

/* ---------------- 汇总 ---------------- */
console.log(`\n${'='.repeat(46)}`);
if (fail === 0) {
  const tail = skipped ? `，${skipped} 项跳过` : '';
  console.log(`\x1b[32m✓ 全绿：${pass} 项通过，0 项失败${tail}\x1b[0m`);
} else {
  console.log(`\x1b[31m✗ ${fail} 项失败 / 共 ${pass + fail} 项${skipped ? `，${skipped} 项跳过` : ''}\x1b[0m`);
  failed.forEach((f) => console.log('   - ' + f));
}
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
