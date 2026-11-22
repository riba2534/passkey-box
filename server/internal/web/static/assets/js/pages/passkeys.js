// 我的通行密钥: the passkeys the signed-in user owns and the ones shared with
// them, with details, labels, sharing, transfers and batch actions.

import {
  state, h, icon, iconButton, api, toast, toastError, renderShell, go, confirmDialog, confirmDelete,
  siteAvatar, userAvatar, credTitle, credAccount, algName, fmtDateTime,
  emptyState, loading, field, lastUsedShort, lastUsedField, copyAction, backButton, searchBox,
} from '../core.js';
import {
  pickUsers, runBatch, selection, selectionBar, selectBox, selectAllBox, credentialBadges,
} from '../components.js';

const SHARE_WARNING = '共享即交出私钥：对方的插件会拿到这个通行密钥，可以直接用它登录。撤销只能阻止以后再拉取，不能保证对方没有留存。';
const TRANSFER_WARNING = '转移立即生效，不需要对方确认：对方成为新的主人并拿到私钥，其他人的共享保留。撤销只能阻止以后再拉取，不能保证对方没有留存。';

const FILTERS = [['all', '全部'], ['owned', '我拥有的'], ['shared', '共享给我的'], ['sharing', '我共享出去的']];
const FILTER_TEST = {
  all: () => true,
  owned: (c) => !isShared(c),
  shared: isShared,
  sharing: (c) => shareCount(c) > 0,
};
const FILTER_EMPTY = {
  owned: ['你还没有自己的通行密钥', '安装插件后，在网站上创建的通行密钥会保存到这里。'],
  shared: ['没有共享给你的通行密钥', '其他用户把通行密钥共享给你后，会显示在这里。'],
  sharing: ['你还没有共享通行密钥', '打开一个通行密钥，在「共享」里添加用户。'],
};

let filter = 'all';
const sel = selection();

async function loadCreds() {
  state.creds = (await api('GET', '/credentials')).credentials;
  const ids = sel.ids().filter((id) => findCred(id));
  if (ids.length !== sel.size) sel.set(ids);
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
    filter = 'all';
    sel.clear();
  },
};

function isShared(c) {
  return c.access === 'shared';
}

function shareCount(c) {
  return c.shared_with ? c.shared_with.length : 0;
}

function findCred(id) {
  return state.creds && state.creds.find((c) => c.id === id);
}

// briefText names a passkey in batch previews: "github.com · alice".
function briefText(c) {
  return c.user_name ? `${c.rp_id} · ${c.user_name}` : c.rp_id;
}

// itemLabel names the passkey of a failed batch item for batchError.
function itemLabel(item) {
  const c = item.field === 'ids' && findCred(item.value);
  return c ? briefText(c) : '';
}

// titled lets truncated badges show their full text on hover.
function titled(badges) {
  for (const b of badges) {
    b.classList.add('trunc');
    b.title = b.textContent;
  }
  return badges;
}

function labelBadge(c) {
  return c.label ? titled([h('span', { class: 'badge gray' }, c.label)]) : null;
}

