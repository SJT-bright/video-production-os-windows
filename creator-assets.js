'use strict';

const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 760;
const PANEL_COMPACT_WIDTH = 520;
const PANEL_EXPANDED_WIDTH = 720;
const RENDER_BATCH = 120;
const TYPE_COPY = Object.freeze({ image: '图片', audio: '音频', video: '视频', document: '文档', other: '其他' });
const TYPE_ICON = Object.freeze({
  image: UIIcons.src('image'),
  audio: UIIcons.src('audio'),
  video: UIIcons.src('video'),
  document: UIIcons.src('document'),
  other: UIIcons.src('library'),
});
const PREVIEW_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const SURFACE_MODE = new URLSearchParams(location.search).get('surface') === 'library' ? 'library' : 'panel';
document.body.dataset.surface = SURFACE_MODE;

function createBrowserAdapter() {
  let panel = { open: true, layout: 'overlay', width: Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, innerWidth)) };
  const panelListeners = [];
  return {
    browserOnly: true,
    getConfig: async () => {
      const response = await fetch('/api/creative-projects', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      const project = (data.projects || []).find(item => item.id === data.activeProjectId) || null;
      return { panel, project, rootName: project?.name || '创作资产库', creativeAssetAvailable: true };
    },
    setPanelState: async patch => {
      panel = { ...panel, ...patch };
      panelListeners.forEach(callback => callback(panel));
      return panel;
    },
    startDrag: () => false,
    copyImage: async relativePath => {
      if (!navigator.clipboard || typeof ClipboardItem !== 'function') throw new Error('当前浏览器不支持复制本地图片');
      const response = await fetch(assetUrl(relativePath));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return true;
    },
    showItem: relativePath => requestAction(`/api/show-creative-asset?project=${encodeURIComponent(activeProjectId())}&p=${encodeURIComponent(relativePath)}`),
    openLibrary: () => requestAction(`/api/open-creative-assets-folder?project=${encodeURIComponent(activeProjectId())}`),
    showProjectPicker: async () => { location.assign('/?projectPicker=1'); return true; },
    onPanelState: callback => { panelListeners.push(callback); return () => {}; },
    onDragResult: () => () => {},
  };
}

async function requestAction(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const NATIVE_API = window.assetAPI;
const API = NATIVE_API || createBrowserAdapter();
const state = {
  config: null,
  tree: null,
  folders: [],
  assets: [],
  selectedFolder: '',
  query: '',
  filter: 'all',
  sort: 'recent',
  preview: null,
  renderLimit: RENDER_BATCH,
  collapsedFolders: new Set(),
  knownFolders: new Set(),
  selectedPaths: new Set(),
  lastCheckedPath: '',
  compactWidth: PANEL_COMPACT_WIDTH,
  folderParent: '',
  audioKind: '',
  audioItems: [],
  audioBusy: false,
  importBusy: false,
};

const el = Object.fromEntries([
  'resizeHandle', 'librarySummary', 'expandPanel', 'closePanel', 'importAssets', 'normalizeNames', 'switchScript',
  'scriptSwitchDialog', 'scriptSwitchList', 'scriptSwitchClose', 'scriptSwitchCancel',
  'newSubfolder', 'openLibrary', 'assetFileInput', 'assetSearch', 'clearSearch', 'collapseFolders',
  'folderTree', 'currentPath', 'assetHeading', 'assetCount', 'assetSort', 'assetCollapse', 'assetGrid', 'assetStatus', 'capabilityNote',
  'previewDialog', 'previewName', 'previewPath', 'previewCanvas', 'previewMedia', 'closePreview',
  'zoomControls', 'zoomOut', 'zoomRange', 'zoomIn', 'zoomValue', 'captureFirstFrame', 'captureTailFrame', 'previewCopy', 'previewShow',
  'folderDialog', 'folderForm', 'folderDialogTitle', 'folderDialogParent', 'folderName',
  'cancelFolderTop', 'cancelFolder', 'assetToast',
  'renameDialog', 'renameForm', 'renameDialogFrom', 'renameInput', 'cancelRenameTop', 'cancelRename',
  'moveDialog', 'moveDialogHint', 'moveFolderList', 'cancelMoveTop', 'cancelMove',
  'selectionBar', 'selectionCount', 'selectVisible', 'batchMove', 'batchDelete', 'clearSelection',
].map(id => [id, document.getElementById(id)]));

const libraryPaneEl = document.querySelector('.library-pane');
const GRID_COLLAPSE_KEY = 'videoOS.creatorAssets.gridCollapsed.v1';
// 资产列表折叠状态按资产类型分别记忆（常用/图片/视频…），重开面板时还原。
const gridCollapsedState = (() => {
  try {
    const parsed = JSON.parse(localStorage.getItem(GRID_COLLAPSE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
})();

function applyGridCollapse() {
  const collapsed = !state.audioKind && gridCollapsedState[state.filter] === true;
  libraryPaneEl.classList.toggle('grid-collapsed', collapsed);
  el.assetCollapse.setAttribute('aria-expanded', String(!collapsed));
  el.assetCollapse.setAttribute('aria-controls', state.audioKind ? 'audioLibrary' : 'assetGrid');
  el.assetCollapse.title = state.audioKind
    ? `收起${state.audioKind === 'bgm' ? ' BGM' : '音效'}`
    : collapsed ? '展开资产列表' : '收起资产列表，把空间留给文件夹';
  el.assetCollapse.setAttribute('aria-label', el.assetCollapse.title);
  el.assetGrid.inert = collapsed;
}

function setGridCollapsed(collapsed) {
  if (collapsed) gridCollapsedState[state.filter] = true;
  else delete gridCollapsedState[state.filter];
  try { localStorage.setItem(GRID_COLLAPSE_KEY, JSON.stringify(gridCollapsedState)); } catch {}
  applyGridCollapse();
}

let toastTimer = null;
let searchTimer = null;
let resizeFrame = null;
let reloadTimer = null;
let libraryRequestId = 0;
let projectRefreshNeeded = false;

function adoptProject(project) {
  if (!project || project.id === state.config?.project?.id) return;
  libraryRequestId++;
  if (el.previewDialog.open) closePreviewNow();
  window.AssetSources?.close();
  state.config = { ...state.config, project, rootName: project.name };
  state.selectedFolder = project.folder;
  state.audioItems = [];
  state.assets = [];
  state.tree = null;
  state.knownFolders.clear();
  state.collapsedFolders.clear();
  el.folderTree.replaceChildren();
  el.assetGrid.replaceChildren();
  el.librarySummary.textContent = `${project.name} · 正在读取…`;
}

function scheduleLibraryReload(projectChanged = false) {
  projectRefreshNeeded ||= projectChanged;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      if (projectRefreshNeeded) {
        projectRefreshNeeded = false;
        const config = await API.getConfig();
        adoptProject(config.project);
      }
      await loadLibrary({ select: state.selectedFolder });
    } catch (error) { showToast(`资产刷新失败：${error.message}`); }
  }, 180);
}

function showToast(message) {
  el.assetToast.textContent = message;
  el.assetToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.assetToast.classList.remove('show'), 2400);
}

function assetUrl(relativePath) {
  return `/api/creative-assets/file?project=${encodeURIComponent(activeProjectId())}&p=${encodeURIComponent(relativePath)}`;
}

function activeProjectId() {
  return state.config?.project?.id || new URLSearchParams(location.search).get('project') || 'inspiration';
}

function folderLabel(folderPath) {
  if (!folderPath) return '创作资产库';
  return folderPath.split('/').filter(Boolean).at(-1) || '创作资产库';
}

function collectTree(root) {
  const folders = [];
  const assets = [];
  const knownPaths = new Set();
  const walk = (node, depth = 0, parentPath = '') => {
    if (!node || node.kind !== 'folder') return;
    if (!state.knownFolders.has(node.path)) {
      state.knownFolders.add(node.path);
      if (depth > 0) state.collapsedFolders.add(node.path);
    }
    folders.push({ node, depth, parentPath, hasChildren: true });
    knownPaths.add(node.path || '');
    for (const child of node.children || []) {
      if (child.kind === 'folder') walk(child, depth + 1, node.path || '');
      else if (child.kind === 'file' && TYPE_COPY[child.type]) assets.push({ ...child, folderPath: node.path || '' });
    }
  };
  walk(root);
  state.folders = folders;
  state.assets = assets;
  if (!knownPaths.has(state.selectedFolder)) state.selectedFolder = root?.path || '';
}

