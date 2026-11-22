// Shared building blocks of the web console: DOM and icon helpers,
// formatting, avatars, the API client, toasts, dialogs, small widgets and
// the state every page reads.

export const $app = document.getElementById('app');
const $overlay = document.getElementById('overlay-root');
const $toasts = document.getElementById('toast-root');

// Pages keep their cached server data here and clear it in their reset().
export const state = {
  info: { version: '', allow_register: false, extension_download: false },
  me: null,
  creds: null, // current user's credentials
  users: null, // admin: all users
  userCreds: {}, // admin: user id -> credentials
  query: { passkeys: '', users: '' },
  sort: localStorage.getItem('pkb.sort') || 'site',
  route: { page: '', id: '' },
};

/* ------------------------------------------------------------------ */
/* Shell hooks                                                         */
/* ------------------------------------------------------------------ */

// main.js installs the shell at boot, so pages can redraw, navigate and
// drop cached data without importing it.
const shell = { render() {}, route() {}, reset() {} };

export function installShell(hooks) {
  Object.assign(shell, hooks);
}

// renderShell redraws the current page from state.
export function renderShell() {
  shell.render();
}

// go navigates to a hash route, re-running the route when it is current.
export function go(hash) {
  if (location.hash === hash) shell.route();
  else location.hash = hash;
}

// resetData drops everything cached for the signed-in user.
export function resetData() {
  shell.reset();
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const ICONS = {
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  sliders: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4"/><path d="m15.4 6.5-6.8 4"/>',
  transfer: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  edit: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  refresh: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
};

export function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstChild;
}

export function iconButton(name, label, onclick, extraClass) {
  return h('button', { type: 'button', class: 'icon-btn' + (extraClass ? ' ' + extraClass : ''), title: label, 'aria-label': label, onclick }, icon(name));
}

export function brandMark() {
  return h('img', { class: 'brand-mark', src: '/assets/logo-128.png', alt: '', draggable: 'false' });
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const DTF = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function dateParts(s) {
  return Object.fromEntries(DTF.formatToParts(new Date(s)).map((p) => [p.type, p.value]));
}

export function fmtDateTime(s) {
  if (!s) return '—';
  const p = dateParts(s);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function fmtDate(s) {
  if (!s) return '—';
  const p = dateParts(s);
  return `${p.year}-${p.month}-${p.day}`;
}

function fmtRelative(s) {
  if (!s) return '从未使用';
  const diff = Date.now() - Date.parse(s);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return fmtDate(s);
}

export function algName(alg) {
  if (alg === -7) return 'ES256（ECDSA P-256，SHA-256）';
  if (alg === -257) return 'RS256（RSASSA-PKCS1-v1_5，SHA-256）';
  return `COSE ${alg}`;
}

export function credTitle(c) {
  return c.rp_name || c.rp_id;
}

export function credAccount(c) {
  return c.user_name || c.user_display_name || '（无用户名）';
}

// credBrief names a passkey in one line: "github.com · alice".
export function credBrief(c) {
  return c.user_name ? `${c.rp_id} · ${c.user_name}` : c.rp_id;
}

/* ------------------------------------------------------------------ */
/* Avatars                                                             */
/* ------------------------------------------------------------------ */

const COLORS = ['#0572EC', '#7A5AF8', '#E5484D', '#E8590C', '#B7791F', '#12A150', '#0E9F9A', '#D6409F', '#3E63DD', '#8E4EC6'];
const iconFailed = new Set();

function colorFor(s) {
  let n = 0;
  for (const ch of s || '') n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[n % COLORS.length];
}

function firstChar(s) {
  const t = (s || '').trim();
  return t ? [...t][0].toUpperCase() : '?';
}

function canFetchIcon(domain) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)
    && !/^[\d.]+$/.test(domain)
    && !/\.(localhost|local|test|internal|lan|home|example|invalid)$/.test(domain);
}

export function siteAvatar(rpId, name, size) {
  const domain = (rpId || '').toLowerCase();
  const el = h('span', { class: 'avatar' + (size ? ' ' + size : ''), style: `background:${colorFor(domain)}` }, firstChar(name || domain));
  if (canFetchIcon(domain) && !iconFailed.has(domain)) {
    const img = h('img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => {
      if (img.naturalWidth > 1) el.classList.add('has-icon');
      else img.remove();
    });
    img.addEventListener('error', () => {
      iconFailed.add(domain);
      img.remove();
    });
    img.src = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
    el.append(img);
  }
  return el;
}

