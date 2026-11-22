// 全部通行密钥 (admin): every user's passkeys, filtered and paged on the
// server, and the admin actions on them: transfer, share, unshare and
// delete. 用户管理 runs the same actions on the passkeys of one user.

import {
  state, h, icon, iconButton, api, errText, toast, toastError, renderShell, go, chooseDialog, formDialog,
  siteAvatar, userAvatar, credTitle, credAccount, credBrief, fmtDate, fmtDateTime,
  emptyState, loading, field, lastUsedShort, lastUsedField, copyAction, backButton, searchBox,
} from '../core.js';
import {
  pickUsers, runBatch, selection, selectionBar, selectBox, selectAllBox, credentialBadges, filterChip, filterSelect,
  labelBadge, labelEditor, credentialTechInfo,
} from '../components.js';
import { showAudit } from './audit.js';

const PAGE = 100;
// The server's limits on one batch (docs/API.md).
const MAX_IDS = 1000;
const MAX_PAIRS = 10000;
const SHARE_WARNING = '共享即交出私钥，撤销只能阻止以后再拉取。';

// Changing a filter clears the selection: the rows it named may no longer
// be loaded, so it could not be shown or checked before acting on it.
const sel = selection();
// The detail pane's passkey by ID; null once the server says it is gone.
const details = new Map();
let view = noFilters();
let searchTimer = 0;

function noFilters() {
  return { q: '', owner: null, rpId: '', shared: '' };
}

export default {
  id: 'credentials',
  title: '全部通行密钥',
  icon: 'database',
  adminOnly: true,
  // Opening the list reloads it; a passkey reloads every time it is shown.
  load: (r) => Promise.all([
    !r.id || !current() ? loadList() : null,
    r.id ? loadDetail(r.id) : null,
  ]),
  render: renderPage,
  reset: () => {
    view = noFilters();
    sel.clear();
    details.clear();
    state.allCreds = null;
  },
};

/**
 * showCredentials opens the list with some filters set, for example the
 * passkeys of one site or of one (possibly disabled) user.
 *
 * @param {{owner?: {id: number, username: string}, rpId?: string, shared?: '' | 'true' | 'false'}} filters
 */
export function showCredentials(filters) {
  view = { ...noFilters(), ...filters };
  sel.clear();
  state.allCreds = null;
  go('#/credentials');
}

