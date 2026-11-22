// 用户管理 (admin): accounts, their roles and passwords, and the passkeys
// each one owns.

import {
  state, h, icon, iconButton, api, errText, toast, toastError, renderShell, go,
  confirmDialog, confirmDelete, formDialog, siteAvatar, userAvatar, credTitle, credAccount,
  fmtDate, fmtDateTime, emptyState, loading, field, usernameError, roleText,
  lastUsedShort, lastUsedField, copyAction, backButton, searchBox,
} from '../core.js';

async function loadUsers() {
  state.users = (await api('GET', '/admin/users')).users;
}

async function loadUserCreds(id) {
  state.userCreds[id] = (await api('GET', `/admin/users/${encodeURIComponent(id)}/credentials`)).credentials;
}

export default {
  id: 'users',
  title: '用户管理',
  icon: 'users',
  adminOnly: true,
  // The sidebar shows the user count on every page.
  preload: () => (state.users ? undefined : loadUsers()),
  // A missing user is not an error: the detail pane says so.
  load: (r) => (r.id && !state.userCreds[r.id]
    ? loadUserCreds(r.id).catch((err) => {
      if (err.code !== 'not_found') throw err;
    })
    : undefined),
  render: renderUsersPage,
  count: () => (state.users ? state.users.length : null),
  reset: () => {
    state.users = null;
    state.userCreds = {};
  },
};

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
