// Agent 接入: API tokens and setup for agents. Not built yet.

import { h, singlePage, emptyState } from '../core.js';

export default {
  id: 'agent',
  title: 'Agent 接入',
  icon: 'bot',
  render: () => singlePage('Agent 接入', '这里将可以创建 API 令牌，让 Agent 读取和管理你的通行密钥。',
    h('div', { class: 'card' }, emptyState('bot', '即将推出'))),
};
