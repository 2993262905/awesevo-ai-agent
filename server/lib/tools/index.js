import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import { exec, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 应用自身根目录（awes-agent） */
const ROOT = path.resolve(__dirname, '../../..');
/** 兜底回收站：系统回收站不可用时的目录 */
const TRASH_DIR = path.resolve(ROOT, 'data/trash');

/** 应用自身的相对路径特征 */
const SELF_HINTS = ['web', 'server', 'package.json', '启动.bat', 'readme.md'];

const MAX_READ = 400_000; // 单次读取字符上限
const MAX_OUT = 24_000; // 工具结果回传给模型的上限
const MAX_GREP_FILES = 400;
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'target', 'vendor', '.idea', '.vscode',
  '.cache', 'coverage', '.turbo', 'out',
]);

/** 无论如何都不许碰的系统目录 */
const SYSTEM_DENY = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
  'C:\\Recovery',
  'C:\\Boot',
];

/** 敏感目录（密钥、凭据），即使在用户目录下也拒绝 */
const SENSITIVE_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.password-store']);

function isUnder(p, root) {
  const a = path.resolve(p).toLowerCase();
  const b = path.resolve(root).toLowerCase();
  return a === b || a.startsWith(b + path.sep);
}

/** 根据模式算出允许的根目录（工作区是全局的，不按会话区分） */
export function buildRoots(settings) {
  if (settings?.mode === 'full') return [os.homedir()];
  return settings?.workspace ? [path.resolve(settings.workspace)] : [];
}

function rejectSystemDir(abs) {
  for (const d of SYSTEM_DENY) {
    if (isUnder(abs, d)) throw new Error(`这是系统目录，不允许操作：${d}`);
  }
}

function rejectSensitive(abs) {
  for (const seg of abs.split(path.sep)) {
    if (SENSITIVE_SEGMENTS.has(seg)) throw new Error(`这是敏感目录（${seg}），已拒绝访问`);
  }
}

/**
 * 解析并校验路径。
 * - 系统目录：永久拒绝
 * - 必须落在允许的根目录内
 * - 敏感目录：拒绝
 * - 自举：写的是应用自身文件（web/、server/…）而工作区里没有同名文件时，自动改到应用根目录
 */
export function resolvePath(ctx, p) {
  const roots = ctx?.roots?.length ? ctx.roots : [process.cwd()];
  const raw = String(p ?? '').trim() || '.';
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(roots[0], raw);

  if (!path.isAbsolute(raw)) {
    const norm = raw.replace(/^\.+[\\/]+/, '').replace(/\\/g, '/').toLowerCase();
    if (SELF_HINTS.some((h) => norm === h || norm.startsWith(h + '/'))) {
      const selfAbs = path.resolve(ROOT, norm);
      const wsAbs = path.resolve(roots[0], norm);
      // 工作区里已经有这个文件 → 听工作区的
      if (!fs.existsSync(wsAbs)) {
        // 应用侧有该文件或其父目录，而工作区连对应目录都没有 → 算作改应用自己
        const selfOk = fs.existsSync(selfAbs) || fs.existsSync(path.dirname(selfAbs));
        if (selfOk && !fs.existsSync(path.dirname(wsAbs))) {
          rejectSystemDir(selfAbs);
          rejectSensitive(selfAbs);
          return selfAbs;
        }
      }
    }
  }

  rejectSystemDir(abs);

  if (!roots.some((r) => isUnder(abs, r))) {
    throw new Error(`路径超出允许范围。当前只能操作：${roots.join('、')}`);
  }

  rejectSensitive(abs);
  return abs;
}

function rel(root, abs) {
  const r = path.relative(path.resolve(root), abs);
  return r === '' ? '.' : r.split(path.sep).join('/');
}

function clip(s, n = MAX_OUT) {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  return t.slice(0, n) + `\n…（已截断，共 ${t.length} 字符）`;
}

