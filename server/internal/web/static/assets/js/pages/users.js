// 用户管理 (admin): accounts with their roles, status, passwords and notes,
// batch work on many at once, and the passkeys each user owns or has been
// shared.

import {
  state, h, icon, iconButton, api, errText, toast, toastError, renderShell, go, refreshMe, sessionEnded,
  openModal, confirmDialog, chooseDialog, formDialog, copyText, siteAvatar, userAvatar, credTitle, credAccount,
  fmtDate, fmtDateTime, emptyState, loading, field, formRow, usernameError, roleText,
  lastUsedShort, lastUsedField, copyAction, backButton, searchBox,
} from '../core.js';
import {
  pickUsers, runBatch, selection, selectionBar, selectBox, selectAllBox, credentialBadges, filterSelect, labelBadge,
} from '../components.js';
import {
  transferCreds, shareCreds, deleteCreds, forgetCredentials, showCredentials,
} from './credentials.js';
import { showAudit } from './audit.js';

// The server's limits (docs/API.md).
const MAX_CREATE = 200;
const MAX_DELETE = 100;

// The list is filtered here, so the selection may hold users that the
// current search hides; every batch previews exactly whom it touches.
const sel = selection();
let filters = { role: '', status: '' };
// The batch-create text survives a preview that is cancelled or fails.
let draft = emptyDraft();

function emptyDraft() {
  return { text: '', isAdmin: false, note: '' };
}

async function loadUsers() {
  state.users = (await api('GET', '/admin/users')).users;
}

// A missing user is not an error: the detail pane says so.
async function loadUserCreds(id) {
  try {
    state.userCreds[id] = (await api('GET', `/admin/users/${encodeURIComponent(id)}/credentials`)).credentials;
  } catch (err) {
    if (err.code !== 'not_found') throw err;
    delete state.userCreds[id];
  }
}

export default {
  id: 'users',
  title: '用户管理',
  icon: 'users',
  adminOnly: true,
  // The sidebar shows the user count on every page.
  preload: () => (state.users ? undefined : loadUsers()),
  // Passkey counts change on other pages, so showing the list reloads it;
  // a user's passkeys reload every time the user is shown.
  load: (r) => Promise.all([state.users ? loadUsers() : null, r.id ? loadUserCreds(r.id) : null]),
  render: renderUsersPage,
  count: () => (state.users ? state.users.length : null),
  reset: () => {
    state.users = null;
    state.userCreds = {};
    filters = { role: '', status: '' };
    draft = emptyDraft();
    sel.clear();
  },
};

/**
 * showUsers opens the list with the role or status filter set.
 *
 * @param {{role?: '' | 'admin' | 'user', status?: '' | 'active' | 'disabled'}} f
 */
export function showUsers(f) {
  filters = { role: f.role || '', status: f.status || '' };
  state.query.users = '';
  go('#/users');
}

function byId(id) {
  return state.users && state.users.find((u) => u.id === id);
}

// refreshUsers reloads the list and the open user's passkeys after a
// change, and the signed-in account when the change touched it.
async function refreshUsers(touchedMe) {
  const r = state.route;
  try {
    await Promise.all([
      loadUsers(),
      r.page === 'users' && r.id ? loadUserCreds(r.id) : null,
      touchedMe ? refreshMe() : null,
    ]);
  } catch (err) {
    if (sessionEnded(err)) return;
    toastError(err);
  }
  renderShell();
}

