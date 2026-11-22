// Shared widgets for sharing, transfers and admin batch work: the user
// picker, batch requests with a dry-run preview, multi-select, list filters,
// audit event sentences and the parts of a passkey's detail that the user
// and admin pages share, its names and custom fields among them.

import {
  h, icon, iconButton, api, errText, sessionEnded, toast, toastError, renderShell, openModal, formDialog, emptyState,
  loading, searchBox, userAvatar, credBrief, algName, field, copyAction, copyText,
} from './core.js';
import { parseTotp, canComputeCodes, hotp, totpCounter, groupCode } from './totp.js';

/* ------------------------------------------------------------------ */
/* User picker                                                         */
/* ------------------------------------------------------------------ */

/**
 * pickUsers opens a dialog for choosing users from GET /users, which lists
 * every active user (admins use it too).
 *
 * @param {object} opts
 * @param {string} opts.title            Dialog title.
 * @param {boolean} [opts.multiple]      Allow several users; otherwise exactly one.
 * @param {number[]} [opts.exclude]      User IDs to leave out, e.g. the owner and current recipients.
 * @param {string} [opts.submitText]     Confirm button text, default "确定".
 * @param {string|Node} [opts.intro]     Text above the search box, e.g. a warning.
 * @returns {Promise<{id: number, username: string}[] | null>} The chosen
 *   users in the order they were picked, or null if the dialog was closed.
 */
export function pickUsers({ title, multiple, exclude, submitText, intro }) {
  return new Promise((resolve) => {
    const skip = new Set(exclude || []);
    const chosen = new Map();
    let users = null;
    let query = '';
    let picked = null;

    const list = h('div', { class: 'pick-list', role: 'group', 'aria-label': '用户列表' }, loading());
    const count = h('span', { class: 'pick-count' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary', disabled: true }, submitText || '确定');
    const update = () => {
      submit.disabled = !chosen.size;
      count.textContent = multiple && chosen.size ? `已选 ${chosen.size} 人` : '';
    };
    const fill = () => {
      if (!users) return;
      const q = query.trim().toLowerCase();
      const shown = users.filter((u) => !skip.has(u.id) && (!q || u.username.toLowerCase().includes(q)));
      if (!shown.length) {
        list.replaceChildren(q ? emptyState('search', '没有匹配的用户') : emptyState('users', '没有可以选择的用户'));
        return;
      }
      list.replaceChildren(...shown.map((u) => h('label', { class: 'pick-item' },
        h('input', {
          type: multiple ? 'checkbox' : 'radio',
          name: 'pick-user',
          checked: chosen.has(u.id),
          onchange: (e) => {
            if (!multiple) chosen.clear();
            if (e.target.checked) chosen.set(u.id, u);
            else chosen.delete(u.id);
            update();
          },
        }),
        userAvatar(u.username, 'sm'),
        h('span', { class: 'pick-name' }, u.username))));
    };

    openModal(title, (close) => h('form', {
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        if (!chosen.size) return;
        picked = [...chosen.values()];
        close();
      },
    },
    h('div', { class: 'modal-body' },
      intro ? h('p', null, intro) : null,
      searchBox('搜索用户名', '', (v) => {
        query = v;
        fill();
      }),
      list),
    h('div', { class: 'modal-foot' },
      count,
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, '取消'),
      submit)), () => resolve(picked));

    api('GET', '/users').then((data) => {
      users = data.users;
      fill();
    }, (err) => {
      if (!sessionEnded(err)) list.replaceChildren(emptyState('alert', '无法加载用户列表', errText(err)));
    });
  });
}

/* ------------------------------------------------------------------ */
/* Batch requests                                                      */
/* ------------------------------------------------------------------ */

// Server messages for item errors and warnings that deserve their own text.
const ITEM_TEXT = {
  'duplicate item': '重复了',
  'user owns this credential': '该用户就是这个通行密钥的主人',
  'user is disabled': '该用户已停用',
};

function itemMessage(item) {
  if (ITEM_TEXT[item.message]) return ITEM_TEXT[item.message];
  const isCred = item.field === 'ids';
  switch (item.code) {
    case 'not_found': return isCred ? '通行密钥不存在或无权访问' : '用户不存在';
    case 'forbidden': return isCred ? '只有主人可以这样操作' : '没有权限执行此操作';
    case 'conflict': return isCred ? '通行密钥已存在' : '用户名已存在';
    case 'invalid_request': return item.message ? `输入的内容不正确（${item.message}）` : errText(item);
    default: return errText(item);
  }
}

// itemValue names a failed item by its request value, never showing a
// password from a batch-create or batch-update item.
function itemValue(value) {
  if (value == null) return '';
  if (typeof value === 'number') return `ID ${value}`;
  if (typeof value === 'object') return itemValue(value.username ?? value.user);
  const s = String(value);
  return [...s].length > 24 ? [...s].slice(0, 12).join('') + '…' : s;
}

const SINGLE_FIELDS = { to: '接收人', transfer_credentials_to: '交接对象' };
const FIELD_NAMES = { ids: '通行密钥', users: '用户', items: '用户' };

/**
 * batchError explains a failed batch request in Chinese. A 400 with items
 * becomes one line per item, e.g. "第 2 项 bob：用户不存在"; anything else
 * is the usual error text.
 *
 * @param {Error & {code: string, items?: object[]}} err  Thrown by api().
 * @param {(item: {field: string, index: number, value: *}) => string} [label]
 *   Optional better name for an item, e.g. "github.com · alice" for a
 *   credential id; return "" to fall back to the request value.
 * @returns {string} Text with "\n" between lines; show it with white-space: pre-line.
 */
