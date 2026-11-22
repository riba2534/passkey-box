// 概览 (admin): site-wide counts, the sites with the most passkeys and the
// latest audit events.

import {
  state, h, api, errText, singlePage, emptyState, loading, siteAvatar,
} from '../core.js';
import { showUsers } from './users.js';
import { showCredentials } from './credentials.js';
import { eventRow, showAudit } from './audit.js';

async function loadOverview() {
  try {
    state.overview = await api('GET', '/admin/overview');
  } catch (err) {
    state.overview = { error: err };
  }
}

export default {
  id: 'overview',
  title: '概览',
  icon: 'grid',
  adminOnly: true,
  // Every visit reloads the numbers.
  load: loadOverview,
  render: renderOverview,
  reset: () => {
    state.overview = null;
  },
};

// stat is one number; with onclick it opens the list it counts.
function stat(value, label, onclick) {
  return h(onclick ? 'button' : 'div', { type: onclick ? 'button' : null, class: 'stat', onclick },
    h('span', { class: 'stat-value' }, value),
    h('span', { class: 'stat-label' }, label));
}

function siteRow(s) {
  return h('button', { type: 'button', class: 'site-row', onclick: () => showCredentials({ rpId: s.rp_id }) },
    siteAvatar(s.rp_id, s.rp_id, 'sm'),
    h('span', { class: 'site-name', title: s.rp_id }, s.rp_id),
    h('span', { class: 'site-count' }, `${s.credentials} 个通行密钥 · ${s.owners} 个主人`));
}

function renderOverview() {
  const o = state.overview;
  let body;
  if (!o) {
    body = loading();
  } else if (o.error) {
    body = h('div', { class: 'card' }, emptyState('alert', '无法加载概览', errText(o.error)));
  } else {
    body = [
      h('h3', { class: 'section-title' }, '用户'),
      h('div', { class: 'stat-grid' },
        stat(o.users.total, '用户', () => showUsers({})),
        stat(o.users.admins, '管理员', () => showUsers({ role: 'admin' })),
        stat(o.users.disabled, '已停用', () => showUsers({ status: 'disabled' }))),
      h('h3', { class: 'section-title' }, '通行密钥'),
      h('div', { class: 'stat-grid' },
        stat(o.credentials.total, '通行密钥', () => showCredentials({})),
        stat(o.credentials.shared, '有共享的', () => showCredentials({ shared: 'true' })),
        stat(o.credentials.shares, '共享关系'),
        stat(o.credentials.sites, '网站')),
      h('h3', { class: 'section-title' }, o.sites.length < o.credentials.sites ? `网站分布 · 前 ${o.sites.length} 个` : '网站分布'),
      h('div', { class: 'card' }, o.sites.length ? o.sites.map(siteRow) : emptyState('database', '还没有通行密钥')),
      h('div', { class: 'section-head' },
        h('h3', { class: 'section-title' }, '最近操作'),
        h('button', { type: 'button', class: 'section-link', onclick: () => showAudit({}) }, '查看全部')),
      h('div', { class: 'card' }, o.recent_events.length ? o.recent_events.map(eventRow) : emptyState('clipboard', '还没有操作记录')),
    ];
  }
  const page = singlePage('概览', '用户、通行密钥和共享的整体情况。点数字或网站可以打开对应的列表。', body);
  page.classList.add('admin-page');
  return page;
}
