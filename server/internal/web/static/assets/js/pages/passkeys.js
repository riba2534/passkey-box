// 我的通行密钥: the signed-in user's passkeys, with details, labels and
// deletion.

import {
  state, h, icon, api, toast, toastError, renderShell, go, confirmDelete,
  siteAvatar, credTitle, credAccount, algName, fmtDateTime,
  emptyState, loading, field, lastUsedField, copyAction, backButton, searchBox,
} from '../core.js';
import { credentialBadges } from '../components.js';

async function loadCreds() {
  state.creds = (await api('GET', '/credentials')).credentials;
}

export default {
  id: 'passkeys',
  title: '我的通行密钥',
  icon: 'key',
  load: () => (state.creds ? undefined : loadCreds()),
  render: renderPasskeysPage,
  count: () => (state.creds ? state.creds.length : null),
  reset: () => {
    state.creds = null;
  },
};

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
    h('div', { class: 'item-title' }, h('span', { class: 'text' }, credTitle(c)), c.label ? h('span', { class: 'badge gray' }, c.label) : null, credentialBadges(c)),
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
