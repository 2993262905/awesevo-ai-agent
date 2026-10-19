const BASE = '/api';

async function req(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const API = {
  getConfig: () => req('/config'),
  saveConfig: (patch) => req('/config', { method: 'PATCH', body: patch }),

  getRuntime: () => req('/runtime'),
  getLogs: (lines = 400) => req('/logs?lines=' + lines),
  clearLogs: () => req('/logs', { method: 'DELETE' }),

  getPrompts: () => req('/prompts'),
  savePrompt: (prompt) => req('/prompts', { method: 'POST', body: { prompt } }),
  deletePrompt: (id) => req('/prompts/' + encodeURIComponent(id), { method: 'DELETE' }),
  previewPrompt: (payload) => req('/prompts/preview', { method: 'POST', body: payload }),
  previewSystem: (payload) => req('/preview-system', { method: 'POST', body: payload }),

  listSessions: () => req('/sessions'),
  createSession: (init) => req('/sessions', { method: 'POST', body: init || {} }),
  getSession: (id) => req('/sessions/' + encodeURIComponent(id)),
  patchSession: (id, patch) => req('/sessions/' + encodeURIComponent(id), { method: 'PATCH', body: patch }),
  deleteSession: (id) => req('/sessions/' + encodeURIComponent(id), { method: 'DELETE' }),
  truncate: (id, index) =>
    req(`/sessions/${encodeURIComponent(id)}/truncate`, { method: 'POST', body: { index } }),

  openDir: (path) => req('/open-dir', { method: 'POST', body: { path } }),
  onboard: (payload) => req('/onboard', { method: 'POST', body: payload }),
  disks: () => req('/disks'),
  fetchModels: (payload) => req('/fetch-models', { method: 'POST', body: payload }),
  setActive: (providerId, model, models) =>
    req('/set-active', { method: 'POST', body: { providerId, model, models } }),

  stop: (sessionId) => req('/stop', { method: 'POST', body: { sessionId } }),
  confirm: (token, allow) => req('/confirm', { method: 'POST', body: { token, allow } }),

  tree: (workspace, path = '.') =>
    req(`/fs/tree?workspace=${encodeURIComponent(workspace || '')}&path=${encodeURIComponent(path)}`),
  file: (workspace, path) =>
    req(`/fs/file?workspace=${encodeURIComponent(workspace || '')}&path=${encodeURIComponent(path)}`),
  setWorkspace: (path) => req('/fs/workspace', { method: 'POST', body: { path } }),

  probe: (provider) => req('/probe', { method: 'POST', body: { provider } }),
};

/** 流式对话：SSE over fetch POST */
export async function streamChat(payload, onEvent, signal) {
  const res = await fetch(BASE + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(t.slice(0, 400) || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          onEvent(JSON.parse(raw));
        } catch {}
      }
    }
  }
}