/* ------------------------- 工具定义（给模型看） ------------------------- */

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        '读取工作区内某个文件的文本内容。返回带行号的文本。大文件请用 offset/limit 分段读取。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          offset: { type: 'integer', description: '起始行号（从 1 开始），可选' },
          limit: { type: 'integer', description: '最多读取多少行，默认 800' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建新文件或整体覆盖写入文件。父目录会自动创建。修改已有文件请优先用 edit_file。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '对文件做精确字符串替换。old_string 必须与文件内容完全一致（含缩进），且在文件中唯一；否则请扩大上下文重试。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          old_string: { type: 'string', description: '要被替换的原文，必须唯一' },
          new_string: { type: 'string', description: '替换后的新内容' },
          replace_all: { type: 'boolean', description: '是否替换所有匹配项，默认 false' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description:
        '移动或重命名文件/目录。dest 若是已存在的目录，则移入该目录；否则当作新路径（可借此改名）。目标已存在时默认报错，需显式覆盖。',
      parameters: {
        type: 'object',
        properties: {
          src: { type: 'string', description: '源路径' },
          dest: { type: 'string', description: '目标路径，或目标目录' },
          overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
        },
        required: ['src', 'dest'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description: '复制文件或目录（目录会递归复制）。目标已存在时默认报错，需显式覆盖。',
      parameters: {
        type: 'object',
        properties: {
          src: { type: 'string', description: '源路径' },
          dest: { type: 'string', description: '目标路径，或目标目录' },
          overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
        },
        required: ['src', 'dest'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        '把文件或目录移到系统回收站（不是永久删除，用户可以从回收站还原）。需要彻底删除请明确说明，不要用这个工具假装完成。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要删除的路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: '查看文件或目录的详细信息：大小、修改时间、是否目录、子项数量。整理文件时用它判断。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要查看的路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录下的文件和子目录（自动跳过 node_modules 等）。用于快速了解项目结构。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的目录路径，默认根目录' },
          depth: { type: 'integer', description: '递归深度，默认 2，最大 4' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '按文件名模式查找文件，支持 * 和 **，例如 "**/*.ts"、"src/**/*.jsx"。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式' },
          path: { type: 'string', description: '搜索起始目录，默认工作区根目录' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: '在文件内容中搜索正则表达式，返回命中的文件、行号和该行内容。找符号定义/调用点用这个。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '搜索目录，默认工作区根目录' },
          glob: { type: 'string', description: '只搜索匹配的文件名模式，如 "*.js"' },
          ignore_case: { type: 'boolean', description: '忽略大小写' },
          context: { type: 'integer', description: '每处命中附带的前后行数，默认 0' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在工作区根目录执行一条 shell 命令，返回 stdout/stderr 和退出码。用于跑测试、构建、安装依赖、执行脚本。不要用它读文件或搜索（有专门工具）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeout: { type: 'integer', description: '超时秒数，默认 120，最大 600' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        '创建或更新当前任务的待办清单。任务超过 3 步时先列计划，每完成一项就更新状态。状态只能是 pending / in_progress / completed。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整的最新待办列表（会整体覆盖旧列表）',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
];

export const MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'run_command',
  'move_file',
  'copy_file',
  'delete_file',
]);

/** 即使在自动模式下也要单独确认的高风险工具 */
export const RISKY_TOOLS = new Set(['delete_file']);

/* ------------------------- 工具执行 ------------------------- */

export async function executeTool(name, args, ctx) {
  // 统一成带 roots/root 的执行上下文
  const c = {
    ...ctx,
    roots: ctx?.roots?.length ? ctx.roots : [ctx?.workspace].filter(Boolean),
  };
  c.root = c.roots[0] || process.cwd();
  try {
    switch (name) {
      case 'read_file':
        return await readFileTool(c, args);
      case 'write_file':
        return await writeFileTool(c, args);
      case 'edit_file':
        return await editFileTool(c, args);
      case 'move_file':
        return await moveFileTool(c, args);
      case 'copy_file':
        return await copyFileTool(c, args);
      case 'delete_file':
        return await deleteFileTool(c, args);
      case 'file_info':
        return await fileInfoTool(c, args);
      case 'list_dir':
        return await listDirTool(c, args);
      case 'glob':
        return await globTool(c, args);
      case 'grep':
        return await grepTool(c, args);
      case 'run_command':
        return await runCommandTool(c, args);
      case 'todo_write':
        return { ok: true, output: '待办已更新。' };
      default:
        return { ok: false, output: `未知工具：${name}` };
    }
  } catch (e) {
    return { ok: false, output: `工具执行失败：${e.message}` };
  }
}

async function readFileTool(ctx, { path: p, offset, limit }) {
  const abs = resolvePath(ctx, p);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) return { ok: false, output: `${p} 是目录，请用 list_dir` };
  if (st.size > 4_000_000) return { ok: false, output: `文件过大（${Math.round(st.size / 1024)}KB），请用 offset/limit 或 grep 定位` };

  let text = await fsp.readFile(abs, 'utf8');
  if (text.includes('\u0000')) return { ok: false, output: '这是二进制文件，无法按文本读取' };

  const all = text.split('\n');
  const start = Math.max(1, Number(offset) || 1);
  const count = Math.max(1, Math.min(2000, Number(limit) || 800));
  const slice = all.slice(start - 1, start - 1 + count);

  const numbered = slice
    .map((line, i) => `${String(start + i).padStart(5)}| ${line}`)
    .join('\n');

  const tail =
    start - 1 + count < all.length
      ? `\n…（文件共 ${all.length} 行，已显示 ${start}-${Math.min(all.length, start + count - 1)} 行）`
      : '';

  return {
    ok: true,
    output: clip(numbered + tail, MAX_READ),
    meta: { path: rel(ctx.root, abs), lines: all.length },
  };
}

async function writeFileTool(ctx, { path: p, content }) {
  const abs = resolvePath(ctx, p);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  await fsp.writeFile(abs, String(content ?? ''), 'utf8');
  const lines = String(content ?? '').split('\n').length;
  return {
    ok: true,
    output: `${existed ? '已覆盖' : '已创建'} ${rel(ctx.root, abs)}（${lines} 行）`,
    meta: { path: rel(ctx.root, abs), lines, created: !existed },
  };
}

async function editFileTool(ctx, { path: p, old_string, new_string, replace_all }) {
  const abs = resolvePath(ctx, p);
  if (!fs.existsSync(abs)) return { ok: false, output: `文件不存在：${p}` };
  const src = await fsp.readFile(abs, 'utf8');
  const oldS = String(old_string ?? '');
  const newS = String(new_string ?? '');
  if (!oldS) return { ok: false, output: 'old_string 不能为空' };

  const occurrences = countOccurrences(src, oldS);
  if (occurrences === 0) {
    return {
      ok: false,
      output: `未找到要替换的内容。请先用 read_file 确认原文（注意缩进、换行、引号必须完全一致）。`,
    };
  }
  if (occurrences > 1 && !replace_all) {
    return {
      ok: false,
      output: `old_string 在文件中出现了 ${occurrences} 次，不唯一。请扩大上下文让它唯一，或设置 replace_all=true。`,
    };
  }

  const next = replace_all ? src.split(oldS).join(newS) : src.replace(oldS, () => newS);
  await fsp.writeFile(abs, next, 'utf8');
  return {
    ok: true,
    output: `已修改 ${rel(ctx.root, abs)}（替换 ${replace_all ? occurrences : 1} 处）`,
    meta: { path: rel(ctx.root, abs), occurrences },
  };
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** 调外部命令并拿到结果（用于回收站） */
function runExe(cmd, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '')
          .replace(/\s+/g, ' ')
          .slice(0, 300);
        return reject(new Error(msg || '外部命令执行失败'));
      }
      resolve(stdout);
    });
  });
}