export function userAvatar(name, size) {
  return h('span', { class: 'avatar round' + (size ? ' ' + size : ''), style: `background:${colorFor(name)}` }, firstChar(name));
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

// ApiError is what api() throws. Batch requests that fail on some items
// carry them in items (see components.js batchError).
class ApiError extends Error {
  constructor(status, code, message, items) {
    super(message);
    this.status = status;
    this.code = code;
    if (items) this.items = items;
  }
}

const ERROR_TEXT = {
  network: '无法连接到服务器，请检查网络',
  unauthorized: '登录已失效，请重新登录',
  account_disabled: '账户已被停用',
  forbidden: '没有权限执行此操作',
  read_only_token: '只读令牌不能执行修改操作',
  token_not_allowed: '这个操作不能使用 API 令牌',
  registration_disabled: '服务器未开启注册',
  not_found: '内容不存在或已被删除',
  conflict: '名称已存在',
  invalid_password: '当前密码不正确',
  invalid_request: '输入的内容不正确',
  internal: '服务器出错了，请稍后重试',
};

export function errText(err, overrides) {
  return (overrides && overrides[err.code]) || ERROR_TEXT[err.code] || '操作失败，请重试';
}

// sessionEnded reports an error that means the user is signed out: an
// expired session or a disabled account. api() has already gone back to
// the login page and said why, so callers stay quiet about it.
export function sessionEnded(err) {
  return err.status === 401 || err.code === 'account_disabled';
}

// toastError reports a failed request unless api() already handled it.
export function toastError(err, overrides) {
  if (!sessionEnded(err)) toast(errText(err, overrides), 'error');
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api/v1' + path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'network error');
  }
  let data = null;
  if (res.status !== 204) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = (data && data.error) || {};
    const err = new ApiError(res.status, e.code || 'internal', e.message || res.statusText, e.items);
    if (sessionEnded(err) && !path.startsWith('/auth/') && state.me) sessionLost(err);
    throw err;
  }
  return data;
}

export async function refreshMe() {
  state.me = (await api('GET', '/me')).user;
}

function sessionLost(err) {
  state.me = null;
  resetData();
  closeModal();
  toast(ERROR_TEXT[err.code === 'account_disabled' ? err.code : 'unauthorized'], 'error');
  go('#/login');
}

/* ------------------------------------------------------------------ */
/* Toast, clipboard, modal                                             */
/* ------------------------------------------------------------------ */

export function toast(message, kind) {
  const el = h('div', { class: 'toast' + (kind === 'error' ? ' error' : '') }, icon(kind === 'error' ? 'alert' : 'check'), h('span', null, message));
  $toasts.append(el);
  setTimeout(() => el.remove(), 2600);
}

export async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;top:-1000px;opacity:0', readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`已复制${what || ''}`);
}

let modalCleanup = null;

export function closeModal() {
  if (modalCleanup) modalCleanup();
}