function selectFolder(folderPath) {
  setAudioMode('');
  state.selectedFolder = folderPath || '';
  state.query = '';
  state.renderLimit = RENDER_BATCH;
  el.assetSearch.value = '';
  el.clearSearch.hidden = true;
  // 只原地更新选中态，不重建树，保证展开动画不被打断。
  el.folderTree.querySelectorAll('.folder-button').forEach(button => {
    const active = button.dataset.folderPath === state.selectedFolder;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  el.newSubfolder.disabled = !state.selectedFolder;
  renderAssets();
}

function toggleFolderRow(row) {
  const key = row.dataset.folderPath || '';
  const collapsed = !state.collapsedFolders.has(key);
  if (collapsed) state.collapsedFolders.add(key);
  else state.collapsedFolders.delete(key);
  const wrapper = row.nextElementSibling;
  const disclosure = row.querySelector('.folder-disclosure');
  if (wrapper && wrapper.classList.contains('folder-children')) {
    wrapper.classList.toggle('collapsed', collapsed);
  }
  if (disclosure) {
    disclosure.classList.toggle('expanded', !collapsed);
    disclosure.setAttribute('aria-expanded', String(!collapsed));
    disclosure.setAttribute('aria-label', `${collapsed ? '展开' : '收起'}${row.dataset.folderName || ''}`);
  }
}

function buildFolderRow(folder) {
  const key = folder.node.path || '';
  const collapsed = state.collapsedFolders.has(key);
  const row = document.createElement('div');
  row.className = 'folder-row';
  row.dataset.folderPath = key;
  row.dataset.folderName = folder.node.name || '';
  row.setAttribute('role', 'listitem');

  const disclosure = document.createElement('button');
  disclosure.type = 'button';
  disclosure.className = `folder-disclosure${folder.hasChildren ? '' : ' empty'}${folder.hasChildren && !collapsed ? ' expanded' : ''}`;
  disclosure.tabIndex = folder.hasChildren ? 0 : -1;
  disclosure.setAttribute('aria-label', `${collapsed ? '展开' : '收起'}${folder.node.name}`);
  disclosure.setAttribute('aria-expanded', folder.hasChildren ? String(!collapsed) : 'false');
  const chevron = document.createElement('span');
  chevron.className = 'folder-chevron';
  disclosure.appendChild(chevron);
  if (folder.hasChildren) {
    disclosure.addEventListener('click', event => {
      event.stopPropagation();
      toggleFolderRow(row);
    });
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.folderPath = key;
  button.className = `folder-button${state.selectedFolder === key ? ' active' : ''}`;
  button.setAttribute('aria-pressed', String(state.selectedFolder === key));
  button.title = key || state.config?.rootPath || '创作资产库';
  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = folder.depth ? folder.node.name : '全部资产';
  button.append(name);
  button.addEventListener('click', () => {
    selectFolder(key);
    // Obsidian 习惯：选中收起中的文件夹时自动展开；收起只由箭头控制，避免误收。
    if (folder.hasChildren && state.collapsedFolders.has(key)) toggleFolderRow(row);
  });

  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = String(folder.node.fileCount || 0);
  row.append(disclosure, button, count);
  return row;
}

function appendFolderRows(parent, folders, parentPath, rendered) {
  // 根节点 path 与 parentPath 同为 ''，子级与根共用 '' 作为父路径；
  // 递归会提前渲染后续兄弟，循环体内必须实时检查 done 防止重复渲染。
  const done = rendered || new Set();
  for (const folder of folders) {
    if (folder.parentPath !== parentPath || done.has(folder)) continue;
    done.add(folder);
    parent.appendChild(buildFolderRow(folder));
    if (!folder.hasChildren) continue;
    const key = folder.node.path || '';
    const wrapper = document.createElement('div');
    wrapper.className = 'folder-children' + (state.collapsedFolders.has(key) ? ' collapsed' : '');
    const inner = document.createElement('div');
    inner.className = 'folder-children-inner';
    wrapper.appendChild(inner);
    appendFolderRows(inner, folders, key, done);
    const files = state.assets.filter(item => item.folderPath === key);
    const addFiles = () => {
      const start = inner.querySelectorAll(':scope > .folder-file').length;
      files.slice(start, start + 60).forEach(item => inner.appendChild(buildFolderFile(item)));
      if (start + 60 < files.length) {
        const more = document.createElement('button');
        more.className = 'text-button';
        more.textContent = '显示更多文件';
        more.addEventListener('click', () => { more.remove(); addFiles(); });
        inner.appendChild(more);
      }
    };
    addFiles();
    if (!inner.childElementCount) {
      const empty = document.createElement('span');
      empty.className = 'folder-empty';
      empty.textContent = '暂无资产';
      inner.appendChild(empty);
    }
    parent.appendChild(wrapper);
  }
}

function buildFolderFile(item) {
  const file = document.createElement('button');
  file.type = 'button';
  file.className = 'folder-file';
  file.title = item.name;
  file.draggable = true;
  let icon;
  if (item.type === 'video') {
    icon = videoCoverNode(item, 'folder-video-cover', 'tree');
  } else {
    icon = document.createElement('img');
    icon.src = item.type === 'image' ? assetUrl(item.path) : TYPE_ICON[item.type];
    icon.alt = '';
    icon.loading = 'lazy';
    icon.draggable = false;
  }
  const name = document.createElement('span');
  name.textContent = item.name;
  file.append(icon, name);
  file.addEventListener('click', () => openPreview(item));
  file.addEventListener('dragstart', event => {
    if (NATIVE_API) { event.preventDefault(); API.startDrag(item.path); }
    else if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/uri-list', new URL(assetUrl(item.path), location.href).href);
      event.dataTransfer.setData('text/plain', item.name);
    }
  });
  return file;
}

function renderFolders() {
  const scrollTop = el.folderTree.scrollTop;
  resetCoverObserver('tree');  // 树重建：只解除树内封面登记，不影响网格
  el.folderTree.replaceChildren();
  const fragment = document.createDocumentFragment();
  appendFolderRows(fragment, state.folders, '');
  el.folderTree.appendChild(fragment);
  el.folderTree.scrollTop = scrollTop;
  el.newSubfolder.disabled = !state.selectedFolder;
}

function visibleAssets() {
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  const filtered = state.assets.filter(item => {
    if (state.filter !== 'all' && item.type !== state.filter) return false;
    if (query) return `${item.name}\n${item.path}`.toLocaleLowerCase('zh-CN').includes(query);
    if (!state.selectedFolder) return true;
    return item.folderPath === state.selectedFolder || item.folderPath.startsWith(`${state.selectedFolder}/`);
  });
  return filtered.sort((a, b) => {
    if (state.sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (state.sort === 'folder') return a.folderPath.localeCompare(b.folderPath, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN');
    return String(b.mtime || '').localeCompare(String(a.mtime || '')) || a.name.localeCompare(b.name, 'zh-CN');
  });
}

function createMediaIcon(type) {
  const glyph = document.createElement('span');
  glyph.className = 'media-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  const image = document.createElement('img');
  image.src = TYPE_ICON[type] || TYPE_ICON.other;
  image.alt = '';
  image.draggable = false;
  glyph.appendChild(image);
  return glyph;
}

// 视频封面懒加载：元素进入预加载区（视口外扩 200px，属预载缓冲而非严格可见边界）才挂 src，
// 减少网格卡片批量打开时的集中请求。登记集按容器作用域拆分（grid=资产网格，tree=文件夹树）：
// 网格重建（筛选/搜索）与树重建各自只清理自己的登记，避免一侧重建把另一侧已登记、
// 尚未进入预加载区的封面解除观察（否则树内缩略图在筛选切换后永远不再懒挂）。
const coverObserver = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const video = entry.target;
    coverObserver.unobserve(video);
    for (const set of Object.values(trackedCovers)) set.delete(video);
    const coverSrc = video.dataset.coverSrc;
    if (coverSrc) {
      delete video.dataset.coverSrc;
      video.src = coverSrc;
    }
  }
}, { rootMargin: '200px' }) : null;
const trackedCovers = { grid: new Set(), tree: new Set() };

function resetCoverObserver(scope) {
  if (!coverObserver) return;
  const set = trackedCovers[scope];
  if (!set) return;
  for (const video of set) coverObserver.unobserve(video);
  set.clear();
}
// 只读观测口（测试/诊断用）：登记集大小与懒加载可用性，验证重建后登记被显式释放与重建。
window.__coverObserverDebug = () => ({ tracked: trackedCovers.grid.size + trackedCovers.tree.size, grid: trackedCovers.grid.size, tree: trackedCovers.tree.size, supported: !!coverObserver });

function registerCoverLazy(video, coverUrl, scope = 'grid') {
  if (!coverObserver) { video.src = coverUrl; return; }  // 无 IntersectionObserver 环境降级为急加载
  video.dataset.coverSrc = coverUrl;
  coverObserver.observe(video);
  (trackedCovers[scope] || trackedCovers.grid).add(video);
}

function videoCoverNode(item, className, scope = 'grid') {
  // 视频封面：#t=0.1 让浏览器 seek 到开头附近的帧作为封面画面（约等于首帧，非严格第 0 帧）。
  // preload=metadata 只是加载提示，seek 时浏览器会按需下载视频开头的一段数据，实际用量随容器/编码而异。
  const video = document.createElement('video');
  video.className = className;
  registerCoverLazy(video, `${assetUrl(item.path)}#t=0.1`, scope);
  video.preload = 'metadata';
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.tabIndex = -1;
  video.setAttribute('aria-hidden', 'true');
  video.draggable = false;
  video.addEventListener('error', () => {
    // 封面解码失败（如损坏文件）：保留黑底占位并标记，不再退回 3D 图标。
    video.classList.add('cover-failed');
  }, { once: true });
  return video;
}

function mediaPreviewNode(item) {
  if (item.type === 'image') {
    const image = document.createElement('img');
    image.src = assetUrl(item.path);
    image.alt = item.name;
    image.loading = 'lazy';
    image.draggable = false;
    return image;
  }
  if (item.type === 'video') {
    const cover = videoCoverNode(item, 'video-cover', 'grid');
    const wrap = document.createElement('span');
    wrap.className = `media-placeholder video video-cover-wrap`;
    wrap.appendChild(cover);
    const badge = document.createElement('span');
    badge.className = 'play-badge';
    badge.setAttribute('aria-hidden', 'true');
    wrap.appendChild(badge);
    return wrap;
  }
  const placeholder = document.createElement('span');
  placeholder.className = `media-placeholder ${item.type}`;
  placeholder.appendChild(createMediaIcon(item.type));
  return placeholder;
}

async function copyImage(item) {
  try {
    await API.copyImage(item.path);
    showToast(`已复制：${item.name}`);
  } catch (error) {
    showToast(`复制失败：${error.message}`);
  }
}

async function showItem(item) {
  try {
    await API.showItem(item.path);
    showToast('已在 Finder 中定位资产');
  } catch (error) {
    showToast(`无法定位资产：${error.message}`);
  }
}

async function deleteItem(item) {
  if (typeof API.deleteItem !== 'function') {
    showToast('删除需要最新版桌面软件');
    return;
  }
  if (!confirm(`删除「${item.name}」？文件会移到废纸篓，可随时恢复。`)) return;
  try {
    await API.deleteItem(item.path);
    if (state.preview && state.preview.path === item.path) closePreviewNow();
    showToast(`已移到废纸篓：${item.name}`);
    await loadLibrary({ select: state.selectedFolder });
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  }
}

async function postAssetAction(action, body) {
  const response = await fetch(`/api/creative-assets/${action}?project=${encodeURIComponent(activeProjectId())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

let renameTarget = null;

function openRenameDialog(item) {
  renameTarget = item;
  el.renameDialogFrom.textContent = `位置：${item.folderPath || '创作资产库'}`;
  el.renameInput.value = item.name.replace(/\.[^.]+$/, '');
  el.renameDialog.showModal();
  requestAnimationFrame(() => { el.renameInput.focus(); el.renameInput.select(); });
}

async function submitRename() {
  const item = renameTarget;
  const name = el.renameInput.value.trim();
  if (!item || !name) { el.renameInput.focus(); return; }
  try {
    const result = await postAssetAction('rename', { path: item.path, name });
    el.renameDialog.close();
    showToast(`已重命名为「${result.name}」`);
    await loadLibrary({ select: state.selectedFolder });
  } catch (error) {
    showToast(`重命名失败：${error.message}`);
  }
}

let moveTargets = null; // null = 单个资产；数组 = 批量移动

function openMoveDialog(paths) {
  moveTargets = paths;
  const label = paths.length > 1 ? `${paths.length} 项资产` : paths[0].split('/').at(-1);
  el.moveDialogHint.textContent = `将「${label}」移动到：`;
  el.moveFolderList.replaceChildren();
  const currentFolders = new Set(paths.map(path => path.split('/').slice(0, -1).join('/')));
  for (const folder of state.folders) {
    if (currentFolders.has(folder.node.path || '')) continue;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'move-folder-row';
    row.dataset.folderPath = folder.node.path || '';
    const name = document.createElement('span');
    name.className = 'move-folder-name';
    name.textContent = folder.depth ? folder.node.name : '全部资产';
    row.appendChild(name);
    row.addEventListener('click', () => submitMove(folder.node.path || ''));
    el.moveFolderList.appendChild(row);
  }
  if (!el.moveFolderList.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'move-folder-empty';
    empty.textContent = '没有可移动到的其他文件夹。';
    el.moveFolderList.appendChild(empty);
  }
  el.moveDialog.showModal();
}

async function submitMove(folderPath) {
  const paths = [...moveTargets];
  if (!paths.length) { el.moveDialog.close(); return; }
  el.moveDialog.close();
  let moved = 0;
  const failed = [];
  for (const path of paths) {
    try {
      await postAssetAction('move', { path, folder: folderPath });
      moved += 1;
    } catch (error) {
      failed.push(`${path.split('/').at(-1)}：${error.message}`);
    }
  }
  state.selectedPaths.clear();
  updateSelectionBar();
  await loadLibrary({ select: folderPath });
  showToast(failed.length
    ? `已移动 ${moved} 项；${failed[0]}`
    : `已移动 ${moved} 项到「${folderLabel(folderPath)}」`);
}

/* ---------- 多选批量操作 ---------- */

function updateSelectionBar() {
  const count = state.selectedPaths.size;
  el.selectionBar.hidden = count === 0;
  el.selectionCount.textContent = `已选 ${count} 项`;
  el.batchDelete.disabled = false;
  el.batchMove.disabled = false;
  document.querySelectorAll('.asset-card').forEach(card => {
    card.classList.toggle('selected', state.selectedPaths.has(card.dataset.path));
  });
  document.querySelectorAll('.asset-check').forEach(button => {
    button.classList.toggle('checked', state.selectedPaths.has(button.dataset.checkPath));
  });
}

function toggleSelection(path) {
  if (state.selectedPaths.has(path)) state.selectedPaths.delete(path);
  else state.selectedPaths.add(path);
  state.lastCheckedPath = path;
  updateSelectionBar();
}

function clearSelection() {
  state.selectedPaths.clear();
  updateSelectionBar();
}

async function normalizeNames() {
  if (!state.selectedFolder) {
    showToast('请先在左侧选择一个分类文件夹');
    return;
  }
  if (!confirm('扫描当前分类里的平台乱名文件（UUID 命名），按“生成图片-001”顺序重命名？相关素材索引会一并更新。')) return;
  el.normalizeNames.disabled = true;
  try {
    const response = await fetch(`/api/creative-assets/normalize?project=${encodeURIComponent(activeProjectId())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: state.selectedFolder }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    await loadLibrary({ select: state.selectedFolder });
    showToast(data.renamed?.length
      ? `已整理 ${data.renamed.length} 个文件名（如 ${data.renamed[0].to}）`
      : '当前分类没有需要整理的乱名文件');
  } catch (error) {
    showToast(`整理失败：${error.message}`);
  } finally {
    el.normalizeNames.disabled = false;
  }
}

async function batchDeleteSelected() {
  const paths = [...state.selectedPaths];
  if (!paths.length) return;
  if (!confirm(`删除选中的 ${paths.length} 项？文件会移到废纸篓，可随时恢复。`)) return;
  let deleted = 0;
  const failed = [];
  for (const path of paths) {
    try {
      await API.deleteItem(path);
      deleted += 1;
    } catch (error) {
      failed.push(`${path.split('/').at(-1)}：${error.message}`);
    }
  }
  state.selectedPaths.clear();
  updateSelectionBar();
  if (state.preview && state.selectedPaths && paths.includes(state.preview.path)) closePreviewNow();
  await loadLibrary({ select: state.selectedFolder });
  showToast(failed.length
    ? `已删除 ${deleted} 项；${failed[0]}`
    : `已把 ${deleted} 项移到废纸篓`);
}

function setZoom(value) {
  const zoom = Math.max(50, Math.min(220, Number(value) || 100));
  el.zoomRange.value = String(zoom);
  el.zoomValue.textContent = `${zoom}%`;
  const image = el.previewMedia.querySelector('img');
  if (image) image.style.transform = `scale(${zoom / 100})`;
}

function clearPreview() {
  const media = el.previewMedia.querySelector('audio, video');
  if (media) {
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
  const image = el.previewMedia.querySelector('img');
  if (image) image.src = PREVIEW_PLACEHOLDER;
  el.previewMedia.replaceChildren();
  el.previewDialog.classList.remove('video-review');
  state.preview = null;
}

function closePreviewNow() {
  clearPreview();
  el.previewDialog.close();
}

function openPreview(item) {
  clearPreview();
  state.preview = item;
  // 视频走“展开审核”形态：对话框放大、循环播放便于反复审看。
  el.previewDialog.classList.toggle('video-review', item.type === 'video');
  el.previewName.textContent = item.name;
  el.previewPath.textContent = `${item.folderPath || '创作资产库'} · ${item.sizeText || ''}`;
  el.previewCopy.hidden = item.type !== 'image';
  el.captureFirstFrame.hidden = item.type !== 'video';
  el.captureTailFrame.hidden = item.type !== 'video';
  el.zoomControls.hidden = item.type !== 'image';
  setZoom(100);

  if (item.type === 'image') {
    const image = document.createElement('img');
    image.src = assetUrl(item.path);
    image.alt = `${item.name} 预览`;
    el.previewMedia.appendChild(image);
  } else if (item.type === 'audio' || item.type === 'video') {
    const media = document.createElement(item.type);
    media.controls = true;
    media.preload = 'metadata';
    if (item.type === 'video') media.loop = true; // 审核场景：循环播放便于反复看动作与节奏
    media.src = assetUrl(item.path);
    media.setAttribute('aria-label', `${item.name} ${TYPE_COPY[item.type]}预览`);
    el.previewMedia.appendChild(media);
  } else if (item.type === 'document') {
    const documentPreview = document.createElement('div');
    documentPreview.className = 'document-preview';
    const glyph = createMediaIcon('document');
    const copy = document.createElement('span');
    copy.textContent = '文档资产会保留原文件；可直接打开预览或在 Finder 中定位。';
    const link = document.createElement('a');
    link.href = assetUrl(item.path);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '打开文档';
    documentPreview.append(glyph, copy, link);
    el.previewMedia.appendChild(documentPreview);
  } else {
    const otherPreview = document.createElement('div');
    otherPreview.className = 'document-preview';
    const glyph = createMediaIcon('other');
    const copy = document.createElement('span');
    copy.textContent = '该文件会保留在资产层级中，但当前不支持在工作台内预览。';
    otherPreview.append(glyph, copy);
    el.previewMedia.appendChild(otherPreview);
  }
  el.previewDialog.showModal();
}

function waitForMedia(media, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      media.removeEventListener(eventName, complete);
      media.removeEventListener('error', fail);
    };
    const complete = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('视频无法读取')); };
    media.addEventListener(eventName, complete, { once: true });
    media.addEventListener('error', fail, { once: true });
  });
}