/** 把 dest 规范化：若指向已存在的目录，则落到该目录下的同名项 */
async function resolveDest(from, to) {
  if (fs.existsSync(to)) {
    try {
      const st = await fsp.stat(to);
      if (st.isDirectory()) return path.join(to, path.basename(from));
    } catch {}
  }
  return to;
}

async function moveFileTool(ctx, { src, dest, overwrite }) {
  const from = resolvePath(ctx, src);
  if (!fs.existsSync(from)) return { ok: false, output: `源路径不存在：${src}` };
  const st = await fsp.stat(from);
  const to = await resolveDest(from, resolvePath(ctx, dest));

  if (to === from) return { ok: false, output: '源路径和目标路径相同' };
  if (st.isDirectory() && to.startsWith(from + path.sep)) {
    return { ok: false, output: '不能把目录移动到它自己里面' };
  }

  if (fs.existsSync(to)) {
    if (!overwrite) {
      return {
        ok: false,
        output: `目标已存在：${rel(ctx.root, to)}。确认要覆盖请设 overwrite=true。`,
      };
    }
    await fsp.rm(to, { recursive: true, force: true });
  }

  await fsp.mkdir(path.dirname(to), { recursive: true });

  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // 跨盘：复制后删源
    await fsp.cp(from, to, { recursive: true, force: true });
    await fsp.rm(from, { recursive: true, force: true });
  }

  return {
    ok: true,
    output: `已移动：${rel(ctx.root, from)} → ${rel(ctx.root, to)}`,
    meta: { from: rel(ctx.root, from), to: rel(ctx.root, to), isDir: st.isDirectory() },
  };
}