// openModal renders a dialog. build(close) returns its body and footer;
// onClose runs once however the dialog is closed. opts.wide gives lists
// and tables more room.
export function openModal(title, build, onClose, opts) {
  closeModal();
  const previous = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    $overlay.replaceChildren();
    modalCleanup = null;
    if (previous && previous.isConnected && previous.focus) previous.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const dialog = h('div', { class: 'modal' + (opts && opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', { class: 'modal-title' }, title)),
    build(close));
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, dialog);
  $overlay.replaceChildren(backdrop);
  document.addEventListener('keydown', onKey);
  modalCleanup = close;
  const focusable = dialog.querySelector('input, textarea, .btn-primary, .btn-danger');
  if (focusable) focusable.focus();
  return close;
}

export function confirmDialog({ title, message, confirmText, danger }) {
  return new Promise((resolve) => {
    let confirmed = false;
    openModal(title, (close) => [
      h('div', { class: 'modal-body' }, h('p', null, message)),
      h('div', { class: 'modal-foot' },
        h('button', { type: 'button', class: 'btn', onclick: close }, '取消'),
        h('button', {
          type: 'button',
          class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'),
          onclick: () => {
            confirmed = true;
            close();
          },
        }, confirmText || '确定')),
    ], () => resolve(confirmed));
  });
}

/**
 * chooseDialog asks which of a few ways to go on.
 *
 * @param {{title: string, message: string, choices: {value: string, text: string, primary?: boolean, danger?: boolean}[]}} opts
 * @returns {Promise<string|null>} The chosen value, or null when cancelled.
 */
export function chooseDialog({ title, message, choices }) {
  return new Promise((resolve) => {
    let chosen = null;
    openModal(title, (close) => [
      h('div', { class: 'modal-body' }, h('p', null, message)),
      h('div', { class: 'modal-foot wrap' },
        h('button', { type: 'button', class: 'btn', onclick: close }, '取消'),
        choices.map((c) => h('button', {
          type: 'button',
          class: 'btn' + (c.primary ? ' btn-primary' : c.danger ? ' btn-danger-outline' : ''),
          onclick: () => {
            chosen = c.value;
            close();
          },
        }, c.text))),
    ], () => resolve(chosen));
  });
}

// confirmDelete asks for confirmation, then sends DELETE. It resolves true
// once the item is gone, including when it had already been deleted.
export async function confirmDelete(dialog, path, errOverrides) {
  if (!(await confirmDialog({ ...dialog, danger: true }))) return false;
  try {
    await api('DELETE', path);
  } catch (err) {
    if (err.code === 'not_found') return true;
    toastError(err, errOverrides);
    return false;
  }
  return true;
}

// formDialog shows a form; onSubmit(values) returns an error message or "".
// A field is { name, label, type, value, placeholder, autocomplete, hint, options }:
// type is an input type, 'checkbox' (value is a boolean), 'textarea' or
// 'select' (options is [[value, text], ...]; the submitted value is the
// option's value string); hint is a note under the input.
export function formDialog({ title, intro, fields, submitText, onSubmit }) {
  openModal(title, (close) => {
    const inputs = {};
    const error = h('div', { class: 'form-error' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, submitText || '保存');
    const form = h('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        const values = {};
        for (const [name, input] of Object.entries(inputs)) values[name] = input.type === 'checkbox' ? input.checked : input.value;
        submit.disabled = true;
        error.textContent = '';
        try {
          const msg = await onSubmit(values);
          if (msg) error.textContent = msg;
          else close();
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('div', { class: 'modal-body' },
      intro ? h('p', null, intro) : null,
      fields.map((f) => {
        const id = 'f-' + f.name;
        const hint = f.hint ? h('div', { class: 'form-hint' }, f.hint) : null;
        if (f.type === 'checkbox') {
          inputs[f.name] = h('input', { type: 'checkbox', id, checked: f.value });
          return h('div', { class: 'form-row' }, h('label', { class: 'checkbox', for: id }, inputs[f.name], f.label), hint);
        }
        if (f.type === 'select') {
          inputs[f.name] = h('select', { class: 'input input-select', id },
            f.options.map(([value, text]) => h('option', { value }, text)));
          if (f.value != null) inputs[f.name].value = f.value;
        } else if (f.type === 'textarea') {
          inputs[f.name] = h('textarea', { class: 'input textarea', id, rows: 6, spellcheck: 'false', placeholder: f.placeholder || '', value: f.value });
        } else {
          inputs[f.name] = h('input', { class: 'input', id, type: f.type || 'text', autocomplete: f.autocomplete || 'off', placeholder: f.placeholder || '', value: f.value });
        }
        return formRow(f.label, inputs[f.name], hint);
      }),
      error),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, '取消'),
      submit));
    return form;
  });
}

/* ------------------------------------------------------------------ */
/* Small widgets                                                       */
/* ------------------------------------------------------------------ */

// singlePage lays out a page without a list pane: the title (narrow
// screens show it in the top bar instead), an optional intro and content.
export function singlePage(title, intro, ...children) {
  return h('div', { class: 'page single' },
    h('div', { class: 'content' },
      h('div', { class: 'content-inner' },
        h('h1', { class: 'page-title' }, title),
        intro ? h('p', { class: 'page-sub' }, intro) : null,
        children)));
}

export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName)),
    h('div', { class: 'empty-title' }, title),
    text ? h('div', { class: 'empty-text' }, text) : null,
    action || null);
}

export function loading() {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner', 'aria-label': '正在加载' }));
}

export function field(label, value, opts) {
  const o = opts || {};
  const empty = value == null || value === '';
  return h('div', { class: 'field' },
    h('div', { class: 'field-main' },
      h('div', { class: 'field-label' }, label),
      h('div', { class: 'field-value' + (o.mono ? ' mono' : '') + (empty ? ' muted' : '') }, empty ? (o.placeholder || '—') : value)),
    o.actions && o.actions.length ? h('div', { class: 'field-actions' }, o.actions) : null);
}

export function formRow(label, input, hint) {
  return h('div', { class: 'form-row' }, h('label', { for: input.id }, label), input, hint);
}

// usernameError checks a trimmed username against the docs/API.md rule.
export function usernameError(username) {
  if (!username) return '请输入用户名';
  if ([...username].length > 64) return '用户名不能超过 64 个字符';
  return '';
}

export function roleText(u) {
  return u.is_admin ? '管理员' : '普通用户';
}

// lastUsedShort is "最近使用 3 天前" or "从未使用", for list rows.
export function lastUsedShort(t) {
  return t ? '最近使用 ' + fmtRelative(t) : '从未使用';
}

export function lastUsedField(t) {
  return field('最近使用', t ? `${fmtRelative(t)}（${fmtDateTime(t)}）` : '', { placeholder: '从未使用' });
}

export function copyAction(text, what) {
  return iconButton('copy', '复制' + (what || ''), () => copyText(text, what));
}

export function backButton(text, hash) {
  return h('div', { class: 'detail-back' },
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => go(hash) }, icon('back'), text));
}

export function searchBox(placeholder, value, oninput) {
  return h('div', { class: 'search' },
    icon('search'),
    h('input', { class: 'input', type: 'search', placeholder, value, 'aria-label': placeholder, oninput: (e) => oninput(e.target.value) }));
}