export function batchError(err, label) {
  const items = err.items;
  if (!items || !items.length) return errText(err);
  const mixed = new Set(items.map((i) => i.field)).size > 1;
  const lines = items.map((item) => {
    const where = SINGLE_FIELDS[item.field]
      || `${mixed && FIELD_NAMES[item.field] ? FIELD_NAMES[item.field] : ''}第 ${item.index + 1} 项`;
    const name = (label && label(item)) || itemValue(item.value);
    return `${where}${name ? ' ' + name : ''}：${itemMessage(item)}`;
  });
  return [`以下 ${items.length} 项有问题，整批操作都没有执行：`, ...lines].join('\n');
}

function warningText(w) {
  if (ITEM_TEXT[w]) return ITEM_TEXT[w];
  const m = /^(.+) already has a passkey for this account$/.exec(w);
  return m ? `${m[1]} 已有这个网站同一账号的通行密钥，转移后两个并存` : w;
}

// PREVIEW_ROWS caps the rows a preview renders; the rest are counted.
const PREVIEW_ROWS = 200;

// messageDialog shows text with a single close button and resolves when
// the dialog closes.
function messageDialog(title, text, isError) {
  return new Promise((resolve) => {
    openModal(title, (close) => [
      h('div', { class: 'modal-body' }, h('p', { class: 'batch-message' + (isError ? ' error' : ''), role: isError ? 'alert' : null }, text)),
      h('div', { class: 'modal-foot' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: close }, '关闭')),
    ], resolve);
  });
}

/**
 * runBatch sends a batch request with dry_run: true, previews the outcome
 * (item count, warnings and one line per result) and, once the user
 * confirms, sends it again with dry_run: false.
 *
 * @param {object} opts
 * @param {string} opts.path      API path under /api/v1, e.g. "/credentials/transfer".
 * @param {object} opts.body      Request body without dry_run.
 * @param {string} opts.title     Dialog title.
 * @param {(result: object) => string} opts.describe  One-line summary of an
 *   entry of the response's results, e.g. "github.com · alice → bob".
 * @param {string} [opts.confirmText]  Confirm button text, default "确认执行".
 * @param {boolean} [opts.danger]      Red confirm button for destructive operations.
 * @param {string|Node} [opts.intro]   Text above the preview, e.g. a warning.
 * @param {(item: object) => string} [opts.label]  Passed to batchError.
 * @returns {Promise<object|null>} The response to the real request
 *   ({dry_run: false, results}), or null when the user cancels or a request
 *   fails; failures are shown with batchError before it resolves.
 */
export async function runBatch({ path, body, title, describe, confirmText, danger, intro, label }) {
  let preview;
  try {
    preview = await api('POST', path, { ...body, dry_run: true });
  } catch (err) {
    if (!sessionEnded(err)) await messageDialog(title, batchError(err, label), true);
    return null;
  }
  const results = preview.results || [];
  if (!results.length) {
    await messageDialog(title, '没有需要执行的操作。');
    return null;
  }

  return new Promise((resolve) => {
    let outcome = null;
    openModal(title, (close) => {
      const unchanged = results.filter((r) => r.status === 'unchanged').length;
      const warned = results.filter((r) => r.warnings && r.warnings.length);
      const error = h('p', { class: 'batch-message error', role: 'alert' });
      const cancel = h('button', { type: 'button', class: 'btn', onclick: () => close() }, '取消');
      const confirm = h('button', {
        type: 'button',
        class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'),
        onclick: async () => {
          confirm.disabled = true;
          confirm.textContent = '正在执行…';
          try {
            outcome = await api('POST', path, { ...body, dry_run: false });
            close();
          } catch (err) {
            // A signed-out user is already back at the login page.
            if (sessionEnded(err)) return;
            error.textContent = batchError(err, label);
            confirm.remove();
            cancel.textContent = '关闭';
          }
        },
      }, confirmText || '确认执行');

      const rows = results.slice(0, PREVIEW_ROWS).map((r) => h('li', { class: 'batch-row' },
        h('span', { class: 'batch-text' }, describe(r)),
        r.status === 'unchanged' ? h('span', { class: 'badge gray' }, '无变化') : null,
        r.warnings && r.warnings.length ? h('span', { class: 'badge amber' }, '有警告') : null));
      if (results.length > PREVIEW_ROWS) rows.push(h('li', { class: 'batch-row muted' }, `以及另外 ${results.length - PREVIEW_ROWS} 项`));

      return [
        h('div', { class: 'modal-body' },
          intro ? h('p', null, intro) : null,
          h('p', { class: 'batch-summary' }, `共 ${results.length} 项`, unchanged ? `，其中 ${unchanged} 项无需变更` : '', '。'),
          warned.length
            ? h('div', { class: 'batch-warnings' },
              h('div', { class: 'batch-warnings-title' }, icon('alert'), `${warned.length} 项有警告`),
              h('ul', null, warned.flatMap((r) => r.warnings.map((w) => h('li', null, `${describe(r)}：${warningText(w)}`)))))
            : null,
          h('ul', { class: 'batch-list' }, rows),
          error),
        h('div', { class: 'modal-foot' }, cancel, confirm),
      ];
    }, () => resolve(outcome), { wide: true });
  });
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} Selection
 * @property {(id: string|number) => boolean} has
 * @property {(id: string|number, on?: boolean) => void} toggle  Flips id, or sets it to on.
 * @property {(ids: Iterable<string|number>) => void} set  Replaces the selection.
 * @property {() => void} clear
 * @property {number} size  Read-only.
 * @property {() => Array<string|number>} ids  Selected ids in the order they were added.
 * @property {(el: Element, update: () => void) => void} follow  Runs update on
 *   every change while el is in the document, until a redraw removes el.
 */

/**
 * selection creates a multi-select model. Keep it in page state so it
 * survives redraws; the widgets below follow its changes by themselves.
 *
 * @returns {Selection}
 */
