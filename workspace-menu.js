'use strict';
(() => {
  const api = window.WorkspaceMenuAPI;
  if (!api) throw new Error('工作区菜单预载未生效');
  const root = document.getElementById('workspaceMenu');
  const search = document.getElementById('menuSearch'), list = document.getElementById('menuList');
  const context = document.getElementById('projectContext');
  let state = { token: '', kind: '', items: [] }, contextId = '', sizeFrame = 0;
  const reportSize = () => {
    cancelAnimationFrame(sizeFrame);
    sizeFrame = requestAnimationFrame(() => api.reportSize({ token: state.token, width: root.offsetWidth, height: root.offsetHeight }));
  };
  function hideContext() { contextId = ''; context.hidden = true; reportSize(); }
  function pick(action, id = '', event) {
    api.pick({ token: state.token, action, id, x: event?.clientX || 12, y: event?.clientY || 12 });
  }
  function renderItems() {
    hideContext();
    const query = search.value.trim().toLocaleLowerCase();
    const matched = state.items.filter(item => !query || `${item.label} ${item.platform || ''}`.toLocaleLowerCase().includes(query));
    list.replaceChildren();
    for (const item of matched) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'menu-item' + (item.active ? ' active' : '');
      button.dataset.id = item.id; button.disabled = item.enabled === false;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(!!item.active));
      const label = document.createElement('span'); label.className = 'menu-label'; label.textContent = item.label;
      button.appendChild(label); button.title = item.label;
      if (item.platform) { const platform = document.createElement('span'); platform.className = 'menu-platform'; platform.textContent = item.platform; button.appendChild(platform); }
      button.addEventListener('click', event => pick('select', item.id, event));
      const migrate = event => {
        if (state.kind !== 'projects' || button.disabled) return;
        event.preventDefault(); contextId = item.id; context.hidden = false;
        document.getElementById('migrate').textContent = `迁移「${item.label}」的固定提示词…`;
        document.getElementById('migrate').focus({ preventScroll: true }); reportSize();
      };
      button.addEventListener('contextmenu', migrate);
      button.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) migrate(event); });
      list.appendChild(button);
    }
    if (!matched.length) { const empty = document.createElement('div'); empty.className = 'menu-empty'; empty.textContent = query ? `没有匹配「${search.value.trim()}」的网页` : '暂无可选择项目'; list.appendChild(empty); }
    reportSize();
  }
  api.onShow(payload => {
    state = payload; contextId = ''; search.value = '';
    root.style.setProperty('--list-max-height', `${Math.max(80, Math.min(360, Number(payload.listMaxHeight) || 360))}px`);
    document.body.dataset.mode = payload.mode;
    document.getElementById('menuTitle').textContent = payload.kind === 'projects' ? '切换剧本' : '全部网页';
    search.hidden = payload.kind !== 'tabs'; document.getElementById('menuHint').hidden = payload.kind !== 'projects';
    document.getElementById('manage').hidden = payload.kind !== 'projects';
    root.setAttribute('aria-label', payload.kind === 'projects' ? '切换剧本' : '全部网页');
    renderItems();
    requestAnimationFrame(() => (payload.kind === 'tabs' ? search : list.querySelector('.active') || list.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true }));
  });
  search.addEventListener('input', renderItems);
  document.getElementById('dismiss').addEventListener('click', () => api.dismiss(state.token));
  document.getElementById('manage').addEventListener('click', event => pick('manage', '', event));
  document.getElementById('migrate').addEventListener('click', event => { if (contextId) pick('migrate', contextId, event); });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!context.hidden) { hideContext(); list.querySelector('[data-id]')?.focus(); } else api.dismiss(state.token); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !context.hidden) return;
    const items = [...list.querySelectorAll('button:not(:disabled)')]; if (!items.length) return;
    event.preventDefault(); const current = items.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index].focus();
  });
  new ResizeObserver(reportSize).observe(root);
})();
