// 安装插件: the extension download and how to set it up.

import { state, h, icon, brandMark, singlePage, field, copyAction } from '../core.js';

export default {
  id: 'install',
  title: '安装插件',
  icon: 'download',
  render: renderInstallPage,
};

function renderInstallPage() {
  const origin = location.origin;
  const step = (n, title, text) => h('li', { class: 'step' },
    h('span', { class: 'step-num' }, n),
    h('div', { class: 'step-main' }, h('div', { class: 'step-title' }, title), h('div', { class: 'step-text' }, text)));

  const download = state.info.extension_download
    ? h('div', { class: 'card download-card' },
      brandMark(),
      h('div', { class: 'dl-text' },
        h('div', { class: 'dl-title' }, 'Passkey Box 浏览器插件'),
        h('div', { class: 'dl-sub' }, '适用于 Chrome、Edge 等 Chromium 内核浏览器')),
      h('a', { class: 'btn btn-primary', href: '/downloads/passkey-box-extension.zip', download: 'passkey-box-extension.zip' }, icon('download'), '下载插件'))
    : h('div', { class: 'notice', style: 'margin-bottom:20px' }, '服务器还没有提供插件安装包（未配置 PKB_EXTENSION_ZIP），请向管理员索取插件文件。');

  return singlePage('安装插件', '安装 Passkey Box 插件后，网站创建的通行密钥会保存到这台服务器，登录时自动使用，无需指纹或系统验证。',
    download,
    h('h3', { class: 'section-title' }, '安装步骤'),
    h('div', { class: 'card' },
      h('ol', { class: 'steps' },
        step(1, '解压安装包', '把下载的 passkey-box-extension.zip 解压到一个固定的文件夹，安装后不要删除或移动它。'),
        step(2, '打开扩展程序页面', ['在地址栏输入 ', h('span', { class: 'kbd' }, 'chrome://extensions'), ' 并回车。']),
        step(3, '开启开发者模式', '打开页面右上角的“开发者模式”开关。'),
        step(4, '加载已解压的扩展程序', '点击“加载已解压的扩展程序”，选择第 1 步解压出的文件夹。'),
        step(5, '登录插件', '点击浏览器工具栏中的 Passkey Box 图标（可先在拼图菜单里固定），填写下面的服务器地址、用户名和密码。'))),
    h('h3', { class: 'section-title' }, '插件设置'),
    h('div', { class: 'card' },
      field('服务器地址', origin, { mono: true, actions: [copyAction(origin, '服务器地址')] }),
      field('用户名', state.me.username, { actions: [copyAction(state.me.username, '用户名')] }),
      field('密码', '与登录本后台的密码相同')));
}
