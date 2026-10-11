(function (root) {
  'use strict';
  const remap = (value, change) => typeof value === 'string' && (value === change.oldPath || value.startsWith(`${change.oldPath}/`))
    ? change.path + value.slice(change.oldPath.length) : value;
  function rememberOrder(change) {
    const key = `videoOS.assetFolderOrder.v1.${change.projectId}`;
    const order = JSON.parse(localStorage.getItem(key) || '{}');
    const next = Object.fromEntries(Object.entries(order).map(([parent, children]) =>
      [remap(parent, change), Array.isArray(children) ? children.map(child => remap(child, change)) : []]));
    localStorage.setItem(key, JSON.stringify(next));
  }
  const normalizePath = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/g, '').normalize('NFC');
  const parentPath = value => normalizePath(value).split('/').slice(0, -1).join('/');
  function editName(anchor, request, saveName, onSaved, onError, onCancelled) {
    if (!anchor?.isConnected || anchor.parentElement.querySelector('.folder-rename-input')) return;
    const input = document.createElement('input');
    input.className = 'folder-rename-input';
    input.value = request.name || '';
    input.maxLength = 80;
    input.setAttribute('aria-label', '文件夹名称');
    input.title = request.create ? 'Enter 创建 · Esc 取消' : 'Enter 保存 · Esc 取消；新导入使用这个名称加序号';
    input.style.cssText = 'flex:1;min-width:0;width:100px;height:30px;padding:2px 8px;border:1px solid var(--accent,#1677ff);border-radius:6px;font:inherit;color:inherit;background:var(--surface,#fff)';
    const previousDisplay = anchor.style.display;
    anchor.style.display = 'none';
    anchor.before(input);
    let done = false, busy = false;
    const observer = new MutationObserver(() => { if (!input.isConnected && !done) close(true); });
    const close = cancelled => { if (done) return; done = true; observer.disconnect(); input.remove(); anchor.style.display = previousDisplay; if (cancelled) onCancelled?.(); };
    observer.observe(document.body, { childList: true, subtree: true });
    const save = async () => {
      if (done || busy) return;
      if (!request.create && input.value.trim() === request.name) { close(); return; }
      busy = true; input.disabled = true;
      try {
        const result = await saveName(input.value);
        close(); await onSaved(result);
      } catch (error) {
        busy = false; input.disabled = false;
        input.setAttribute('aria-invalid', 'true'); input.title = error.message;
        onError(error.message || (request.create ? '创建失败' : '改名失败')); input.focus(); input.select();
      }
    };
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('contextmenu', event => event.stopPropagation());
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); save(); }
      if (event.key === 'Escape' && !busy) { event.preventDefault(); close(true); }
    });
    input.addEventListener('blur', () => { if (!busy && !done) close(true); });
    input.focus(); input.select();
  }
  function edit(anchor, request, api, onSaved, onError) {
    editName(anchor, request, name => api.renameFolder({ projectId: request.projectId, path: request.path, name }), onSaved, onError);
  }
  function create(anchor, request, api, onSaved, onError, onCancelled) {
    editName(anchor, { ...request, create: true, name: '新建文件夹' },
      name => api.createFolder({ projectId: request.projectId, parent: request.parent, name }), onSaved, onError, onCancelled);
  }
  let closeMenu = null;
  function menu(event, items, boundsElement) {
    closeMenu?.();
    const node = document.createElement('div');
    node.className = 'asset-context-menu';
    node.setAttribute('role', 'menu');
    node.setAttribute('aria-label', '资产操作');
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = item.label;
      button.addEventListener('click', () => { closeMenu?.(); item.run(); });
      node.appendChild(button);
    }
    document.body.appendChild(node);
    const bounds = boundsElement?.getBoundingClientRect() || { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
    node.style.maxWidth = `${Math.max(120, bounds.right - bounds.left - 8)}px`;
    const rect = node.getBoundingClientRect();
    node.style.left = `${Math.max(bounds.left + 4, Math.min(event.clientX, bounds.right - rect.width - 4))}px`;
    node.style.top = `${Math.max(4, Math.min(event.clientY, innerHeight - rect.height - 4))}px`;
    const outside = evt => { if (!node.contains(evt.target)) closeMenu?.(); };
    const key = evt => {
      if (evt.key === 'Escape') { evt.preventDefault(); closeMenu?.(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(evt.key)) return;
      evt.preventDefault(); const buttons = [...node.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      buttons[evt.key === 'Home' ? 0 : evt.key === 'End' ? buttons.length - 1
        : (index + (evt.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    };
    closeMenu = () => {
      node.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key);
      window.removeEventListener('blur', closeMenu); closeMenu = null;
    };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key);
    window.addEventListener('blur', closeMenu); node.querySelector('button')?.focus({ preventScroll: true });
  }
  function updateMediaPath(container, url) {
    const media = container?.querySelector('img, video, audio');
    if (!media) return;
    if (media.tagName === 'IMG') { media.src = url; return; }
    const time = Number(media.currentTime) || 0, paused = media.paused;
    media.addEventListener('loadedmetadata', () => {
      media.currentTime = Math.min(time, Number.isFinite(media.duration) ? media.duration : time);
      if (!paused) media.play().catch(() => {});
    }, { once: true });
    media.src = url;
  }
  root.FolderEditor = { remap, rememberOrder, edit, create, menu, normalizePath, parentPath, updateMediaPath };
})(window);