export function selection() {
  const chosen = new Set();
  // The widgets following the selection. Pages render synchronously and are
  // inserted right away, so a widget counts as shown once it is found in the
  // document after the task that built it, and as gone once it is not.
  const widgets = new Set();
  let sweeping = false;
  const visit = (notify) => {
    for (const w of [...widgets]) {
      if (w.el.isConnected) {
        w.shown = true;
        if (notify) w.update();
      } else if (w.shown) {
        widgets.delete(w);
      }
    }
  };
  const changed = () => visit(true);
  return {
    has: (id) => chosen.has(id),
    toggle(id, on = !chosen.has(id)) {
      if (on === chosen.has(id)) return;
      if (on) chosen.add(id);
      else chosen.delete(id);
      changed();
    },
    set(ids) {
      chosen.clear();
      for (const id of ids) chosen.add(id);
      changed();
    },
    clear() {
      if (!chosen.size) return;
      chosen.clear();
      changed();
    },
    get size() {
      return chosen.size;
    },
    ids: () => [...chosen],
    follow(el, update) {
      widgets.add({ el, update, shown: false });
      // Once the redraw that built el is done, drop the widgets it replaced.
      if (sweeping) return;
      sweeping = true;
      queueMicrotask(() => {
        sweeping = false;
        visit(false);
      });
    },
  };
}

/**
 * selectionBar shows how many items are selected, buttons for acting on
 * them and a button to clear the selection. It is hidden while nothing is
 * selected.
 *
 * @param {Selection} sel
 * @param {{text: string, icon?: string, danger?: boolean, onclick: (ids: Array<string|number>) => void}[]} actions
 *   onclick receives the selected ids.
 * @returns {HTMLElement}
 */
export function selectionBar(sel, actions) {
  const count = h('span', { class: 'selection-count' });
  const bar = h('div', { class: 'selection-bar', role: 'toolbar', 'aria-label': '批量操作' },
    count,
    h('div', { class: 'selection-actions' }, actions.map((a) => h('button', {
      type: 'button',
      class: 'btn btn-sm' + (a.danger ? ' btn-danger-outline' : ''),
      onclick: () => a.onclick(sel.ids()),
    }, a.icon ? icon(a.icon) : null, a.text))),
    iconButton('x', '取消选择', () => sel.clear()));
  const update = () => {
    bar.hidden = !sel.size;
    count.textContent = `已选 ${sel.size} 项`;
  };
  update();
  sel.follow(bar, update);
  return bar;
}

/**
 * selectBox is a checkbox for one item of a selection. Clicks on it do not
 * reach the row around it, so it can sit inside a link.
 *
 * @param {Selection} sel
 * @param {string|number} id
 * @param {string} name  The item's name, for the accessible label "选择 <name>".
 * @returns {HTMLInputElement}
 */
export function selectBox(sel, id, name) {
  const box = h('input', {
    type: 'checkbox',
    class: 'select-box',
    checked: sel.has(id),
    'aria-label': '选择 ' + name,
    onclick: (e) => e.stopPropagation(),
    onchange: () => sel.toggle(id, box.checked),
  });
  sel.follow(box, () => {
    box.checked = sel.has(id);
  });
  return box;
}

/**
 * selectAllBox selects or clears every id ids() returns, for example the
 * rows matching the current search. It is ticked when all of them are
 * selected and shows a dash when only some are.
 *
 * The box follows changes of the selection; call its refresh() after the
 * list behind ids() changes, for example when a filter is applied.
 *
 * @param {Selection} sel
 * @param {() => Array<string|number>} ids
 * @returns {HTMLInputElement & {refresh: () => void}}
 */
