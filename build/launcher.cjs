'use strict';

/**
 * AwesEvo 启动器（SEA 单文件 exe 的入口）。
 *
 * 两种工作形态：
 *   portable —— exe 旁边就有 server/index.js：直接用它，配置和数据都在原地，
 *               放回项目目录即可无缝沿用原有 data/。
 *   bundled  —— 单独一个 exe：把内嵌的源码释放到 %LOCALAPPDATA%\AwesEvo\app，
 *               首次运行解压一次，之后靠 .build 标记跳过。
 *
 * 不依赖任何 npm 包，只用 Node 内置模块。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const BUILD = '20261019-1258';
const PORT = Number(process.env.PORT) || 4173;
const NO_OPEN = process.argv.includes('--no-open');

const say = (s) => console.log(s);

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

/** 决定用哪份源码：优先 exe 同级目录（绿色版），否则释放到用户目录 */
function resolveAppDir() {
  const exeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(exeDir, 'server', 'index.js'))) {
    return { dir: exeDir, mode: 'portable' };
  }
  return { dir: path.join(localAppData(), 'AwesEvo', 'app'), mode: 'bundled' };
}

/**
 * 把 console 输出同时写进 data/app.log。
 * exe 是 GUI 子系统，没有控制台窗口，日志文件就是唯一的排查线索，
 * 设置 → 后台 那个页面读的就是它。
 */
function setupFileLog(dir) {
  const dataDir = path.join(dir, 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    /* 目录建不了就放弃落盘 */
  }
  const logPath = path.join(dataDir, 'app.log');

  // 超过 2MB 轮转一次，别让它无限长
  try {
    if (fs.statSync(logPath).size > 2 * 1024 * 1024) fs.renameSync(logPath, logPath + '.1');
  } catch {
    /* 文件不存在，正常 */
  }

  let stream;
  try {
    stream = fs.createWriteStream(logPath, { flags: 'a' });
  } catch {
    return logPath;
  }

  // GUI 子系统下 stdout 句柄无效，写入会异步报错，吞掉即可
  try {
    process.stdout?.on?.('error', () => {});
  } catch {}
  try {
    process.stderr?.on?.('error', () => {});
  } catch {}

  const pad = (n) => String(n).padStart(2, '0');
  const stamp = () => {
    const d = new Date();
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  };
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

  const wrap = (fn) => (...args) => {
    let text = '';
    try {
      text = args
        .map((a) => {
          if (typeof a === 'string') return a;
          if (a instanceof Error) return a.stack || a.message;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
    } catch {
      text = '(日志参数无法序列化)';
    }
    try {
      stream.write(`[${stamp()}] ${strip(text)}\n`);
    } catch {
      /* 磁盘满了也不该让主流程挂掉 */
    }
    try {
      fn(...args);
    } catch {
      /* 没有控制台时 stdout 写入会失败，忽略 */
    }
  };

  console.log = wrap(console.log.bind(console));
  console.error = wrap(console.error.bind(console));
  console.warn = wrap(console.warn.bind(console));
  return logPath;
}

/** 释放内嵌源码。返回释放的文件数，0 表示已是最新 */
function extractAssets(dir) {
  const sea = require('node:sea');
  if (typeof sea.isSea !== 'function' || !sea.isSea()) {
    throw new Error('当前不是单文件模式，且同级目录没有源码');
  }
  const marker = path.join(dir, '.build');
  try {
    if (fs.readFileSync(marker, 'utf8').trim() === BUILD) return 0;
  } catch {
    /* 首次运行，没有标记 */
  }
  const keys = sea.getAssetKeys();
  for (const key of keys) {
    const dest = path.join(dir, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(sea.getRawAsset(key)));
  }
  fs.writeFileSync(marker, BUILD);
  return keys.length;
}

/** 探测本端口上是否已经有一个 AwesEvo 在跑 */
function ping(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).ok === true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

const WINDOW_SIZE = '1320x880';

/** 找一个支持 --app 的 Chromium 内核浏览器 */
function findBrowser() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* 忽略不可访问的路径 */
    }
  }
  return null;
}

/**
 * 开一个应用窗口：--app 模式没有地址栏、标签页、书签栏，
 * 任务栏里是独立窗口，关掉窗口进程就退出。
 * 用独立 profile，避免和用户日常浏览的窗口混在一起。
 */
function openAppWindow(url, profileDir) {
  const exe = findBrowser();
  if (!exe) return null;
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch {
    /* 建不了目录就让浏览器自己处理 */
  }
  try {
    const child = spawn(
      exe,
      [
        '--app=' + url,
        '--window-size=' + WINDOW_SIZE,
        '--user-data-dir=' + profileDir,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
      ],
      // detached：Edge 主进程会立刻把活交给子进程再自己退出，
      // 不分离的话 launcher 退出会把它一起带走
      { stdio: 'ignore', detached: true }
    );
    child.unref();
    return child;
  } catch {
    return null;
  }
}

/** 兜底：系统默认浏览器（会带地址栏，总比打不开强） */
function openDefaultBrowser(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {
    /* 打不开就算了，地址已经打印出来了 */
  }
}

let LOG_PATH = '';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 启动失败时的兜底。
 * GUI 子系统没有控制台，出错时用户什么都看不到，
 * 所以把原因和日志尾部写成一张临时页面打开。
 */
