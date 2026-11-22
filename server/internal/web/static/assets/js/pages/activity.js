// 我的动态: audit events that involve the signed-in user. Not built yet.

import { h, singlePage, emptyState } from '../core.js';

export default {
  id: 'activity',
  title: '我的动态',
  icon: 'activity',
  render: () => singlePage('我的动态', '这里将显示与你有关的共享、转移和账户变更。',
    h('div', { class: 'card' }, emptyState('activity', '即将推出'))),
};
