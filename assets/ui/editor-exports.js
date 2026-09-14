'use strict';

// 大厅和创作资产共用同一入口，不创建新页面，也不切换当前创作剧本。
(() => {
  let dialog, projectSelect, content, status, interval, requestId = 0;
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  };
  async function get(url, body) {
    const response = await fetch(url, { cache: 'no-store', ...(body ? { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取失败，请重试');
    return data;
  }
  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = node('dialog', 'editor-exports-dialog');
    dialog.setAttribute('aria-labelledby', 'editorExportsTitle');
    const header = node('header', 'ee-header');
    const title = node('h2', '', '剪映导出');
    title.id = 'editorExportsTitle';
    const close = node('button', 'ee-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭剪映导出');
    close.onclick = () => dialog.close();
    header.append(title, close);
    const label = node('label', 'ee-project', '归属剧本');
    projectSelect = node('select');
    projectSelect.setAttribute('aria-label', '导出归属剧本');
    projectSelect.onchange = () => {
      content.replaceChildren(node('p', 'ee-loading', '读取目录…'));
      message('');
      refresh();
    };
    label.append(projectSelect);
    content = node('div', 'ee-content');
    status = node('p', 'ee-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const note = node('p', 'ee-note', '将路径粘贴到剪映的导出位置。切换剧本后，请在剪映中更换导出目录。');
    dialog.append(header, label, content, status, note);
    dialog.addEventListener('close', () => { clearInterval(interval); requestId++; });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    document.body.append(dialog);
  }
  function card(folder) {
    const section = node('section', 'ee-card');
    section.dataset.kind = folder.id;
    const heading = node('div', 'ee-card-heading');
    const icon = node('img', 'ee-icon');
    icon.src = window.UIIcons.src(folder.id === 'voice' ? 'audio' : 'film');
    icon.alt = '';
    icon.draggable = false;
    const copy = node('div', 'ee-card-copy');
    copy.append(node('h3', '', folder.label), node('p', '', folder.id === 'voice'
      ? '角色音色 · 自动收录到本剧音频库' : '最终视频 · 自动收录到本剧成片库'));
    heading.append(icon, copy);
    const input = node('input', 'ee-path');
    input.readOnly = true;
    input.value = folder.absolutePath;
    input.title = folder.absolutePath;
    input.setAttribute('aria-label', `${folder.label}导出路径`);
    input.onclick = () => input.select();
    const actions = node('div', 'ee-actions');
    const copyButton = node('button', 'ee-copy', '复制路径');
    copyButton.type = 'button';
    copyButton.onclick = async () => {
      try { await navigator.clipboard.writeText(folder.absolutePath); message(`${folder.label}路径已复制`); }
      catch { input.focus(); input.select(); message('路径已选中，请手动复制。', true); }
    };
    const openButton = node('button', 'ee-open', '打开文件夹');
    openButton.type = 'button';
    openButton.onclick = async () => {
      openButton.disabled = true;
      try {
        await get(`/api/editor-exports/open?${new URLSearchParams({ project: folder.projectId })}`, { kind: folder.id });
        message(`已打开${folder.label}文件夹`);
      } catch (error) { message(error.message, true); }
      finally { openButton.disabled = false; }
    };
    actions.append(copyButton, openButton, node('span', 'ee-count'));
    section.append(heading, input, actions);
    return section;
  }
  async function refresh() {
    const id = ++requestId;
    const projectId = projectSelect.value;
    if (!projectId) return;
    try {
      const data = await get(`/api/editor-exports?${new URLSearchParams({ project: projectId })}`);
      if (id !== requestId || !dialog.open) return;
      for (const folder of data.folders) {
        let section = content.querySelector(`[data-kind="${folder.id}"]`);
        if (!section || section.dataset.path !== folder.absolutePath) {
          const replacement = card(folder);
          replacement.dataset.path = folder.absolutePath;
          if (section) section.replaceWith(replacement);
          else { content.querySelector('.ee-loading')?.remove(); content.append(replacement); }
          section = replacement;
        }
        section.querySelector('.ee-count').textContent = folder.pending
          ? `${folder.pending} 项等待文件稳定` : `${folder.ready} 项已收录`;
      }
    } catch (error) { if (id === requestId && dialog.open) message(error.message, true); }
  }
  async function open({ projectId } = {}) {
    ensureDialog();
    if (dialog.open) return;
    dialog.showModal();
    content.replaceChildren(node('p', 'ee-loading', '读取目录…'));
    projectSelect.replaceChildren();
    projectSelect.disabled = true;
    message('');
    const id = ++requestId;
    try {
      const snapshot = await get('/api/creative-projects');
      if (id !== requestId || !dialog.open) return;
      const projects = snapshot.projects.filter(project => project.available);
      projects.forEach(project => {
        const option = node('option', '', project.name);
        option.value = project.id;
        projectSelect.append(option);
      });
      projectSelect.value = projects.some(project => project.id === projectId) ? projectId : snapshot.activeProjectId;
      projectSelect.disabled = false;
      await refresh();
      if (dialog.open) interval = setInterval(() => { if (!document.hidden) refresh(); }, 3000);
    } catch (error) { if (id === requestId && dialog.open) message(error.message, true); }
  }
  window.EditorExports = Object.freeze({ open });
})();
