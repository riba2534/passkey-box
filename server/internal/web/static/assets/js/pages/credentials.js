// 全部通行密钥 (admin): every user's passkeys. Not built yet.

import { h, singlePage, emptyState } from '../core.js';

export default {
  id: 'credentials',
  title: '全部通行密钥',
  icon: 'database',
  adminOnly: true,
  render: () => singlePage('全部通行密钥', '这里将列出所有用户的通行密钥，可以批量共享、转移和删除。',
    h('div', { class: 'card' }, emptyState('database', '即将推出'))),
};