// userLabel names failed items in a batch error by username instead of ID.
function userLabel(item) {
  const v = item.value;
  const u = byId(v && typeof v === 'object' ? v.user : v);
  return u ? u.username : '';
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

function visibleUsers() {
  const q = state.query.users.trim().toLowerCase();
  return state.users.filter((u) => (!q || u.username.toLowerCase().includes(q) || (u.note || '').toLowerCase().includes(q))
    && (!filters.role || (filters.role === 'admin') === u.is_admin)
    && (!filters.status || (filters.status === 'disabled') === u.disabled));
}

function renderUsersPage() {
  const r = state.route;
  const listBody = h('div', { class: 'list-body' });
  const countEl = h('span');
  const selectAll = selectAllBox(sel, () => (state.users ? visibleUsers().map((u) => u.id) : []));
  const fill = () => {
    renderUserList(listBody, countEl);
    selectAll.refresh();
  };
  const setFilter = (patch) => {
    filters = { ...filters, ...patch };
    renderShell();
  };

  const listPane = h('section', { class: 'list-pane', 'aria-label': '用户列表' },
    h('div', { class: 'list-header' },
      h('div', { class: 'list-title-row' },
        h('h1', { class: 'list-title' }, '用户管理'),
        h('div', { class: 'list-title-actions' },
          h('button', { type: 'button', class: 'btn btn-sm', onclick: batchCreateDialog }, icon('users'), '批量创建'),
          h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: createUserDialog }, icon('plus'), '新建用户'))),
      searchBox('搜索用户名或备注', state.query.users, (v) => {
        state.query.users = v;
        fill();
      }),
      h('div', { class: 'filter-bar' },
        filterSelect('角色', filters.role, [['', '角色：全部'], ['admin', '管理员'], ['user', '普通用户']], (v) => setFilter({ role: v })),
        filterSelect('状态', filters.status, [['', '状态：全部'], ['active', '正常'], ['disabled', '已停用']], (v) => setFilter({ status: v }))),
      h('div', { class: 'list-tools' }, h('span', { class: 'select-all' }, selectAll, countEl)),
      selectionBar(sel, [
        { text: '停用', icon: 'ban', onclick: (ids) => updateUsers(ids, 'disable') },
        { text: '启用', icon: 'check', onclick: (ids) => updateUsers(ids, 'enable') },
        { text: '设为管理员', icon: 'shield', onclick: (ids) => updateUsers(ids, 'promote') },
        { text: '取消管理员', icon: 'user', onclick: (ids) => updateUsers(ids, 'demote') },
        { text: '重置密码', icon: 'lock', onclick: (ids) => updateUsers(ids, 'password') },
        { text: '删除', icon: 'trash', danger: true, onclick: deleteUsers },
      ])),
    listBody);
  fill();

  let detail;
  if (!r.id) {
    detail = emptyState('users', '选择一个用户', '查看和修改用户、管理 TA 的通行密钥，或者多选后批量操作');
  } else if (!state.users) {
    detail = loading();
  } else {
    const u = state.users.find((x) => String(x.id) === r.id);
    detail = u
      ? renderUserDetail(u)
      : h('div', { class: 'detail' }, backButton('用户管理', '#/users'), emptyState('alert', '找不到这个用户', '该用户可能已被删除'));
  }

  return h('div', { class: 'page admin-page' + (r.id ? ' has-selection' : '') },
    listPane,
    h('section', { class: 'detail-pane', 'aria-label': '用户详情' }, detail));
}

function userBadges(u) {
  return [
    u.is_admin ? h('span', { class: 'badge' }, '管理员') : null,
    u.disabled ? h('span', { class: 'badge red' }, '已停用') : null,
    u.id === state.me.id ? h('span', { class: 'badge gray' }, '你') : null,
  ];
}

function shareCounts(u) {
  return [
    `${u.credential_count} 个通行密钥`,
    u.shared_out_count ? `共享出 ${u.shared_out_count} 个` : '',
    u.shared_in_count ? `收到共享 ${u.shared_in_count} 个` : '',
  ].filter(Boolean).join(' · ');
}

function renderUserList(container, countEl) {
  if (!state.users) {
    countEl.textContent = '';
    container.replaceChildren(loading());
    return;
  }
  const list = visibleUsers();
  const filtered = list.length !== state.users.length;
  countEl.textContent = filtered ? `${list.length} / ${state.users.length} 个用户` : `共 ${state.users.length} 个用户`;
  if (!list.length) {
    container.replaceChildren(emptyState('search', '没有匹配的用户', '换个关键词或筛选条件试试'));
    return;
  }
  const open = state.route.id;
  container.replaceChildren(...list.map((u) => h('a', {
    class: 'list-item' + (String(u.id) === open ? ' selected' : '') + (u.disabled ? ' is-disabled' : ''),
    href: '#/users/' + u.id,
    'aria-current': String(u.id) === open ? 'true' : null,
  },
  selectBox(sel, u.id, u.username),
  userAvatar(u.username),
  h('div', { class: 'item-main' },
    h('div', { class: 'item-title' }, h('span', { class: 'text', title: u.username }, u.username), userBadges(u)),
    h('div', { class: 'item-sub' }, `${shareCounts(u)} · ${lastUsedShort(u.last_used_at)}`),
    h('div', { class: 'item-meta', title: u.note || null }, u.note || '创建于 ' + fmtDate(u.created_at))))));
}

