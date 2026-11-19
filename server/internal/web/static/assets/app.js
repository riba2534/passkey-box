'use strict';

(() => {
  const $app = document.getElementById('app');
  const $overlay = document.getElementById('overlay-root');
  const $toasts = document.getElementById('toast-root');

  const state = {
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
  /* DOM helpers                                                         */
  /* ------------------------------------------------------------------ */

  const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly']);

  function h(tag, attrs, ...children) {
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
  };

  function icon(name) {
    const t = document.createElement('template');
    t.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return t.content.firstChild;
  }

  function iconButton(name, label, onclick, extraClass) {
    return h('button', { type: 'button', class: 'icon-btn' + (extraClass ? ' ' + extraClass : ''), title: label, 'aria-label': label, onclick }, icon(name));
  }

  function brandMark() {
    return h('span', { class: 'brand-mark' }, icon('key'));
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

  function fmtDateTime(s) {
    if (!s) return '—';
    const p = dateParts(s);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  function fmtDate(s) {
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

  function algName(alg) {
    if (alg === -7) return 'ES256（ECDSA P-256，SHA-256）';
    if (alg === -257) return 'RS256（RSASSA-PKCS1-v1_5，SHA-256）';
    return `COSE ${alg}`;
  }

  function credTitle(c) {
    return c.rp_name || c.rp_id;
  }

  function credAccount(c) {
    return c.user_name || c.user_display_name || '（无用户名）';
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

  function siteAvatar(rpId, name, size) {
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

  function userAvatar(name, size) {
    return h('span', { class: 'avatar round' + (size ? ' ' + size : ''), style: `background:${colorFor(name)}` }, firstChar(name));
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  const ERROR_TEXT = {
    network: '无法连接到服务器，请检查网络',
    unauthorized: '登录已失效，请重新登录',
    forbidden: '没有权限执行此操作',
    registration_disabled: '服务器未开启注册',
    not_found: '内容不存在或已被删除',
    conflict: '名称已存在',
    invalid_password: '当前密码不正确',
    invalid_request: '输入的内容不正确',
    internal: '服务器出错了，请稍后重试',
  };

  function errText(err, overrides) {
    return (overrides && overrides[err.code]) || ERROR_TEXT[err.code] || '操作失败，请重试';
  }

  // toastError reports a failed request; a 401 was already handled by api().
  function toastError(err, overrides) {
    if (err.status !== 401) toast(errText(err, overrides), 'error');
  }

  async function api(method, path, body) {
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
      const err = new ApiError(res.status, e.code || 'internal', e.message || res.statusText);
      if (res.status === 401 && !path.startsWith('/auth/') && state.me) sessionLost();
      throw err;
    }
    return data;
  }

  async function loadCreds() {
    state.creds = (await api('GET', '/credentials')).credentials;
  }

  async function loadUsers() {
    state.users = (await api('GET', '/admin/users')).users;
  }

  async function loadUserCreds(id) {
    state.userCreds[id] = (await api('GET', `/admin/users/${encodeURIComponent(id)}/credentials`)).credentials;
  }

  async function refreshMe() {
    state.me = (await api('GET', '/me')).user;
  }

  function resetData() {
    state.creds = null;
    state.users = null;
    state.userCreds = {};
  }

  function sessionLost() {
    state.me = null;
    resetData();
    closeModal();
    toast('登录已失效，请重新登录', 'error');
    go('#/login');
  }

  /* ------------------------------------------------------------------ */
  /* Toast, clipboard, modal                                             */
  /* ------------------------------------------------------------------ */

  function toast(message, kind) {
    const el = h('div', { class: 'toast' + (kind === 'error' ? ' error' : '') }, icon(kind === 'error' ? 'alert' : 'check'), h('span', null, message));
    $toasts.append(el);
    setTimeout(() => el.remove(), 2600);
  }

  async function copyText(text, what) {
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

  function closeModal() {
    if (modalCleanup) modalCleanup();
  }

  // openModal renders a dialog. build(close) returns its body and footer;
  // onClose runs once however the dialog is closed.
  function openModal(title, build, onClose) {
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
    const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', { class: 'modal-title' }, title)),
      build(close));
    const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, dialog);
    $overlay.replaceChildren(backdrop);
    document.addEventListener('keydown', onKey);
    modalCleanup = close;
    const focusable = dialog.querySelector('input, .btn-primary, .btn-danger');
    if (focusable) focusable.focus();
    return close;
  }

  function confirmDialog({ title, message, confirmText, danger }) {
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

  // confirmDelete asks for confirmation, then sends DELETE. It resolves true
  // once the item is gone, including when it had already been deleted.
  async function confirmDelete(dialog, path, errOverrides) {
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
  function formDialog({ title, intro, fields, submitText, onSubmit }) {
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
          if (f.type === 'checkbox') {
            inputs[f.name] = h('input', { type: 'checkbox', id });
            return h('div', { class: 'form-row' }, h('label', { class: 'checkbox', for: id }, inputs[f.name], f.label));
          }
          inputs[f.name] = h('input', { class: 'input', id, type: f.type || 'text', autocomplete: f.autocomplete || 'off', placeholder: f.placeholder || '' });
          return formRow(f.label, inputs[f.name]);
        }),
        error),
      h('div', { class: 'modal-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => close() }, '取消'),
        submit));
      return form;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Routing                                                             */
  /* ------------------------------------------------------------------ */

  const PAGE_TITLES = { passkeys: '我的通行密钥', users: '用户管理', install: '安装插件', settings: '账户设置' };
  const PAGES = Object.keys(PAGE_TITLES);

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const parts = raw.split('/');
    let id = '';
    if (parts.length > 1) {
      try {
        id = decodeURIComponent(parts.slice(1).join('/'));
      } catch {
        id = '';
      }
    }
    return { page: parts[0] || '', id };
  }

  function go(hash) {
    if (location.hash === hash) onRoute();
    else location.hash = hash;
  }

  function replaceHash(hash) {
    history.replaceState(null, '', hash);
  }

  async function onRoute() {
    const r = parseHash();
    closeModal();
    if (!state.me) {
      if (r.page === 'register' && state.info.allow_register) return renderAuth('register');
      if (r.page !== 'login') replaceHash('#/login');
      return renderAuth('login');
    }
    if (!PAGES.includes(r.page) || (r.page === 'users' && !state.me.is_admin)) {
      replaceHash('#/passkeys');
      r.page = 'passkeys';
      r.id = '';
    }
    state.route = r;
    const loads = [];
    if (r.page === 'passkeys' && !state.creds) loads.push(loadCreds());
    if (state.me.is_admin && !state.users) loads.push(loadUsers());
    if (r.page === 'users' && r.id && !state.userCreds[r.id]) loads.push(loadUserCreds(r.id));
    if (r.page === 'settings') loads.push(refreshMe());
    renderShell();
    if (!loads.length) return;
    try {
      await Promise.all(loads);
    } catch (err) {
      if (err.status === 401) return;
      if (!(r.page === 'users' && err.code === 'not_found')) toast(errText(err), 'error');
    }
    if (state.route === r && state.me) renderShell();
  }

  /* ------------------------------------------------------------------ */
  /* Login / register                                                    */
  /* ------------------------------------------------------------------ */

  function renderAuth(mode) {
    const register = mode === 'register';
    const username = h('input', { class: 'input', id: 'login-username', name: 'username', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' });
    const password = h('input', { class: 'input', id: 'login-password', name: 'password', type: 'password', autocomplete: register ? 'new-password' : 'current-password' });
    const confirm = register ? h('input', { class: 'input', id: 'login-confirm', type: 'password', autocomplete: 'new-password' }) : null;
    const error = h('div', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, register ? '注册' : '登录');

    const onSubmit = async (e) => {
      e.preventDefault();
      error.textContent = '';
      const u = username.value.trim();
      const invalid = usernameError(u);
      if (invalid) return void (error.textContent = invalid);
      if (!password.value) return void (error.textContent = '请输入密码');
      if (register && password.value !== confirm.value) return void (error.textContent = '两次输入的密码不一致');
      submit.disabled = true;
      try {
        const data = await api('POST', register ? '/auth/register' : '/auth/login', { username: u, password: password.value });
        state.me = data.user;
        resetData();
        go('#/passkeys');
      } catch (err) {
        error.textContent = errText(err, {
          unauthorized: '用户名或密码错误',
          conflict: '该用户名已被使用',
          invalid_request: '用户名或密码格式不正确',
        });
      } finally {
        submit.disabled = false;
      }
    };

    const card = h('div', { class: 'auth-card' },
      h('div', { class: 'auth-logo' }, brandMark()),
      h('h1', null, register ? '注册 Passkey Box' : '登录 Passkey Box'),
      h('p', { class: 'auth-sub' }, register ? '创建账户后即可在插件中使用你的通行密钥' : '管理保存在服务器上的通行密钥'),
      h('form', { onsubmit: onSubmit, novalidate: true },
        formRow('用户名', username),
        formRow('密码', password),
        register ? formRow('确认密码', confirm) : null,
        error,
        submit),
      state.info.allow_register
        ? h('div', { class: 'auth-switch' },
          register ? '已有账户？' : '还没有账户？',
          h('button', { type: 'button', onclick: () => go(register ? '#/login' : '#/register') }, register ? '登录' : '注册新账户'))
        : null);

    $app.className = '';
    $app.replaceChildren(h('div', { class: 'auth-page' }, card,
      h('div', { class: 'auth-footer' }, 'Passkey Box' + (state.info.version ? ' · ' + state.info.version : ''))));
    username.focus();
  }

  async function logout() {
    try {
      await api('POST', '/auth/logout');
    } catch {
      // The session is gone either way.
    }
    state.me = null;
    resetData();
    go('#/login');
  }

  /* ------------------------------------------------------------------ */
  /* Shell                                                               */
  /* ------------------------------------------------------------------ */

  function renderShell() {
    const r = state.route;
    const oldList = $app.querySelector('.list-body');
    const keepScroll = oldList && $app.dataset.page === r.page ? oldList.scrollTop : 0;

    const app = h('div', { class: 'app' },
      renderSidebar(),
      h('div', { class: 'nav-scrim', onclick: () => setNav(false) }),
      h('main', { class: 'main' }, renderTopbar(), renderPage()));
    $app.className = '';
    $app.dataset.page = r.page;
    $app.replaceChildren(app);

    const newList = $app.querySelector('.list-body');
    if (newList && keepScroll) newList.scrollTop = keepScroll;
  }

  function setNav(open) {
    const app = $app.querySelector('.app');
    if (app) app.classList.toggle('nav-open', open);
  }

  function renderSidebar() {
    const r = state.route;
    const me = state.me;
    const item = (page, iconName, text, count) => h('a', {
      class: 'nav-item' + (r.page === page ? ' active' : ''),
      href: '#/' + page,
      'aria-current': r.page === page ? 'page' : null,
    }, icon(iconName), h('span', { class: 'nav-text' }, text), count != null ? h('span', { class: 'nav-count' }, count) : null);

    return h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, brandMark(), h('span', { class: 'brand-name' }, 'Passkey Box')),
      h('nav', { class: 'nav', 'aria-label': '主导航' },
        item('passkeys', 'key', '我的通行密钥', state.creds ? state.creds.length : null),
        me.is_admin ? item('users', 'users', '用户管理', state.users ? state.users.length : null) : null),
      h('div', { class: 'nav-label' }, '设置'),
      h('nav', { class: 'nav', 'aria-label': '设置' },
        item('install', 'download', '安装插件'),
        item('settings', 'sliders', '账户设置')),
      h('div', { class: 'sidebar-footer' },
        h('div', { class: 'account-chip' },
          userAvatar(me.username, 'sm'),
          h('div', { class: 'account-meta' },
            h('div', { class: 'account-name', title: me.username }, me.username),
            h('div', { class: 'account-role' }, roleText(me))),
          iconButton('logout', '退出登录', logout))));
  }

  function renderTopbar() {
    return h('header', { class: 'topbar' },
      iconButton('menu', '打开菜单', () => setNav(true)),
      h('div', { class: 'topbar-title' }, PAGE_TITLES[state.route.page] || 'Passkey Box'));
  }

  function renderPage() {
    switch (state.route.page) {
      case 'users': return renderUsersPage();
      case 'install': return renderInstallPage();
      case 'settings': return renderSettingsPage();
      default: return renderPasskeysPage();
    }
  }

  function emptyState(iconName, title, text, action) {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-icon' }, icon(iconName)),
      h('div', { class: 'empty-title' }, title),
      text ? h('div', { class: 'empty-text' }, text) : null,
      action || null);
  }

  function loading() {
    return h('div', { class: 'loading' }, h('div', { class: 'spinner', 'aria-label': '正在加载' }));
  }

  function field(label, value, opts) {
    const o = opts || {};
    const empty = value == null || value === '';
    return h('div', { class: 'field' },
      h('div', { class: 'field-main' },
        h('div', { class: 'field-label' }, label),
        h('div', { class: 'field-value' + (o.mono ? ' mono' : '') + (empty ? ' muted' : '') }, empty ? (o.placeholder || '—') : value)),
      o.actions && o.actions.length ? h('div', { class: 'field-actions' }, o.actions) : null);
  }

  function formRow(label, input) {
    return h('div', { class: 'form-row' }, h('label', { for: input.id }, label), input);
  }

  // usernameError checks a trimmed username against the docs/API.md rule.
  function usernameError(username) {
    if (!username) return '请输入用户名';
    if ([...username].length > 64) return '用户名不能超过 64 个字符';
    return '';
  }

  function roleText(u) {
    return u.is_admin ? '管理员' : '普通用户';
  }

  // lastUsedShort is "最近使用 3 天前" or "从未使用", for list rows.
  function lastUsedShort(t) {
    return t ? '最近使用 ' + fmtRelative(t) : '从未使用';
  }

  function lastUsedField(t) {
    return field('最近使用', t ? `${fmtRelative(t)}（${fmtDateTime(t)}）` : '', { placeholder: '从未使用' });
  }

  function copyAction(text, what) {
    return iconButton('copy', '复制' + (what || ''), () => copyText(text, what));
  }

  function backButton(text, hash) {
    return h('div', { class: 'detail-back' },
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => go(hash) }, icon('back'), text));
  }

  function searchBox(placeholder, value, oninput) {
    return h('div', { class: 'search' },
      icon('search'),
      h('input', { class: 'input', type: 'search', placeholder, value, 'aria-label': placeholder, oninput: (e) => oninput(e.target.value) }));
  }

  /* ------------------------------------------------------------------ */
  /* My passkeys                                                         */
  /* ------------------------------------------------------------------ */

  function matchesCred(c, q) {
    if (!q) return true;
    return [c.rp_id, c.rp_name, c.user_name, c.user_display_name, c.label, c.origin]
      .some((v) => (v || '').toLowerCase().includes(q));
  }

  function renderPasskeysPage() {
    const r = state.route;
    const listBody = h('div', { class: 'list-body' });
    const countEl = h('span');
    const fillList = () => {
      renderPasskeyList(listBody, countEl);
    };
    const sort = h('select', {
      class: 'select',
      'aria-label': '排序方式',
      onchange: (e) => {
        state.sort = e.target.value;
        localStorage.setItem('pkb.sort', state.sort);
        fillList();
      },
    },
    [['site', '按网站分组'], ['created', '最近创建'], ['used', '最近使用']].map(([v, t]) => h('option', { value: v }, t)));
    sort.value = state.sort;

    const listPane = h('section', { class: 'list-pane', 'aria-label': '通行密钥列表' },
      h('div', { class: 'list-header' },
        h('div', { class: 'list-title-row' }, h('h1', { class: 'list-title' }, '我的通行密钥')),
        searchBox('搜索网站、用户名或备注', state.query.passkeys, (v) => {
          state.query.passkeys = v;
          fillList();
        }),
        h('div', { class: 'list-tools' }, countEl, sort)),
      listBody);
    fillList();

    let detail;
    if (!r.id) {
      detail = emptyState('key', '选择一个通行密钥', '在左侧列表中选择通行密钥以查看详细信息');
    } else if (!state.creds) {
      detail = loading();
    } else {
      const c = state.creds.find((x) => x.id === r.id);
      detail = c
        ? renderCredentialDetail(c)
        : h('div', { class: 'detail' }, backButton('我的通行密钥', '#/passkeys'), emptyState('alert', '找不到这个通行密钥', '它可能已被删除'));
    }

    return h('div', { class: 'page' + (r.id ? ' has-selection' : '') },
      listPane,
      h('section', { class: 'detail-pane', 'aria-label': '通行密钥详情' }, detail));
  }

  function renderPasskeyList(container, countEl) {
    if (!state.creds) {
      countEl.textContent = '';
      container.replaceChildren(loading());
      return;
    }
    const q = state.query.passkeys.trim().toLowerCase();
    const all = state.creds;
    const list = all.filter((c) => matchesCred(c, q));
    countEl.textContent = q ? `${list.length} / ${all.length} 个` : `共 ${all.length} 个`;

    if (!all.length) {
      container.replaceChildren(emptyState('key', '还没有通行密钥',
        '安装插件后，在网站上创建的通行密钥会自动保存到这里。',
        h('a', { class: 'btn btn-primary btn-sm', href: '#/install' }, '安装插件')));
      return;
    }
    if (!list.length) {
      container.replaceChildren(emptyState('search', '没有匹配的通行密钥', '换个关键词试试'));
      return;
    }

    const selected = state.route.id;
    const row = (c) => h('a', {
      class: 'list-item' + (c.id === selected ? ' selected' : ''),
      href: '#/passkeys/' + encodeURIComponent(c.id),
      'aria-current': c.id === selected ? 'true' : null,
    },
    siteAvatar(c.rp_id, credTitle(c)),
    h('div', { class: 'item-main' },
      h('div', { class: 'item-title' }, h('span', { class: 'text' }, credTitle(c)), c.label ? h('span', { class: 'badge gray' }, c.label) : null),
      h('div', { class: 'item-sub' }, credAccount(c))));

    const nodes = [];
    if (state.sort === 'site') {
      const groups = new Map();
      for (const c of list) {
        const key = c.rp_id.toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      for (const key of keys) {
        const items = groups.get(key).sort((a, b) => credAccount(a).localeCompare(credAccount(b), 'zh-CN'));
        nodes.push(h('div', { class: 'group-header' }, h('span', null, key), h('span', null, items.length)));
        for (const c of items) nodes.push(row(c));
      }
    } else if (state.sort === 'used') {
      const sorted = [...list].sort((a, b) => (b.last_used_at || '').localeCompare(a.last_used_at || ''));
      for (const c of sorted) nodes.push(row(c));
    } else {
      for (const c of list) nodes.push(row(c));
    }
    container.replaceChildren(...nodes);
  }

  // siteURL only trusts http(s) origins, so a stored "javascript:" origin
  // can never become a clickable link.
  function siteURL(c) {
    try {
      const u = new URL(c.origin);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch {
      // Missing or unparsable origin: fall back to the RP ID.
    }
    return 'https://' + c.rp_id;
  }

  function renderCredentialDetail(c) {
    const labelInput = h('input', { class: 'input', value: c.label, placeholder: '添加备注，例如“工作号”', maxlength: '200', 'aria-label': '备注' });
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: true }, '保存');
    const saveLabel = async () => {
      if (labelInput.value === c.label) return;
      saveBtn.disabled = true;
      try {
        const data = await api('PATCH', `/credentials/${encodeURIComponent(c.id)}`, { label: labelInput.value });
        const i = state.creds.findIndex((x) => x.id === c.id);
        if (i >= 0) state.creds[i] = data.credential;
        toast('备注已保存');
        renderShell();
      } catch (err) {
        saveBtn.disabled = false;
        toastError(err);
      }
    };
    labelInput.addEventListener('input', () => {
      saveBtn.disabled = labelInput.value === c.label;
    });
    labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveLabel();
    });
    saveBtn.addEventListener('click', saveLabel);

    const remove = async () => {
      const deleted = await confirmDelete({
        title: '删除通行密钥？',
        message: `删除后将无法再用它登录 ${c.rp_id} 上的账号“${credAccount(c)}”。此操作无法撤销。`,
        confirmText: '删除',
      }, `/credentials/${encodeURIComponent(c.id)}`);
      if (!deleted) return;
      state.creds = state.creds.filter((x) => x.id !== c.id);
      state.users = null;
      state.userCreds = {};
      toast('通行密钥已删除');
      go('#/passkeys');
    };

    return h('div', { class: 'detail' },
      backButton('我的通行密钥', '#/passkeys'),
      h('div', { class: 'detail-head' },
        siteAvatar(c.rp_id, credTitle(c), 'lg'),
        h('div', { class: 'detail-head-main' },
          h('h2', { class: 'detail-title' }, credTitle(c)),
          h('div', { class: 'detail-subtitle' }, h('span', { class: 'badge' }, '通行密钥'), h('span', null, c.rp_id)))),
      h('div', { class: 'card' },
        field('用户名', c.user_name, { actions: c.user_name ? [copyAction(c.user_name, '用户名')] : [] }),
        field('显示名', c.user_display_name),
        field('网站', c.rp_id, {
          actions: [h('a', { class: 'icon-btn', href: siteURL(c), target: '_blank', rel: 'noopener noreferrer', title: '打开网站', 'aria-label': '打开网站' }, icon('external'))],
        })),
      h('h3', { class: 'section-title' }, '备注'),
      h('div', { class: 'card' },
        h('div', { class: 'field' }, h('div', { class: 'field-main' }, h('div', { class: 'label-edit' }, labelInput, saveBtn)))),
      h('h3', { class: 'section-title' }, '使用情况'),
      h('div', { class: 'card' },
        field('创建时间', fmtDateTime(c.created_at)),
        lastUsedField(c.last_used_at),
        field('使用次数', `${c.use_count} 次`)),
      h('h3', { class: 'section-title' }, '技术信息'),
      h('div', { class: 'card' },
        field('算法', algName(c.alg)),
        field('凭据 ID', c.id, { mono: true, actions: [copyAction(c.id, '凭据 ID')] }),
        field('用户句柄（User Handle）', c.user_handle, { mono: true, actions: [copyAction(c.user_handle, '用户句柄')] }),
        field('注册来源', c.origin)),
      h('div', { class: 'danger-zone' },
        h('button', { type: 'button', class: 'btn btn-danger-outline', onclick: remove }, icon('trash'), '删除通行密钥')));
  }

  /* ------------------------------------------------------------------ */
  /* Users (admin)                                                       */
  /* ------------------------------------------------------------------ */

  function userSummary(u) {
    return `${u.credential_count} 个通行密钥 · ${lastUsedShort(u.last_used_at)}`;
  }

  function renderUsersPage() {
    const r = state.route;
    const listBody = h('div', { class: 'list-body' });
    const countEl = h('span');
    const fillList = () => renderUserList(listBody, countEl);

    const listPane = h('section', { class: 'list-pane', 'aria-label': '用户列表' },
      h('div', { class: 'list-header' },
        h('div', { class: 'list-title-row' },
          h('h1', { class: 'list-title' }, '用户管理'),
          h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: createUserDialog }, icon('plus'), '新建用户')),
        searchBox('搜索用户名', state.query.users, (v) => {
          state.query.users = v;
          fillList();
        }),
        h('div', { class: 'list-tools' }, countEl)),
      listBody);
    fillList();

    let detail;
    if (!r.id) {
      detail = emptyState('users', '选择一个用户', '查看用户信息、管理其通行密钥，或点击“新建用户”添加账户');
    } else if (!state.users) {
      detail = loading();
    } else {
      const u = state.users.find((x) => String(x.id) === r.id);
      detail = u
        ? renderUserDetail(u)
        : h('div', { class: 'detail' }, backButton('用户管理', '#/users'), emptyState('alert', '找不到这个用户', '该用户可能已被删除'));
    }

    return h('div', { class: 'page' + (r.id ? ' has-selection' : '') },
      listPane,
      h('section', { class: 'detail-pane', 'aria-label': '用户详情' }, detail));
  }

  function renderUserList(container, countEl) {
    if (!state.users) {
      countEl.textContent = '';
      container.replaceChildren(loading());
      return;
    }
    const q = state.query.users.trim().toLowerCase();
    const list = state.users.filter((u) => !q || u.username.toLowerCase().includes(q));
    countEl.textContent = q ? `${list.length} / ${state.users.length} 个用户` : `共 ${state.users.length} 个用户`;
    if (!list.length) {
      container.replaceChildren(emptyState('search', '没有匹配的用户', '换个关键词试试'));
      return;
    }
    const selected = state.route.id;
    container.replaceChildren(...list.map((u) => h('a', {
      class: 'list-item' + (String(u.id) === selected ? ' selected' : ''),
      href: '#/users/' + u.id,
      'aria-current': String(u.id) === selected ? 'true' : null,
    },
    userAvatar(u.username),
    h('div', { class: 'item-main' },
      h('div', { class: 'item-title' },
        h('span', { class: 'text' }, u.username),
        u.is_admin ? h('span', { class: 'badge' }, '管理员') : null,
        u.id === state.me.id ? h('span', { class: 'badge gray' }, '你') : null),
      h('div', { class: 'item-sub' }, userSummary(u)),
      h('div', { class: 'item-meta' }, '创建于 ' + fmtDate(u.created_at))))));
  }

  function createUserDialog() {
    formDialog({
      title: '新建用户',
      intro: '新用户可以用这里设置的用户名和密码登录后台和插件。',
      submitText: '创建',
      fields: [
        { name: 'username', label: '用户名', autocomplete: 'off' },
        { name: 'password', label: '密码', type: 'password', autocomplete: 'new-password' },
        { name: 'is_admin', label: '设为管理员', type: 'checkbox' },
      ],
      onSubmit: async (v) => {
        const username = v.username.trim();
        const invalid = usernameError(username);
        if (invalid) return invalid;
        if (!v.password) return '请输入密码';
        try {
          const data = await api('POST', '/admin/users', { username, password: v.password, is_admin: v.is_admin });
          await loadUsers();
          toast(`已创建用户 ${data.user.username}`);
          go('#/users/' + data.user.id);
          return '';
        } catch (err) {
          return errText(err, { conflict: '该用户名已存在', invalid_request: '用户名或密码格式不正确' });
        }
      },
    });
  }

  function resetPasswordDialog(u) {
    formDialog({
      title: '重置密码',
      intro: `为 ${u.username} 设置新密码。用户已登录的会话不受影响。`,
      submitText: '重置密码',
      fields: [
        { name: 'password', label: '新密码', type: 'password', autocomplete: 'new-password' },
        { name: 'confirm', label: '确认新密码', type: 'password', autocomplete: 'new-password' },
      ],
      onSubmit: async (v) => {
        if (!v.password) return '请输入新密码';
        if (v.password !== v.confirm) return '两次输入的密码不一致';
        try {
          await api('PATCH', `/admin/users/${u.id}`, { password: v.password });
          toast('密码已重置');
          return '';
        } catch (err) {
          return errText(err);
        }
      },
    });
  }

  async function toggleAdmin(u) {
    const makeAdmin = !u.is_admin;
    const ok = await confirmDialog({
      title: makeAdmin ? '设为管理员？' : '取消管理员？',
      message: makeAdmin
        ? `${u.username} 将可以管理所有用户及其通行密钥。`
        : `${u.username} 将不能再访问用户管理。`,
      confirmText: makeAdmin ? '设为管理员' : '取消管理员',
    });
    if (!ok) return;
    try {
      await api('PATCH', `/admin/users/${u.id}`, { is_admin: makeAdmin });
      await loadUsers();
      toast(makeAdmin ? '已设为管理员' : '已取消管理员');
      renderShell();
    } catch (err) {
      toastError(err, { invalid_request: '不能取消自己的管理员身份' });
    }
  }

  async function deleteUser(u) {
    const deleted = await confirmDelete({
      title: `删除用户 ${u.username}？`,
      message: `该用户的 ${u.credential_count} 个通行密钥和所有登录会话将被一并删除。此操作无法撤销。`,
      confirmText: '删除用户',
    }, `/admin/users/${u.id}`, { invalid_request: '不能删除自己' });
    if (!deleted) return;
    delete state.userCreds[String(u.id)];
    try {
      await loadUsers();
    } catch {
      state.users = null;
    }
    toast('用户已删除');
    go('#/users');
  }

  async function deleteUserCred(u, c) {
    const deleted = await confirmDelete({
      title: '删除通行密钥？',
      message: `将删除 ${u.username} 在 ${c.rp_id} 上的通行密钥“${credAccount(c)}”。此操作无法撤销。`,
      confirmText: '删除',
    }, `/admin/users/${u.id}/credentials/${encodeURIComponent(c.id)}`);
    if (!deleted) return;
    if (u.id === state.me.id) state.creds = null;
    try {
      await Promise.all([loadUsers(), loadUserCreds(String(u.id))]);
    } catch (err) {
      toastError(err);
    }
    toast('通行密钥已删除');
    renderShell();
  }

  function renderUserDetail(u) {
    const isMe = u.id === state.me.id;
    const creds = state.userCreds[String(u.id)];

    let credCard;
    if (!creds) {
      credCard = h('div', { class: 'card' }, loading());
    } else if (!creds.length) {
      credCard = h('div', { class: 'card' }, emptyState('key', '还没有通行密钥', null));
    } else {
      credCard = h('div', { class: 'card' }, creds.map((c) => h('div', { class: 'subitem' },
        siteAvatar(c.rp_id, credTitle(c), 'sm'),
        h('div', { class: 'item-main' },
          h('div', { class: 'item-title' }, h('span', { class: 'text' }, credTitle(c)), c.label ? h('span', { class: 'badge gray' }, c.label) : null),
          h('div', { class: 'item-sub' }, credAccount(c)),
          h('div', { class: 'item-meta' }, `创建于 ${fmtDate(c.created_at)} · ${lastUsedShort(c.last_used_at)} · ${c.use_count} 次`)),
        iconButton('trash', '删除通行密钥', () => deleteUserCred(u, c), 'danger'))));
    }

    return h('div', { class: 'detail' },
      backButton('用户管理', '#/users'),
      h('div', { class: 'detail-head' },
        userAvatar(u.username, 'lg'),
        h('div', { class: 'detail-head-main' },
          h('h2', { class: 'detail-title' }, u.username),
          h('div', { class: 'detail-subtitle' },
            h('span', { class: u.is_admin ? 'badge' : 'badge gray' }, roleText(u)),
            isMe ? h('span', null, '当前登录的账户') : null))),
      h('div', { class: 'detail-actions', style: 'margin:-8px 0 20px' },
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => resetPasswordDialog(u) }, icon('lock'), '重置密码'),
        h('button', {
          type: 'button',
          class: 'btn btn-sm',
          disabled: isMe && u.is_admin,
          title: isMe && u.is_admin ? '不能取消自己的管理员身份' : null,
          onclick: () => toggleAdmin(u),
        }, icon('shield'), u.is_admin ? '取消管理员' : '设为管理员'),
        h('button', {
          type: 'button',
          class: 'btn btn-sm btn-danger-outline',
          disabled: isMe,
          title: isMe ? '不能删除自己' : null,
          onclick: () => deleteUser(u),
        }, icon('trash'), '删除用户')),
      h('div', { class: 'card' },
        field('用户名', u.username, { actions: [copyAction(u.username, '用户名')] }),
        field('角色', roleText(u)),
        field('通行密钥', `${u.credential_count} 个`),
        lastUsedField(u.last_used_at),
        field('创建时间', fmtDateTime(u.created_at))),
      h('h3', { class: 'section-title' }, `通行密钥${creds ? ' · ' + creds.length : ''}`),
      credCard);
  }

  /* ------------------------------------------------------------------ */
  /* Install & settings                                                  */
  /* ------------------------------------------------------------------ */

  function renderInstallPage() {
    const origin = location.origin;
    const step = (n, title, text) => h('li', { class: 'step' },
      h('span', { class: 'step-num' }, n),
      h('div', { class: 'step-main' }, h('div', { class: 'step-title' }, title), h('div', { class: 'step-text' }, text)));

    const download = state.info.extension_download
      ? h('div', { class: 'card download-card' },
        brandMark(),
        h('div', { class: 'dl-text' },
          h('div', { class: 'dl-title' }, 'Passkey Box 浏览器插件'),
          h('div', { class: 'dl-sub' }, '适用于 Chrome、Edge 等 Chromium 内核浏览器')),
        h('a', { class: 'btn btn-primary', href: '/downloads/passkey-box-extension.zip', download: 'passkey-box-extension.zip' }, icon('download'), '下载插件'))
      : h('div', { class: 'notice', style: 'margin-bottom:20px' }, '服务器还没有提供插件安装包（未配置 PKB_EXTENSION_ZIP），请向管理员索取插件文件。');

    return h('div', { class: 'page single' },
      h('div', { class: 'content' },
        h('div', { class: 'content-inner' },
          h('h1', { class: 'page-title' }, '安装插件'),
          h('p', { class: 'page-sub' }, '安装 Passkey Box 插件后，网站创建的通行密钥会保存到这台服务器，登录时自动使用，无需指纹或系统验证。'),
          download,
          h('h3', { class: 'section-title' }, '安装步骤'),
          h('div', { class: 'card' },
            h('ol', { class: 'steps' },
              step(1, '解压安装包', '把下载的 passkey-box-extension.zip 解压到一个固定的文件夹，安装后不要删除或移动它。'),
              step(2, '打开扩展程序页面', ['在地址栏输入 ', h('span', { class: 'kbd' }, 'chrome://extensions'), ' 并回车。']),
              step(3, '开启开发者模式', '打开页面右上角的“开发者模式”开关。'),
              step(4, '加载已解压的扩展程序', '点击“加载已解压的扩展程序”，选择第 1 步解压出的文件夹。'),
              step(5, '登录插件', '点击浏览器工具栏中的 Passkey Box 图标（可先在拼图菜单里固定），填写下面的服务器地址、用户名和密码。'))),
          h('h3', { class: 'section-title' }, '插件设置'),
          h('div', { class: 'card' },
            field('服务器地址', origin, { mono: true, actions: [copyAction(origin, '服务器地址')] }),
            field('用户名', state.me.username, { actions: [copyAction(state.me.username, '用户名')] }),
            field('密码', '与登录本后台的密码相同')))));
  }

  function renderSettingsPage() {
    const me = state.me;
    const old = h('input', { class: 'input', id: 'pw-old', type: 'password', autocomplete: 'current-password' });
    const next = h('input', { class: 'input', id: 'pw-new', type: 'password', autocomplete: 'new-password' });
    const confirm = h('input', { class: 'input', id: 'pw-confirm', type: 'password', autocomplete: 'new-password' });
    const error = h('div', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, '修改密码');

    const onSubmit = async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (!old.value) return void (error.textContent = '请输入当前密码');
      if (!next.value) return void (error.textContent = '请输入新密码');
      if (next.value !== confirm.value) return void (error.textContent = '两次输入的新密码不一致');
      submit.disabled = true;
      try {
        await api('PUT', '/me/password', { old_password: old.value, new_password: next.value });
        old.value = next.value = confirm.value = '';
        toast('密码已修改，请在插件中使用新密码');
      } catch (err) {
        if (err.status !== 401) error.textContent = errText(err);
      } finally {
        submit.disabled = false;
      }
    };

    return h('div', { class: 'page single' },
      h('div', { class: 'content' },
        h('div', { class: 'content-inner' },
          h('h1', { class: 'page-title' }, '账户设置'),
          h('p', { class: 'page-sub' }, '查看账户信息并修改登录密码。'),
          h('h3', { class: 'section-title' }, '账户'),
          h('div', { class: 'card' },
            field('用户名', me.username),
            field('角色', roleText(me)),
            field('通行密钥', `${me.credential_count} 个`),
            field('创建时间', fmtDateTime(me.created_at))),
          h('h3', { class: 'section-title' }, '修改密码'),
          h('form', { class: 'card form-card', onsubmit: onSubmit, novalidate: true },
            h('input', { type: 'text', autocomplete: 'username', value: me.username, hidden: true, readonly: true }),
            formRow('当前密码', old),
            formRow('新密码', next),
            formRow('确认新密码', confirm),
            error,
            h('div', { class: 'form-actions' }, submit)))));
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    await Promise.all([
      // On failure keep the default info; the login form still works.
      api('GET', '/info').then((info) => { state.info = info; }, () => {}),
      refreshMe().catch(() => { state.me = null; }),
    ]);
    window.addEventListener('hashchange', onRoute);
    onRoute();
  }

  boot();
})();