async function copyFileTool(ctx, { src, dest, overwrite }) {
  const from = resolvePath(ctx, src);
  if (!fs.existsSync(from)) return { ok: false, output: `源路径不存在：${src}` };
  const st = await fsp.stat(from);
  const to = await resolveDest(from, resolvePath(ctx, dest));

  if (to === from) return { ok: false, output: '源路径和目标路径相同' };
  if (st.isDirectory() && to.startsWith(from + path.sep)) {
    return { ok: false, output: '不能把目录复制到它自己里面' };
  }

  if (fs.existsSync(to)) {
    if (!overwrite) {
      return {
        ok: false,
        output: `目标已存在：${rel(ctx.root, to)}。确认要覆盖请设 overwrite=true。`,
      };
    }
    await fsp.rm(to, { recursive: true, force: true });
  }

  await fsp.mkdir(path.dirname(to), { recursive: true });

  if (st.isDirectory()) {
    await fsp.cp(from, to, { recursive: true, force: true });
  } else {
    await fsp.copyFile(from, to);
  }

  return {
    ok: true,
    output: `已复制：${rel(ctx.root, from)} → ${rel(ctx.root, to)}`,
    meta: { from: rel(ctx.root, from), to: rel(ctx.root, to), isDir: st.isDirectory() },
  };
}

