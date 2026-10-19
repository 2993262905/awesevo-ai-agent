import { readLines, joinURL, AbortedError } from './util.js';
import { normalizeUsage } from './openai.js';

/**
 * Anthropic Messages API 适配器。
 * 内部统一用 OpenAI 风格消息，这里做双向转换。
 */
export async function streamAnthropic({ provider, model, messages, tools, params, signal, onEvent }) {
  const url = joinURL(provider.baseURL, '/messages');
  const { system, converted } = toAnthropicMessages(messages);

  const body = {
    model,
    max_tokens: Math.max(64, Number(params.maxTokens) || 4096),
    temperature: Math.min(1, Math.max(0, Number(params.temperature ?? 0.7))),
    system: system || undefined,
    messages: converted,
    stream: true,
  };
  if (params.topP != null) body.top_p = Number(params.topP);
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
  }

  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(provider.headers || {}),
  };
  if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
  // 允许浏览器/代理场景
  if (provider.headers?.['anthropic-dangerous-direct-browser-access'] === undefined) {
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${shorten(txt)}`);
  }

  let text = '';
  let reasoning = '';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const blocks = new Map(); // index -> {type, id, name, json}
  let finishReason = null;

  for await (const line of readLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }

    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage;
        if (u) usage = normalizeUsage(u);
        break;
      }
      case 'content_block_start': {
        const cb = ev.content_block || {};
        blocks.set(ev.index, {
          type: cb.type,
          id: cb.id,
          name: cb.name,
          json: '',
        });
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && d.text) {
          text += d.text;
          onEvent({ type: 'text', text: d.text });
        } else if (d.type === 'thinking_delta' && d.thinking) {
          reasoning += d.thinking;
          onEvent({ type: 'reasoning', text: d.thinking });
        } else if (d.type === 'input_json_delta') {
          const b = blocks.get(ev.index);
          if (b) b.json += d.partial_json || '';
        }
        break;
      }
      case 'message_delta': {
        if (ev.delta?.stop_reason) finishReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens) {
          usage.completionTokens = ev.usage.output_tokens;
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
        break;
      }
      case 'error': {
        throw new Error(ev.error?.message || 'Anthropic 返回错误');
      }
      default:
        break;
    }
  }

  const toolCalls = [];
  for (const [i, b] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    if (b.type !== 'tool_use') continue;
    toolCalls.push({
      id: b.id || `toolu_${Date.now()}_${i}`,
      type: 'function',
      function: { name: b.name, arguments: b.json || '{}' },
    });
  }

  return { text, reasoning, toolCalls, usage, finishReason };
}

function toAnthropicMessages(messages) {
  let system = '';
  const out = [];

  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + (m.content || '');
      continue;
    }

    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: String(m.content ?? ''),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((c) => c.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try {
          input = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          input = {};
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      if (!content.length) content.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content });
      continue;
    }

    // user
    const last = out[out.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') {
      last.content += '\n\n' + (m.content || '');
    } else {
      out.push({ role: 'user', content: String(m.content ?? '') });
    }
  }

  // Anthropic 要求首条必须是 user
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '(继续)' });
  }

  return { system, converted: out };
}

function shorten(s, n = 400) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export { AbortedError };