export function selectAllBox(sel, ids) {
  const box = h('input', {
    type: 'checkbox',
    class: 'select-box',
    'aria-label': '全选',
    onclick: (e) => e.stopPropagation(),
    onchange: () => {
      const all = ids();
      if (box.checked) {
        sel.set([...sel.ids(), ...all.filter((id) => !sel.has(id))]);
      } else {
        const drop = new Set(all);
        sel.set(sel.ids().filter((id) => !drop.has(id)));
      }
    },
  });
  const update = () => {
    const all = ids();
    const n = all.filter((id) => sel.has(id)).length;
    box.checked = all.length > 0 && n === all.length;
    box.indeterminate = n > 0 && n < all.length;
  };
  update();
  sel.follow(box, update);
  box.refresh = update;
  return box;
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

/**
 * filterChip is a filter that is set in a dialog: "+ 主人" while unset,
 * "主人：alice ×" once set.
 *
 * @param {string} label
 * @param {string} value     The current value's text, or "" when unset.
 * @param {() => void} onpick   Opens the dialog that sets the filter.
 * @param {() => void} onclear  Clears the filter.
 * @returns {HTMLElement}
 */
export function filterChip(label, value, onpick, onclear) {
  if (!value) return h('button', { type: 'button', class: 'chip', onclick: onpick }, icon('plus'), label);
  return h('span', { class: 'chip active' },
    h('button', { type: 'button', class: 'chip-text', title: `${label}：${value}`, onclick: onpick }, `${label}：${value}`),
    iconButton('x', `清除${label}筛选`, onclear, 'chip-x'));
}

/**
 * filterSelect is a drop-down filter styled like filterChip.
 *
 * @param {string} label  Accessible name.
 * @param {string} value  The selected value; "" means no filter.
 * @param {Array<[string, string] | [string, Array<[string, string]>]>} options
 *   [value, text] pairs; [group label, pairs] makes an option group.
 * @param {(value: string) => void} onchange
 * @returns {HTMLSelectElement}
 */
export function filterSelect(label, value, options, onchange) {
  const option = ([v, t]) => h('option', { value: v }, t);
  const select = h('select', {
    class: 'select chip-select' + (value ? ' active' : ''),
    'aria-label': label,
    onchange: (e) => onchange(e.target.value),
  }, options.map(([v, t]) => (Array.isArray(t) ? h('optgroup', { label: v }, t.map(option)) : option([v, t]))));
  select.value = value;
  return select;
}

/* ------------------------------------------------------------------ */
/* Audit events                                                        */
/* ------------------------------------------------------------------ */

const CJK = /[\u2e80-\u9fff\uff00-\uffef]/;
const CJK_PUNCT = /[\u3000-\u303f\uff00-\uffef]/;

// say joins sentence fragments, with a space between Chinese and Latin
// text ("admin 把 alice 的") but not inside Chinese ("你把") or next to
// full-width punctuation ("bob（管理员）").
function say(...parts) {
  return parts.flat().filter(Boolean).reduce((s, p) => {
    const a = s.at(-1);
    const b = p[0];
    const tight = (CJK.test(a) && CJK.test(b)) || CJK_PUNCT.test(a) || CJK_PUNCT.test(b);
    return s + (tight ? '' : ' ') + p;
  });
}

const UPDATED_NAMES = [['label', '备注'], ['rp_name', '网站名称'], ['user_name', '用户名'], ['user_display_name', '显示名']];

// updateChanges lists what a credential.update event changed, e.g.
// "把网站名称改为「GitHub」" or "添加了字段「恢复码」". The detail names fields
// by label only; their values are never in the audit log.
function updateChanges(d) {
  const parts = [];
  for (const [key, name] of UPDATED_NAMES) {
    const c = d[key];
    if (c) parts.push(c.to ? `把${name}改为「${c.to}」` : `清除了${name}`);
  }
  const f = d.fields || {};
  // "添加了字段「恢复码」、「PIN」和 1 个未命名字段"
  const fields = (verb, list) => {
    if (!list || !list.length) return;
    const named = list.filter(Boolean).map((l) => `「${l}」`).join('、');
    const unnamed = list.filter((l) => !l).length;
    parts.push(verb + (named ? '字段' + named : '') + (unnamed ? `${named ? '和' : ''} ${unnamed} 个未命名字段` : ''));
  };
  fields('添加了', f.added);
  fields('修改了', f.changed);
  fields('删除了', f.removed);
  return parts;
}

/**
 * eventText describes an AuditEvent in one Chinese sentence, e.g.
 * "admin 把 alice 的 github.com · alice@example.com 转移给了 bob".
 *
 * @param {object} event  AuditEvent from /me/activity, /admin/audit or /admin/overview.
 * @param {number} [meId] The viewer's user ID; that user is called "你".
 * @returns {string}
 */
export function eventText(event, meId) {
  const who = (u) => (!u ? '已删除的用户' : u.id === meId ? '你' : u.username);
  const actor = event.actor ? who(event.actor) : '系统';
  const subject = who(event.subject);
  const target = who(event.target);
  const d = event.detail || {};
  const self = Boolean(event.actor && event.subject && event.actor.id === event.subject.id);
  const whose = self ? '自己' : subject;
  const cred = event.credential ? credBrief(event.credential) : '通行密钥';
  // A passkey is named with its owner unless the owner acts on it.
  const owned = self ? [cred] : [subject, '的', cred];

  switch (event.action) {
    case 'user.create':
      return say(actor, '创建了用户', subject, d.is_admin ? '（管理员）' : '');
    case 'user.update': {
      const c = d.changes || {};
      const parts = [];
      if (c.username) parts.push(say('把用户名', c.username.from, '改为', c.username.to));
      if (c.is_admin) parts.push(c.is_admin.to ? say('把', subject, '设为管理员') : say('取消了', whose, '的管理员身份'));
      if (c.disabled) parts.push(say(c.disabled.to ? '停用了' : '启用了', subject));
      if (c.note) parts.push(say('修改了', whose, '的备注'));
      if (c.password) parts.push(self ? '修改了密码' : say('重置了', subject, '的密码'));
      if (!parts.length) parts.push(say('修改了', whose, '的账户'));
      return say(actor, parts.join('，'));
    }
    case 'user.delete': {
      let s = say(actor, '删除了用户', subject);
      if (d.credentials_transferred) s += '，' + say(`${d.credentials_transferred} 个通行密钥转给了`, target);
      if (d.credentials_deleted) s += `，${d.credentials_deleted} 个通行密钥被一并删除`;
      return s;
    }
    case 'user.revoke_sessions':
      return say(actor, '注销了', whose, `的全部登录（${d.sessions || 0} 个会话、${d.tokens || 0} 个 API 令牌）`);
    case 'credential.create':
      return say(actor, self ? '' : ['为', subject], '新建了通行密钥', cred);
    case 'credential.update': {
      const changes = updateChanges(d);
      // Events before 0.7.0 only change the label, and so do many since.
      if (!changes.length || (changes.length === 1 && d.label)) {
        return d.label && d.label.to
          ? say(actor, '把', owned, '的备注改为', `「${d.label.to}」`)
          : say(actor, '清除了', owned, '的备注');
      }
      return say(actor, '修改了', owned, '：', changes.join('，'));
    }
    case 'credential.delete':
      return say(actor, '删除了', owned);
    case 'credential.share':
      return say(actor, '把', owned, '共享给了', target);
    case 'credential.unshare':
      return say(actor, '停止向', target, '共享', owned);
    case 'credential.leave':
      return say(actor, '退出了', subject, '共享的', cred);
    case 'credential.transfer':
      // The old owner by name: "自己" would read as the new owner here.
      return say(actor, '把', owned, '转移给了', target, d.keep_access ? ['，', say(subject, '仍可使用')] : '');
    case 'token.create':
      return say(actor, self ? '' : ['为', subject], '创建了', d.read_only ? '只读' : '', 'API 令牌', `「${d.name}」`);
    case 'token.revoke':
      return say(actor, '吊销了', self ? '' : [subject, '的'], 'API 令牌', `「${d.name}」`);
    default:
      return say(actor, '执行了', event.action);
  }
}

/* ------------------------------------------------------------------ */
/* Passkeys                                                            */
/* ------------------------------------------------------------------ */

/**
 * labelBadge shows a passkey's label, with the full text on hover.
 *
 * @param {object} c  Credential.
 * @returns {HTMLElement|null} A .badge, or null without a label.
 */
export function labelBadge(c) {
  return c.label ? h('span', { class: 'badge gray', title: c.label }, c.label) : null;
}

/**
 * credentialBadges labels how a passkey is shared: "共享自 alice" when it
 * was shared with the user the list belongs to, "已共享 2 人" when it has
 * recipients. Show them next to the title, like the label badge.
 *
 * @param {object} c  Credential.
 * @returns {HTMLElement[]} Zero to two .badge elements.
 */
export function credentialBadges(c) {
  const badges = [];
  if (c.access === 'shared' && c.owner) badges.push(h('span', { class: 'badge violet' }, `共享自 ${c.owner.username}`));
  if (c.shared_with && c.shared_with.length) badges.push(h('span', { class: 'badge green' }, `已共享 ${c.shared_with.length} 人`));
  return badges;
}

/**
 * labelEditor is a card for changing a passkey's label: 保存 or Enter calls
 * save with the new text, then says so and redraws; a failure is reported
 * and the label can be saved again.
 *
 * @param {object} c  Credential.
 * @param {(label: string) => Promise<void>} save  Stores the label and updates the page's data.
 * @param {string} [hint]  Text under the input.
 * @returns {HTMLElement}
 */
export function labelEditor(c, save, hint) {
  const input = h('input', { class: 'input', value: c.label, placeholder: '添加备注，例如“工作号”', maxlength: '200', 'aria-label': '备注' });
  const button = h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: true }, '保存');
  const submit = async () => {
    if (input.value === c.label) return;
    button.disabled = true;
    try {
      await save(input.value);
      toast('备注已保存');
      renderShell();
    } catch (err) {
      button.disabled = false;
      toastError(err);
    }
  };
  input.addEventListener('input', () => {
    button.disabled = input.value === c.label;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  button.addEventListener('click', submit);
  return h('div', { class: 'card' },
    h('div', { class: 'field' }, h('div', { class: 'field-main' },
      h('div', { class: 'label-edit' }, input, button),
      hint ? h('div', { class: 'form-hint' }, hint) : null)));
}

/**
 * credentialTechInfo is the 技术信息 section of a passkey's detail.
 *
 * @param {object} c  Credential.
 * @returns {HTMLElement[]} The section title and its card.
 */
export function credentialTechInfo(c) {
  return [
    h('h3', { class: 'section-title' }, '技术信息'),
    h('div', { class: 'card' },
      field('算法', algName(c.alg)),
      field('凭据 ID', c.id, { mono: true, actions: [copyAction(c.id, '凭据 ID')] }),
      field('用户句柄（User Handle）', c.user_handle, { mono: true, actions: [copyAction(c.user_handle, '用户句柄')] }),
      field('注册来源', c.origin)),
  ];
}

/* ------------------------------------------------------------------ */
/* Names and custom fields                                             */
/* ------------------------------------------------------------------ */

const KEPT_HINT = '在网站上重新注册同一账号时，你改过的名称、备注和字段会保留。';

// The server's limits (docs/API.md).
const MAX_NAME = 1000;
const MAX_FIELDS = 50;
const MAX_LABEL = 100;
const MAX_VALUE = 10000;

// FIELD_TYPES names the custom field types, in the order the add menu
// offers them. The extension uses the same names.
const FIELD_TYPES = {
  text: { name: '文本', icon: 'text' },
  password: { name: '密码', icon: 'lock' },
  totp: { name: '一次性密码', icon: 'timer' },
  url: { name: '网址', icon: 'link' },
  email: { name: '邮箱', icon: 'mail' },
  phone: { name: '电话', icon: 'phone' },
  date: { name: '日期', icon: 'calendar' },
  multiline: { name: '多行文本', icon: 'lines' },
};

// Input attributes for the value of each type in the editor.
const VALUE_INPUTS = {
  url: { inputmode: 'url', placeholder: 'https://' },
  email: { inputmode: 'email', placeholder: 'name@example.com' },
  phone: { inputmode: 'tel', placeholder: '+86 138 0000 0000' },
  date: { inputmode: 'numeric', placeholder: 'YYYY-MM-DD，例如 2026-11-23' },
  totp: { placeholder: '粘贴 base32 密钥或 otpauth:// 链接' },
};

const MASK = '••••••••';
const DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

function typeOf(f) {
  return FIELD_TYPES[f.type] || FIELD_TYPES.text;
}

// fieldName is a field's label, or its type's name when it has none.
function fieldName(f) {
  return (f.label || '').trim() || typeOf(f).name;
}

function chars(s) {
  return [...s].length;
}

// parseDate reads YYYY-MM-DD as a real calendar date (UTC), or returns null.
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

// webURL is the value as a link target when it is an http(s) URL.
function webURL(v) {
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function mailHref(v) {
  const s = v.trim();
  return /^[^\s@]+@[^\s@]+$/.test(s) ? 'mailto:' + s : null;
}

function telHref(v) {
  const s = v.trim();
  return /^\+?[\d\s().-]{3,}$/.test(s) && /\d/.test(s) ? 'tel:' + s.replace(/[^\d+]/g, '') : null;
}

// sectionHead is a section title, with a button on its right if given.
function sectionHead(title, button) {
  const t = h('h3', { class: 'section-title' }, title);
  return button ? h('div', { class: 'section-bar' }, t, button) : t;
}

// saveError explains a failed PATCH in its dialog. The server names a bad
// field by its index ("fields[3]: invalid TOTP secret"); fields is the
// list that was sent.
function saveError(err, fields) {
  if (sessionEnded(err)) return '';
  if (err.code !== 'invalid_request' || !err.message) return errText(err);
  const m = /^fields\[(\d+)\]:\s*(.*)$/.exec(err.message);
  const f = m && fields && fields[Number(m[1])];
  if (!f) return `${errText(err)}：${err.message}`;
  const name = [...fieldName(f)];
  return `第 ${Number(m[1]) + 1} 个字段「${name.length > 16 ? name.slice(0, 15).join('') + '…' : name.join('')}」：${m[2]}`;
}

// revealButton is an eye button that shows and hides what; toggle gets
// whether it is shown now.
function revealButton(what, toggle) {
  let shown = false;
  const button = iconButton('eye', '显示' + what, () => {
    shown = !shown;
    toggle(shown);
    button.replaceChildren(icon(shown ? 'eye-off' : 'eye'));
    button.title = (shown ? '隐藏' : '显示') + what;
    button.setAttribute('aria-label', button.title);
  });
  return button;
}

/**
 * credentialNames is the 账号 section of a passkey's detail: 网站名称, 用户名
 * and 显示名. With save it has an 编辑 button whose dialog sends only the
 * names that changed, then says so and redraws; a failure is shown in the
 * dialog.
 *
 * @param {object} c  Credential.
 * @param {object} [opts]
 * @param {(patch: {rp_name?: string, user_name?: string, user_display_name?: string}) => Promise<void>} [opts.save]
 *   Sends the PATCH and updates the page's data. Leave it out for viewers
 *   who may not edit.
 * @param {Node|Node[]} [opts.before]  Rows above the names, e.g. the owner.
 * @param {Node|Node[]} [opts.after]   Rows below them, e.g. the site.
 * @returns {HTMLElement[]} The section title and its card.
 */
export function credentialNames(c, opts) {
  const o = opts || {};
  const edit = o.save
    ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => editNames(c, o.save) }, icon('edit'), '编辑')
    : null;
  return [
    sectionHead('账号', edit),
    h('div', { class: 'card' },
      o.before,
      field('网站名称', c.rp_name, { placeholder: `未设置，显示为 ${c.rp_id}` }),
      field('用户名', c.user_name, { actions: c.user_name ? [copyAction(c.user_name, '用户名')] : [] }),
      field('显示名', c.user_display_name),
      o.after),
  ];
}

