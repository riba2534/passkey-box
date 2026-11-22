// 概览 (admin): site-wide counts and recent events. Not built yet.

import { h, singlePage, emptyState } from '../core.js';

export default {
  id: 'overview',
  title: '概览',
  icon: 'grid',
  adminOnly: true,
  render: () => singlePage('概览', '这里将显示用户、通行密钥和共享的统计，以及最近的操作。',
    h('div', { class: 'card' }, emptyState('grid', '即将推出'))),
};
