// 操作日志 (admin): every recorded change, newest first, filtered by user,
// kind of action or passkey. 概览 reuses its rows, and the other admin
// pages its filter widgets.

import {
  state, h, icon, iconButton, api, errText, toastError, renderShell, go, fmtDateTime,
  singlePage, emptyState, loading,
} from '../core.js';
import { pickUsers, eventText } from '../components.js';

const PAGE = 50;

// ACTIONS are the choices of the action filter: a value ending in "." is a
// prefix, a nested list is an option group.
const ACTIONS = [
  ['', '全部操作'],
  ['用户', [
    ['user.', '全部用户操作'],
    ['user.create', '创建用户'],
    ['user.update', '修改用户'],
    ['user.delete', '删除用户'],
    ['user.revoke_sessions', '强制下线'],
  ]],
  ['通行密钥', [
    ['credential.', '全部通行密钥操作'],
    ['credential.create', '新建通行密钥'],
    ['credential.update', '修改备注'],
    ['credential.share', '共享'],
    ['credential.unshare', '撤销共享'],
    ['credential.leave', '退出共享'],
    ['credential.transfer', '转移'],
    ['credential.delete', '删除通行密钥'],
  ]],
  ['API 令牌', [
    ['token.', '全部令牌操作'],
    ['token.create', '创建令牌'],
    ['token.revoke', '吊销令牌'],
  ]],
];

const VIA = { session: '网页', basic: 'Basic 认证', system: '系统' };

let filters = noFilters();

function noFilters() {
  return { user: null, action: '', credentialId: '' };
}

export default {
  id: 'audit',
  title: '操作日志',
  icon: 'clipboard',
  adminOnly: true,
  // The log grows all the time, so every visit reloads the first page.
  load: () => loadEvents(),
  render: renderAuditPage,
  reset: () => {
    filters = noFilters();
    state.audit = null;
  },
};

/**
 * showAudit opens the log filtered to one user or one passkey, including a
 * disabled or deleted one that the user picker cannot offer.
 *
 * @param {{user?: {id: number, username: string}, credentialId?: string}} f
 */
export function showAudit(f) {
  filters = { ...noFilters(), ...f };
  state.audit = null;
  go('#/audit');
}

function filterKey() {
  return JSON.stringify([filters.user && filters.user.id, filters.action, filters.credentialId]);
}

function fetchEvents(before) {
  const p = new URLSearchParams({ limit: PAGE });
  if (filters.user) p.set('user_id', filters.user.id);
  if (filters.action) p.set('action', filters.action);
  if (filters.credentialId) p.set('credential_id', filters.credentialId);
  if (before != null) p.set('before', before);
  return api('GET', '/admin/audit?' + p);
}

// loadEvents fetches the first page; a response for filters that have
// changed since is dropped.
async function loadEvents() {
  const key = filterKey();
  try {
    const data = await fetchEvents();
    if (key === filterKey()) state.audit = { events: data.events, next: data.next_before };
  } catch (err) {
    if (key === filterKey()) state.audit = { error: err };
  }
}

async function loadMore(button) {
  const data = state.audit;
  button.disabled = true;
  try {
    const res = await fetchEvents(data.next);
    if (state.audit !== data) return;
    state.audit = { events: data.events.concat(res.events), next: res.next_before };
    renderShell();
  } catch (err) {
    button.disabled = false;
    toastError(err);
  }
}

async function setFilters(patch) {
  filters = { ...filters, ...patch };
  state.audit = null;
  renderShell();
  await loadEvents();
  if (state.me) renderShell();
}

/* ------------------------------------------------------------------ */
/* Shared widgets                                                      */
/* ------------------------------------------------------------------ */

function viaText(via) {
  if (via && via.startsWith('token:')) return `API 令牌「${via.slice(6)}」`;
  return VIA[via] || via;
}

/**
 * eventRow shows an AuditEvent: the sentence, when, how, and a link to the
 * passkey it involves (its page says so when the passkey is gone).
 *
 * @param {object} e  AuditEvent.
 * @returns {HTMLElement}
 */