async function captureVideoFrame(kind) {
  const item = state.preview;
  const video = el.previewMedia.querySelector('video');
  if (!item || item.type !== 'video' || !video) throw new Error('请先打开一个视频');
  const action = kind === 'tail' ? el.captureTailFrame : el.captureFirstFrame;
  action.disabled = true;
  try {
    if (video.readyState < 1) await waitForMedia(video, 'loadedmetadata');
    if (video.readyState < 2) await waitForMedia(video, 'loadeddata');
    if (!video.videoWidth || !video.videoHeight) throw new Error('视频画面尚未准备好');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = kind === 'tail' ? Math.max(0, duration - Math.min(.08, duration / 2)) : 0;
    if (Math.abs(video.currentTime - target) > .002) {
      const seeked = waitForMedia(video, 'seeked');
      video.currentTime = target;
      await seeked;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('当前设备无法截取视频画面');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('视频画面编码失败');
    const frameCategory = state.config?.project?.categories?.find(category => category.id === 'frames');
    const childLabel = kind === 'tail' ? '尾帧' : '首帧';
    const folder = frameCategory?.children?.find(child => child.label === childLabel)?.path
      || (frameCategory?.path ? `${frameCategory.path}/${childLabel}` : '');
    if (!folder) throw new Error('当前剧本的首尾帧目录不可用');
    const base = item.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || '视频';
    const name = `${base}-${childLabel}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    const url = `/api/creative-assets/import?project=${encodeURIComponent(activeProjectId())}&folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}&frame=${encodeURIComponent(kind)}&source=${encodeURIComponent(item.path)}`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    await loadLibrary({ select: folder });
    showToast(`${childLabel}已保存到「${state.config.project.name}」`);
  } finally {
    action.disabled = false;
  }
}

function createAssetCard(item) {
  const card = document.createElement('article');
  card.className = `asset-card${item.type === 'image' ? ' image-card' : ''}`;
  card.dataset.kind = item.type;
  card.dataset.path = item.path;
  card.draggable = true;
  card.title = NATIVE_API ? '拖到右侧创作平台上传；点击可预览' : '点击预览资产';

  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'asset-preview-button';
  preview.appendChild(mediaPreviewNode(item));
  const badge = document.createElement('span');
  badge.className = 'asset-type-badge';
  badge.textContent = TYPE_COPY[item.type];
  preview.appendChild(badge);
  preview.addEventListener('click', event => {
    // Cmd/Ctrl+点击 = 选中/取消选中，配合批量操作。
    if (event.metaKey || event.ctrlKey) {
      toggleSelection(item.path);
      return;
    }
    openPreview(item);
  });

  const info = document.createElement('div');
  info.className = 'asset-card-copy';
  const name = document.createElement('strong');
  name.textContent = item.name;
  const meta = document.createElement('span');
  meta.textContent = `${item.sizeText || '未知大小'} · ${item.folderPath || '创作资产库'}`;
  info.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'asset-card-actions';
  const firstAction = document.createElement('button');
  firstAction.type = 'button';
  firstAction.textContent = item.type === 'image' ? '复制' : '预览';
  firstAction.addEventListener('click', () => item.type === 'image' ? copyImage(item) : openPreview(item));
  const showButton = document.createElement('button');
  showButton.type = 'button';
  showButton.textContent = '定位';
  showButton.addEventListener('click', () => showItem(item));
  const renameButton = document.createElement('button');
  renameButton.type = 'button';
  renameButton.textContent = '改名';
  renameButton.addEventListener('click', () => openRenameDialog(item));
  const moveButton = document.createElement('button');
  moveButton.type = 'button';
  moveButton.textContent = '移动';
  moveButton.addEventListener('click', () => openMoveDialog([item.path]));
  actions.append(firstAction, showButton, renameButton, moveButton);

  // 多选圆点（左上角）+ 右上角删除标志：悬停浮现。
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'asset-check' + (state.selectedPaths.has(item.path) ? ' checked' : '');
  check.dataset.checkPath = item.path;
  check.textContent = '✓';
  check.title = '选中（可配合批量删除 / 批量移动）';
  check.setAttribute('aria-label', `选中 ${item.name}`);
  check.setAttribute('aria-pressed', String(state.selectedPaths.has(item.path)));
  check.addEventListener('click', event => {
    event.stopPropagation();
    toggleSelection(item.path);
  });

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'asset-delete-button';
  deleteButton.textContent = '✕';
  deleteButton.title = '删除（移到废纸篓）';
  deleteButton.setAttribute('aria-label', `删除 ${item.name}`);
  deleteButton.addEventListener('click', event => {
    event.stopPropagation();
    deleteItem(item);
  });

  card.addEventListener('dragstart', event => {
    card.classList.add('dragging');
    el.assetStatus.textContent = `正在拖拽：${item.name}`;
    if (NATIVE_API) {
      event.preventDefault();
      API.startDrag(item.path);
    } else if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/uri-list', new URL(assetUrl(item.path), location.href).href);
      event.dataTransfer.setData('text/plain', item.name);
    }
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.append(preview, check, info, actions, deleteButton);
  if (state.selectedPaths.has(item.path)) card.classList.add('selected');
  return card;
}

function renderAssets({ preserveScroll = false } = {}) {
  if (state.audioKind) { renderAudioLibrary(); return; }
  resetCoverObserver('grid');  // 网格重建：只解除网格封面登记，不影响树
  const previousScrollTop = el.assetGrid.scrollTop;
  const allItems = visibleAssets();
  const items = allItems.slice(0, state.renderLimit);
  el.assetGrid.replaceChildren();
  el.assetCount.textContent = `${allItems.length} 项`;
  el.currentPath.textContent = state.query ? `搜索“${state.query}”` : folderLabel(state.selectedFolder);
  el.assetHeading.textContent = state.filter === 'all' ? '常用资产' : `${TYPE_COPY[state.filter]}资产`;
  applyGridCollapse();

  if (!allItems.length) {
    const empty = document.createElement('div');
    empty.className = 'asset-state';
    empty.innerHTML = state.query
      ? '没有找到匹配资产。<br>可以换一个文件名或文件夹关键词。'
      : state.selectedFolder
        ? '这个文件夹还是空的。<br>点击“导入资产”，把常用图片、音频或视频放进来。'
        : '还没有预存资产。<br>选择左侧分类后导入图片、音频和视频。';
    el.assetGrid.appendChild(empty);
    el.assetGrid.scrollTop = 0;
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach(item => fragment.appendChild(createAssetCard(item)));
  el.assetGrid.appendChild(fragment);
  if (items.length < allItems.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'load-more';
    more.textContent = `再显示 ${Math.min(RENDER_BATCH, allItems.length - items.length)} 项`;
    more.addEventListener('click', () => {
      state.renderLimit += RENDER_BATCH;
      renderAssets({ preserveScroll: true });
    });
    el.assetGrid.appendChild(more);
  }
  el.assetGrid.scrollTop = preserveScroll ? previousScrollTop : 0;
}

function applyPanelState(panel) {
  if (!panel) return;
  if (SURFACE_MODE === 'library') {
    document.body.dataset.layout = 'push';
    document.body.classList.add('panel-expanded');
    return;
  }
  const layout = panel.layout === 'push' ? 'push' : 'overlay';
  const width = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.round(Number(panel.width) || innerWidth || PANEL_COMPACT_WIDTH)));
  document.body.dataset.layout = layout;
  document.body.classList.toggle('panel-expanded', width >= 620);
  document.querySelectorAll('.layout-switch button[data-layout]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
  });
  el.resizeHandle.setAttribute('aria-valuenow', String(width));
  const expanded = width >= 620;
  el.expandPanel.setAttribute('aria-pressed', String(expanded));
  el.expandPanel.setAttribute('aria-label', expanded ? '还原资产库宽度' : '展开资产库');
  el.expandPanel.title = expanded ? '还原资产库宽度' : '展开资产库';
  if (!expanded) state.compactWidth = width;
}

async function setPanelState(patch) {
  const panel = await API.setPanelState(patch);
  applyPanelState(panel);
  return panel;
}

function bindResize() {
  if (SURFACE_MODE === 'library') return;
  let resizing = null;
  const updateWidth = width => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      setPanelState({ width }).catch(error => showToast(error.message));
    });
  };
  el.resizeHandle.addEventListener('pointerdown', event => {
    resizing = { screenX: event.screenX, width: innerWidth };
    el.resizeHandle.classList.add('resizing');
    el.resizeHandle.setPointerCapture(event.pointerId);
  });
  el.resizeHandle.addEventListener('pointermove', event => {
    if (resizing) updateWidth(resizing.width + resizing.screenX - event.screenX);
  });
  const finish = event => {
    if (!resizing) return;
    resizing = null;
    el.resizeHandle.classList.remove('resizing');
    if (el.resizeHandle.hasPointerCapture(event.pointerId)) el.resizeHandle.releasePointerCapture(event.pointerId);
  };
  el.resizeHandle.addEventListener('pointerup', finish);
  el.resizeHandle.addEventListener('pointercancel', finish);
  el.resizeHandle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') updateWidth(PANEL_MIN_WIDTH);
    else if (event.key === 'End') updateWidth(PANEL_MAX_WIDTH);
    else {
      const step = event.shiftKey ? 48 : 16;
      updateWidth(innerWidth + (event.key === 'ArrowLeft' ? step : -step));
    }
  });
  el.resizeHandle.addEventListener('dblclick', () => updateWidth(PANEL_COMPACT_WIDTH));
}

function openFolderDialog({ parent = '' } = {}) {
  if (!parent) {
    showToast('请先选择一个资产文件夹');
    return;
  }
  state.folderParent = parent;
  el.folderDialogTitle.textContent = '新建子文件夹';
  el.folderDialogParent.textContent = `位置：${folderLabel(parent)}`;
  el.folderName.value = '';
  el.folderDialog.showModal();
  requestAnimationFrame(() => el.folderName.focus());
}

async function createFolder() {
  const name = el.folderName.value.trim();
  if (!name) { el.folderName.focus(); return; }
  const response = await fetch(`/api/creative-assets/folder?project=${encodeURIComponent(activeProjectId())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: activeProjectId(), parent: state.folderParent, name }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  el.folderDialog.close();
  await loadLibrary({ select: data.folder?.path || state.folderParent });
  showToast(`已创建：${data.folder?.path || name}`);
}

function setAudioMode(kind) {
  if (state.audioKind && state.audioKind !== kind) {
    document.querySelectorAll('#audioLibrary audio').forEach(audio => audio.pause());
  }
  state.audioKind = kind;
  applyGridCollapse();
  document.body.dataset.audioMode = String(!!kind);
  document.getElementById('audioLibrary').hidden = !kind;
  document.querySelectorAll('[data-audio-kind]').forEach(button => {
    const expanded = button.dataset.audioKind === kind;
    button.setAttribute('aria-pressed', String(expanded));
    button.setAttribute('aria-expanded', String(expanded));
    button.title = `${expanded ? '收起' : '展开'}${button.dataset.audioKind === 'bgm' ? ' BGM' : '音效'}`;
  });
  if (kind) {
    state.selectedPaths.clear();
    el.selectionBar.hidden = true;
    el.assetSearch.value = state.query = '';
    el.clearSearch.hidden = true;
    document.querySelectorAll('.folder-button.active').forEach(button => {
      button.classList.remove('active');
      button.setAttribute('aria-pressed', 'false');
    });
    renderAudioLibrary();
    loadAudioLibrary().catch(error => showToast(error.message));
  }
}

async function audioRequest(suffix = '', options = {}, project = activeProjectId()) {
  const response = await fetch(`/api/audio-library${suffix}${suffix.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}`, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `音乐音效库读取失败（${response.status}）`);
  return data;
}

async function loadAudioLibrary() {
  const project = activeProjectId();
  const data = await audioRequest('', {}, project);
  if (project !== activeProjectId()) return;
  state.audioItems = data.items || [];
  if (!state.audioBusy && !document.querySelector('.audio-entry input:focus')) renderAudioLibrary();
}

async function saveAudioEntry(body) {
  await audioRequest('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await loadAudioLibrary();
}

function audioButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quiet-button';
  button.textContent = label;
  button.addEventListener('click', () => Promise.resolve().then(action).catch(error => showToast(error.message)));
  return button;
}

function bindAudioDrop(target, entryId = '') {
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    target.addEventListener(type, event => {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      if (type === 'dragenter' || type === 'dragover') {
        event.dataTransfer.dropEffect = 'copy';
        target.classList.add('is-audio-drop');
      } else if (type === 'drop') {
        target.classList.remove('is-audio-drop');
        importAudioFiles(event.dataTransfer.files, entryId);
      } else if (!target.contains(event.relatedTarget)) target.classList.remove('is-audio-drop');
    });
  }
}

