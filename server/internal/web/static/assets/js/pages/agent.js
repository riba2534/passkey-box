// Agent 接入: API tokens for agents, the /skill.md guide and a prompt that
// hands both to an agent.

import {
  state, h, icon, iconButton, api, errText, toast, copyText, renderShell, go, openModal, confirmDelete, formDialog,
  singlePage, emptyState, loading, field, copyAction, fmtDate, fmtDateTime, lastUsedShort,
} from '../core.js';

const EXPIRY = [['', '永不过期'], ['30', '30 天'], ['90', '90 天'], ['365', '365 天']];

let tokens = null;
let failed = null;
// fresh is the token created on this visit, {id, secret}. Its plaintext is
// never shown again once the user leaves the page.
let fresh = null;

export default {
  id: 'agent',
  title: 'Agent 接入',
  icon: 'bot',
  // The page shows its own load errors.
  load: () => {
    fresh = null;
    failed = null;
    return api('GET', '/me/tokens').then((data) => {
      tokens = data.tokens;
    }, (err) => {
      tokens = null;
      failed = err;
    });
  },
  render: renderAgentPage,
  reset: () => {
    tokens = null;
    failed = null;
    fresh = null;
  },
};

function skillURL() {
  return new URL(state.info.skill_url || '/skill.md', location.origin).href;
}

function promptText() {
  return `请读取 ${skillURL()}，按其中说明使用 Passkey Box API。我的 API 令牌是：${fresh ? fresh.secret : '<在这里填入令牌>'}。转移、删除等操作先 dry run 预览并让我确认。`;
}

function createToken() {
  formDialog({
    title: '创建 API 令牌',
    intro: '令牌明文只在创建后显示一次，请直接交给 Agent 或妥善保存。',
    submitText: '创建',
    fields: [
      { name: 'name', label: '名称', placeholder: '例如 claude', hint: '用来辨认是哪个 Agent 在用，最多 64 个字符。' },
      { name: 'expires', label: '有效期', type: 'select', options: EXPIRY, value: '90' },
      { name: 'read_only', label: '只读：只能查询，不能修改', type: 'checkbox' },
    ],
    onSubmit: async (v) => {
      const name = v.name.trim();
      if (!name) return '请输入名称';
      if ([...name].length > 64) return '名称不能超过 64 个字符';
      const body = { name, read_only: v.read_only };
      if (v.expires) body.expires_in_days = Number(v.expires);
      try {
        const data = await api('POST', '/me/tokens', body);
        tokens = [data.token, ...(tokens || [])];
        fresh = { id: data.token.id, secret: data.secret };
        renderShell();
        showSecret(data.token.name, data.secret);
        return '';
      } catch (err) {
        return errText(err, { invalid_request: '令牌已达到每人 50 个的上限，请先吊销不用的令牌' });
      }
    },
  });
}

function showSecret(name, secret) {
  openModal('令牌已创建', (close) => [
    h('div', { class: 'modal-body' },
      h('p', null, `这是令牌「${name}」的明文。关闭后无法再次查看，请现在复制。`),
      h('div', { class: 'agent-secret' }, h('code', null, secret), copyAction(secret, '令牌')),
      h('p', { class: 'form-hint' }, '它也已填进本页的提示词，可以直接复制给 Agent。')),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', class: 'btn', onclick: () => copyText(promptText(), '提示词') }, icon('copy'), '复制提示词'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: close }, '完成')),
  ]);
}

async function revokeToken(t) {
  const revoked = await confirmDelete({
    title: '吊销令牌？',
    message: `使用令牌「${t.name}」的 Agent 会立即失去访问。此操作无法撤销。`,
    confirmText: '吊销',
  }, `/me/tokens/${t.id}`);
  if (!revoked) return;
  tokens = tokens.filter((x) => x.id !== t.id);
  if (fresh && fresh.id === t.id) fresh = null;
  toast('令牌已吊销');
  renderShell();
}

