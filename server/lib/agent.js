import crypto from 'node:crypto';
import os from 'node:os';
import { getAdapter } from './llm/index.js';
import { TOOL_DEFS, MUTATING_TOOLS, RISKY_TOOLS, executeTool, buildRoots } from './tools/index.js';
import { renderPrompt, getPrompt, getConfig, ROOT } from './store.js';

const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_HISTORY_MESSAGES = 120;

function mid() {
  return 'm_' + crypto.randomBytes(6).toString('hex');
}

/** 组装 system prompt */
export function buildSystemPrompt({ session, provider, model, cfg }) {
  const tpl = getPrompt(session.promptId);
  const rendered = renderPrompt(tpl.system || '', {
    workspace: session.workspace,
    model,
    provider: provider?.name || '',
  });

  const toolList = provider?.noTools
    ? ''
    : TOOL_DEFS.filter((t) => cfg.settings.enabledTools?.[t.function.name] !== false)
        .map((t) => `- ${t.function.name}: ${t.function.description.split('。')[0]}`)
        .join('\n');

  const parts = [];
  if (provider?.noTools) {
    parts.push(
      [
        '【运行模式：纯对话】',
        '你现在没有任何工具，无法读取文件、修改代码、浏览目录或执行命令。',
        '用户让你做这类事时，直接说明「当前通道不支持工具调用，请切换到你自己配置的模型」，然后可以给出思路或代码片段让他自己贴。',
        '绝对不要列出工具清单，不要描述工具参数，也不要假装自己已经改过文件。',
      ].join('\n')
    );
  }
  if (rendered.trim()) parts.push(rendered.trim());

  const readonly = cfg.settings.permissionMode === 'readonly';
  const isFull = cfg.settings.mode === 'full';
  const rootDesc = isFull
    ? `用户主目录 ${os.homedir()}（全权模式：主目录下都能读写；系统目录、.ssh 等敏感目录会被拒绝）`
    : cfg.settings.workspace || '（未设置工作区）';
  const envLines = [
    '# 运行环境',
    `- 工作区：${rootDesc}`,
    `- 当前时间：${new Date().toLocaleString('zh-CN')}`,
    `- 模型：${provider?.name || ''} / ${model}`,
    `- 权限模式：${readonly ? '只读（禁止写入和执行命令）' : cfg.settings.permissionMode === 'ask' ? '写入需用户确认' : '自动执行'}`,
  ];

  if (provider?.noTools) {
    envLines.push('', '再次强调：本次对话没有工具可用，只能输出文字。');
  } else {
    envLines.push(
      '',
      '# 可用工具',
      toolList || '(无)',
      '',
      '工具调用是真实执行的：文件会被真的修改，命令会被真的运行。动手前确认路径和目标正确。',
      '需要文件内容时用 read_file 读，不要假设文件内容。',
      '如果工作区里找不到与任务相关的文件，立刻停下来告诉用户，不要反复试探，也不要凭空新建一个项目来"完成"任务。'
    );
  }
  envLines.push('所有面向用户的文字必须使用简体中文。');
  parts.push(envLines.join('\n'));

  // 工作区模式下：告诉模型怎么改 AwesEvo 自己
  if (!isFull) {
    parts.push(
      [
        '# 改 AwesEvo 自己的界面',
        `本应用代码固定在 ${ROOT}，不受工作区限制：`,
        '- 样式：web/css/app.css',
        '- 页面结构：web/index.html',
        '- 交互逻辑：web/js/*.js',
        '- 服务端：server/**',
        '',
        '用户说「改页面 / 改界面 / 换颜色 / 加个功能」指的就是这些文件。',
        '直接按上面的相对路径读写，不用切换工作区——工作区里没有这些文件时，系统会自动定位到应用目录。',
      ].join('\n')
    );
  }

  return parts.join('\n\n');
}