function pickAudioFile(entryId = '') {
  const input = document.getElementById('audioFileInput');
  input.dataset.entry = entryId;
  input.multiple = !entryId;
  input.value = '';
  input.click();
}

async function importAudioFiles(files, entryId = '') {
  if (state.audioBusy) { showToast('正在导入，请稍候'); return; }
  const list = Array.from(files || []);
  if (!list.length) return;
  if (entryId && list.length !== 1) { showToast('一个名称对应一个音频，请拖入一个文件'); return; }
  const kind = state.audioKind;
  if (!kind) return;
  const project = activeProjectId();
  state.audioBusy = true;
  let imported = 0;
  const errors = [];
  try {
    for (const file of list) {
      try {
        if (!/\.(mp3|wav|m4a|aac|flac|ogg|aiff|aif|opus|wma)$/i.test(file.name)) throw new Error('请选择音频文件');
        el.assetStatus.textContent = `正在导入：${file.name}`;
        const query = new URLSearchParams({ kind, entry: entryId, name: file.name });
        await audioRequest(`/upload?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }, project);
        imported++;
      } catch (error) { errors.push(`${file.name}：${error.message}`); }
    }
  } finally { state.audioBusy = false; }
  await loadLibrary({ select: state.selectedFolder }).catch(error => errors.push(error.message));
  const message = errors.length ? `已导入 ${imported} 项；${errors[0]}` : entryId ? '音频已绑定到名称' : `已导入 ${imported} 项音频`;
  el.assetStatus.textContent = message;
  showToast(message);
}

function renderAudioLibrary() {
  if (!state.audioKind) return;
  if (document.querySelector('.audio-entry input:focus')) return;
  el.currentPath.textContent = state.config?.project?.name || '本剧资产';
  el.assetHeading.textContent = state.audioKind === 'bgm' ? 'BGM · 背景音乐' : '常用音效';
  const items = state.audioItems.filter(item => item.kind === state.audioKind && `${item.name} ${item.filename || ''}`.toLowerCase().includes(state.query.toLowerCase()));
  el.assetCount.textContent = `${items.length} 项`;
  const container = document.getElementById('audioEntries');
  const playing = [...container.querySelectorAll('audio')].filter(audio => !audio.paused);
  container.replaceChildren();
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'audio-entry';
    card.dataset.entry = item.id;
    bindAudioDrop(card, item.id);
    const form = document.createElement('form');
    const name = document.createElement('input');
    name.value = item.name;
    name.maxLength = 120;
    name.required = true;
    name.setAttribute('aria-label', '编辑名称');
    const save = document.createElement('button');
    save.className = 'quiet-button';
    save.type = 'submit';
    save.textContent = '保存';
    form.append(name, save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        await saveAudioEntry({ action: 'rename', id: item.id, name: name.value });
        name.blur();
        renderAudioLibrary();
        showToast('名称已保存');
      } catch (error) { showToast(error.message); }
      finally { save.disabled = false; }
    });
    const label = document.createElement('span');
    label.className = 'audio-file-label';
    label.textContent = item.available ? item.filename : item.path ? '文件已移走，可重新拖入绑定' : '将音频拖到这里，与名称绑定';
    label.title = label.textContent;
    card.append(form, label);
    if (item.available) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = assetUrl(item.path);
      audio.addEventListener('play', () => container.querySelectorAll('audio').forEach(other => { if (other !== audio) other.pause(); }));
      card.append(audio);
    }
    const actions = document.createElement('div');
    actions.className = 'audio-entry-actions';
    actions.append(audioButton(item.available ? '更换音频' : '添加音频', () => pickAudioFile(item.id)));
    if (item.available) {
      const drag = audioButton('拖出音频', () => showToast('按住此按钮，拖到创作平台'));
      drag.draggable = true;
      drag.addEventListener('dragstart', event => {
        if (NATIVE_API) { event.preventDefault(); API.startDrag(item.path); }
        else {
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData('text/uri-list', new URL(assetUrl(item.path), location.href).href);
          event.dataTransfer.setData('text/plain', item.name);
        }
      });
      actions.append(drag);
    }
    const remove = audioButton('移除条目', async () => {
      await saveAudioEntry({ action: 'remove', id: item.id });
      showToast('条目已移除，原音频文件保留在资产文件夹');
    });
    remove.title = '仅移除条目，保留音频文件';
    actions.append(remove);
    card.append(actions);
    container.append(card);
  }
  for (const audio of playing) {
    const replacement = [...container.querySelectorAll('audio')].find(item => item.src === audio.src);
    if (replacement) { replacement.replaceWith(audio); if (audio.paused) audio.play().catch(() => {}); }
    else audio.pause();
  }
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'audio-file-label';
    empty.textContent = state.query ? '没有匹配的音频' : '先写名称，或直接拖入音频';
    container.append(empty);
  }
}

function bindAudioLibrary() {
  document.querySelectorAll('[data-audio-kind]').forEach(button => button.addEventListener('click', () => {
    if (state.audioKind === button.dataset.audioKind) selectFolder(state.selectedFolder);
    else setAudioMode(button.dataset.audioKind);
  }));
  const dropzone = document.getElementById('audioDropzone');
  bindAudioDrop(dropzone);
  dropzone.addEventListener('click', () => pickAudioFile());
  document.getElementById('audioFileInput').addEventListener('change', event => importAudioFiles(event.target.files, event.target.dataset.entry));
  document.getElementById('audioNameForm').addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.getElementById('audioNameInput');
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      await saveAudioEntry({ action: 'create', kind: state.audioKind, name: input.value });
      input.value = '';
      showToast('名称已保存，可以把音频拖到该条目');
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  });
}

// 面板内切换剧本：列出全部剧本，点击即激活（服务器广播，面板与创作浏览器原地跟随）。
async function openScriptSwitch() {
  if (state.importBusy || state.audioBusy) { showToast('请等待当前素材导入完成后切换剧本'); return; }
  el.scriptSwitchList.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'script-switch-empty';
  loading.textContent = '正在读取剧本…';
  el.scriptSwitchList.appendChild(loading);
  el.scriptSwitchDialog.showModal();
  let projects = [];
  try {
    const response = await fetch('/api/creative-projects', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    projects = Array.isArray(data.projects) ? data.projects : [];
  } catch (error) {
    el.scriptSwitchList.replaceChildren();
    const errorRow = document.createElement('p');
    errorRow.className = 'script-switch-empty';
    errorRow.textContent = `剧本读取失败：${error.message}`;
    el.scriptSwitchList.appendChild(errorRow);
    return;
  }
  el.scriptSwitchList.replaceChildren();
  const activeId = activeProjectId();
  if (!projects.length) {
    const empty = document.createElement('p');
    empty.className = 'script-switch-empty';
    empty.textContent = '还没有剧本。';
    el.scriptSwitchList.appendChild(empty);
    return;
  }
  for (const project of projects) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'script-switch-row' + (project.id === activeId ? ' active' : '');
    row.dataset.projectId = project.id;
    const name = document.createElement('span');
    name.className = 'script-switch-name';
    name.textContent = project.kind === 'inspiration' ? `${project.name}（灵感工作区）` : project.name;
    const meta = document.createElement('span');
    meta.className = 'script-switch-meta';
    meta.textContent = `${Number(project.assetCount) || 0} 项资产`;
    row.append(name, meta);
    row.addEventListener('click', async () => {
      if (project.id === activeId) { el.scriptSwitchDialog.close(); return; }
      try {
        const response = await fetch(`/api/creative-projects?project=${encodeURIComponent(activeProjectId())}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'activate', id: project.id }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        adoptProject(data.project);
        el.scriptSwitchDialog.close();
        showToast(`已切换到「${project.name}」`);
        await loadLibrary();
      } catch (error) {
        showToast(`切换失败：${error.message}`);
      }
    });
    el.scriptSwitchList.appendChild(row);
  }
}