const NAMES = [['rp_name', '网站名称'], ['user_name', '用户名'], ['user_display_name', '显示名']];

function editNames(c, save) {
  formDialog({
    title: '编辑账号信息',
    intro: KEPT_HINT,
    fields: [
      { name: 'rp_name', label: '网站名称', value: c.rp_name || '', placeholder: c.rp_id, hint: '列表和详情的标题，留空时显示网站域名。' },
      { name: 'user_name', label: '用户名', value: c.user_name || '' },
      { name: 'user_display_name', label: '显示名', value: c.user_display_name || '' },
    ],
    onSubmit: async (v) => {
      const patch = {};
      for (const [key, name] of NAMES) {
        if (v[key] === (c[key] || '')) continue;
        const s = v[key].trim();
        if (chars(s) > MAX_NAME) return `${name}不能超过 ${MAX_NAME} 个字符`;
        patch[key] = s;
      }
      if (!Object.keys(patch).length) return '';
      try {
        await save(patch);
      } catch (err) {
        return saveError(err);
      }
      toast('账号信息已保存');
      renderShell();
      return '';
    },
  });
}

/**
 * credentialFields is the 自定义字段 section of a passkey's detail. Each
 * field shows its type, label and value: passwords and TOTP secrets stay
 * hidden until shown, http(s) URLs, emails and phone numbers are links, and
 * a TOTP field shows its current code with the seconds left. With save it
 * has a button that opens the editor, which sends the whole list.
 *
 * @param {object} c  Credential; servers before 0.7.0 leave out fields.
 * @param {object} [opts]
 * @param {(fields: {id?: string, label: string, type: string, value: string}[]) => Promise<void>} [opts.save]
 *   Sends the PATCH and updates the page's data. Leave it out for viewers
 *   who may not edit.
 * @returns {HTMLElement[]} The section title and its card; nothing for a
 *   viewer when there are no fields.
 */