export function eventRow(e) {
  const c = e.credential;
  return h('div', { class: 'event-row' },
    h('div', { class: 'event-text' }, eventText(e, state.me.id)),
    h('div', { class: 'event-meta' },
      h('time', { datetime: e.at }, fmtDateTime(e.at)),
      h('span', null, viaText(e.via)),
      c ? h('a', { href: '#/credentials/' + encodeURIComponent(c.id) }, '查看通行密钥') : null));
}

/**
 * filterChip is a filter that is set in a dialog: "+ 主人" while unset,
 * "主人：alice ×" once set.
 *
 * @param {string} label
 * @param {string} value     The current value's text, or "" when unset.
 * @param {() => void} onpick   Opens the dialog that sets the filter.
 * @param {() => void} onclear  Clears the filter.
 * @returns {HTMLElement}
 */
export function filterChip(label, value, onpick, onclear) {
  if (!value) return h('button', { type: 'button', class: 'chip', onclick: onpick }, icon('plus'), label);
  return h('span', { class: 'chip active' },
    h('button', { type: 'button', class: 'chip-text', title: `${label}：${value}`, onclick: onpick }, `${label}：${value}`),
    iconButton('x', `清除${label}筛选`, onclear, 'chip-x'));
}

/**
 * filterSelect is a drop-down filter styled like filterChip.
 *
 * @param {string} label  Accessible name.
 * @param {string} value  The selected value; "" means no filter.
 * @param {Array<[string, string] | [string, Array<[string, string]>]>} options
 *   [value, text] pairs; [group label, pairs] makes an option group.
 * @param {(value: string) => void} onchange
 * @returns {HTMLSelectElement}
 */
export function filterSelect(label, value, options, onchange) {
  const option = ([v, t]) => h('option', { value: v }, t);
  const select = h('select', {
    class: 'select chip-select' + (value ? ' active' : ''),
    'aria-label': label,
    onchange: (e) => onchange(e.target.value),
  }, options.map(([v, t]) => (Array.isArray(t) ? h('optgroup', { label: v }, t.map(option)) : option([v, t]))));
  select.value = value;
  return select;
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function filterBar() {
  const credInput = h('input', {
    class: 'input filter-input',
    type: 'search',
    placeholder: '凭据 ID',
    value: filters.credentialId,
    'aria-label': '按凭据 ID 筛选',
    onchange: (e) => setFilters({ credentialId: e.target.value.trim() }),
  });
  return h('div', { class: 'filter-bar' },
    filterChip('用户', filters.user && filters.user.username, async () => {
      const picked = await pickUsers({ title: '按用户筛选', submitText: '筛选', intro: '显示这个用户执行的、或者与他有关的操作。' });
      if (picked) setFilters({ user: picked[0] });
    }, () => setFilters({ user: null })),
    filterSelect('操作类型', filters.action, ACTIONS, (v) => setFilters({ action: v })),
    credInput);
}

function renderAuditPage() {
  const data = state.audit;
  const filtered = Boolean(filters.user || filters.action || filters.credentialId);
  let body;
  if (!data) {
    body = loading();
  } else if (data.error) {
    body = h('div', { class: 'card' }, emptyState('alert', '无法加载操作日志', errText(data.error)));
  } else if (!data.events.length) {
    body = h('div', { class: 'card' }, filtered
      ? emptyState('search', '没有符合条件的记录', '换个筛选条件试试')
      : emptyState('clipboard', '还没有操作记录'));
  } else {
    const more = h('button', { type: 'button', class: 'btn btn-sm', onclick: (e) => loadMore(e.currentTarget) }, '加载更多');
    body = [
      h('div', { class: 'card' }, data.events.map(eventRow)),
      h('div', { class: 'load-more' }, data.next != null ? more : h('span', null, `共 ${data.events.length} 条`)),
    ];
  }
  const page = singlePage('操作日志', '谁在什么时候创建、修改、共享、转移或删除了什么。登录、使用通行密钥和查看不会记录。',
    filterBar(), body);
  page.classList.add('admin-page');
  return page;
}