/** 把存盘消息转成 LLM 请求消息（做裁剪，保证 tool_call 配对完整） */
function toLLMMessages(history) {
  const msgs = history.filter((m) => m.role !== 'system').map(stripForLLM);
  if (msgs.length <= MAX_HISTORY_MESSAGES) return msgs;

  let start = msgs.length - MAX_HISTORY_MESSAGES;
  // 往前挪，避免从 tool 消息中间开始
  while (start < msgs.length && msgs[start].role === 'tool') start++;
  return msgs.slice(start);
}

function stripForLLM(m) {
  const out = { role: m.role, content: m.content ?? '' };
  if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

/**
 * 运行一次 Agent 回合。
 * @param {object} opts
 * @param {object} opts.session  会话对象（会被原地修改 messages）
 * @param {string} opts.userText 用户输入
 * @param {object} opts.provider
 * @param {string} opts.model
 * @param {object} opts.params
 * @param {(ev:object)=>void} opts.emit
 * @param {AbortSignal} opts.signal
 * @param {(req:{tool:string,args:object})=>Promise<boolean>} opts.confirm
 */
export async function runAgentTurn(opts) {
  const { session, userText, provider, model, params, emit, signal, confirm } = opts;
  const cfg = getConfig();
  const adapter = getAdapter(provider?.format);

  if (!provider?.baseURL) throw new Error('当前模型未配置 baseURL，请到「设置 → 模型与 API」里填写。');
  if (!model) throw new Error('未选择模型。');

  // 1. 记录用户消息
  const userMsg = { id: mid(), role: 'user', content: userText, createdAt: new Date().toISOString() };
  session.messages.push(userMsg);
  emit({ type: 'user_saved', message: userMsg });

  const systemPrompt = buildSystemPrompt({ session, provider, model, cfg });

  const enabledToolNames = new Set(
    TOOL_DEFS.filter((t) => cfg.settings.enabledTools?.[t.function.name] !== false).map((t) => t.function.name)
  );
  // noTools 的通道（如免费体验）工具调用不稳定，直接不传工具，避免模型吐出畸形调用
  const tools = provider.noTools
    ? []
    : TOOL_DEFS.filter((t) => enabledToolNames.has(t.function.name));
  const readonly = cfg.settings.permissionMode === 'readonly';

  const maxSteps = Math.max(1, Math.min(60, Number(cfg.settings.maxSteps) || 24));
  const callSignatureCount = new Map();

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw abortErr();

    const messages = [{ role: 'system', content: systemPrompt }, ...toLLMMessages(session.messages)];

    const assistantId = mid();
    let text = '';
    let reasoning = '';

    const result = await adapter({
      provider,
      model,
      messages,
      tools: readonly ? tools.filter((t) => !MUTATING_TOOLS.has(t.function.name)) : tools,
      params,
      signal,
      onEvent: (ev) => {
        if (ev.type === 'text') {
          text += ev.text;
          emit({ type: 'delta', id: assistantId, text: ev.text });
        } else if (ev.type === 'reasoning') {
          reasoning += ev.text;
          emit({ type: 'reasoning', id: assistantId, text: ev.text });
        }
      },
    });

    // 只读模式下模型可能仍想写：拦下来
    // 没给模型工具时，任何 tool_calls 都是幻觉，一律丢弃，绝不执行
    let toolCalls = tools.length ? result.toolCalls || [] : [];
    if (!tools.length && result.toolCalls?.length) {
      emit({
        type: 'notice',
        level: 'warn',
        text: '模型试图调用工具，但当前通道不支持工具调用，已忽略。',
      });
    }
    if (readonly) {
      const blocked = toolCalls.filter((t) => MUTATING_TOOLS.has(t.function.name));
      if (blocked.length) {
        emit({ type: 'notice', level: 'warn', text: `只读模式下已阻止 ${blocked.length} 个写操作` });
        toolCalls = toolCalls.filter((t) => !MUTATING_TOOLS.has(t.function.name));
      }
    }

    const assistantMsg = {
      id: assistantId,
      role: 'assistant',
      content: text,
      reasoning: reasoning || undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      usage: result.usage || undefined,
      createdAt: new Date().toISOString(),
    };
    session.messages.push(assistantMsg);

    if (result.usage) {
      session.usage.promptTokens += result.usage.promptTokens || 0;
      session.usage.completionTokens += result.usage.completionTokens || 0;
      emit({ type: 'usage', usage: session.usage, last: result.usage });
    }

    emit({ type: 'assistant_done', message: assistantMsg });

    if (!toolCalls.length) {
      emit({ type: 'step_done', step, reason: 'no_tool_calls' });
      break;
    }

    // 2. 执行工具
    const batch = toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
    for (const call of batch) {
      if (signal?.aborted) throw abortErr();

      const name = call.function?.name;
      let args = {};
      let argErr = null;
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch (e) {
        argErr = e.message;
      }

      const toolId = call.id;
      emit({ type: 'tool_start', id: toolId, name, args, messageId: assistantId });

      let outcome;
      if (argErr) {
        outcome = { ok: false, output: `参数不是合法 JSON：${argErr}` };
      } else if (!enabledToolNames.has(name)) {
        outcome = { ok: false, output: `工具 ${name} 已在设置中禁用` };
      } else {
        // 防死循环：同一工具同一参数重复 3 次就打断
        const sig = name + ':' + JSON.stringify(args);
        const n = (callSignatureCount.get(sig) || 0) + 1;
        callSignatureCount.set(sig, n);
        if (n >= 3) {
          outcome = { ok: false, output: '检测到重复调用相同工具与参数，已停止。请换一种方式或直接回答。' };
        } else {
          // 权限确认：delete_file 即使在自动模式下也要问一次
          const risky =
            RISKY_TOOLS.has(name) ||
            (name === 'run_command' &&
              /rm\s+-rf|del\s+\/|format\s|mkfs|shutdown|reg\s+delete/i.test(args.command || ''));
          const needConfirm =
            MUTATING_TOOLS.has(name) &&
            (cfg.settings.permissionMode === 'ask' ||
              (cfg.settings.permissionMode === 'auto' && risky));

          let allowed = true;
          if (needConfirm && confirm) {
            allowed = await confirm({ tool: name, args, id: toolId });
            if (!allowed) outcome = { ok: false, output: '用户拒绝了这次操作。' };
          }

          if (allowed) {
            const res = await executeTool(name, args, {
              workspace: session.workspace,
              roots: buildRoots(cfg.settings),
              mode: cfg.settings.mode,
              session,
            });
            outcome = res;
          }
        }
      }

      emit({ type: 'tool_end', id: toolId, name, args, ok: !!outcome.ok, output: outcome.output, meta: outcome.meta });

      session.messages.push({
        id: mid(),
        role: 'tool',
        tool_call_id: toolId,
        name,
        content: `${outcome.ok ? 'OK' : 'ERROR'}\n${outcome.output ?? ''}`,
        toolMeta: { ok: !!outcome.ok, name, args, meta: outcome.meta },
        createdAt: new Date().toISOString(),
      });
    }

    if (toolCalls.length > batch.length) {
      emit({
        type: 'notice',
        level: 'warn',
        text: `本轮工具调用超过 ${MAX_TOOL_CALLS_PER_TURN} 个，剩余 ${toolCalls.length - batch.length} 个已跳过。`,
      });
    }

    if (step === maxSteps - 1) {
      emit({ type: 'notice', level: 'warn', text: `已达最大步数 ${maxSteps}，回合结束。可在设置里调高上限。` });
    }
  }

  emit({ type: 'turn_done', usage: session.usage });
}

function abortErr() {
  const e = new Error('已停止');
  e.name = 'AbortError';
  return e;
}