// forgetCredentials drops the loaded list and passkeys after another page
// changed them, so they reload when shown.
export function forgetCredentials() {
  state.allCreds = null;
  details.clear();
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

function listKey() {
  return JSON.stringify([view.q.trim(), view.owner && view.owner.id, view.rpId, view.shared]);
}

function filtered() {
  return Boolean(view.q.trim() || view.owner || view.rpId || view.shared);
}

// current is the loaded list if it matches the filters.
function current() {
  return state.allCreds && state.allCreds.key === listKey() ? state.allCreds : null;
}

function listPath(offset, limit) {
  const p = new URLSearchParams({ limit, offset });
  if (view.q.trim()) p.set('q', view.q.trim());
  if (view.owner) p.set('owner_id', view.owner.id);
  if (view.rpId) p.set('rp_id', view.rpId);
  if (view.shared) p.set('shared', view.shared);
  return '/admin/credentials?' + p;
}

// loadList fetches the first page, or with keep as many rows as are loaded
// now, so a refresh after a change keeps what the admin paged through. A
// response for filters that have changed since is dropped.
async function loadList(keep) {
  const key = listKey();
  const loaded = keep && state.allCreds && state.allCreds.items ? state.allCreds.items.length : 0;
  try {
    const data = await api('GET', listPath(0, Math.min(500, Math.max(PAGE, loaded))));
    if (key === listKey()) state.allCreds = { key, items: data.credentials, total: data.total };
  } catch (err) {
    if (key === listKey()) state.allCreds = { key, error: err };
  }
}

async function loadMore() {
  const data = state.allCreds;
  try {
    const res = await api('GET', listPath(data.items.length, PAGE));
    if (state.allCreds !== data) return;
    // Rows created meanwhile shift the pages; skip the ones already shown.
    const seen = new Set(data.items.map((c) => c.id));
    state.allCreds = { ...data, items: data.items.concat(res.credentials.filter((c) => !seen.has(c.id))), total: res.total };
  } catch (err) {
    toastError(err);
  }
}

async function loadDetail(id) {
  try {
    details.set(id, (await api('GET', `/admin/credentials/${encodeURIComponent(id)}`)).credential);
  } catch (err) {
    if (err.code !== 'not_found') throw err;
    details.set(id, null);
  }
}

function listed(id) {
  const data = state.allCreds;
  return (data && data.items && data.items.find((c) => c.id === id)) || undefined;
}

async function setView(patch) {
  view = { ...view, ...patch };
  sel.clear();
  state.allCreds = null;
  renderShell();
  await loadList();
  renderShell();
}

/* ------------------------------------------------------------------ */
/* Actions (shared with users.js)                                      */
/* ------------------------------------------------------------------ */

function ownersOf(creds) {
  return [...new Map(creds.map((c) => [c.owner.id, c.owner])).values()];
}

function count(results, status) {
  return results.filter((r) => r.status === status).length;
}

function tooMany(creds, users = 1) {
  if (creds.length <= MAX_IDS && creds.length * users <= MAX_PAIRS) return false;
  toast(`一次最多处理 ${MAX_IDS} 个通行密钥、${MAX_PAIRS} 条共享，请分批操作`, 'error');
  return true;
}

// batchLabel names failed items in a batch error by passkey and username
// instead of their IDs.
function batchLabel(creds, users) {
  const byId = new Map(creds.map((c) => [c.id, credBrief(c)]));
  const names = new Map((users || []).map((u) => [u.id, u.username]));
  return (item) => (item.field === 'ids' ? byId.get(item.value) : names.get(item.value)) || '';
}

function warningIntro(text, ...more) {
  return h('span', null, text, h('span', { class: 'share-warning' }, icon('alert'), SHARE_WARNING), more);
}

// finish reports a batch that ran and forgets 我的通行密钥 when the
// signed-in admin owned, received or was given one of the passkeys.
function finish(out, creds, message) {
  if (!out) return null;
  const me = state.me.id;
  const isMe = (u) => Boolean(u) && u.id === me;
  if (creds.some((c) => isMe(c.owner) || (c.shared_with || []).some((s) => isMe(s.user)))
    || out.results.some((r) => isMe(r.user) || isMe(r.to))) state.creds = null;
  toast(message(out.results));
  return out;
}

/**
 * The actions below take passkeys as returned by the admin endpoints
 * (with owner and shared_with), ask what is needed, preview the batch and
 * run it. Each resolves to the batch response, or null when nothing ran;
 * the caller reloads what it shows.
 */

export async function transferCreds(creds) {
  if (tooMany(creds)) return null;
  const owners = ownersOf(creds);
  const keep = h('input', { type: 'checkbox' });
  const picked = await pickUsers({
    title: creds.length > 1 ? `转移 ${creds.length} 个通行密钥` : '转移通行密钥',
    intro: warningIntro('选择新主人。转移立即生效，不需要对方确认。',
      h('label', { class: 'checkbox keep-access' }, keep, '原主人保留访问（变为被共享人）')),
    exclude: owners.length === 1 ? [owners[0].id] : [],
    submitText: '下一步',
  });
  if (!picked) return null;
  const to = picked[0];
  const out = await runBatch({
    path: '/admin/credentials/transfer',
    body: { ids: creds.map((c) => c.id), to: to.id, keep_access: keep.checked },
    title: `转移给 ${to.username}`,
    intro: (keep.checked ? '原主人保留访问，变为被共享人' : '原主人将失去访问') + '；其他人的共享保留。',
    describe: (r) => `${credBrief(r.credential)}：${r.from.username} → ${r.to.username}`,
    confirmText: '转移',
    label: batchLabel(creds, picked),
  });
  return finish(out, creds, (results) => `已转移 ${count(results, 'transferred')} 个通行密钥`);
}

export async function shareCreds(creds) {
  if (tooMany(creds)) return null;
  const owners = ownersOf(creds);
  const exclude = owners.length === 1 ? [owners[0].id] : [];
  if (creds.length === 1) exclude.push(...(creds[0].shared_with || []).map((s) => s.user.id));
  const picked = await pickUsers({
    title: creds.length > 1 ? `共享 ${creds.length} 个通行密钥` : '共享通行密钥',
    multiple: true,
    exclude,
    intro: warningIntro('被共享的人可以用它登录网站，但不能修改、删除、再共享或转移。'),
    submitText: '下一步',
  });
  if (!picked || tooMany(creds, picked.length)) return null;
  const out = await runBatch({
    path: '/admin/credentials/share',
    body: { ids: creds.map((c) => c.id), users: picked.map((u) => u.id) },
    title: '确认共享',
    intro: SHARE_WARNING,
    describe: (r) => `${credBrief(r.credential)}（${r.credential.owner.username}）→ ${r.user.username}`,
    confirmText: '共享',
    label: batchLabel(creds, picked),
  });
  return finish(out, creds, (results) => `已新增 ${count(results, 'shared')} 条共享`);
}

// unshareCreds revokes the shares of the given users, or asks whose.
async function unshareCreds(creds, users) {
  if (tooMany(creds)) return null;
  if (!users) {
    const recipients = new Map(creds.flatMap((c) => (c.shared_with || []).map((s) => [s.user.id, s.user])));
    if (!recipients.size) {
      toast(creds.length > 1 ? '选中的通行密钥没有共享给任何人' : '这个通行密钥没有共享给任何人', 'error');
      return null;
    }
    const choice = await chooseDialog({
      title: '撤销共享',
      message: `选中的 ${creds.length} 个通行密钥共享给了 ${recipients.size} 个人。可以全部撤销，也可以只撤销其中几个人的。`,
      choices: [{ value: 'pick', text: '选择用户…' }, { value: 'all', text: '全部撤销', danger: true }],
    });
    if (!choice) return null;
    if (choice === 'pick') {
      users = await pickUsers({
        title: '撤销哪些人的共享',
        multiple: true,
        // Offer only the current recipients.
        exclude: (state.users || []).filter((u) => !recipients.has(u.id)).map((u) => u.id),
        submitText: '下一步',
      });
      if (!users) return null;
    }
  }
  const ids = creds.map((c) => c.id);
  const out = await runBatch({
    path: '/admin/credentials/unshare',
    body: users ? { ids, users: users.map((u) => u.id) } : { ids, all: true },
    title: '确认撤销共享',
    intro: '撤销只能阻止对方以后再拉取，不能保证对方没有留存私钥。',
    describe: (r) => `${credBrief(r.credential)}：不再共享给 ${r.user.username}`,
    confirmText: '撤销共享',
    danger: true,
    label: batchLabel(creds, users),
  });
  return finish(out, creds, (results) => `已撤销 ${count(results, 'unshared')} 条共享`);
}

export async function deleteCreds(creds) {
  if (tooMany(creds)) return null;
  const out = await runBatch({
    path: '/admin/credentials/batch-delete',
    body: { ids: creds.map((c) => c.id) },
    title: creds.length > 1 ? `删除 ${creds.length} 个通行密钥` : '删除通行密钥',
    intro: '删除后，主人和被共享的人都不能再用它们登录。此操作无法撤销。',
    describe: (r) => `${credBrief(r.credential)}（主人 ${r.credential.owner.username}）`,
    confirmText: '删除',
    danger: true,
    label: batchLabel(creds),
  });
  return finish(out, creds, (results) => `已删除 ${results.length} 个通行密钥`);
}

// act runs an action from this page and reloads the list and the open
// passkey. Passkeys that left the list (deleted, or no longer matching the
// filters) leave the selection; when the open one was deleted the page goes
// back to the list.
async function act(action, creds) {
  if (!creds.length) return;
  const out = await action(creds);
  if (!out) return;
  const r = state.route;
  const deleted = r.id && out.results.some((x) => x.status === 'deleted' && x.credential.id === r.id);
  try {
    await Promise.all([loadList(true), r.id && !deleted ? loadDetail(r.id) : null]);
  } catch (err) {
    toastError(err);
  }
  sel.set(sel.ids().filter((id) => listed(id)));
  if (deleted) go('#/credentials');
  else renderShell();
}

function selected(ids) {
  return ids.map(listed).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

function renderPage(r) {
  const listBody = h('div', { class: 'list-body' });
  const countEl = h('span');
  const selectAll = selectAllBox(sel, () => (state.allCreds && state.allCreds.items ? state.allCreds.items.map((c) => c.id) : []));
  const fill = () => {
    fillList(listBody, countEl, update);
    selectAll.refresh();
  };
  // update shows a list that loaded later: it refills this list, which
  // keeps the focus in the search box, unless the page was redrawn meanwhile.
  const update = () => {
    if (listBody.isConnected) fill();
    else renderShell();
  };

  const listPane = h('section', { class: 'list-pane', 'aria-label': '通行密钥列表' },
    h('div', { class: 'list-header' },
      h('div', { class: 'list-title-row' }, h('h1', { class: 'list-title' }, '全部通行密钥')),
      searchBox('搜索网站、账号、备注或主人', view.q, (v) => {
        view.q = v;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          sel.clear();
          await loadList();
          update();
        }, 250);
      }),
      h('div', { class: 'filter-bar' },
        filterChip('主人', view.owner && view.owner.username, async () => {
          const picked = await pickUsers({ title: '按主人筛选', submitText: '筛选' });
          if (picked) setView({ owner: picked[0] });
        }, () => setView({ owner: null })),
        filterChip('网站', view.rpId, () => formDialog({
          title: '按网站筛选',
          fields: [{ name: 'rp_id', label: '网站', value: view.rpId, placeholder: '例如 github.com', hint: '与通行密钥的网站完全一致（不区分大小写）。' }],
          submitText: '筛选',
          onSubmit: (v) => {
            setView({ rpId: v.rp_id.trim() });
            return '';
          },
        }), () => setView({ rpId: '' })),
        filterSelect('共享状态', view.shared, [['', '共享：全部'], ['true', '有共享'], ['false', '未共享']], (v) => setView({ shared: v }))),
      h('div', { class: 'list-tools' }, h('span', { class: 'select-all' }, selectAll, countEl)),
      selectionBar(sel, [
        { text: '转移', icon: 'transfer', onclick: (ids) => act(transferCreds, selected(ids)) },
        { text: '共享', icon: 'share', onclick: (ids) => act(shareCreds, selected(ids)) },
        { text: '撤销共享', icon: 'ban', onclick: (ids) => act(unshareCreds, selected(ids)) },
        { text: '删除', icon: 'trash', danger: true, onclick: (ids) => act(deleteCreds, selected(ids)) },
      ])),
    listBody);
  fill();

  return h('div', { class: 'page admin-page' + (r.id ? ' has-selection' : '') },
    listPane,
    h('section', { class: 'detail-pane', 'aria-label': '通行密钥详情' }, r.id ? renderDetail(r.id)
      : emptyState('database', '选择一个通行密钥', '查看它的主人和共享，或者多选后批量转移、共享和删除')));
}

