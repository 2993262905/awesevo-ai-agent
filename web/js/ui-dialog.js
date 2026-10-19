import { esc } from './store.js';

/**
 * 自定义确认 / 输入弹窗。
 * 不用 window.confirm / prompt：浏览器可能拦截，Electron 也不支持。
 */
function dialog({ title, body, okText = '确定', cancelText = '取消', danger = false, input = null }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.innerHTML = `
      <div class="modal small">
        <div class="modal-head"><h2>${esc(title)}</h2></div>
        <div class="modal-body">
          ${body ? `<p class="confirm-title">${esc(body)}</p>` : ''}
          ${
            input
              ? `<input class="input" id="dlgInput" value="${esc(input.value || '')}" placeholder="${esc(
                  input.placeholder || ''
                )}" />`
              : ''
          }
        </div>
        <div class="modal-foot">
          <button class="btn ghost" data-act="cancel">${esc(cancelText)}</button>
          <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-act="ok">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const inputEl = mask.querySelector('#dlgInput');
    if (inputEl) {
      setTimeout(() => {
        inputEl.focus();
        inputEl.select();
      }, 60);
    }

    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      resolve(val);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      } else if (e.key === 'Enter' && input) {
        e.preventDefault();
        done(inputEl.value);
      }
    };
    document.addEventListener('keydown', onKey, true);

    mask.addEventListener('click', (e) => {
      if (e.target === mask) return done(null);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') done(input ? inputEl.value : true);
      if (act === 'cancel') done(null);
    });
  });
}

/** 返回 true / false */
export async function confirmDialog(title, body, opts = {}) {
  const r = await dialog({ title, body, okText: opts.okText || '确定', danger: !!opts.danger });
  return r === true;
}

/** 返回字符串或 null */
export function promptDialog(title, value = '', placeholder = '') {
  return dialog({
    title,
    input: { value, placeholder },
    okText: '确定',
  });
}