export function credentialFields(c, opts) {
  const save = opts && opts.save;
  const fields = c.fields || [];
  if (!save && !fields.length) return [];
  const edit = save
    ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => editFields(c, save) },
      icon(fields.length ? 'edit' : 'plus'), fields.length ? '编辑' : '添加')
    : null;
  return [
    sectionHead(fields.length ? `自定义字段 · ${fields.length}` : '自定义字段', edit),
    h('div', { class: 'card' }, fields.length
      ? fields.map(fieldRow)
      : h('div', { class: 'card-empty' }, '可以添加恢复码、PIN、一次性密码（TOTP）等信息，主人和被共享的人都能看到。')),
  ];
}

function fieldRow(f) {
  const t = typeOf(f);
  const name = fieldName(f);
  const v = f.value || '';
  const value = h('div', { class: 'field-value' });
  const more = [];
  const actions = [];
  if (f.type === 'totp') {
    const p = parseTotp(v);
    const code = totpCode(p);
    const secret = h('div', { class: 'cf-secret', hidden: true },
      h('code', null, v),
      iconButton('copy', '复制密钥', () => copyText(v.trim(), '密钥')));
    value.append(code);
    more.push(secret);
    actions.push(revealButton('密钥', (shown) => { secret.hidden = !shown; }));
    if (!p.error) actions.push(iconButton('copy', '复制验证码', () => code.code && copyText(code.code, '验证码')));
  } else if (!v) {
    value.classList.add('muted');
    value.textContent = '—';
  } else {
    let href = null;
    switch (f.type) {
      case 'password':
        value.textContent = MASK;
        actions.push(revealButton(name, (shown) => {
          value.textContent = shown ? v : MASK;
          value.classList.toggle('mono', shown);
        }));
        break;
      case 'url':
        href = webURL(v);
        value.append(href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, v) : v);
        break;
      case 'email':
        href = mailHref(v);
        value.append(href ? h('a', { href }, v) : v);
        break;
      case 'phone':
        href = telHref(v);
        value.append(href ? h('a', { href }, v) : v);
        break;
      case 'date': {
        const d = parseDate(v);
        value.append(d ? DATE_FORMAT.format(d) : v);
        break;
      }
      case 'multiline':
        value.classList.add('multiline');
        value.append(v);
        break;
      default:
        value.append(v);
    }
    actions.push(copyAction(v, name));
  }
  return h('div', { class: 'field cf-row' },
    h('span', { class: 'cf-icon', title: t.name }, icon(t.icon)),
    h('div', { class: 'field-main' }, h('div', { class: 'field-label' }, name), value, more),
    actions.length ? h('div', { class: 'field-actions' }, actions) : null);
}