function tokenRow(t) {
  const expired = t.expires_at != null && Date.parse(t.expires_at) <= Date.now();
  const expiry = !t.expires_at ? '永不过期' : `${expired ? '已于 ' : ''}${fmtDate(t.expires_at)} 过期`;
  return h('div', { class: 'subitem' },
    h('span', { class: 'agent-token-icon' }, icon('key')),
    h('div', { class: 'item-main' },
      h('div', { class: 'item-title' },
        h('span', { class: 'text', title: t.name }, t.name),
        h('span', { class: t.read_only ? 'badge gray' : 'badge' }, t.read_only ? '只读' : '可读写'),
        expired ? h('span', { class: 'badge amber' }, '已过期') : null),
      h('div', { class: 'agent-token-prefix' }, t.prefix + '…'),
      h('div', {
        class: 'item-meta agent-token-meta',
        title: `创建于 ${fmtDateTime(t.created_at)}${t.expires_at ? `，${fmtDateTime(t.expires_at)} 过期` : ''}`,
      }, `创建于 ${fmtDate(t.created_at)} · ${expiry} · ${lastUsedShort(t.last_used_at)}`)),
    iconButton('trash', `吊销令牌 ${t.name}`, () => revokeToken(t), 'danger'));
}

function tokenList() {
  if (failed) {
    return h('div', { class: 'card' }, emptyState('alert', '无法加载令牌', errText(failed),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => go('#/agent') }, icon('refresh'), '重试')));
  }
  if (!tokens) return h('div', { class: 'card' }, loading());
  if (!tokens.length) {
    return h('div', { class: 'card' }, emptyState('bot', '还没有 API 令牌', '创建一个令牌交给 Agent 使用。令牌明文只在创建时显示一次。'));
  }
  return h('div', { class: 'card' }, tokens.map(tokenRow));
}

function renderAgentPage() {
  const url = skillURL();
  const prompt = promptText();
  const fact = (name, text) => h('li', { class: 'agent-fact' }, icon(name), h('span', null, text));

  return singlePage('Agent 接入', '创建 API 令牌交给 Agent（例如 Claude Code），它就能通过本站的 API 帮你查询和管理通行密钥。',
    h('h3', { class: 'section-title' }, '令牌的权限'),
    h('div', { class: 'card' },
      h('ul', { class: 'agent-facts' },
        fact('user', state.me.is_admin
          ? '令牌继承你的权限。你是管理员，你的令牌也能做管理员能做的事，例如管理用户和所有人的通行密钥。'
          : '令牌继承你的权限：Agent 能做你在后台能做的事。管理员的令牌能做管理员能做的事。'),
        fact('lock', '令牌拿不到通行密钥的私钥，也不能修改密码或创建令牌。'),
        fact('shield', '可以设为只读（只能查询），可以设置有效期；不用时随时吊销。'))),
    h('h3', { class: 'section-title' }, '交给 Agent'),
    h('div', { class: 'card' },
      field('使用说明', url, {
        mono: true,
        actions: [
          h('a', { class: 'icon-btn', href: url, target: '_blank', rel: 'noopener', title: '在新窗口打开', 'aria-label': '在新窗口打开' }, icon('external')),
          copyAction(url, '链接'),
        ],
      }),
      h('div', { class: 'field' },
        h('div', { class: 'field-main' },
          h('div', { class: 'field-label' }, '提示词'),
          h('div', { class: 'agent-prompt' }, prompt),
          h('div', { class: 'form-hint' }, fresh
            ? '已填入刚创建的令牌。离开本页后不会再显示它的明文。'
            : '创建令牌后会自动填进这里；也可以把占位符换成你保存的令牌。')),
        h('div', { class: 'field-actions' }, copyAction(prompt, '提示词')))),
    h('div', { class: 'user-section-head' },
      h('h3', { class: 'section-title' }, tokens && tokens.length ? `API 令牌 · ${tokens.length}` : 'API 令牌'),
      h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: createToken }, icon('plus'), '创建令牌')),
    tokenList());
}
