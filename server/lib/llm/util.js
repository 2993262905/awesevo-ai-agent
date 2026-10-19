/** SSE / 流式读取工具 */

export async function* readLines(stream) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  if (buf.trim()) yield buf;
}

export function joinURL(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!b) throw new Error('未配置 baseURL');
  const s = suffix.startsWith('/') ? suffix : '/' + suffix;
  return b + s;
}

export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk * 1.05 + rest / 3.6);
}

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}