/**
 * totpCode shows the current code of a TOTP field and the seconds left in
 * its period, and keeps them current every second while it is in the
 * document. Its timer stops at the first tick after the element has left
 * the document, that is once a redraw or another page replaced it.
 *
 * @param {ReturnType<typeof parseTotp>} p
 * @returns {HTMLElement & {code: string}} code is the code shown, "" until
 *   it is computed or when it cannot be.
 */
function totpCode(p) {
  let note = '';
  if (p.error) note = '无法识别这个密钥';
  else if (!canComputeCodes()) note = '浏览器只在 HTTPS 页面上提供验证码计算';
  if (note) return Object.assign(h('span', { class: 'totp-note' }, note), { code: '' });

  const digits = h('span', { class: 'totp-digits' }, groupCode('•'.repeat(p.digits)));
  const ring = h('span', { class: 'totp-ring', 'aria-hidden': 'true' });
  const left = h('span', { class: 'totp-left' });
  const el = Object.assign(h('span', { class: 'totp' }, digits, h('span', { class: 'totp-timer' }, ring, left)), { code: '' });
  let counter = -1;
  const paint = () => {
    const step = totpCounter(p, Date.now() / 1000);
    left.textContent = `${step.remaining} 秒`;
    ring.style.setProperty('--left', String(step.remaining / p.period));
    el.classList.toggle('ending', step.remaining <= 5);
    return step;
  };
  const tick = () => {
    if (!el.isConnected) return;
    const step = paint();
    if (step.counter !== counter) {
      counter = step.counter;
      hotp(p.secret, step.counter, p.algorithm, p.digits).then((code) => {
        if (counter !== step.counter) return;
        el.code = code;
        digits.textContent = groupCode(code);
      }, () => {
        el.code = '';
        digits.textContent = '无法计算';
      });
    }
    // Just after the next whole second, when the countdown changes.
    setTimeout(tick, 1010 - (Date.now() % 1000));
  };
  paint();
  setTimeout(tick, 0);
  return el;
}

let draftKey = 0;

function sameFields(a, b) {
  return a.length === b.length && a.every((f, i) => f.id === b[i].id && f.type === b[i].type
    && f.label === (b[i].label || '') && f.value === (b[i].value || ''));
}

