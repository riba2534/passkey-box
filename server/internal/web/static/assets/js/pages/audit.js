// 操作日志 (admin): the audit log. Not built yet.

import { h, singlePage, emptyState } from '../core.js';

export default {
  id: 'audit',
  title: '操作日志',
  icon: 'clipboard',
  adminOnly: true,
  render: () => singlePage('操作日志', '这里将记录谁在什么时候创建、修改、共享、转移或删除了什么。',
    h('div', { class: 'card' }, emptyState('clipboard', '即将推出'))),
};
