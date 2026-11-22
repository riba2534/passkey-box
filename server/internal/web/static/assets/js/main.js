// The console shell: page registry, hash routing, sidebar, sign-in and boot.

import {
  $app, state, h, icon, iconButton, brandMark, userAvatar, api, errText, toast,
  closeModal, refreshMe, resetData, formRow, usernameError, roleText, installShell, go,
} from './core.js';
import passkeys from './pages/passkeys.js';
import activity from './pages/activity.js';
import overview from './pages/overview.js';
import users from './pages/users.js';
import credentials from './pages/credentials.js';
import audit from './pages/audit.js';
import agent from './pages/agent.js';
import install from './pages/install.js';
import settings from './pages/settings.js';

/* ------------------------------------------------------------------ */
/* Page registry                                                       */
/* ------------------------------------------------------------------ */

/**
 * Every module under pages/ default-exports one page.
 *
 * @typedef {{page: string, id: string}} Route  Parsed from #/<page>[/<id>].
 *
 * @typedef {object} Page
 * @property {string} id            Route segment: the page lives at #/<id>[/<sub id>].
 * @property {string} title         Sidebar and top bar text.
 * @property {string} icon          Sidebar icon, a name from ICONS in core.js.
 * @property {boolean} [adminOnly]  Hidden from non-admins, who are sent to #/passkeys.
 * @property {(route: Route) => Node} render  Builds the page; called on every redraw.
 * @property {(route: Route) => (Promise<unknown>|undefined)} [load]
 *   Runs when the page is visited. Return a promise to fetch data: the shell
 *   renders at once (show loading() for missing data) and again when it
 *   settles. A rejection other than 401 becomes an error toast, so catch the
 *   errors the page displays itself.
 * @property {() => (Promise<unknown>|undefined)} [preload]
 *   Like load, but runs on every route change while the page is visible in
 *   the sidebar; use it for the data count() needs.
 * @property {() => (number|null)} [count]  Sidebar count; null hides it.
 * @property {() => void} [reset]   Drops cached data on sign-in, sign-out and session loss.
 */

// The sidebar: a group without a label is the main navigation. A group
// whose pages are all hidden from the user is left out.
const NAV = [
  { pages: [passkeys, activity] },
  { label: '管理', pages: [overview, users, credentials, audit] },
  { label: '设置', pages: [agent, install, settings] },
];

const PAGES = new Map(NAV.flatMap((g) => g.pages).map((p) => [p.id, p]));

function visible(page) {
  return !page.adminOnly || state.me.is_admin;
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

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
  let page = PAGES.get(r.page);
  if (!page || !visible(page)) {
    replaceHash('#/passkeys');
    page = passkeys;
    r.page = page.id;
    r.id = '';
  }
  state.route = r;
  const loads = [];
  for (const p of PAGES.values()) {
    if (p.preload && visible(p)) loads.push(p.preload());
  }
  if (page.load) loads.push(page.load(r));
  renderShell();
  if (!loads.some(Boolean)) return;
  try {
    await Promise.all(loads);
  } catch (err) {
    if (err.status === 401) return;
    toast(errText(err), 'error');
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
    h('main', { class: 'main' }, renderTopbar(), PAGES.get(r.page).render(r)));
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
  const item = (page) => {
    const active = r.page === page.id;
    const count = page.count ? page.count() : null;
    return h('a', {
      class: 'nav-item' + (active ? ' active' : ''),
      href: '#/' + page.id,
      'aria-current': active ? 'page' : null,
    }, icon(page.icon), h('span', { class: 'nav-text' }, page.title), count != null ? h('span', { class: 'nav-count' }, count) : null);
  };

  return h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, brandMark(), h('span', { class: 'brand-name' }, 'Passkey Box')),
    NAV.map((g) => {
      const pages = g.pages.filter(visible);
      if (!pages.length) return null;
      return [
        g.label ? h('div', { class: 'nav-label' }, g.label) : null,
        h('nav', { class: 'nav', 'aria-label': g.label || '主导航' }, pages.map(item)),
      ];
    }),
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
    h('div', { class: 'topbar-title' }, PAGES.get(state.route.page).title));
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  installShell({
    render: renderShell,
    route: onRoute,
    reset: () => {
      for (const p of PAGES.values()) if (p.reset) p.reset();
    },
  });
  await Promise.all([
    // On failure keep the default info; the login form still works.
    api('GET', '/info').then((info) => { state.info = info; }, () => {}),
    refreshMe().catch(() => { state.me = null; }),
  ]);
  window.addEventListener('hashchange', onRoute);
  onRoute();
}

boot();