function matchesCred(c, q) {
  if (!q) return true;
  return [c.rp_id, c.rp_name, c.user_name, c.user_display_name, c.label, c.origin, c.owner && c.owner.username]
    .some((v) => (v || '').toLowerCase().includes(q));
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

function renderPasskeysPage() {
  const r = state.route;
  const listBody = h('div', { class: 'list-body' });
  const countEl = h('span');
  let shown = [];
  const fillList = () => {
    shown = renderPasskeyList(listBody, countEl);
  };
  const selectAll = selectAllBox(sel, () => shown);
  const refill = () => {
    fillList();
    selectAll.refresh();
  };
  const select = (label, options, value, onchange) => {
    const el = h('select', { class: 'select', 'aria-label': label, onchange: (e) => onchange(e.target.value) },
      options.map(([v, t]) => h('option', { value: v }, t)));
    el.value = value;
    return el;
  };
  const filterSelect = select('筛选', FILTERS, filter, (v) => {
    filter = v;
    refill();
  });
  const sortSelect = select('排序方式', [['site', '按网站分组'], ['created', '最近创建'], ['used', '最近使用']], state.sort, (v) => {
    state.sort = v;
    localStorage.setItem('pkb.sort', v);
    fillList();
  });
  refill();

  const listPane = h('section', { class: 'list-pane pk-list-pane', 'aria-label': '通行密钥列表' },
    h('div', { class: 'list-header' },
      h('div', { class: 'list-title-row' }, h('h1', { class: 'list-title' }, '我的通行密钥')),
      searchBox('搜索网站、用户名或备注', state.query.passkeys, (v) => {
        state.query.passkeys = v;
        refill();
      }),
      h('div', { class: 'list-tools' },
        h('label', { class: 'pk-select-all' }, selectAll, countEl),
        h('div', { class: 'pk-tools' }, filterSelect, sortSelect)),
      selectionBar(sel, [
        { text: '共享给…', icon: 'share', onclick: shareSelected },
        { text: '转移给…', icon: 'transfer', onclick: transferSelected },
        { text: '删除', icon: 'trash', danger: true, onclick: deleteSelected },
      ])),
    listBody);

  let detail;
  if (!r.id) {
    detail = emptyState('key', '选择一个通行密钥', '在左侧列表中选择通行密钥以查看详细信息');
  } else if (!state.creds) {
    detail = loading();
  } else {
    const c = findCred(r.id);
    detail = c
      ? renderCredentialDetail(c)
      : h('div', { class: 'detail' }, backButton('我的通行密钥', '#/passkeys'), emptyState('alert', '找不到这个通行密钥', '它可能已被删除'));
  }

  return h('div', { class: 'page' + (r.id ? ' has-selection' : '') },
    listPane,
    h('section', { class: 'detail-pane', 'aria-label': '通行密钥详情' }, detail));
}

// renderPasskeyList fills the list and returns the IDs of the rows shown.
function renderPasskeyList(container, countEl) {
  if (!state.creds) {
    countEl.textContent = '';
    container.replaceChildren(loading());
    return [];
  }
  const q = state.query.passkeys.trim().toLowerCase();
  const all = state.creds;
  const base = all.filter(FILTER_TEST[filter]);
  const list = base.filter((c) => matchesCred(c, q));
  countEl.textContent = q ? `${list.length} / ${base.length} 个` : `共 ${base.length} 个`;

  if (!all.length) {
    container.replaceChildren(emptyState('key', '还没有通行密钥',
      '安装插件后，在网站上创建的通行密钥会自动保存到这里。',
      h('a', { class: 'btn btn-primary btn-sm', href: '#/install' }, '安装插件')));
    return [];
  }
  if (!base.length) {
    container.replaceChildren(emptyState('key', ...FILTER_EMPTY[filter]));
    return [];
  }
  if (!list.length) {
    container.replaceChildren(emptyState('search', '没有匹配的通行密钥', '换个关键词试试'));
    return [];
  }

  const selected = state.route.id;
  const row = (c) => h('a', {
    class: 'list-item' + (c.id === selected ? ' selected' : ''),
    href: '#/passkeys/' + encodeURIComponent(c.id),
    'aria-current': c.id === selected ? 'true' : null,
  },
  selectBox(sel, c.id, `${credTitle(c)} ${credAccount(c)}`),
  siteAvatar(c.rp_id, credTitle(c)),
  h('div', { class: 'item-main' },
    h('div', { class: 'item-title' }, h('span', { class: 'text', title: credTitle(c) }, credTitle(c)), labelBadge(c), titled(credentialBadges(c))),
    h('div', { class: 'item-sub', title: credAccount(c) }, credAccount(c))));

  let ordered = list;
  const nodes = [];
  if (state.sort === 'site') {
    const groups = new Map();
    for (const c of list) {
      const key = c.rp_id.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    ordered = [];
    for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
      const items = groups.get(key).sort((a, b) => credAccount(a).localeCompare(credAccount(b), 'zh-CN'));
      nodes.push(h('div', { class: 'group-header' }, h('span', { title: key }, key), h('span', null, items.length)));
      for (const c of items) nodes.push(row(c));
      ordered.push(...items);
    }
  } else {
    if (state.sort === 'used') ordered = [...list].sort((a, b) => (b.last_used_at || '').localeCompare(a.last_used_at || ''));
    for (const c of ordered) nodes.push(row(c));
  }
  container.replaceChildren(...nodes);
  return ordered.map((c) => c.id);
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

// Admin pages cache users and passkeys whose counts may have just changed.
function dropAdminCache() {
  state.users = null;
  state.userCreds = {};
}

// refresh reloads the list after a change and leaves a detail page whose
// passkey is no longer there.
async function refresh() {
  dropAdminCache();
  try {
    await loadCreds();
  } catch {
    state.creds = null; // load() fetches again and reports the error.
  }
  const id = state.route.id;
  go(id && state.creds && !findCred(id) ? '#/passkeys' : location.hash);
}

// batch previews and runs a batch request, then reloads the list. It
// resolves to the response, or null when nothing ran.
async function batch(opts) {
  const res = await runBatch({ label: itemLabel, ...opts });
  if (res) await refresh();
  return res;
}

function selectedCreds(ids) {
  return ids.map(findCred).filter(Boolean);
}

// ownedOnly keeps a share or transfer to the passkeys the user owns: only
// the owner may share or transfer one. It resolves to those passkeys, or
// null when there is nothing left to do.
async function ownedOnly(creds, verb) {
  const shared = creds.filter(isShared);
  if (!shared.length) return creds;
  const owned = creds.filter((c) => !isShared(c));
  const ok = await confirmDialog({
    title: `不能${verb}别人共享给你的通行密钥`,
    message: `选中的 ${creds.length} 个通行密钥里，有 ${shared.length} 个是别人共享给你的，只有主人可以${verb}。`
      + (owned.length ? `要只${verb}你拥有的 ${owned.length} 个吗？` : '取消选择它们后再试。'),
    confirmText: owned.length ? `只${verb}我拥有的 ${owned.length} 个` : '取消选择它们',
  });
  if (!ok) return null;
  sel.set(owned.map((c) => c.id));
  return owned.length ? owned : null;
}

async function shareCreds(creds) {
  const exclude = [state.me.id];
  if (creds.length === 1) exclude.push(...(creds[0].shared_with || []).map((s) => s.user.id));
  const users = await pickUsers({
    title: creds.length === 1 ? '共享通行密钥' : `共享 ${creds.length} 个通行密钥`,
    multiple: true,
    exclude,
    submitText: '下一步',
    intro: SHARE_WARNING,
  });
  if (!users) return null;
  const res = await batch({
    path: '/credentials/share',
    body: { ids: creds.map((c) => c.id), users: users.map((u) => u.id) },
    title: '确认共享',
    intro: SHARE_WARNING,
    confirmText: '共享',
    describe: (r) => (r.status === 'unchanged'
      ? `${briefText(r.credential)} 已经共享给了 ${r.user.username}`
      : `把 ${briefText(r.credential)} 共享给 ${r.user.username}`),
  });
  if (res) toast(`已共享给 ${users.map((u) => u.username).join('、')}`);
  return res;
}

async function transferCreds(creds) {
  const keep = h('input', { type: 'checkbox', id: 'transfer-keep' });
  const user = await pickUsers({
    title: creds.length === 1 ? '转移通行密钥' : `转移 ${creds.length} 个通行密钥`,
    exclude: [state.me.id],
    submitText: '下一步',
    intro: h('span', null, TRANSFER_WARNING,
      h('label', { class: 'checkbox transfer-keep', for: 'transfer-keep' }, keep, '保留我的访问（转移后我变为被共享人）')),
  });
  if (!user) return null;
  const to = user[0];
  const keepAccess = keep.checked;
  const res = await batch({
    path: '/credentials/transfer',
    body: { ids: creds.map((c) => c.id), to: to.id, keep_access: keepAccess },
    title: '确认转移',
    intro: `转移后 ${to.username} 成为主人，立即生效。${keepAccess ? '你变为被共享人，仍可使用。' : '你将失去访问，除非对方再共享给你。'}撤销只能阻止以后再拉取，不能保证对方没有留存。`,
    confirmText: '转移',
    danger: !keepAccess,
    describe: (r) => (r.status === 'unchanged'
      ? `${r.to.username} 已经是 ${briefText(r.credential)} 的主人`
      : `把 ${briefText(r.credential)} 转移给 ${r.to.username}`),
  });
  if (res) toast(`已转移给 ${to.username}`);
  return res;
}

async function shareSelected(ids) {
  const creds = await ownedOnly(selectedCreds(ids), '共享');
  if (creds && (await shareCreds(creds))) sel.clear();
}

async function transferSelected(ids) {
  const creds = await ownedOnly(selectedCreds(ids), '转移');
  if (creds && (await transferCreds(creds))) sel.clear();
}

async function deleteSelected(ids) {
  const creds = selectedCreds(ids);
  const owned = creds.filter((c) => !isShared(c));
  const left = creds.length - owned.length;
  const people = new Set(owned.flatMap((c) => (c.shared_with || []).map((s) => s.user.id))).size;
  const intro = [];
  if (owned.length) intro.push(`将删除你拥有的 ${owned.length} 个通行密钥${people ? `，共享给的 ${people} 个人也会失去访问` : ''}，此操作无法撤销。`);
  if (left) intro.push(`将退出别人共享给你的 ${left} 个通行密钥，之后无法再用它们登录，除非主人再次共享。`);
  const res = await batch({
    path: '/credentials/batch-delete',
    body: { ids: creds.map((c) => c.id) },
    title: creds.length === 1 ? '删除通行密钥' : `删除 ${creds.length} 个通行密钥`,
    intro: intro.join(''),
    confirmText: '删除',
    danger: true,
    describe: (r) => (r.status === 'left'
      ? `退出 ${r.credential.owner.username} 共享的 ${briefText(r.credential)}`
      : `删除 ${briefText(r.credential)}`),
  });
  if (!res) return;
  sel.clear();
  const n = (status) => res.results.filter((r) => r.status === status).length;
  toast([n('deleted') ? `已删除 ${n('deleted')} 个通行密钥` : '', n('left') ? `已退出 ${n('left')} 个共享` : ''].filter(Boolean).join('，'));
}

async function unshareOne(c, user) {
  const res = await batch({
    path: '/credentials/unshare',
    body: { ids: [c.id], users: [user.id] },
    title: `撤销对 ${user.username} 的共享`,
    intro: `撤销后 ${user.username} 的插件不能再拉取这个通行密钥。撤销只能阻止以后再拉取，不能保证对方没有留存。`,
    confirmText: '撤销共享',
    danger: true,
    describe: (r) => (r.status === 'unchanged'
      ? `${briefText(r.credential)} 没有共享给 ${r.user.username}`
      : `停止向 ${r.user.username} 共享 ${briefText(r.credential)}`),
  });
  if (res) toast(`已撤销对 ${user.username} 的共享`);
}

// removeCred deletes a passkey the user owns or leaves one shared with them;
// both are DELETE /credentials/{id}.
async function removeCred(c, dialog, done) {
  if (!(await confirmDelete(dialog, `/credentials/${encodeURIComponent(c.id)}`))) return;
  state.creds = state.creds.filter((x) => x.id !== c.id);
  sel.toggle(c.id, false);
  dropAdminCache();
  toast(done);
  go('#/passkeys');
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

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
  const shared = isShared(c);
  return h('div', { class: 'detail pk-detail' },
    backButton('我的通行密钥', '#/passkeys'),
    h('div', { class: 'detail-head' },
      siteAvatar(c.rp_id, credTitle(c), 'lg'),
      h('div', { class: 'detail-head-main' },
        h('h2', { class: 'detail-title' }, credTitle(c)),
        h('div', { class: 'detail-subtitle' },
          h('span', { class: 'badge' }, '通行密钥'), titled(credentialBadges(c)), h('span', { class: 'pk-rp' }, c.rp_id)))),
    h('div', { class: 'card' },
      field('用户名', c.user_name, { actions: c.user_name ? [copyAction(c.user_name, '用户名')] : [] }),
      field('显示名', c.user_display_name),
      field('网站', c.rp_id, {
        actions: [h('a', { class: 'icon-btn', href: siteURL(c), target: '_blank', rel: 'noopener noreferrer', title: '打开网站', 'aria-label': '打开网站' }, icon('external'))],
      })),
    shared ? sharedWithMe(c) : [labelSection(c), sharesSection(c)],
    h('h3', { class: 'section-title' }, '使用情况'),
    h('div', { class: 'card' },
      field('创建时间', fmtDateTime(c.created_at)),
      lastUsedField(c.last_used_at),
      field(shared || shareCount(c) ? '使用次数（所有人合计）' : '使用次数', `${c.use_count} 次`)),
    h('h3', { class: 'section-title' }, '技术信息'),
    h('div', { class: 'card' },
      field('算法', algName(c.alg)),
      field('凭据 ID', c.id, { mono: true, actions: [copyAction(c.id, '凭据 ID')] }),
      field('用户句柄（User Handle）', c.user_handle, { mono: true, actions: [copyAction(c.user_handle, '用户句柄')] }),
      field('注册来源', c.origin)),
    shared
      ? h('div', { class: 'danger-zone' },
        h('button', {
          type: 'button',
          class: 'btn btn-danger-outline',
          onclick: () => removeCred(c, {
            title: '移除共享？',
            message: `移除后你将无法再用它登录 ${c.rp_id} 上的账号“${credAccount(c)}”，除非 ${c.owner.username} 再次共享给你。`,
            confirmText: '移除共享',
          }, '已移除共享'),
        }, icon('x'), '移除共享'))
      : h('div', { class: 'danger-zone' },
        h('button', { type: 'button', class: 'btn', onclick: () => transferCreds([c]) }, icon('transfer'), '转移给…'),
        h('button', {
          type: 'button',
          class: 'btn btn-danger-outline',
          onclick: () => removeCred(c, {
            title: '删除通行密钥？',
            message: `删除后将无法再用它登录 ${c.rp_id} 上的账号“${credAccount(c)}”${shareCount(c) ? `，共享给的 ${shareCount(c)} 个人也会失去访问` : ''}。此操作无法撤销。`,
            confirmText: '删除',
          }, '通行密钥已删除'),
        }, icon('trash'), '删除通行密钥')));
}

// sharedWithMe is the read-only part of a passkey someone shared with the
// user: who owns it, since when, and the owner's label.
function sharedWithMe(c) {
  return [
    h('h3', { class: 'section-title' }, '共享'),
    h('div', { class: 'card' },
      field('所有者', c.owner.username),
      field('共享时间', fmtDateTime(c.shared_at)),
      field('备注', c.label, { placeholder: '无' })),
    h('p', { class: 'pk-note' }, `这是 ${c.owner.username} 共享给你的通行密钥。你可以用它登录，但不能修改备注、再共享或转移。`),
  ];
}

function labelSection(c) {
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

  return [
    h('h3', { class: 'section-title' }, '备注'),
    h('div', { class: 'card' },
      h('div', { class: 'field' }, h('div', { class: 'field-main' }, h('div', { class: 'label-edit' }, labelInput, saveBtn)))),
  ];
}

// sharesSection lists who the owner shares the passkey with.
function sharesSection(c) {
  const shares = c.shared_with || [];
  const row = (s) => h('div', { class: 'subitem' },
    userAvatar(s.user.username, 'sm'),
    h('div', { class: 'item-main' },
      h('div', { class: 'item-title' }, h('span', { class: 'text', title: s.user.username }, s.user.username)),
      h('div', { class: 'item-sub' }, `共享于 ${fmtDateTime(s.shared_at)}`,
        s.shared_by && s.shared_by.id !== c.owner.id ? `，由 ${s.shared_by.username} 操作` : ''),
      h('div', { class: 'item-meta' }, lastUsedShort(s.last_used_at))),
    iconButton('x', `撤销对 ${s.user.username} 的共享`, () => unshareOne(c, s.user), 'danger'));

  return [
    h('div', { class: 'user-section-head' },
      h('h3', { class: 'section-title' }, shares.length ? `共享 · ${shares.length} 人` : '共享'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => shareCreds([c]) }, icon('user-plus'), '添加')),
    h('div', { class: 'card' },
      shares.length ? shares.map(row) : h('div', { class: 'pk-share-empty' }, '还没有共享给任何人。'),
      h('div', { class: 'pk-share-note' }, icon('alert'), h('span', null, SHARE_WARNING))),
  ];
}