/* ------------------------------------------------------------------ */
/* Batch work                                                          */
/* ------------------------------------------------------------------ */

const UPDATES = {
  disable: {
    patch: { disabled: true },
    title: '停用用户',
    intro: '停用后，这些用户不能再登录后台、插件和 API，已有的登录立即失效。账户数据保留，随时可以重新启用。',
    confirmText: '停用',
    danger: true,
    self: '不能停用自己',
    done: '已停用',
  },
  enable: {
    patch: { disabled: false },
    title: '启用用户',
    intro: '启用后，这些用户可以重新用原来的密码登录。',
    confirmText: '启用',
    done: '已启用',
  },
  promote: {
    patch: { is_admin: true },
    title: '设为管理员',
    intro: '管理员可以管理所有用户和他们的通行密钥。',
    confirmText: '设为管理员',
    done: '已设为管理员',
  },
  demote: {
    patch: { is_admin: false },
    title: '取消管理员',
    intro: '这些用户将不能再访问管理页面。',
    confirmText: '取消管理员',
    self: '不能取消自己的管理员身份',
    done: '已取消管理员',
  },
  password: {
    patch: { generate_password: true },
    title: '重置密码',
    intro: '将为每个用户生成新的 16 位随机密码，旧密码立即失效，插件里要用新密码重新登录；已登录的网页不受影响。新密码在下一步只显示一次。',
    confirmText: '重置密码',
    danger: true,
    done: '已重置密码',
  },
};

async function updateUsers(ids, kind) {
  const k = UPDATES[kind];
  if (k.self && ids.includes(state.me.id)) {
    toast(`${k.self}，请先取消选择你的账户`, 'error');
    return;
  }
  const out = await runBatch({
    path: '/admin/users/batch-update',
    body: { items: ids.map((id) => ({ user: id, ...k.patch })) },
    title: `${k.title}（${ids.length} 人）`,
    intro: k.intro,
    describe: (r) => (r.changes.length ? r.user.username : `${r.user.username}（无需变更）`),
    confirmText: k.confirmText,
    danger: k.danger,
    label: userLabel,
  });
  if (!out) return;
  toast(`${k.done} ${out.results.filter((r) => r.changes.length).length} 个用户`);
  await refreshUsers(ids.includes(state.me.id));
  if (kind === 'password') passwordsDialog('新密码', out.results.map((r) => ({ username: r.user.username, password: r.password })));
}

async function deleteUsers(ids) {
  if (ids.includes(state.me.id)) {
    toast('不能删除自己，请先取消选择你的账户', 'error');
    return;
  }
  if (ids.length > MAX_DELETE) {
    toast(`一次最多删除 ${MAX_DELETE} 个用户`, 'error');
    return;
  }
  const users = ids.map(byId).filter(Boolean);
  const owned = users.reduce((n, u) => n + u.credential_count, 0);
  const who = users.length === 1 ? `${users[0].username} ` : `这 ${users.length} 个用户`;
  let to = null;
  if (owned) {
    const choice = await chooseDialog({
      title: users.length === 1 ? `删除用户 ${users[0].username}` : `删除 ${users.length} 个用户`,
      message: `${who}拥有 ${owned} 个通行密钥。可以先把它们交接给另一个用户（已有的共享保留），否则它们随用户一起删除。`,
      choices: [{ value: 'delete', text: '一并删除', danger: true }, { value: 'transfer', text: '交接给…', primary: true }],
    });
    if (!choice) return;
    if (choice === 'transfer') {
      const picked = await pickUsers({
        title: '选择交接对象',
        intro: `${who}拥有的通行密钥都会转给 TA，TA 也就拿到了这些私钥。`,
        exclude: ids,
        submitText: '下一步',
      });
      if (!picked) return;
      to = picked[0];
    }
  }
  const out = await runBatch({
    path: '/admin/users/batch-delete',
    body: to ? { users: ids, transfer_credentials_to: to.id } : { users: ids },
    title: users.length === 1 ? `删除用户 ${users[0].username}` : `删除 ${ids.length} 个用户`,
    intro: '删除后无法恢复。这些用户的会话、API 令牌和别人共享给他们的通行密钥一并移除'
      + (to ? `，他们拥有的通行密钥交给 ${to.username}。` : '，他们拥有的通行密钥一并删除。'),
    describe: (r) => {
      if (r.credentials_transferred) return `${r.user.username}：${r.credentials_transferred} 个通行密钥交给 ${to.username}`;
      if (r.credentials_deleted) return `${r.user.username}：${r.credentials_deleted} 个通行密钥一并删除`;
      return `${r.user.username}：没有通行密钥`;
    },
    confirmText: '删除',
    danger: true,
    label: userLabel,
  });
  if (!out) return;
  const gone = new Set(out.results.map((r) => r.user.id));
  sel.set(sel.ids().filter((id) => !gone.has(id)));
  for (const id of gone) delete state.userCreds[id];
  forgetCredentials();
  state.creds = null;
  toast(`已删除 ${gone.size} 个用户`);
  if (gone.has(Number(state.route.id))) go('#/users');
  else await refreshUsers();
}