// editFields opens the editor for a passkey's custom fields: add one (type
// first, then label and value), change, remove and reorder them, then save
// the whole list at once. What it checks while typing is advice: the server
// decides, and its message shows in the dialog.
function editFields(c, save) {
  const original = c.fields || [];
  const draft = original.map((f) => ({ id: f.id, label: f.label || '', type: f.type, value: f.value || '', key: ++draftKey }));
  let choosing = !draft.length;
  let list;
  let adder;

  const rowOf = (d) => list.querySelector(`[data-key="${d.key}"]`);

  const draw = () => {
    list.replaceChildren(...(draft.length
      ? draft.map(editorRow)
      : [h('div', { class: 'cf-edit-empty' }, original.length ? '已删除全部字段，保存后生效。' : '还没有自定义字段。')]));
    drawAdder();
  };

  const drawAdder = () => {
    if (draft.length >= MAX_FIELDS) {
      adder.replaceChildren(h('div', { class: 'form-hint' }, `最多 ${MAX_FIELDS} 个字段`));
    } else if (!choosing) {
      adder.replaceChildren(h('button', {
        type: 'button',
        class: 'btn btn-sm',
        onclick: () => {
          choosing = true;
          drawAdder();
          adder.scrollIntoView({ block: 'nearest' });
          adder.querySelector('.cf-type-btn').focus();
        },
      }, icon('plus'), '添加字段'));
    } else {
      adder.replaceChildren(
        h('div', { class: 'cf-add-title' }, '选择字段类型'),
        h('div', { class: 'cf-types' }, Object.entries(FIELD_TYPES).map(([type, t]) => h('button', {
          type: 'button',
          class: 'cf-type-btn',
          onclick: () => add(type),
        }, icon(t.icon), t.name))),
        draft.length
          ? h('button', { type: 'button', class: 'btn btn-sm cf-add-cancel', onclick: () => { choosing = false; drawAdder(); } }, '取消')
          : null);
    }
  };

  const add = (type) => {
    const d = { label: '', type, value: '', key: ++draftKey };
    draft.push(d);
    choosing = false;
    draw();
    const row = rowOf(d);
    row.scrollIntoView({ block: 'nearest' });
    row.querySelector('[data-role="label"]').focus();
  };

  const move = (d, by) => {
    const i = draft.indexOf(d);
    draft.splice(i, 1);
    draft.splice(i + by, 0, d);
    draw();
    const [up, down] = rowOf(d).querySelectorAll('.cf-edit-actions .icon-btn');
    const target = by < 0 ? up : down;
    (target.disabled ? (by < 0 ? down : up) : target).focus();
  };

  const remove = (d) => {
    const i = draft.indexOf(d);
    draft.splice(i, 1);
    draw();
    const next = draft[Math.min(i, draft.length - 1)];
    (next ? rowOf(next).querySelector('[data-role="label"]') : adder.querySelector('button')).focus();
  };

  const editorRow = (d, i) => {
    const t = typeOf(d);
    const labelHint = h('div', { class: 'cf-hint bad' });
    const valueHint = h('div', { class: 'cf-hint' });
    const label = h('input', {
      class: 'input', value: d.label, placeholder: `字段名，留空时显示“${t.name}”`,
      'aria-label': '字段名', autocomplete: 'off', 'data-role': 'label',
    });
    const checkLabel = () => {
      const n = chars(d.label.trim());
      labelHint.textContent = n > MAX_LABEL ? `字段名不能超过 ${MAX_LABEL} 个字符，现在是 ${n} 个` : '';
    };
    label.addEventListener('input', () => {
      d.label = label.value;
      checkLabel();
    });

    let previewed = null;
    const checkValue = () => {
      const n = chars(d.value);
      valueHint.classList.remove('bad');
      if (n > MAX_VALUE) {
        valueHint.classList.add('bad');
        valueHint.textContent = `内容不能超过 ${MAX_VALUE} 个字符，现在是 ${n} 个`;
        previewed = null;
      } else if (d.type === 'date') {
        const bad = d.value !== '' && !parseDate(d.value);
        valueHint.classList.toggle('bad', bad);
        valueHint.textContent = bad ? '日期格式应为 YYYY-MM-DD，例如 2026-11-23' : '';
      } else if (d.type === 'totp' && d.value.trim() !== previewed) {
        previewed = d.value.trim();
        const p = parseTotp(d.value);
        if (p.error) {
          valueHint.classList.toggle('bad', Boolean(previewed));
          valueHint.replaceChildren(previewed ? p.error : '可以粘贴网站给出的密钥，或者二维码里的 otpauth:// 链接');
        } else {
          valueHint.replaceChildren(h('span', { class: 'cf-preview' }, '验证码预览', totpCode(p),
            h('span', null, `${p.algorithm.replace('-', '')} · ${p.digits} 位 · ${p.period} 秒一换`)));
        }
      } else if (d.type !== 'totp') {
        valueHint.textContent = '';
      }
    };

    const attrs = {
      class: 'input', 'aria-label': '值', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      'data-role': 'value', ...(VALUE_INPUTS[d.type] || { placeholder: '值' }),
    };
    let input;
    let valueBox;
    if (d.type === 'multiline') {
      input = h('textarea', { ...attrs, class: 'input textarea cf-textarea', rows: 3, value: d.value });
      valueBox = input;
    } else if (d.type === 'password' || d.type === 'totp') {
      // Masked with CSS rather than type=password, so the browser does not
      // offer to fill in or save the console's own password here.
      input = h('input', { ...attrs, class: 'input cf-masked', value: d.value });
      valueBox = h('div', { class: 'cf-input-wrap' }, input,
        revealButton(d.type === 'totp' ? '密钥' : '密码', (shown) => input.classList.toggle('cf-masked', !shown)));
    } else {
      input = h('input', { ...attrs, value: d.value });
      valueBox = input;
    }
    input.addEventListener('input', () => {
      d.value = input.value;
      checkValue();
    });

    const up = iconButton('up', '上移', () => move(d, -1));
    const down = iconButton('down', '下移', () => move(d, 1));
    up.disabled = i === 0;
    down.disabled = i === draft.length - 1;
    checkLabel();
    checkValue();
    return h('div', { class: 'cf-edit-row', 'data-key': d.key },
      h('div', { class: 'cf-edit-head' },
        h('span', { class: 'cf-edit-type' }, icon(t.icon), t.name),
        h('div', { class: 'cf-edit-actions' }, up, down, iconButton('trash', '删除这个字段', () => remove(d), 'danger'))),
      label, labelHint, valueBox, valueHint);
  };

  openModal('编辑自定义字段', (close) => {
    list = h('div', { class: 'cf-edit-list' });
    adder = h('div', { class: 'cf-add' });
    const error = h('div', { class: 'form-error cf-edit-error', role: 'alert' });
    const submit = h('button', {
      type: 'button',
      class: 'btn btn-primary',
      onclick: async () => {
        const fields = draft.map((d) => (d.id
          ? { id: d.id, label: d.label, type: d.type, value: d.value }
          : { label: d.label, type: d.type, value: d.value }));
        if (sameFields(fields, original)) {
          close();
          return;
        }
        submit.disabled = true;
        error.textContent = '';
        for (const row of list.querySelectorAll('.cf-edit-row.invalid')) row.classList.remove('invalid');
        try {
          await save(fields);
        } catch (err) {
          submit.disabled = false;
          error.textContent = saveError(err, draft);
          const m = /^fields\[(\d+)\]/.exec(err.message || '');
          const bad = m && draft[Number(m[1])];
          if (bad) {
            rowOf(bad).classList.add('invalid');
            rowOf(bad).scrollIntoView({ block: 'nearest' });
          }
          return;
        }
        close();
        toast('自定义字段已保存');
        renderShell();
      },
    }, '保存');
    draw();
    // Only the body scrolls, so the error and the buttons stay in view.
    return [
      h('div', { class: 'modal-body cf-edit-body' },
        list,
        adder,
        h('p', { class: 'form-hint' }, '主人和被共享的人都能看到这些字段。', KEPT_HINT)),
      error,
      h('div', { class: 'modal-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => close() }, '取消'),
        submit),
    ];
  }, null, { wide: true });
  if (choosing) adder.querySelector('.cf-type-btn').focus();
}
