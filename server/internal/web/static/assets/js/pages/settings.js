// 账户设置: the signed-in user's account and password.

import { state, h, api, errText, toast, refreshMe, field, formRow, roleText, fmtDateTime } from '../core.js';

export default {
  id: 'settings',
  title: '账户设置',
  icon: 'sliders',
  // Refresh the account so its passkey count is current.
  load: () => refreshMe(),
  render: renderSettingsPage,
};

function renderSettingsPage() {
  const me = state.me;
  const old = h('input', { class: 'input', id: 'pw-old', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', id: 'pw-new', type: 'password', autocomplete: 'new-password' });
  const confirm = h('input', { class: 'input', id: 'pw-confirm', type: 'password', autocomplete: 'new-password' });
  const error = h('div', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, '修改密码');

  const onSubmit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!old.value) return void (error.textContent = '请输入当前密码');
    if (!next.value) return void (error.textContent = '请输入新密码');
    if (next.value !== confirm.value) return void (error.textContent = '两次输入的新密码不一致');
    submit.disabled = true;
    try {
      await api('PUT', '/me/password', { old_password: old.value, new_password: next.value });
      old.value = next.value = confirm.value = '';
      toast('密码已修改，请在插件中使用新密码');
    } catch (err) {
      if (err.status !== 401) error.textContent = errText(err);
    } finally {
      submit.disabled = false;
    }
  };

  return h('div', { class: 'page single' },
    h('div', { class: 'content' },
      h('div', { class: 'content-inner' },
        h('h1', { class: 'page-title' }, '账户设置'),
        h('p', { class: 'page-sub' }, '查看账户信息并修改登录密码。'),
        h('h3', { class: 'section-title' }, '账户'),
        h('div', { class: 'card' },
          field('用户名', me.username),
          field('角色', roleText(me)),
          field('通行密钥', `${me.credential_count} 个`),
          field('创建时间', fmtDateTime(me.created_at))),
        h('h3', { class: 'section-title' }, '修改密码'),
        h('form', { class: 'card form-card', onsubmit: onSubmit, novalidate: true },
          h('input', { type: 'text', autocomplete: 'username', value: me.username, hidden: true, readonly: true }),
          formRow('当前密码', old),
          formRow('新密码', next),
          formRow('确认新密码', confirm),
          error,
          h('div', { class: 'form-actions' }, submit)))));
}