// parseUsers reads one user per line, "username" or "username,password"
// (a full-width comma or a tab also separates them).
function parseUsers(text) {
  const users = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const at = line.search(/[,，\t]/);
    const username = (at < 0 ? line : line.slice(0, at)).trim();
    const invalid = usernameError(username);
    if (invalid) return { error: `第 ${i + 1} 行：${invalid}` };
    users.push({ username, password: at < 0 ? '' : line.slice(at + 1).trim(), line: i + 1 });
  }
  if (!users.length) return { error: '请至少输入一个用户名' };
  if (users.length > MAX_CREATE) return { error: `一次最多创建 ${MAX_CREATE} 个用户，现在有 ${users.length} 个` };
  return { users };
}

function batchCreateDialog() {
  openModal('批量创建用户', (close) => {
    const text = h('textarea', {
      class: 'input textarea mono', id: 'bc-users', rows: 10, spellcheck: 'false',
      placeholder: 'alice\nbob,初始密码\ncarol', value: draft.text,
      oninput: (e) => { draft.text = e.target.value; },
    });
    const isAdmin = h('input', { type: 'checkbox', id: 'bc-admin', checked: draft.isAdmin, onchange: (e) => { draft.isAdmin = e.target.checked; } });
    const note = h('input', {
      class: 'input', id: 'bc-note', value: draft.note, placeholder: '例如“测试组”，只有管理员能看到',
      oninput: (e) => { draft.note = e.target.value; },
    });
    const error = h('div', { class: 'form-error', role: 'alert' });
    return h('form', {
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        const parsed = parseUsers(text.value);
        if (parsed.error) {
          error.textContent = parsed.error;
          return;
        }
        close();
        createUsers(parsed.users);
      },
    },
    h('div', { class: 'modal-body' },
      h('p', null, `每行一个用户：只写用户名时由服务器生成 16 位随机密码，也可以写成“用户名,密码”。一次最多 ${MAX_CREATE} 个。`),
      formRow('用户', text),
      h('div', { class: 'form-row' }, h('label', { class: 'checkbox', for: 'bc-admin' }, isAdmin, '全部设为管理员')),
      formRow('备注（应用到全部）', note),
      error),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, '取消'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, '预览')));
  }, null, { wide: true });
}

// createUsers previews and creates the users; when the preview is
// cancelled or fails it goes back to the editor with the text kept.
async function createUsers(lines) {
  const typed = new Set(lines.filter((u) => u.password).map((u) => u.username.toLowerCase()));
  const note = draft.note.trim();
  const out = await runBatch({
    path: '/admin/users/batch-create',
    body: {
      users: lines.map((u) => ({
        username: u.username,
        password: u.password || undefined,
        is_admin: draft.isAdmin,
        note: note || undefined,
      })),
    },
    title: `创建 ${lines.length} 个用户`,
    intro: '确认后创建以下用户。',
    describe: (r) => `${r.user.username}${r.user.is_admin ? '（管理员）' : ''}：${typed.has(r.user.username.toLowerCase()) ? '使用填写的密码' : '自动生成密码'}`,
    confirmText: '创建',
    label: (item) => {
      const u = lines[item.index];
      return u ? `${u.username}（第 ${u.line} 行）` : '';
    },
  });
  if (!out) {
    // A signed-out admin is back at the login page.
    if (state.me) batchCreateDialog();
    return;
  }
  draft = emptyDraft();
  const rows = out.results.map((r) => ({ username: r.user.username, password: r.password || '' }));
  toast(`已创建 ${rows.length} 个用户`);
  await refreshUsers();
  if (rows.some((r) => r.password)) passwordsDialog('已创建的用户', rows);
}