async function importFiles(files) {  if (state.audioKind) return importAudioFiles(files);
  if (state.importBusy) { showToast('正在导入，请稍候'); return; }
  const list = Array.from(files || []);
  if (!list.length) return;
  if (!state.selectedFolder) {
    showToast('请先选择或新建一个剧本文件夹');
    return;
  }
  if (libraryPaneEl.classList.contains('grid-collapsed')) setGridCollapsed(false);
  const projectId = activeProjectId();
  const folder = state.selectedFolder;
  state.importBusy = true;
  el.importAssets.disabled = true;
  let imported = 0;
  const failed = [];
  for (const file of list) {
    el.assetStatus.textContent = `正在导入 ${imported + failed.length + 1}/${list.length}：${file.name}`;
    try {
      if (activeProjectId() !== projectId) throw new Error('剧本已切换，该文件未导入');
      const url = `/api/creative-assets/import?project=${encodeURIComponent(projectId)}&folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`;
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      imported++;
    } catch (error) {
      failed.push(`${file.name}：${error.message}`);
    }
  }
  el.importAssets.disabled = false;
  state.importBusy = false;
  el.assetFileInput.value = '';
  await loadLibrary({ select: activeProjectId() === projectId ? folder : state.selectedFolder }).catch(error => showToast(error.message));
  el.assetStatus.textContent = failed.length ? `已导入 ${imported} 项，${failed.length} 项失败` : `已导入 ${imported} 项到 ${folderLabel(folder)}`;
  showToast(failed.length ? `已导入 ${imported} 项；${failed[0]}` : `已导入 ${imported} 项资产`);
}

