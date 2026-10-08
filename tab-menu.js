'use strict';

// 标签右键菜单小窗渲染层：主进程推送过滤后的条目，这里只负责渲染、键盘导航与回传。
// 消失时机全部由主进程裁决——Esc/blur 驻留 500ms，点选立即回执不等 120ms 淡出。
const root = document.getElementById('menuRoot');
const api = window.TabMenuAPI;

if (!api) throw new Error('TabMenuAPI 未注入：菜单窗 preload 未生效');

// 快捷键提示美化：渲染端拿到的 accelerator 是 'CmdOrCtrl+Shift+T' 这类原始串，
// 按 creator 页 DOM 菜单的习惯在 mac 上显示 ⌘⇧T，其他平台显示 Ctrl+Shift+T。
function prettifyAccelerator(value) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  return String(value || '')
    .split('+')
    .map(part => {
      const key = part.trim();
      const lower = key.toLowerCase();
      if (!key) return '';
      if (lower === 'cmdorctrl') return isMac ? '⌘' : 'Ctrl';
      if (lower === 'cmd' || lower === 'meta') return '⌘';
      if (lower === 'ctrl' || lower === 'control') return isMac ? '⌃' : 'Ctrl';
      if (lower === 'shift') return isMac ? '⇧' : 'Shift';
      if (lower === 'alt' || lower === 'option') return isMac ? '⌥' : 'Alt';
      return key.length === 1 ? key.toUpperCase() : key;
    })
    .filter(Boolean)
    .join(isMac ? '' : '+');
}

function selectableItems() {
  return [...root.querySelectorAll('.tab-context-item:not(:disabled)')];
}

function focusSelectable(index) {
  const items = selectableItems();
  if (!items.length) return;
  // 与 creator 页 DOM 菜单一致：循环滚动，Home 到顶、End 到底；禁用项跳过
  const next = (index + items.length) % items.length;
  items[next].focus({ preventScroll: true });
}

function replayEntrance() {
  root.classList.remove('entering', 'closing');
  // 强制 reflow 让同一节点重新起播（驻留期内原地换内容也要有进入动画）
  void root.offsetWidth;
  root.classList.add('entering');
}

function renderItems(items) {
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.separator) {
      const line = document.createElement('div');
      line.className = 'tab-context-separator';
      fragment.appendChild(line);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab-context-item' + (item.danger ? ' danger' : '');
    button.setAttribute('role', 'menuitem');
    button.dataset.action = String(item.id || '');
    button.disabled = item.enabled === false;
    const hint = prettifyAccelerator(item.accelerator);
    button.innerHTML = '<span class="tab-context-label"></span>' + (hint ? '<span class="tab-context-hint"></span>' : '');
    button.querySelector('.tab-context-label').textContent = String(item.label || '');
    if (hint) button.querySelector('.tab-context-hint').textContent = hint;
    fragment.appendChild(button);
  }
  root.replaceChildren(fragment);
}

function reportSize() {
  // 内容尺寸回报主进程：主进程 setContentSize 后按显示器 workArea 钳制定位，保证菜单完整可见
  api.reportSize(root.offsetWidth, root.offsetHeight);
}

api.onShow(payload => {
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  renderItems(items);
  replayEntrance();
  requestAnimationFrame(() => {
    reportSize();
    selectableItems()[0]?.focus({ preventScroll: true });
  });
});

// 键盘导航与 creator 页 DOM 菜单（creator.js tabContextMenu keydown）对齐
root.addEventListener('keydown', event => {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const items = selectableItems();
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus({ preventScroll: true });
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    const item = event.target instanceof Element ? event.target.closest('.tab-context-item') : null;
    if (!item || item.disabled) return;
    event.preventDefault();
    item.click();
  }
});

// Esc 与 blur 走主进程同一条驻留路径：不立即消失，500ms 后才回执 cancelled 并关窗
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  root.classList.add('closing');
  api.dismiss();
});

// 点选：回执立即发出（主进程不等动画先 resolve），120ms 淡出后 dismiss 通知主进程收窗
root.addEventListener('click', event => {
  const item = event.target instanceof Element ? event.target.closest('.tab-context-item') : null;
  if (!item || item.disabled) return;
  event.preventDefault();
  root.classList.add('closing');
  api.pick(item.dataset.action || '');
  setTimeout(() => api.dismiss(), 120);
});