function csvCell(s) {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function passwordsCSV(rows) {
  return ['username,password', ...rows.map((r) => `${csvCell(r.username)},${csvCell(r.password)}`)].join('\r\n') + '\r\n';
}

function downloadCSV(csv) {
  // The byte order mark makes Excel read the file as UTF-8.
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: `passkey-box-passwords-${fmtDateTime(new Date()).replace(/\D/g, '')}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// passwordsDialog lists passwords the server generated. They are shown
// only this once, so closing before copying or downloading them asks first.
function passwordsDialog(title, rows) {
  const csv = passwordsCSV(rows);
  let saved = false;
  openModal(title, (close) => [
    h('div', { class: 'modal-body' },
      h('p', { class: 'notice' }, '密码只显示这一次，关闭后无法再查看。请复制或下载后发给对应的用户。'),
      h('div', { class: 'pw-wrap' },
        h('table', { class: 'pw-table' },
          h('thead', null, h('tr', null, h('th', null, '用户名'), h('th', null, '密码'), h('th', { 'aria-label': '复制' }))),
          h('tbody', null, rows.map((r) => h('tr', null,
            h('td', { class: 'pw-user', title: r.username }, r.username),
            h('td', { class: r.password ? 'pw-pass' : 'pw-pass muted' }, r.password || '使用填写的密码'),
            h('td', null, r.password ? copyAction(r.password, '密码') : null))))))),
    h('div', { class: 'modal-foot wrap' },
      h('button', {
        type: 'button',
        class: 'btn',
        onclick: () => {
          saved = true;
          copyText(csv, '全部用户名和密码');
        },
      }, icon('copy'), '复制全部'),
      h('button', {
        type: 'button',
        class: 'btn',
        onclick: () => {
          saved = true;
          downloadCSV(csv);
        },
      }, icon('download'), '下载 CSV'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: close }, '关闭')),
  ], async () => {
    if (saved || !state.me) return;
    const ok = await confirmDialog({ title: '关闭密码列表？', message: '这些密码只显示这一次，关闭后无法再查看。', confirmText: '仍然关闭' });
    if (!ok) passwordsDialog(title, rows);
  }, { wide: true });
}

/* ------------------------------------------------------------------ */
/* One user                                                            */
/* ------------------------------------------------------------------ */

function createUserDialog() {
  formDialog({
    title: '新建用户',
    intro: '新用户可以用这里设置的用户名和密码登录后台和插件。',
    submitText: '创建',
    fields: [
      { name: 'username', label: '用户名', autocomplete: 'off' },
      { name: 'password', label: '密码', type: 'password', autocomplete: 'new-password' },
      { name: 'note', label: '备注', placeholder: '可选，只有管理员能看到' },
      { name: 'is_admin', label: '设为管理员', type: 'checkbox' },
    ],
    onSubmit: async (v) => {
      const username = v.username.trim();
      const invalid = usernameError(username);
      if (invalid) return invalid;
      if (!v.password) return '请输入密码';
      try {
        const data = await api('POST', '/admin/users', { username, password: v.password, is_admin: v.is_admin, note: v.note.trim() });
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

function editUserDialog(u) {
  formDialog({
    title: '编辑用户',
    submitText: '保存',
    fields: [
      { name: 'username', label: '用户名', value: u.username, hint: '改名后，该用户需要在插件里用新用户名重新登录。' },
      { name: 'note', label: '备注', value: u.note || '', placeholder: '只有管理员能看到' },
    ],
    onSubmit: async (v) => {
      const username = v.username.trim();
      const invalid = usernameError(username);
      if (invalid) return invalid;
      const body = {};
      if (username !== u.username) body.username = username;
      if (v.note.trim() !== (u.note || '')) body.note = v.note.trim();
      if (!Object.keys(body).length) return '';
      try {
        await api('PATCH', `/admin/users/${u.id}`, body);
      } catch (err) {
        return errText(err, { conflict: '该用户名已存在' });
      }
      toast(body.username ? '已改名，该用户需要在插件里用新用户名重新登录' : '已保存');
      await refreshUsers(u.id === state.me.id);
      return '';
    },
  });
}

function resetPasswordDialog(u) {
  formDialog({
    title: '重置密码',
    intro: `为 ${u.username} 设置新密码。插件里需要用新密码重新登录，已登录的网页不受影响。`,
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

async function patchUser(u, body, done) {
  try {
    await api('PATCH', `/admin/users/${u.id}`, body);
  } catch (err) {
    toastError(err);
    return;
  }
  toast(done);
  await refreshUsers(u.id === state.me.id);
}

async function toggleDisabled(u) {
  const disable = !u.disabled;
  const ok = await confirmDialog({
    title: disable ? `停用 ${u.username}？` : `启用 ${u.username}？`,
    message: disable
      ? 'TA 将不能再登录后台、插件和 API，已有的登录立即失效。账户数据保留，随时可以重新启用。'
      : 'TA 可以重新用原来的密码登录后台和插件。',
    confirmText: disable ? '停用' : '启用',
    danger: disable,
  });
  if (ok) await patchUser(u, { disabled: disable }, disable ? '已停用' : '已启用');
}

async function toggleAdmin(u) {
  const makeAdmin = !u.is_admin;
  const ok = await confirmDialog({
    title: makeAdmin ? '设为管理员？' : '取消管理员？',
    message: makeAdmin
      ? `${u.username} 将可以管理所有用户及其通行密钥。`
      : `${u.username} 将不能再访问管理页面。`,
    confirmText: makeAdmin ? '设为管理员' : '取消管理员',
  });
  if (ok) await patchUser(u, { is_admin: makeAdmin }, makeAdmin ? '已设为管理员' : '已取消管理员');
}

async function revokeSessions(u) {
  const isMe = u.id === state.me.id;
  const ok = await confirmDialog({
    title: `强制 ${u.username} 下线？`,
    message: `将删除 TA 的全部网页登录和 API 令牌${isMe ? '，包括你现在的登录' : ''}。插件用密码认证，不受影响；要彻底阻止访问，请停用账户或重置密码。`,
    confirmText: '强制下线',
    danger: true,
  });
  if (!ok) return;
  try {
    const data = await api('POST', `/admin/users/${u.id}/revoke-sessions`);
    toast(`已注销 ${data.sessions} 个登录、${data.tokens} 个 API 令牌`);
  } catch (err) {
    toastError(err);
    return;
  }
  // Without a session the next request goes back to the login page.
  if (isMe) await refreshUsers();
}

// credAction runs one of the passkey actions of 全部通行密钥 on a passkey
// of the open user.
async function credAction(action, c) {
  if (!(await action([c]))) return;
  forgetCredentials();
  await refreshUsers();
}

// revokeShare stops sharing c with u through the unshare batch, never
// DELETE /admin/users/{id}/credentials/{cid}: had c been transferred to u
// in the meantime, that would delete the passkey itself.
async function revokeShare(u, c) {
  const ok = await confirmDialog({
    title: '撤销这条共享？',
    message: `${u.username} 将不能再从服务器拉取 ${c.rp_id} 上的账号“${credAccount(c)}”。撤销只能阻止以后再拉取，TA 可能已经留存了私钥。`,
    confirmText: '撤销共享',
    danger: true,
  });
  if (!ok) return;
  try {
    const out = await api('POST', '/admin/credentials/unshare', { ids: [c.id], users: [u.id] });
    if (out.results.some((r) => r.status === 'unshared')) toast('已撤销共享');
    else toast(`${u.username} 已经不是这个通行密钥的被共享人（共享可能刚被撤销，或通行密钥已转移给 TA），已刷新`, 'error');
  } catch (err) {
    if (sessionEnded(err)) return;
    if (err.items) toast('这个通行密钥或用户已经不存在了，已刷新', 'error');
    else toastError(err);
  }
  if (u.id === state.me.id || c.owner.id === state.me.id) state.creds = null;
  forgetCredentials();
  await refreshUsers();
}

function credRow(c, meta, actions) {
  return h('div', { class: 'subitem' },
    siteAvatar(c.rp_id, credTitle(c), 'sm'),
    h('div', { class: 'item-main' },
      h('div', { class: 'item-title' },
        h('a', { class: 'text', href: '#/credentials/' + encodeURIComponent(c.id), title: credTitle(c) }, credTitle(c)),
        labelBadge(c),
        credentialBadges(c)),
      h('div', { class: 'item-sub', title: credAccount(c) }, credAccount(c)),
      h('div', { class: 'item-meta' }, meta)),
    h('div', { class: 'row-actions' }, actions));
}

function credCard(creds, empty, row) {
  if (!creds) return h('div', { class: 'card' }, loading());
  return h('div', { class: 'card' }, creds.length ? creds.map(row) : h('div', { class: 'card-empty' }, empty));
}

function renderUserDetail(u) {
  const isMe = u.id === state.me.id;
  const creds = state.userCreds[String(u.id)];
  const owned = creds && creds.filter((c) => c.access !== 'shared');
  const shared = creds && creds.filter((c) => c.access === 'shared');
  // blocked disables an action on the admin's own account and says why.
  const btn = (iconName, text, onclick, blocked) => h('button', {
    type: 'button',
    class: 'btn btn-sm',
    disabled: Boolean(blocked),
    title: blocked || null,
    onclick,
  }, icon(iconName), text);

  return h('div', { class: 'detail' },
    backButton('用户管理', '#/users'),
    h('div', { class: 'detail-head' },
      userAvatar(u.username, 'lg'),
      h('div', { class: 'detail-head-main' },
        h('h2', { class: 'detail-title' }, u.username),
        h('div', { class: 'detail-subtitle' },
          h('span', { class: u.is_admin ? 'badge' : 'badge gray' }, roleText(u)),
          u.disabled ? h('span', { class: 'badge red' }, '已停用') : null,
          isMe ? h('span', null, '当前登录的账户') : null))),
    h('div', { class: 'detail-actions admin-actions' },
      btn('edit', '编辑', () => editUserDialog(u)),
      btn('lock', '重置密码', () => resetPasswordDialog(u)),
      btn(u.disabled ? 'check' : 'ban', u.disabled ? '启用' : '停用', () => toggleDisabled(u), isMe && !u.disabled && '不能停用自己'),
      btn('logout', '强制下线', () => revokeSessions(u)),
      btn('shield', u.is_admin ? '取消管理员' : '设为管理员', () => toggleAdmin(u), isMe && u.is_admin && '不能取消自己的管理员身份'),
      btn('clipboard', '操作日志', () => showAudit({ user: { id: u.id, username: u.username } }))),
    isMe ? h('p', { class: 'form-hint self-hint' }, '这是你当前登录的账户：不能停用、取消管理员身份或删除自己，请让另一位管理员操作。') : null,
    h('div', { class: 'card' },
      field('用户名', u.username, { actions: [copyAction(u.username, '用户名')] }),
      field('备注', u.note, { placeholder: '没有备注' }),
      field('角色', roleText(u)),
      field('状态', u.disabled ? '已停用：不能登录后台、插件和 API' : '正常'),
      field('通行密钥', shareCounts(u)),
      lastUsedField(u.last_used_at),
      field('创建时间', fmtDateTime(u.created_at))),
    h('div', { class: 'section-head' },
      h('h3', { class: 'section-title' }, `拥有的通行密钥${owned ? ' · ' + owned.length : ''}`),
      owned && owned.length
        ? h('button', { type: 'button', class: 'section-link', onclick: () => showCredentials({ owner: { id: u.id, username: u.username } }) }, '批量管理')
        : null),
    credCard(owned, '还没有通行密钥', (c) => credRow(c,
      `创建于 ${fmtDate(c.created_at)} · ${lastUsedShort(c.last_used_at)} · ${c.use_count} 次`,
      [
        iconButton('transfer', '转移', () => credAction(transferCreds, c)),
        iconButton('share', '共享', () => credAction(shareCreds, c)),
        iconButton('trash', '删除', () => credAction(deleteCreds, c), 'danger'),
      ])),
    h('h3', { class: 'section-title' }, `共享给 TA 的${shared ? ' · ' + shared.length : ''}`),
    credCard(shared, '没有人共享通行密钥给 TA', (c) => credRow(c,
      `共享于 ${fmtDate(c.shared_at)} · ${lastUsedShort(c.last_used_at)}`,
      [iconButton('x', '撤销这条共享', () => revokeShare(u, c), 'danger')])),
    h('div', { class: 'danger-zone' },
      h('button', {
        type: 'button',
        class: 'btn btn-danger-outline',
        disabled: isMe,
        title: isMe ? '不能删除自己' : null,
        onclick: () => deleteUsers([u.id]),
      }, icon('trash'), '删除用户')));
}