function showFatal(message) {
  let tail = '';
  try {
    tail = fs.readFileSync(LOG_PATH, 'utf8').split(/\r?\n/).slice(-40).join('\n');
  } catch {
    tail = '(读不到日志)';
  }
  const html = `<!doctype html><meta charset="utf-8"><title>AwesEvo 启动失败</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:36px;max-width:920px;margin:0 auto;color:#1f2937;line-height:1.7}
h1{color:#b4432f;font-size:20px;margin:0 0 6px}
h3{font-size:14px;margin:24px 0 8px;color:#374151}
pre{background:#f6f7f9;border:1px solid #e5e7eb;padding:14px 16px;border-radius:8px;overflow:auto;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-all}
code{background:#f0f1f3;padding:1px 5px;border-radius:4px;font-size:12px}
p.sub{color:#6b7280;font-size:13px;margin:0}
</style>
<h1>AwesEvo 启动失败</h1>
<p class="sub">${escapeHtml(message)}</p>
<h3>最近的日志</h3>
<pre>${escapeHtml(tail || '(空)')}</pre>
<p class="sub" style="margin-top:18px">完整日志：<code>${escapeHtml(LOG_PATH)}</code></p>`;

  const tmp = path.join(os.tmpdir(), 'awesevo-error.html');
  try {
    fs.writeFileSync(tmp, html, 'utf8');
    openDefaultBrowser('file:///' + tmp.replace(/\\/g, '/'));
  } catch {
    /* 连错误页都写不出来就没办法了 */
  }
}

(async () => {
  const profileDir = path.join(localAppData(), 'AwesEvo', 'browser');

  // 已有实例：不再重复启动，直接把应用窗口拉起来
  if (await ping(PORT)) {
    const url = 'http://127.0.0.1:' + PORT;
    console.log('  已在运行，正在打开窗口');
    if (!NO_OPEN) {
      const w = openAppWindow(url, profileDir);
      if (!w) openDefaultBrowser(url);
    }
    setTimeout(() => process.exit(0), 1200);
    return;
  }

  const { dir, mode } = resolveAppDir();

  // 先接管日志，后面所有输出都会落盘
  LOG_PATH = setupFileLog(dir);
  console.log('');
  console.log('  AwesEvo  ' + BUILD);
  console.log('  ' + '-'.repeat(42));

  if (mode === 'bundled') {
    const n = extractAssets(dir);
    if (n) say('  已释放运行文件 ' + n + ' 个');
  } else {
    say('  使用同级目录的源码');
  }

  const entry = path.join(dir, 'server', 'index.js');
  if (!fs.existsSync(entry)) {
    console.error('  找不到服务入口：' + entry);
    process.exit(1);
  }

  const mod = await import(pathToFileURL(entry).href);

  let started;
  try {
    started = await mod.startServer(PORT);
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      const m = '端口 ' + PORT + ' 已被其他程序占用。关掉占用的程序，或用 PORT=8080 重新启动。';
      console.error('  ' + m);
      showFatal(m);
      process.exit(1);
    }
    throw e;
  }

  const stop = () => {
    try {
      started.server.close();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  say('  数据 ' + path.join(dir, 'data'));
  say('');

  if (NO_OPEN) {
    say('  地址 ' + started.url);
    say('  关闭此窗口即停止服务');
    say('');
    return;
  }

  const win = openAppWindow(started.url, profileDir);
  if (!win) {
    say('  没找到 Edge 或 Chrome，改用默认浏览器打开');
    openDefaultBrowser(started.url);
    say('');
    return;
  }

  say('  关闭应用窗口即退出');
  say('');

  /**
   * 判断窗口是否还开着，不能靠子进程退出事件——
   * Edge 的主进程把活交给子进程后自己就退了，那个事件会立刻触发。
   * 改成看连接数：窗口开着时页面会一直保持连接（SSE 长连），
   * 窗口一关连接归零，持续一段时间没连接就收摊。
   */
  let liveConns = 0;
  let everConnected = false;
  started.server.on('connection', (socket) => {
    liveConns++;
    everConnected = true;
    socket.once('close', () => {
      liveConns = Math.max(0, liveConns - 1);
    });
  });

  const openedAt = Date.now();
  const IDLE_MS = 15000; // 连接归零后等这么久
  const NEVER_CONNECT_MS = 60000; // 一直没连上，认为窗口没起来
  let zeroSince = 0;

  const watchdog = setInterval(() => {
    if (liveConns > 0) {
      zeroSince = 0;
      return;
    }
    if (!everConnected) {
      if (Date.now() - openedAt > NEVER_CONNECT_MS) {
        clearInterval(watchdog);
        stop();
      }
      return;
    }
    if (!zeroSince) {
      zeroSince = Date.now();
      return;
    }
    if (Date.now() - zeroSince > IDLE_MS) {
      clearInterval(watchdog);
      stop();
    }
  }, 2000);
  watchdog.unref?.();
})().catch((e) => {
  const msg = e && e.stack ? e.stack : String(e);
  console.error('');
  console.error('  启动失败：');
  console.error(msg);
  console.error('');
  showFatal(msg);
  process.exitCode = 1;
});
