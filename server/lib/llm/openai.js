import { readLines, AbortedError } from './util.js';

/** 组装 chat completions 地址，支持 provider.query（如 Pollinations 的 referrer） */
function chatURL(provider) {
  const base = String(provider.baseURL || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 baseURL');
  let url = base + (provider.chatPath || '/chat/completions');
  const q =
    provider.query && Object.keys(provider.query).length
      ? new URLSearchParams(provider.query).toString()
      : '';
  if (q) url += (url.includes('?') ? '&' : '?') + q;
  return url;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new AbortedError());
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

/** 从限速响应里抠出建议等待秒数 */
function parseRetryAfter(text, status) {
  const t = String(text || '');
  const limited =
    status === 402 || status === 429 || /FREE_LIMIT|rate.?limit|too many requests|quota/i.test(t);
  if (!limited) return 0;
  const m = t.match(/[Rr]etry after\s+(\d+)\s*s/) || t.match(/(\d+)\s*seconds?/);
  const n = m ? Number(m[1]) : 30;
  return Math.min(60, Math.max(3, n));
}

function friendlyError(status, text) {
  const t = String(text || '').replace(/\s+/g, ' ').slice(0, 260);
  if (/terminal usage/i.test(t))
    return '这个通道处理失败（它没能正确结束这次回答）。免费通道对复杂请求不太稳定，换用自己的模型会好很多。';
  if (status === 401) return 'API Key 无效或没填（401）。到「设置 → 模型与 API」检查一下。';
  if (status === 403) return `没有访问权限（403）。${t}`;
  if (status === 404)
    return `接口地址不存在（404）。检查 Base URL，OpenAI 兼容端点通常以 /v1 结尾。${t}`;
  if (status === 402 || /FREE_LIMIT/i.test(t)) return `免费通道已到限额。${t}`;
  if (status === 429) return '请求太频繁（429），等几秒再试。';
  if (status >= 500) return `服务端出错（${status}），可能过一会儿就好。${t}`;
  return `HTTP ${status}: ${t}`;
}

/**
 * OpenAI 兼容格式（DeepSeek / Kimi / Qwen / Ollama / vLLM / OneAPI / Pollinations ...）
 * 内部消息格式即 OpenAI 格式，直接透传。
 */
export async function streamOpenAI({ provider, model, messages, tools, params, signal, onEvent }) {
  const url = chatURL(provider);

  const buildBody = (withUsage) => {
    const body = {
      model,
      messages: sanitizeMessages(messages),
      stream: true,
      temperature: clamp(params.temperature ?? 0.7, 0, 2),
      top_p: clamp(params.topP ?? 1, 0, 1),
      max_tokens: Math.max(64, Number(params.maxTokens) || 4096),
    };
    if (params.frequencyPenalty) body.frequency_penalty = params.frequencyPenalty;
    if (params.presencePenalty) body.presence_penalty = params.presencePenalty;
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (withUsage) body.stream_options = { include_usage: true };
    return body;
  };

  const headers = {
    'Content-Type': 'application/json',
    ...(provider.headers || {}),
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const post = (withUsage) =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(withUsage)),
      signal,
    });

  let res = await post(true);
  let retried = 0;

  // 400 且是不认 stream_options 的端点 → 去掉该字段重试
  if (!res.ok && res.status === 400) {
    const txt = await res.text().catch(() => '');
    if (/stream_options|unrecognized|unknown (field|parameter)/i.test(txt)) {
      res = await post(false);
    } else {
      throw new Error(friendlyError(400, txt));
    }
  }

  // 限速（免费通道常见）：按服务端建议等一次再重试
  while (!res.ok) {
    const txt = await res.text().catch(() => '');
    const wait = parseRetryAfter(txt, res.status);
    if (wait && retried < 1) {
      retried++;
      onEvent({ type: 'notice', level: 'warn', text: `通道限速，等待 ${wait} 秒后自动重试…` });
      await sleep(wait * 1000, signal);
      res = await post(true);
      continue;
    }
    throw new Error(friendlyError(res.status, txt));
  }

  const ctype = res.headers.get('content-type') || '';
  // 不支持流式时按整体 JSON 处理
  if (!ctype.includes('event-stream')) {
    const raw = await res.text().catch(() => '');
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`返回内容无法解析：${raw.slice(0, 200)}`);
    }
    throwIfPayloadError(json);
    return parseNonStream(json, onEvent);
  }

  let text = '';
  let reasoning = '';
  const toolMap = new Map();
  let usage = null;
  let finishReason = null;

  for await (const line of readLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    throwIfPayloadError(json);
    if (json.usage) usage = normalizeUsage(json.usage);

    const choice = json.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || {};

    const rc = d.reasoning_content ?? d.reasoning;
    if (rc) {
      reasoning += rc;
      onEvent({ type: 'reasoning', text: rc });
    }
    if (d.content) {
      text += d.content;
      onEvent({ type: 'text', text: d.content });
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        const cur = toolMap.get(i) || { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = (cur.name || '') + tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        toolMap.set(i, cur);
      }
    }
  }

  const toolCalls = [...toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, v]) => ({
      id: v.id || `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: v.name, arguments: v.arguments || '{}' },
    }))
    .filter((t) => t.function.name);

  return { text, reasoning, toolCalls, usage, finishReason };
}

/** 有些服务把错误塞在 200 的 body 里（Pollinations 就是这样） */
function throwIfPayloadError(json) {
  if (!json || typeof json !== 'object') return;
  if (json.error) {
    const msg =
      typeof json.error === 'string' ? json.error : json.error.message || JSON.stringify(json.error);
    const status = json.status || json.error.code || 0;
    throw new Error(friendlyError(Number(status) || 500, msg));
  }
  if (json.success === false && json.status >= 400) {
    const msg = json.error?.message || JSON.stringify(json).slice(0, 200);
    throw new Error(friendlyError(Number(json.status), msg));
  }
}

function parseNonStream(json, onEvent) {
  const msg = json?.choices?.[0]?.message || {};
  const text = msg.content || '';
  const reasoning = msg.reasoning_content || msg.reasoning || '';
  if (reasoning) onEvent({ type: 'reasoning', text: reasoning });
  if (text) onEvent({ type: 'text', text });
  return {
    text,
    reasoning,
    toolCalls: (msg.tool_calls || []).map((t, i) => ({
      id: t.id || `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: t.function?.name, arguments: t.function?.arguments || '{}' },
    })),
    usage: json.usage ? normalizeUsage(json.usage) : null,
    finishReason: json?.choices?.[0]?.finish_reason || null,
  };
}

function sanitizeMessages(messages) {
  // 只保留 OpenAI 认识的字段，避免把内部字段发出去
  return messages.map((m) => {
    const out = { role: m.role, content: m.content ?? '' };
    if (m.name) out.name = m.name;
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });
}

export function normalizeUsage(u) {
  return {
    promptTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    completionTokens: u.completion_tokens ?? u.output_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens || 0) + (u.completion_tokens || 0),
  };
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export { AbortedError };