/** 兜底回收站：把文件挪进 data/trash，用户还能手动找回 */
async function moveToAppTrash(abs) {
  await fsp.mkdir(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(TRASH_DIR, `${stamp}__${path.basename(abs)}`);
  try {
    await fsp.rename(abs, target);
  } catch {
    await fsp.cp(abs, target, { recursive: true });
    await fsp.rm(abs, { recursive: true, force: true });
  }
  return target;
}

/** 定期清理兜底回收站里超过 N 天的东西 */
export async function cleanupTrash(days = 30) {
  try {
    const files = await fsp.readdir(TRASH_DIR);
    const cutoff = Date.now() - days * 86400000;
    let n = 0;
    for (const f of files) {
      const fp = path.join(TRASH_DIR, f);
      try {
        const st = await fsp.stat(fp);
        if (st.mtimeMs < cutoff) {
          await fsp.rm(fp, { recursive: true, force: true });
          n++;
        }
      } catch {}
    }
    if (n) console.log(`  清理了 ${n} 个超过 ${days} 天的回收站条目`);
  } catch {}
}

async function deleteFileTool(ctx, { path: p }) {
  const abs = resolvePath(ctx, p);
  if (!fs.existsSync(abs)) return { ok: false, output: `路径不存在：${p}` };
  const st = await fsp.stat(abs);
  const isDir = st.isDirectory();

  // 1) 先试系统回收站。命令报错不代表没删掉，以实际文件状态为准。
  let ok = false;
  try {
    if (process.platform === 'win32') {
      const method = isDir ? 'DeleteDirectory' : 'DeleteFile';
      const safe = abs.replace(/'/g, "''");
      const script =
        'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${safe}','OnlyErrorDialogs','SendToRecycleBin')`;
      await runExe('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
      ok = true;
    } else if (process.platform === 'darwin') {
      await runExe('osascript', ['-e', `tell application "Finder" to delete POSIX file "${abs}"`]);
      ok = true;
    } else {
      await runExe('gio', ['trash', abs]);
      ok = true;
    }
  } catch {
    ok = false;
  }

  // 2) 文件还在 → 走应用内回收站
  if (fs.existsSync(abs)) {
    try {
      const target = await moveToAppTrash(abs);
      return {
        ok: true,
        output: `系统回收站不可用，已移到 AwesEvo 回收站：${rel(ctx.root, abs)} → data/trash/${path.basename(target)}（可手动找回）`,
        meta: { path: rel(ctx.root, abs), isDir, where: 'app' },
      };
    } catch (e) {
      return { ok: false, output: `删除失败：${e.message}` };
    }
  }

  return {
    ok: true,
    output: `已移到${ok ? '系统回收站' : '回收站'}：${rel(ctx.root, abs)}${isDir ? '（目录）' : ''}`,
    meta: { path: rel(ctx.root, abs), isDir, where: ok ? 'system' : 'app' },
  };
}

async function fileInfoTool(ctx, { path: p }) {
  const abs = resolvePath(ctx, p);
  if (!fs.existsSync(abs)) return { ok: false, output: `路径不存在：${p}` };
  const st = await fsp.stat(abs);
  const lines = [
    `路径：${rel(ctx.root, abs)}`,
    `类型：${st.isDirectory() ? '目录' : '文件'}`,
    `大小：${fmtSize(st.size)}（${st.size} 字节）`,
    `修改时间：${st.mtime.toLocaleString('zh-CN')}`,
    `创建时间：${st.birthtime.toLocaleString('zh-CN')}`,
  ];
  if (st.isDirectory()) {
    try {
      const items = await fsp.readdir(abs);
      lines.push(`直接子项：${items.length} 个`);
    } catch {}
  }
  return {
    ok: true,
    output: lines.join('\n'),
    meta: { path: rel(ctx.root, abs), size: st.size, isDir: st.isDirectory() },
  };
}

async function listDirTool(ctx, { path: p, depth }) {
  const abs = resolvePath(ctx, p || '.');
  const maxDepth = Math.max(1, Math.min(4, Number(depth) || 2));
  const lines = [];
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) return { ok: false, output: `${p} 不是目录` };

  async function walk(dir, prefix, level) {
    if (level > maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    const shown = entries.slice(0, 120);
    for (const e of shown) {
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        lines.push(`${prefix}${e.name}/`);
        await walk(path.join(dir, e.name), prefix + '  ', level + 1);
      } else {
        let size = '';
        try {
          const s = await fsp.stat(path.join(dir, e.name));
          size = `  ${fmtSize(s.size)}`;
        } catch {}
        lines.push(`${prefix}${e.name}${size}`);
      }
    }
    if (entries.length > shown.length) lines.push(`${prefix}… 还有 ${entries.length - shown.length} 项`);
  }

  await walk(abs, '', 1);
  const head = `${rel(ctx.root, abs)}/\n`;
  return { ok: true, output: clip(head + lines.join('\n'), 12000) };
}

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function globToRegExp(pattern) {
  let p = String(pattern).replace(/\\/g, '/');
  let out = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        out += '.*';
        i++;
        if (p[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

async function globTool(ctx, { pattern, path: p }) {
  const root = resolvePath(ctx, p || '.');
  const re = globToRegExp(pattern);
  const hits = [];

  async function walk(dir) {
    if (hits.length > 500) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
      } else {
        const r = rel(ctx.root, full);
        if (re.test(r) || re.test(e.name)) hits.push(r);
      }
    }
  }
  await walk(root);
  if (!hits.length) return { ok: true, output: `没有匹配 ${pattern} 的文件` };
  return { ok: true, output: clip(hits.slice(0, 300).join('\n') + (hits.length > 300 ? `\n…共 ${hits.length} 个` : ''), 12000) };
}

async function grepTool(ctx, { pattern, path: p, glob, ignore_case, context }) {
  const root = resolvePath(ctx, p || '.');
  let re;
  try {
    re = new RegExp(pattern, ignore_case ? 'i' : '');
  } catch (e) {
    return { ok: false, output: `正则无效：${e.message}` };
  }
  const nameRe = glob ? globToRegExp(glob) : null;
  const ctxLines = Math.max(0, Math.min(5, Number(context) || 0));
  const results = [];
  let scanned = 0;

  async function walk(dir) {
    if (results.length >= 200 || scanned > MAX_GREP_FILES) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= 200 || scanned > MAX_GREP_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
        continue;
      }
      if (nameRe && !nameRe.test(e.name)) continue;
      const r = rel(ctx.root, full);
      if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|exe|dll|so|dylib|woff2?|ttf|mp4|mp3)$/i.test(r)) continue;
      scanned++;
      let text;
      try {
        const st = await fsp.stat(full);
        if (st.size > 1_500_000) continue;
        text = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        let block = '';
        if (ctxLines) {
          const from = Math.max(0, i - ctxLines);
          const to = Math.min(lines.length, i + ctxLines + 1);
          block = lines
            .slice(from, to)
            .map((l, k) => {
              const no = from + k + 1;
              return `${no === i + 1 ? '>' : ' '}${String(no).padStart(5)}| ${l.slice(0, 300)}`;
            })
            .join('\n');
          block += '\n';
        } else {
          block = `${String(i + 1).padStart(5)}| ${lines[i].slice(0, 300)}\n`;
        }
        results.push(`${r}:${i + 1}\n${block}`);
        if (results.length >= 200) break;
      }
    }
  }

  await walk(root);
  if (!results.length) return { ok: true, output: `没有找到匹配 /${pattern}/ 的内容` };
  return { ok: true, output: clip(results.join('\n'), 20000) };
}

/** Windows 下 cmd 输出常是 GBK，按 UTF-8 硬解会变乱码，这里做一次探测 */
function decodeBuf(buf) {
  if (!buf || !buf.length) return '';
  const utf8 = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

function runCommandTool(ctx, { command, timeout }) {
  const cmd = String(command || '').trim();
  if (!cmd) return Promise.resolve({ ok: false, output: '命令为空' });
  const sec = Math.max(1, Math.min(600, Number(timeout) || 120));

  return new Promise((resolve) => {
    const child = exec(
      cmd,
      {
        cwd: ctx.root,
        timeout: sec * 1000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        encoding: 'buffer',
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      },
      (err, stdoutBuf, stderrBuf) => {
        const stdout = decodeBuf(stdoutBuf);
        const stderr = decodeBuf(stderrBuf);
        const code = err?.code ?? 0;
        const killed = err?.killed;
        const parts = [];
        if (stdout) parts.push(stdout.trimEnd());
        if (stderr) parts.push('[stderr]\n' + stderr.trimEnd());
        if (killed) parts.push(`[超时] 命令超过 ${sec}s 被终止`);
        if (err && !killed && code !== 0) parts.push(`[退出码 ${code}]`);
        const output = parts.join('\n') || '(无输出)';
        resolve({
          ok: !err || code === 0,
          output: clip(output, 20000),
          meta: { exitCode: code, command: cmd },
        });
      }
    );
    ctx?.onChild?.(child);
  });
}
