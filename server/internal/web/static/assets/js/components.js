// Shared widgets for sharing, transfers and admin batch work: the user
// picker, batch requests with a dry-run preview, multi-select, list filters,
// audit event sentences and the parts of a passkey's detail that the user
// and admin pages share.

import {
  h, icon, iconButton, api, errText, sessionEnded, toast, toastError, renderShell, openModal, emptyState,
  loading, searchBox, userAvatar, credBrief, algName, field, copyAction,
} from './core.js';

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
    case 'credential.update':
      return d.label && d.label.to
        ? say(actor, '把', owned, '的备注改为', `「${d.label.to}」`)
        : say(actor, '清除了', owned, '的备注');
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