function bindEvents() {
  bindAudioLibrary();
  // body 也有 data-layout，只绑定真正的按钮，避免冒泡把刚选的布局改回去。
  document.querySelectorAll('.layout-switch button[data-layout]').forEach(button => {
    button.addEventListener('click', () => setPanelState({ layout: button.dataset.layout }).catch(error => showToast(error.message)));
  });
  document.querySelectorAll('[data-filter]').forEach(button => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      state.renderLimit = RENDER_BATCH;
      document.querySelectorAll('[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      renderAssets();
    });
  });
  el.expandPanel.addEventListener('click', () => {
    const expanded = el.expandPanel.getAttribute('aria-pressed') === 'true';
    setPanelState({ width: expanded ? Math.max(PANEL_MIN_WIDTH, Math.min(580, state.compactWidth)) : PANEL_EXPANDED_WIDTH })
      .catch(error => showToast(error.message));
  });
  el.closePanel.addEventListener('click', () => setPanelState({ open: false }).catch(error => showToast(error.message)));
  el.openLibrary.addEventListener('click', () => API.openLibrary().catch(error => showToast(error.message)));
  document.getElementById('editorExports').addEventListener('click', () => window.EditorExports.open({ projectId: activeProjectId() }));
  document.getElementById('assetSources').addEventListener('click', () => window.AssetSources.open({ projectId: activeProjectId() }));
  window.addEventListener('asset-library-used', () => loadLibrary().catch(error => showToast(error.message)));
  el.normalizeNames.addEventListener('click', () => {
    normalizeNames().catch(error => showToast(error.message));
  });
  el.switchScript.addEventListener('click', () => openScriptSwitch().catch(error => showToast(error.message)));
  el.scriptSwitchClose.addEventListener('click', () => el.scriptSwitchDialog.close());
  el.scriptSwitchCancel.addEventListener('click', () => el.scriptSwitchDialog.close());
  el.scriptSwitchDialog.addEventListener('click', event => {
    if (event.target === el.scriptSwitchDialog) el.scriptSwitchDialog.close();
  });
  el.importAssets.addEventListener('click', () => {
    if (state.audioKind) { pickAudioFile(); return; }
    if (!state.selectedFolder) { showToast('请先选择或新建一个剧本文件夹'); return; }
    el.assetFileInput.click();
  });
  el.assetFileInput.addEventListener('change', () => importFiles(el.assetFileInput.files));
  // 整库支持拖拽导入：把 Finder 或桌面的图片/视频/音频直接拖到资产区即可入当前分类。
  // 只绑定 .library-pane 一个元素，避免事件冒泡造成重复导入。
  let assetDragDepth = 0;
  const dropTarget = document.querySelector('.library-pane') || el.assetGrid;
  const hasExternalFiles = event => !!(event.dataTransfer && [...event.dataTransfer.types || []].includes('Files'));
  dropTarget.addEventListener('dragenter', event => {
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    assetDragDepth += 1;
    dropTarget.classList.add('is-drop-import');
    // 折叠状态下拖入文件：自动展开列表，让用户看到落点与导入结果。
    if (libraryPaneEl.classList.contains('grid-collapsed')) setGridCollapsed(false);
  });
  dropTarget.addEventListener('dragover', event => {
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  dropTarget.addEventListener('dragleave', () => {
    assetDragDepth = Math.max(0, assetDragDepth - 1);
    if (!assetDragDepth) dropTarget.classList.remove('is-drop-import');
  });
  dropTarget.addEventListener('drop', event => {
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    assetDragDepth = 0;
    dropTarget.classList.remove('is-drop-import');
    importFiles(event.dataTransfer.files);
  });
  el.newSubfolder.addEventListener('click', () => openFolderDialog({ parent: state.selectedFolder }));
  el.folderForm.addEventListener('submit', event => {
    event.preventDefault();
    createFolder().catch(error => showToast(`创建失败：${error.message}`));
  });
  const closeFolder = () => el.folderDialog.close();
  el.cancelFolder.addEventListener('click', closeFolder);
  el.cancelFolderTop.addEventListener('click', closeFolder);
  el.assetSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    el.clearSearch.hidden = !el.assetSearch.value;
    searchTimer = setTimeout(() => {
      state.query = el.assetSearch.value;
      state.renderLimit = RENDER_BATCH;
      renderAssets();
    }, 120);
  });
  el.clearSearch.addEventListener('click', () => {
    el.assetSearch.value = '';
    state.query = '';
    state.renderLimit = RENDER_BATCH;
    el.clearSearch.hidden = true;
    renderAssets();
    el.assetSearch.focus();
  });
  el.collapseFolders.addEventListener('click', () => {
    const collapsed = el.folderTree.classList.toggle('collapsed');
    el.collapseFolders.textContent = collapsed ? '展开' : '收起';
    el.collapseFolders.setAttribute('aria-expanded', String(!collapsed));
  });
  el.assetCollapse.addEventListener('click', () => {
    if (state.audioKind) { selectFolder(state.selectedFolder); return; }
    setGridCollapsed(!libraryPaneEl.classList.contains('grid-collapsed'));
  });
  el.assetSort.addEventListener('change', () => {
    state.sort = el.assetSort.value;
    state.renderLimit = RENDER_BATCH;
    renderAssets();
  });
  // 重命名 / 移动对话框
  el.renameForm.addEventListener('submit', event => {
    event.preventDefault();
    submitRename();
  });
  el.cancelRename.addEventListener('click', () => el.renameDialog.close());
  el.cancelRenameTop.addEventListener('click', () => el.renameDialog.close());
  el.renameDialog.addEventListener('click', event => { if (event.target === el.renameDialog) el.renameDialog.close(); });
  el.cancelMove.addEventListener('click', () => el.moveDialog.close());
  el.cancelMoveTop.addEventListener('click', () => el.moveDialog.close());
  el.moveDialog.addEventListener('click', event => { if (event.target === el.moveDialog) el.moveDialog.close(); });
  // 多选批量操作栏
  el.selectVisible.addEventListener('click', () => {
    document.querySelectorAll('.asset-card').forEach(card => state.selectedPaths.add(card.dataset.path));
    updateSelectionBar();
  });
  // 批量导入剪映 = 多选后直接拖动任一选中卡（多文件原生拖动），见 dragstart 逻辑
  el.batchDelete.addEventListener('click', () => batchDeleteSelected().catch(error => showToast(error.message)));
  el.batchMove.addEventListener('click', () => {
    const paths = [...state.selectedPaths];
    if (paths.length) openMoveDialog(paths);
  });
  el.clearSelection.addEventListener('click', clearSelection);
  el.closePreview.addEventListener('click', closePreviewNow);
  el.previewDialog.addEventListener('click', event => { if (event.target === el.previewDialog) closePreviewNow(); });
  el.previewDialog.addEventListener('close', clearPreview);
  el.previewCopy.addEventListener('click', () => state.preview && copyImage(state.preview));
  el.previewShow.addEventListener('click', () => state.preview && showItem(state.preview));
  el.captureFirstFrame.addEventListener('click', () => captureVideoFrame('first').catch(error => showToast(`首帧保存失败：${error.message}`)));
  el.captureTailFrame.addEventListener('click', () => captureVideoFrame('tail').catch(error => showToast(`尾帧保存失败：${error.message}`)));
  el.zoomRange.addEventListener('input', () => setZoom(el.zoomRange.value));
  el.zoomOut.addEventListener('click', () => setZoom(Number(el.zoomRange.value) - 10));
  el.zoomIn.addEventListener('click', () => setZoom(Number(el.zoomRange.value) + 10));
  API.onPanelState(applyPanelState);
  API.onDragResult(result => {
    document.querySelectorAll('.asset-card.dragging').forEach(card => card.classList.remove('dragging'));
    if (result?.ok) el.assetStatus.textContent = '拖拽完成；可继续选择下一项资产';
    else {
      el.assetStatus.textContent = '拖拽失败；可改用平台上传按钮或 Finder 定位';
      showToast(result?.error || '资产拖拽失败');
    }
  });
  bindResize();
}