function fillList(body, countEl, update) {
  const data = state.allCreds;
  if (!data || data.error) {
    countEl.textContent = '';
    body.replaceChildren(data ? emptyState('alert', '无法加载通行密钥', errText(data.error)) : loading());
    return;
  }
  const { items, total } = data;
  countEl.textContent = filtered() ? `找到 ${total} 个` : `共 ${total} 个`;
  if (!items.length) {
    body.replaceChildren(filtered()
      ? emptyState('search', '没有符合条件的通行密钥', '换个条件试试')
      : emptyState('database', '还没有通行密钥', '用户用插件在网站上创建的通行密钥会出现在这里。'));
    return;
  }
  const more = total > items.length
    ? h('div', { class: 'load-more' }, h('button', {
      type: 'button',
      class: 'btn btn-sm',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        await loadMore();
        update();
      },
    }, `加载更多（还有 ${total - items.length} 个）`))
    : null;
  body.replaceChildren(...items.map(listRow));
  if (more) body.append(more);
}

function listRow(c) {
  const isOpen = c.id === state.route.id;
  return h('a', {
    class: 'list-item' + (isOpen ? ' selected' : ''),
    href: '#/credentials/' + encodeURIComponent(c.id),
    'aria-current': isOpen ? 'true' : null,
  },
  selectBox(sel, c.id, `${credTitle(c)} ${credAccount(c)}`),
  siteAvatar(c.rp_id, credTitle(c)),
  h('div', { class: 'item-main' },
    h('div', { class: 'item-title' },
      h('span', { class: 'text', title: credTitle(c) }, credTitle(c)),
      labelBadge(c),
      credentialBadges(c)),
    h('div', { class: 'item-sub', title: credAccount(c) }, credAccount(c)),
    h('div', { class: 'item-meta', title: c.owner.username }, `主人 ${c.owner.username} · ${lastUsedShort(c.last_used_at)}`)));
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function renderDetail(id) {
  const back = backButton('全部通行密钥', '#/credentials');
  const c = details.has(id) ? details.get(id) : listed(id);
  if (c === undefined) return loading();
  if (c === null) {
    return h('div', { class: 'detail' }, back,
      emptyState('alert', '这个通行密钥已删除', '它被主人或管理员删除了，操作日志里还留着它的记录。',
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => showAudit({ credentialId: id }) }, icon('clipboard'), '查看它的操作日志')));
  }
  const shares = c.shared_with || [];

  return h('div', { class: 'detail' },
    back,
    h('div', { class: 'detail-head' },
      siteAvatar(c.rp_id, credTitle(c), 'lg'),
      h('div', { class: 'detail-head-main' },
        h('h2', { class: 'detail-title' }, credTitle(c)),
        h('div', { class: 'detail-subtitle' }, h('span', { class: 'badge' }, '通行密钥'), h('span', null, c.rp_id), credentialBadges(c)))),
    h('div', { class: 'detail-actions admin-actions' },
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => act(transferCreds, [c]) }, icon('transfer'), '转移'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => act(shareCreds, [c]) }, icon('share'), '共享'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => showAudit({ credentialId: c.id }) }, icon('clipboard'), '操作日志')),
    h('div', { class: 'card' },
      field('主人', h('a', { href: '#/users/' + c.owner.id }, c.owner.username)),
      field('网站', c.rp_id),
      field('网站名称', c.rp_name),
      field('用户名', c.user_name, { actions: c.user_name ? [copyAction(c.user_name, '用户名')] : [] }),
      field('显示名', c.user_display_name)),
    h('h3', { class: 'section-title' }, '备注'),
    labelCard(c),
    h('h3', { class: 'section-title' }, `共享 · ${shares.length}`),
    h('div', { class: 'card' },
      shares.length
        ? shares.map((s) => h('div', { class: 'subitem' },
          userAvatar(s.user.username, 'sm'),
          h('div', { class: 'item-main' },
            h('div', { class: 'item-title' }, h('a', { class: 'text', href: '#/users/' + s.user.id, title: s.user.username }, s.user.username)),
            h('div', { class: 'item-meta' },
              `共享于 ${fmtDate(s.shared_at)}${s.shared_by ? ` · 由 ${s.shared_by.username} 共享` : ''} · ${lastUsedShort(s.last_used_at)}`)),
          iconButton('x', `撤销 ${s.user.username} 的共享`, () => act((cs) => unshareCreds(cs, [s.user]), [c]), 'danger')))
        : h('div', { class: 'card-empty' }, '还没有共享给任何人'),
      h('div', { class: 'card-foot' },
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => act(shareCreds, [c]) }, icon('plus'), '添加共享'),
        h('span', { class: 'form-hint' }, SHARE_WARNING))),
    h('h3', { class: 'section-title' }, '使用情况'),
    h('div', { class: 'card' },
      field('创建时间', fmtDateTime(c.created_at)),
      lastUsedField(c.last_used_at),
      field('使用次数', `${c.use_count} 次（所有能用它的人合计）`)),
    credentialTechInfo(c),
    h('div', { class: 'danger-zone' },
      h('button', { type: 'button', class: 'btn btn-danger-outline', onclick: () => act(deleteCreds, [c]) }, icon('trash'), '删除通行密钥')));
}

function labelCard(c) {
  return labelEditor(c, async (label) => {
    const data = await api('PATCH', `/admin/credentials/${encodeURIComponent(c.id)}`, { label });
    details.set(c.id, data.credential);
    const items = state.allCreds && state.allCreds.items;
    const i = items ? items.findIndex((x) => x.id === c.id) : -1;
    if (i >= 0) items[i] = data.credential;
    if (c.owner.id === state.me.id) state.creds = null;
  }, '主人和被共享的人都能看到这条备注。');
}
