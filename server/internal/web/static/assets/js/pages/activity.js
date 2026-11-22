// 我的动态: audit events that involve the signed-in user, newest first.

import { state, h, icon, api, errText, toastError, renderShell, go, singlePage, emptyState, loading, fmtDateTime } from '../core.js';
import { eventText } from '../components.js';

const PAGE_SIZE = 50;

// Icons by action, falling back to the part before the dot.
const ICONS = {
  'credential.update': 'edit',
  'credential.delete': 'trash',
  'credential.share': 'share',
  'credential.unshare': 'share',
  'credential.leave': 'logout',
  'credential.transfer': 'transfer',
  'user.revoke_sessions': 'ban',
  credential: 'key',
  token: 'bot',
  user: 'user',
};

const VIA = { session: '通过网页后台', basic: '通过插件或 Basic 认证', system: '系统自动' };

let events = null;
let next = null; // next_before of the last page loaded
let failed = null;

function fetchPage(before) {
  const q = new URLSearchParams({ limit: PAGE_SIZE });
  if (before != null) q.set('before', before);
  return api('GET', '/me/activity?' + q);
}

export default {
  id: 'activity',
  title: '我的动态',
  icon: 'activity',
  // Every visit starts again from the newest events; the page shows its
  // own load errors.
  load: () => {
    failed = null;
    return fetchPage().then((data) => {
      events = data.events;
      next = data.next_before;
    }, (err) => {
      events = null;
      failed = err;
    });
  },
  render: renderActivityPage,
  reset: () => {
    events = null;
    next = null;
    failed = null;
  },
};

async function loadMore(button) {
  const shown = events;
  button.disabled = true;
  button.textContent = '正在加载…';
  try {
    const data = await fetchPage(next);
    if (events === shown) {
      events = events.concat(data.events);
      next = data.next_before;
    }
  } catch (err) {
    toastError(err);
  }
  if (state.route.page === 'activity') renderShell();
}

function viaText(via) {
  if (!via) return '';
  return via.startsWith('token:') ? `通过令牌 ${via.slice('token:'.length)}` : VIA[via] || via;
}

function eventRow(e) {
  const at = fmtDateTime(e.at);
  const via = viaText(e.via);
  return h('li', { class: 'activity-item' },
    h('span', { class: 'activity-icon' }, icon(ICONS[e.action] || ICONS[e.action.split('.')[0]] || 'activity')),
    h('div', { class: 'item-main' },
      h('div', { class: 'event-text' }, eventText(e, state.me.id)),
      h('div', { class: 'item-meta', title: via ? `${at} · ${via}` : at },
        h('time', { datetime: e.at }, at), via ? ' · ' + via : '')));
}

function renderActivityPage() {
  let body;
  if (failed) {
    body = h('div', { class: 'card' }, emptyState('alert', '无法加载动态', errText(failed),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => go('#/activity') }, icon('refresh'), '重试')));
  } else if (!events) {
    body = h('div', { class: 'card' }, loading());
  } else if (!events.length) {
    body = h('div', { class: 'card' }, emptyState('activity', '还没有动态',
      '共享、转移或删除通行密钥，创建 API 令牌，或管理员修改你的账户后，记录会显示在这里。'));
  } else {
    body = [
      h('ul', { class: 'card activity-list' }, events.map(eventRow)),
      next != null
        ? h('div', { class: 'activity-more' },
          h('button', { type: 'button', class: 'btn', onclick: (e) => loadMore(e.currentTarget) }, '加载更多'))
        : null,
    ];
  }
  return singlePage('我的动态', '与你有关的共享、转移、删除、API 令牌和账户变更，新的在前。', body);
}
