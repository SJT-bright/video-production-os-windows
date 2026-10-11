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
  function edit(anchor, request, api, onSaved, onError) {
    if (!anchor.isConnected || anchor.parentElement.querySelector('.folder-rename-input')) return;
    const input = document.createElement('input');
    input.className = 'folder-rename-input';
    input.value = request.name;
    input.maxLength = 80;
    input.setAttribute('aria-label', '文件夹名称');
    input.title = 'Enter 保存 · Esc 取消；只修改文件夹名称，文件按 001、002 编号';
    input.style.cssText = 'flex:1;min-width:0;width:100px;height:30px;padding:2px 8px;border:1px solid var(--accent,#1677ff);border-radius:6px;font:inherit;color:inherit;background:var(--surface,#fff)';
    const previousDisplay = anchor.style.display;
    anchor.style.display = 'none';
    anchor.before(input);
    let done = false, busy = false;
    const close = () => { done = true; input.remove(); anchor.style.display = previousDisplay; };
    const save = async () => {
      if (done || busy) return;
      if (input.value.trim() === request.name) { close(); return; }
      busy = true; input.disabled = true;
      try {
        const result = await api.renameFolder({ projectId: request.projectId, path: request.path, name: input.value });
        close(); await onSaved(result);
      } catch (error) {
        busy = false; input.disabled = false;
        input.setAttribute('aria-invalid', 'true'); input.title = error.message;
        onError(error.message || '改名失败'); input.focus(); input.select();
      }
    };
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('contextmenu', event => event.stopPropagation());
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); save(); }
      if (event.key === 'Escape' && !busy) { event.preventDefault(); close(); }
    });
    input.addEventListener('blur', () => { if (!busy && !done) close(); });
    input.focus(); input.select();
  }
  root.FolderEditor = { remap, rememberOrder, edit };
})(window);