async function loadLibrary({ select } = {}) {
  const requestId = ++libraryRequestId;
  const projectId = activeProjectId();
  state.selectedPaths.clear();
  if (el.selectionBar) el.selectionBar.hidden = true;
  const response = await fetch(`/api/creative-assets?project=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (requestId !== libraryRequestId || projectId !== activeProjectId()) return;
  if (!response.ok || !data.available || !data.tree) throw new Error(data.error || `目录接口返回 HTTP ${response.status}`);
  state.tree = data.tree;
  if (data.project) {
    state.config.project = data.project;
    state.config.rootName = data.project.name;
  }
  state.config.rootName = data.rootName || state.config.rootName;
  if (typeof select === 'string') state.selectedFolder = select;
  collectTree(data.tree);
  const stats = data.stats || {};
  el.librarySummary.textContent = `${state.config.project?.name || data.rootName || '创作资产库'} · ${stats.files || 0} 项 · ${stats.sizeText || '0 B'}`;
  renderFolders();
  renderAssets();
  if (state.audioKind) await loadAudioLibrary();
  el.assetStatus.textContent = state.audioKind ? '填写名称或拖入音频；支持 MP3、WAV、M4A'
    : data.truncated
    ? '资产较多，当前只显示安全索引范围内的项目'
    : state.assets.length
      ? '选中分类即可导入；图片视频导入后自动按“分类-序号”重命名'
      : '把图片或视频直接拖进来，或点“导入资产”选择文件';
}

// 创作浏览器快捷面板跳转：选中资产所在文件夹、展开列表、滚动定位并高亮，然后直接弹出预览。
// 入口统一为 {path, projectId, expired?} 对象（兼容旧字符串）；projectId 为发起跳转时的剧本身份：
// 与本面板当前项目不一致（切换竞态）时按预期作废处理，不弹「未找到」的误导提示；
// 旧项目请求不得借相同路径在本面板误投；expired=true 为有界取消的过期送达：实际提示取消，不定位。
async function focusExternalAsset(request) {
  window.__focusExternalCalls = (window.__focusExternalCalls || 0) + 1;
  const payload = typeof request === 'string' ? { path: request } : (request || {});
  const target = String(payload.path || '').replace(/\\/g, '/');
  if (!target) return;
  const projectId = payload.projectId;
  if (payload.expired) {
    showToast('定位请求已过期，已自动取消');
    return;
  }
  if (projectId && activeProjectId() !== projectId) {
    console.warn('[focus] dropped: project mismatch', projectId, activeProjectId());
    return;
  }
  const folder = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
  if (state.selectedFolder !== folder) selectFolder(folder);
  state.renderLimit = Math.max(state.renderLimit, state.assets.length + RENDER_BATCH);
  renderAssets();
  if (libraryPaneEl.classList.contains('grid-collapsed')) setGridCollapsed(false);
  const item = state.assets.find(entry => entry.path === target);
  if (!item) {
    showToast(`未在当前剧本资产库中找到「${target.split('/').pop() || target}」`);
    return;
  }
  const card = document.querySelector(`.asset-card[data-path="${CSS.escape(target)}"]`);
  if (card) {
    card.scrollIntoView({ block: 'center', inline: 'nearest' });
    card.classList.remove('focus-flash');
    requestAnimationFrame(() => card.classList.add('focus-flash'));
  }
  openPreview(item);
}

async function boot() {  bindEvents();
  try {
    state.config = await API.getConfig();
    applyPanelState(state.config.panel);
    el.capabilityNote.textContent = SURFACE_MODE === 'library'
      ? '与视频、音频和成片同属资产中心'
      : NATIVE_API ? '可直接拖到右侧平台' : '浏览器预览：拖放与 Finder 能力受限';
    await loadLibrary();
    const events = new EventSource('/api/events');
    events.addEventListener('audio-library', () => {
      if (state.audioKind && !state.audioBusy && !document.querySelector('.audio-entry input:focus')) {
        loadAudioLibrary().catch(error => showToast(error.message));
      }
    });
    events.addEventListener('creative-assets', () => {
      scheduleLibraryReload();
    });
    // 剧本被其他入口（创作浏览器/主窗口）切换时，面板原地跟随新剧本。
    events.addEventListener('creative-projects', event => {
      try { adoptProject(JSON.parse(event.data).project); } catch {}
      scheduleLibraryReload(true);
    });
    // 创作浏览器快捷面板“在完整库中查看”：定位到指定资产（选中文件夹 + 高亮 + 直接预览）。
    document.body.dataset.ready = 'true';
    if (typeof NATIVE_API?.onFocusAsset === 'function') {
      NATIVE_API.onFocusAsset(payload => { focusExternalAsset(payload).catch(error => console.warn('[focus] push failed:', error)); });
    }
    try {
      const pendingFocus = await NATIVE_API?.consumePendingFocus?.();
      if (pendingFocus?.path) await focusExternalAsset(pendingFocus);
    } catch (error) {
      console.warn('pending focus consume failed:', error);
    }
  } catch (error) {
    document.body.dataset.ready = 'error';
    el.assetGrid.replaceChildren();
    const errorView = document.createElement('div');
    errorView.className = 'asset-state error';
    errorView.textContent = `资产读取失败：${String(error.message || error)}`;
    el.assetGrid.appendChild(errorView);
    el.assetStatus.textContent = '请检查项目“创作资产库”文件夹是否可访问';
  }
}

boot();
