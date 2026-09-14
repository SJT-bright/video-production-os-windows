'use strict';

// 资产中心和创作面板共用的外部来源入口；复用是明确复制，不移动源文件。
(() => {
  let dialog, projects, list, status, query, tabs, folderBar, sourceForm, sourcePath, category;
  let snapshot, vault, source = 'media', folder = '', selectedFile, revision = 0, unsubscribe;
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const button = (text, action, className = '') => {
    const el = node('button', className, text); el.type = 'button'; el.onclick = action; return el;
  };
  async function api(route, body) {
    const response = await fetch(route, { cache: 'no-store', ...(body ? { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取失败');
    return data;
  }
  function message(text, error = false) { status.textContent = text; status.classList.toggle('is-error', error); }
  function ensure() {
    if (dialog) return;
    dialog = node('dialog', 'asset-sources-dialog');
    dialog.setAttribute('aria-labelledby', 'assetSourcesTitle');
    const title = node('h2', '', '外部来源'); title.id = 'assetSourcesTitle';
    const header = node('header', 'as-header');
    const close = button('×', () => dialog.close(), 'as-close'); close.setAttribute('aria-label', '关闭外部来源');
    header.append(title, close);
    const controls = node('div', 'as-controls');
    const label = node('label', '', '用于剧本'); projects = node('select'); projects.setAttribute('aria-label', '素材目标剧本');
    projects.onchange = () => { message(''); render(); };
    label.append(projects);
    category = node('select'); category.setAttribute('aria-label', '保存分类');
    for (const value of ['', '人物资产', '场景资产', '生成图片', '音频', 'BGM', '音效', '生成视频', '成片', '视频参考', '剧本与提示词']) {
      const option = node('option', '', value || '自动分类'); option.value = value; category.append(option);
    }
    controls.append(label, category);
    tabs = node('nav', 'as-tabs'); tabs.setAttribute('aria-label', '素材来源');
    for (const [key, label] of [['media', '已关联文件夹'], ['obsidian', 'Obsidian']]) {
      const tab = button(label, () => { source = key; selectedFile = null; folder = ''; refresh(); });
      tab.dataset.source = key; tabs.append(tab);
    }
    query = node('input'); query.type = 'search'; query.placeholder = '搜索素材'; query.setAttribute('aria-label', '搜索外部素材');
    query.oninput = render;
    folderBar = node('div', 'as-folder-bar');
    list = node('div', 'as-list');
    status = node('p', 'as-status'); status.setAttribute('role', 'status');
    sourceForm = node('details', 'as-add-source');
    sourceForm.append(node('summary', '', '＋ 关联文件夹'));
    const form = node('form', 'as-source-form');
    sourcePath = node('input'); sourcePath.placeholder = '粘贴文件夹完整路径'; sourcePath.required = true;
    sourcePath.setAttribute('aria-label', '外部文件夹路径');
    const purpose = node('select'); purpose.setAttribute('aria-label', '外部文件夹用途');
    for (const [value, text] of [['media', '普通素材 / 音频'], ['finals', '成片目录']]) {
      const option = node('option', '', text); option.value = value; purpose.append(option);
    }
    const save = button('关联', async () => {
      if (!sourcePath.reportValidity()) return;
      save.disabled = true;
      try {
        await api('/api/library-sources', { action: 'add', rootPath: sourcePath.value.trim(), projectId: projects.value, purpose: purpose.value });
        sourcePath.value = ''; sourceForm.open = false; await refresh(); message('已关联，目录中的新素材会自动刷新');
      } catch (error) { message(error.message, true); }
      finally { save.disabled = false; }
    }, 'as-primary');
    form.onsubmit = event => { event.preventDefault(); save.click(); };
    const pick = button('选择文件夹', async () => {
      try {
        if (window.assetAPI?.pickSourceFolder) {
          const result = await window.assetAPI.pickSourceFolder(); if (result?.path) sourcePath.value = result.path;
        } else if (window.desktopOS?.addMediaSource) {
          const result = await window.desktopOS.addMediaSource('folder');
          if (result?.cancelled) return;
          await api('/api/library-sources', { action: 'save', id: result.id, projectId: projects.value, purpose: purpose.value });
          sourceForm.open = false; await refresh(); message('文件夹已关联');
        }
      } catch (error) { message(error.message, true); }
    });
    pick.hidden = !window.assetAPI?.pickSourceFolder && !window.desktopOS?.addMediaSource;
    form.append(sourcePath, purpose, pick, save); sourceForm.append(form);
    dialog.append(header, controls, tabs, query, folderBar, sourceForm, list, status,
      node('p', 'as-note', '原文件保留在来源目录；“用于本剧”会复制到所选剧本，可继续拖入创作网页。'));
    dialog.addEventListener('close', () => { revision++; unsubscribe?.close(); unsubscribe = null; list.replaceChildren(); });
    document.body.append(dialog);
  }
  function fileType(name) {
    if (/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name)) return 'image';
    if (/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(name)) return 'video';
    if (/\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|aiff?|amr|ape)$/i.test(name)) return 'audio';
    if (/\.(md|txt|pdf|srt|json)$/i.test(name)) return 'document';
    return '';
  }
  async function use(file, control) {
    const projectId = projects.value;
    if (!projectId) { message('请选择归属剧本', true); return; }
    const selectedCategory = category.value || (file.finalSource ? '成片' : file.audioRole === 'bgm' ? 'BGM' : file.audioRole === 'sfx' ? '音效' : '');
    const requestRevision = revision;
    control.disabled = true;
    try {
      const result = await api('/api/library-use', { source: file.origin || 'media', path: file.path, projectId, category: selectedCategory });
      if (requestRevision !== revision || !dialog.open) return;
      message(result.existing ? '本剧已收录，不会重复复制' : '已加入本剧资产，可在工作台中拖动复用');
      control.textContent = '已加入';
      window.dispatchEvent(new CustomEvent('asset-library-used', { detail: result }));
    } catch (error) { if (requestRevision === revision) message(error.message, true); }
    finally { control.disabled = false; }
  }
  function card(file) {
    const row = node('article', 'as-file');
    const preview = node('div', 'as-preview');
    const type = file.type || fileType(file.name);
    const url = file.origin === 'obsidian' ? `/api/obsidian/file?p=${encodeURIComponent(file.path)}` : `/api/file?p=${encodeURIComponent(file.path)}`;
    if (type === 'image') {
      const image = node('img'); image.src = url; image.alt = file.name; image.loading = 'lazy'; preview.append(image);
    } else if (type === 'video' || type === 'audio') {
      const media = node(type); media.src = url; media.controls = true; media.preload = 'none'; preview.append(media);
    } else preview.append(node('span', '', '文档'));
    const copy = node('div', 'as-file-copy');
    copy.append(node('strong', '', file.name), node('small', '', file.displayPath || file.path));
    const action = button('用于本剧', () => use(file, action), 'as-use');
    row.append(preview, copy, action);
    return row;
  }
  function findFolder(node, target) {
    if (node.path === target) return node;
    for (const child of node.children || []) { if (child.kind === 'folder') { const found = findFolder(child, target); if (found) return found; } }
    return null;
  }
  function render() {
    if (!snapshot) return;
    list.replaceChildren(); folderBar.replaceChildren();
    tabs.querySelectorAll('button').forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.source === source)));
    sourceForm.hidden = source !== 'media';
    const needle = query.value.trim().toLowerCase();
    if (selectedFile) { list.append(card(selectedFile)); return; }
    if (source === 'obsidian') {
      if (!vault?.available || !vault.tree) { list.append(node('p', 'as-empty', '未连接 Obsidian 素材库')); return; }
      const current = findFolder(vault.tree, folder) || vault.tree;
      folderBar.append(button('‹ 上一级', () => { folder = folder.split('/').slice(0, -1).join('/'); render(); }), node('span', '', folder || vault.rootName));
      const entries = (current.children || []).filter(entry => entry.name.toLowerCase().includes(needle));
      for (const entry of entries.slice(0, 120)) {
        if (entry.kind === 'folder') list.append(button(`›  ${entry.name}`, () => { folder = entry.path; query.value = ''; render(); }, 'as-folder'));
        else if (fileType(entry.name)) list.append(card({ ...entry, type: fileType(entry.name), origin: 'obsidian' }));
      }
      if (!list.childElementCount) list.append(node('p', 'as-empty', '此目录暂无可复用素材'));
      return;
    }
    const sources = snapshot.sources.filter(item => item.id !== 'creative-assets' && (!item.projectId || item.projectId === projects.value));
    for (const item of sources) {
      const files = snapshot.files.filter(file => (file.sourceId === item.id || file.linkedSourceId === item.id) && (!file.projectId || file.projectId === projects.value)
        && `${file.name} ${file.displayPath}`.toLowerCase().includes(needle));
      if (item.builtIn && !files.length) continue;
      const group = node('details', 'as-source-group'); group.open = true;
      const heading = node('summary', '', `${item.label} · ${files.length} 项${item.available ? '' : ' · 离线'}`);
      group.append(heading);
      if (item.removable) {
        const remove = button('停止关联', async () => {
          remove.disabled = true;
          try { await api('/api/library-sources', { action: 'remove', id: item.id }); await refresh(); message('已停止关联，原文件保留'); }
          catch (error) { message(error.message, true); remove.disabled = false; }
        }, 'as-unlink'); group.append(remove);
      }
      files.slice(0, 120).forEach(file => group.append(card(file)));
      if (!files.length) group.append(node('p', 'as-empty', item.available ? '暂无素材，支持图片、音频和视频' : '目录不可用，重新连接磁盘后会自动恢复'));
      if (files.length > 120) group.append(node('p', 'as-empty', '已显示前 120 项，请搜索缩小范围'));
      list.append(group);
    }
    if (!list.childElementCount) list.append(node('p', 'as-empty', '本剧还没有外部素材，可关联文件夹或打开 Obsidian'));
  }
  async function refresh() {
    const id = ++revision;
    try {
      const data = await api('/api/scan');
      let obsidian = vault;
      if (source === 'obsidian') obsidian = await api('/api/obsidian/tree');
      if (id !== revision || !dialog.open) return;
      snapshot = data; vault = obsidian; render();
    } catch (error) { if (id === revision && dialog.open) message(error.message, true); }
  }
  async function open(options = {}) {
    ensure();
    if (dialog.open) return;
    source = options.source === 'obsidian' ? 'obsidian' : 'media'; folder = ''; selectedFile = options.file || null;
    query.value = ''; category.value = ''; message(''); dialog.showModal();
    list.replaceChildren(node('p', 'as-empty', '正在读取来源…'));
    projects.replaceChildren();
    const id = ++revision;
    try {
      const data = await api('/api/creative-projects');
      if (id !== revision || !dialog.open) return;
      for (const project of data.projects.filter(item => item.available)) { const option = node('option', '', project.name); option.value = project.id; projects.append(option); }
      projects.value = data.projects.some(item => item.id === options.projectId) ? options.projectId : data.activeProjectId;
      await refresh();
      if (!dialog.open) return;
      unsubscribe = new EventSource('/api/events');
      unsubscribe.addEventListener('rescan', () => {
        // 不因其他文件入库打断试听；暂停后或点“已关联文件夹”可以刷新。
        if (![...list.querySelectorAll('audio,video')].some(media => !media.paused) && !sourceForm.open) refresh();
      });
    } catch (error) { if (dialog.open) message(error.message, true); }
  }
  window.AssetSources = Object.freeze({ open, close: () => { if (dialog?.open) dialog.close(); } });
})();
