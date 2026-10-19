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
      const archive = project ? await readLibraryDownloadEpisodes(project.id) : { batch: null, error: '' };
      return { panel, project, rootName: project?.name || '创作资产库', creativeAssetAvailable: true,
        downloadEpisodes: archive.batch, archiveMetadataError: archive.error };
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

function validLibraryBatch(batch, projectId) {
  return batch?.projectId === projectId && Array.isArray(batch.states);
}

async function readLibraryDownloadEpisodes(projectId, fallback = null) {
  try {
    const response = await fetch(`/api/download-episodes?project=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
    const batch = await response.json().catch(() => ({}));
    if (!response.ok || !validLibraryBatch(batch, projectId)) throw new Error(batch.error || '网站归档信息暂未读取');
    return { batch, error: '' };
  } catch (error) {
    return { batch: validLibraryBatch(fallback, projectId) ? fallback : { projectId, states: [] }, error: error.message };
  }
}

async function requestAction(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/* ---------- 动效工具（与主窗口共用同一套动效契约） ---------- */

const MOTION_CLOSE_SHEET_NAMES = ['dialogSheetOut', 'backdropOut'];

// 一次性动效：给 node 加 class，动画结束或 fallbackMs 超时后移除；先到者生效并清理另一方。
// animationend 只认 node 本身 + 名单内的动画名——子元素动画会冒泡上来，
// ::backdrop 的 animationend 也派发到宿主（target 仍是 node），靠动画名区分 sheet 与 backdrop。
function playMotionClass(node, cls, fallbackMs, animationNames, onDone) {
  if (!node || node.classList.contains(cls)) return;
  const names = new Set(animationNames);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    node.removeEventListener('animationend', onEnd);
    clearTimeout(timer);
    node.classList.remove(cls);
    if (onDone) onDone();
  };
  const onEnd = event => {
    if (event.target !== node || !names.has(event.animationName)) return;
    settle();
  };
  const timer = setTimeout(settle, fallbackMs);
  node.classList.add(cls);
  node.addEventListener('animationend', onEnd);
}

// 带退出动画的关闭：只延迟 close 本体，不改变调用方控制流；正在关闭或已关闭时直接返回（幂等）。
function closeCreatorDialog(dialog) {
  if (!dialog || !dialog.open || dialog.classList.contains('motion-close')) return;
  playMotionClass(dialog, 'motion-close', 260, MOTION_CLOSE_SHEET_NAMES, () => dialog.close());
}

// 打开包装：showModal 前清掉可能残留的退出动画 class，避免刚打开就播关闭动画；
// 上一次关闭动画未播完就再次打开时 dialog 仍处于 open，取消关闭原地恢复即可
//（此时再 showModal 会抛 InvalidStateError）。
function openCreatorDialog(dialog) {
  dialog.classList.remove('motion-close');
  if (!dialog.open) dialog.showModal();
}

const NATIVE_API = window.assetAPI;
const API = NATIVE_API || createBrowserAdapter();
const state = {
  config: null,
  tree: null,
  folders: [],
  assets: [],
  historyFolders: new Map(),
  historyRoots: new Map(),
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
  batchDeleteBusy: false,
  projectGeneration: 0,
  episodeBusy: false,
  dispositionBusy: false,
};

const el = Object.fromEntries([
  'resizeHandle', 'librarySummary', 'expandPanel', 'closePanel', 'importAssets', 'normalizeNames', 'switchScript',
  'scriptSwitchDialog', 'scriptSwitchList', 'scriptSwitchClose', 'scriptSwitchCancel',
  'newSubfolder', 'openLibrary', 'assetFileInput', 'assetSearch', 'clearSearch', 'collapseFolders',
  'folderTree', 'currentPath', 'folderScopeNote', 'assetHeading', 'assetCount', 'assetSort', 'assetCollapse', 'assetGrid', 'assetStatus', 'capabilityNote',
  'previewDialog', 'previewName', 'previewPath', 'previewCanvas', 'previewMedia', 'closePreview',
  'zoomControls', 'zoomOut', 'zoomRange', 'zoomIn', 'zoomValue', 'captureFirstFrame', 'captureTailFrame', 'previewCopy', 'previewShow',
  'folderDialog', 'folderForm', 'folderDialogTitle', 'folderDialogParent', 'folderName',
  'cancelFolderTop', 'cancelFolder', 'assetToast',
  'renameDialog', 'renameForm', 'renameDialogFrom', 'renameInput', 'cancelRenameTop', 'cancelRename',
  'moveDialog', 'moveDialogTitle', 'moveDialogHint', 'moveFolderList', 'cancelMoveTop', 'cancelMove',
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
let libraryMutationDepth = 0;
const libraryRecentMoves = new Map();
const libraryRecentCopies = new Map();
const libraryRecentDeletes = new Map();
let pendingView = null;
let viewSaveTimer = null;
function viewKey() { return `videoOS.assetView.v1.${SURFACE_MODE}.${activeProjectId()}`; }
function saveAssetView() {
  if (!state.tree || pendingView) return;
  try {
    localStorage.setItem(viewKey(), JSON.stringify({
      folder: state.selectedFolder, query: state.query, filter: state.filter, sort: state.sort,
      collapsed: [...state.collapsedFolders], known: [...state.knownFolders],
      limit: state.renderLimit, scroll: el.assetGrid.scrollTop, treeScroll: el.folderTree.scrollTop,
    }));
  } catch {}
}
function restoreAssetView() {
  state.query = ''; state.filter = 'all'; state.sort = 'recent'; state.audioKind = '';
  state.renderLimit = RENDER_BATCH;
  pendingView = null;
  try {
    const saved = JSON.parse(localStorage.getItem(viewKey()) || 'null');
    if (saved && typeof saved === 'object') {
      pendingView = saved;
      state.selectedFolder = typeof saved.folder === 'string' ? saved.folder : '';
      state.query = typeof saved.query === 'string' ? saved.query : '';
      if (saved.filter === 'all' || TYPE_COPY[saved.filter]) state.filter = saved.filter;
      if ([...el.assetSort.options].some(option => option.value === saved.sort)) state.sort = saved.sort;
      state.collapsedFolders = new Set(Array.isArray(saved.collapsed) ? saved.collapsed : []);
      state.knownFolders = new Set(Array.isArray(saved.known) ? saved.known : []);
      state.renderLimit = Math.max(RENDER_BATCH, Math.min(10000, Number(saved.limit) || RENDER_BATCH));
    }
  } catch {}
  el.assetSearch.value = state.query;
  el.clearSearch.hidden = !state.query;
  el.assetSort.value = state.sort;
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)));
}
function scheduleViewSave() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveAssetView, 180);
}
window.addEventListener('pagehide', saveAssetView);
document.addEventListener('click', scheduleViewSave);
el.assetGrid.addEventListener('scroll', scheduleViewSave, { passive: true });
el.folderTree.addEventListener('scroll', scheduleViewSave, { passive: true });

function adoptProject(project) {
  if (!project || project.id === state.config?.project?.id) return;
  saveAssetView();
  state.projectGeneration++;
  libraryRequestId++;
  if (el.previewDialog.open) closePreviewNow();
  window.AssetSources?.close();
  state.config = { ...state.config, project, rootName: project.name };
  state.selectedFolder = project.folder;
  state.audioItems = [];
  state.assets = [];
  state.selectedPaths.clear();
  state.lastCheckedPath = '';
  state.tree = null;
  state.knownFolders.clear();
  state.collapsedFolders.clear();
  restoreAssetView();
  el.folderTree.replaceChildren();
  el.assetGrid.replaceChildren();
  el.librarySummary.textContent = `${project.name} · 正在读取…`;
  updateSelectionBar();
}

function scheduleLibraryReload(projectChanged = false) {
  projectRefreshNeeded ||= projectChanged;
  clearTimeout(reloadTimer);
  if ((libraryMutationDepth || state.importBusy) && !projectChanged) return;
  reloadTimer = setTimeout(async () => {
    try {
      if (projectRefreshNeeded) {
        projectRefreshNeeded = false;
        const config = await API.getConfig();
        adoptProject(config.project);
        state.config.downloadEpisodes = config.downloadEpisodes;
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
  const generated = state.folders.find(folder => folder.generatedVideoGroup && folder.node.path === folderPath);
  if (generated) return generated.node.name;
  if (isHistoryFolderPath(folderPath)) return '未分集素材';
  if (!folderPath) return '创作资产库';
  return folderPath.split('/').filter(Boolean).at(-1) || '创作资产库';
}

// 这只是展示入口，不是磁盘目录。使用后端相对路径规则不接受的 URI 标识，且所有写入口显式拦截。
const HISTORY_FOLDER_PREFIX = 'videoOS-history://';
function isHistoryFolderPath(folderPath) { return GeneratedVideoLayout.isVirtualPath(folderPath); }
function historyFolderForPath(folderPath) {
  let current = String(folderPath || '');
  while (current) {
    const history = state.historyRoots.get(current);
    if (history) return history;
    const separator = current.lastIndexOf('/');
    if (separator < 0) break;
    current = current.slice(0, separator);
  }
  return '';
}
function rejectHistoryWrite(folderPath) {
  if (!isHistoryFolderPath(folderPath)) return false;
  showToast('汇总分组只用于查看；请先选择真实的分集或自建文件夹存入');
  return true;
}
function updateFolderActions() {
  const history = isHistoryFolderPath(state.selectedFolder) && !state.audioKind;
  el.newSubfolder.disabled = libraryActionBusy() || !state.selectedFolder || history;
  el.importAssets.disabled = libraryActionBusy() || state.importBusy || (history && libraryWritableFolder() === state.selectedFolder);
  el.normalizeNames.disabled = libraryActionBusy() || history;
  el.folderTree.querySelectorAll('.library-episode-select, .library-episode-advance').forEach(control => { control.disabled = libraryActionBusy(); });
}

function libraryActionBusy() { return state.batchDeleteBusy || state.episodeBusy || state.dispositionBusy; }

function libraryWritableFolder(folderPath = state.selectedFolder) {
  const folder = state.folders.find(item => item.node.path === folderPath);
  const entry = folder && libraryEpisodeEntry(folder);
  if (!entry || entry.archiveOnly || entry.downloadable === false) return folderPath;
  const episode = Number(entry.episode);
  return Number.isInteger(episode) && episode > 0 && episode <= 999999 ? `${entry.platformPath}/第${episode}集` : folderPath;
}

async function prepareLibraryImportTarget(projectId, selectedFolder, generation = state.projectGeneration) {
  const target = libraryWritableFolder(selectedFolder);
  if (target === selectedFolder) return target;
  const current = () => projectId === activeProjectId() && generation === state.projectGeneration;
  // A legacy-only registered website has no canonical directory yet. Prepare
  // only that website and its current episode, and only on import intent.
  for (const path of [FolderEditor.parentPath(target), target]) {
    if (!current()) throw new Error('剧本已切换，未创建存入目录');
    if (state.folders.some(folder => folder.node.path === path && !folder.virtualGenerated && !folder.virtualHistory)) continue;
    try { await postAssetAction('folder', { parent: FolderEditor.parentPath(path), name: path.split('/').at(-1) }, projectId); }
    catch (error) {
      // A concurrent legitimate download can create the exact same directory.
      // Re-read its physical existence; never infer it from a display URI.
      const data = await requestAction(`/api/creative-assets?project=${encodeURIComponent(projectId)}`);
      const contains = node => node?.kind === 'folder' && (node.path === path || (node.children || []).some(contains));
      if (!current() || !data.available || !contains(data.tree)) throw error;
    }
  }
  return target;
}

function applyLibraryDownloadBatch(batch) {
  if (!state.config || !validLibraryBatch(batch, activeProjectId())) return;
  state.config.downloadEpisodes = batch; state.config.archiveMetadataError = '';
  if (!state.tree) return;
  collectTree(state.tree); renderFolders(); renderAssets({ preserveScroll: true }); updateSelectionBar();
}

function updateLibraryScopeNote() {
  const folder = state.folders.find(item => item.node.path === state.selectedFolder);
  let note = '';
  if (folder?.downloadEpisode && libraryWritableFolder() !== state.selectedFolder) note = `查看整站素材；导入存入当前第${folder.downloadEpisode.episode || 1}集，切换下载集不改变查看范围。${folder.virtualGenerated ? '首次导入才建立对应真实目录；原有素材不搬动。' : folder.composite ? '目录操作只作用于真实主目录。' : ''}`;
  else if (folder?.virtualGenerated || folder?.virtualHistory) note = '只读查看：此处汇总素材，不是存入目录。请选择真实的集或自建文件夹导入；视频状态可在卡片右键转换。';
  else if (folder?.archiveUnclassified) note = `${folder.explanation}。`;
  else if (folder?.composite) note = '汇总多个真实位置；目录操作只作用于真实主目录，不代表删除整组素材。';
  if (state.config?.archiveMetadataError) note += `${note ? ' ' : ''}网站归档信息暂未读取，原目录仍可访问；刷新后重试。`;
  el.folderScopeNote.hidden = !note;
  el.folderScopeNote.textContent = note;
}
function collectHistoryFolders(folders, assets) {
  state.historyFolders.clear(); state.historyRoots.clear();
  const batch = state.config?.downloadEpisodes;
  const project = state.config?.project;
  if (!project || batch?.projectId !== project.id || !Array.isArray(batch.states)) return folders;
  const categoryIds = { image: 'generated-images', video: 'generated-videos', audio: 'audio' };
  const sitePaths = new Set();
  for (const entry of batch.states) {
    if (!entry || entry.available !== true || entry.projectId !== project.id || !Object.hasOwn(categoryIds, entry.kind)) continue;
    const category = project.categories?.find(item => item.id === categoryIds[entry.kind]);
    const platform = entry.platformFolder;
    if (!category?.path || typeof platform !== 'string' || !platform || /[\\/]/.test(platform) || platform === '.' || platform === '..'
      || entry.platformPath !== `${category.path}/${platform}`) continue;
    sitePaths.add(entry.platformPath);
    if (entry.kind === 'video') {
      for (const disposition of ['可剪辑', '待处理']) sitePaths.add(`${category.path}/${disposition}/${platform}`);
    }
  }
  const childrenByParent = new Map();
  for (const folder of folders) {
    const children = childrenByParent.get(folder.parentPath) || [];
    children.push(folder); childrenByParent.set(folder.parentPath, children);
  }
  for (const folder of folders) {
    if (!sitePaths.has(folder.node.path)) continue;
    const dates = (childrenByParent.get(folder.node.path) || []).filter(child => AssetOrder.dateFolderKey(child.node.name));
    if (!dates.length) continue;
    const key = HISTORY_FOLDER_PREFIX + encodeURIComponent(folder.node.path);
    const history = { node: { kind: 'folder', name: '未分集素材', path: key, fileCount: 0, children: [] },
      depth: folder.depth + 1, parentPath: folder.node.path, hasChildren: true, virtualHistory: true, assetPaths: new Set() };
    if (!state.knownFolders.has(key)) {
      state.knownFolders.add(key); state.collapsedFolders.add(key);
    }
    state.historyFolders.set(key, history);
    dates.forEach(date => state.historyRoots.set(date.node.path, key));
  }
  for (const asset of assets) {
    const history = state.historyFolders.get(historyFolderForPath(asset.folderPath));
    if (history) history.assetPaths.add(asset.path);
  }
  const renderedHistory = new Set();
  const display = [];
  for (const folder of folders) {
    const historyPath = historyFolderForPath(folder.node.path);
    if (!historyPath) { display.push(folder); continue; }
    if (renderedHistory.has(historyPath)) continue;
    const history = state.historyFolders.get(historyPath);
    history.node.fileCount = history.assetPaths.size;
    renderedHistory.add(historyPath); display.push(history);
  }
  return display;
}

// 与创作浏览器左侧分类树共用顺序；这里只改变展示，不移动磁盘文件。
const FOLDER_ORDER_PREFIX = 'videoOS.assetFolderOrder.v1.';
function folderOrderKey() { return `${FOLDER_ORDER_PREFIX}${activeProjectId()}`; }
function readFolderOrder() {
  try {
    const value = JSON.parse(localStorage.getItem(folderOrderKey()) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function orderFolderSiblings(folders, parentPath) {
  const saved = readFolderOrder()[parentPath];
  const sorted = AssetOrder.orderFolders(folders.filter(folder => folder.depth > 0 && folder.node.name !== '浏览器下载'), saved);
  let cursor = 0;
  return folders.map(folder => folder.depth === 0 || folder.node.name === '浏览器下载' ? folder : sorted[cursor++]);
}
function reorderableSiblings(folder) {
  return orderFolderSiblings(state.folders.filter(item =>
    item.depth > 0 && item.parentPath === folder.parentPath && item.node.name !== '浏览器下载'
      && !item.virtualHistory && !item.virtualGenerated && !item.fixedOrder && !AssetOrder.dateFolderKey(item.node.name) && !AssetOrder.episodeFolderKey(item.node.name)), folder.parentPath);
}
function saveFolderSiblingOrder(parentPath, siblings) {
  const order = readFolderOrder();
  order[parentPath] = siblings.map(item => item.node.path);
  try { localStorage.setItem(folderOrderKey(), JSON.stringify(order)); }
  catch (error) { showToast(`分类顺序保存失败：${error.message}`); return false; }
  renderFolders();
  return true;
}
function focusFolderGrip(folderPath) {
  [...el.folderTree.querySelectorAll('.folder-order-grip')]
    .find(grip => grip.closest('.folder-row')?.dataset.folderPath === folderPath)?.focus();
}
function moveFolderByKeyboard(folder, offset) {
  const siblings = reorderableSiblings(folder);
  const index = siblings.findIndex(item => item.node.path === folder.node.path);
  if (index < 0 || siblings.length < 2) return;
  // 与创作浏览器快捷树一致：已在同级边界时给出提示，而不是静默不动。
  if (index + offset < 0 || index + offset >= siblings.length) {
    showToast(offset < 0 ? '已经在同级最前面' : '已经在同级最后面');
    return;
  }
  const ordered = [...siblings];
  ordered.splice(index + offset, 0, ...ordered.splice(index, 1));
  if (saveFolderSiblingOrder(folder.parentPath, ordered)) focusFolderGrip(folder.node.path);
}

let folderOrderDrag = null;
function folderRowForPath(path) {
  return [...el.folderTree.querySelectorAll('.folder-row')].find(row => row.dataset.folderPath === path);
}
function clearFolderOrderMarkers() {
  el.folderTree.querySelectorAll('.folder-order-above, .folder-order-below, .folder-order-source')
    .forEach(row => row.classList.remove('folder-order-above', 'folder-order-below', 'folder-order-source'));
}
function updateFolderOrderPlan(x, y) {
  const drag = folderOrderDrag;
  if (!drag?.active) return;
  clearFolderOrderMarkers();
  folderRowForPath(drag.folder.node.path)?.classList.add('folder-order-source');
  drag.plan = null;
  const bounds = el.folderTree.getBoundingClientRect();
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
  const peers = reorderableSiblings(drag.folder)
    .filter(item => item.node.path !== drag.folder.node.path)
    .map(item => folderRowForPath(item.node.path))
    .filter(row => row && row.getClientRects().length);
  if (!peers.length) return;
  let target = peers.find(row => y < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
  const before = !!target;
  if (!target) target = peers.at(-1);
  drag.plan = { path: target.dataset.folderPath, position: before ? 'before' : 'after' };
  target.classList.add(before ? 'folder-order-above' : 'folder-order-below');
}
function stopFolderOrderDrag(commit) {
  const drag = folderOrderDrag;
  if (!drag) return;
  if (drag.scrollFrame) cancelAnimationFrame(drag.scrollFrame);
  folderOrderDrag = null;
  document.body.classList.remove('folder-order-dragging');
  clearFolderOrderMarkers();
  if (!commit || !drag.active || !drag.plan) return;
  const siblings = reorderableSiblings(drag.folder);
  const from = siblings.findIndex(item => item.node.path === drag.folder.node.path);
  if (from < 0) return;
  const ordered = [...siblings];
  const [moved] = ordered.splice(from, 1);
  let to = ordered.findIndex(item => item.node.path === drag.plan.path);
  if (to < 0) return;
  if (drag.plan.position === 'after') to++;
  ordered.splice(to, 0, moved);
  if (ordered.some((item, index) => item.node.path !== siblings[index].node.path))
    saveFolderSiblingOrder(drag.folder.parentPath, ordered);
}
function scrollFolderOrderDrag() {
  const drag = folderOrderDrag;
  if (!drag?.active) return;
  const bounds = el.folderTree.getBoundingClientRect();
  const edge = 28;
  if (drag.x >= bounds.left && drag.x <= bounds.right) {
    const delta = drag.y < bounds.top + edge ? -12 : drag.y > bounds.bottom - edge ? 12 : 0;
    if (delta) { el.folderTree.scrollTop += delta; updateFolderOrderPlan(drag.x, drag.y); }
  }
  drag.scrollFrame = requestAnimationFrame(scrollFolderOrderDrag);
}
window.addEventListener('pointermove', event => {
  const drag = folderOrderDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.x = event.clientX; drag.y = event.clientY;
  if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 5) {
    drag.active = true;
    document.body.classList.add('folder-order-dragging');
    scrollFolderOrderDrag();
  }
  if (drag.active) { event.preventDefault(); updateFolderOrderPlan(drag.x, drag.y); }
}, { passive: false });
window.addEventListener('pointerup', event => {
  if (folderOrderDrag && event.pointerId === folderOrderDrag.pointerId) {
    updateFolderOrderPlan(event.clientX, event.clientY);
    stopFolderOrderDrag(true);
  }
});
window.addEventListener('pointercancel', event => {
  if (folderOrderDrag && event.pointerId === folderOrderDrag.pointerId) stopFolderOrderDrag(false);
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && folderOrderDrag) { event.preventDefault(); stopFolderOrderDrag(false); }
});
window.addEventListener('storage', event => {
  if (event.key === folderOrderKey() && state.tree) renderFolders();
});

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
  const layout = GeneratedVideoLayout.organize({ folders, assets, project: state.config?.project, batch: state.config?.downloadEpisodes });
  state.videoLayout = layout;
  state.folders = collectHistoryFolders(layout.folders, layout.assets);
  for (const folder of state.folders) {
    knownPaths.add(folder.node.path);
    if (folder.generatedVideoGroup && folder.virtualHistory) state.historyFolders.set(folder.node.path, folder);
    if (!state.knownFolders.has(folder.node.path)) {
      state.knownFolders.add(folder.node.path);
      if (folder.depth > 0) state.collapsedFolders.add(folder.node.path);
    }
  }
  state.assets = layout.assets.sort(AssetOrder.newestFirst);
  state.collapsedFolders = new Set([...state.collapsedFolders].map(path => layout.aliases.get(path) || path));
  state.selectedFolder = layout.aliases.get(state.selectedFolder) || state.selectedFolder;
  state.selectedFolder = historyFolderForPath(state.selectedFolder) || state.selectedFolder;
  if (!knownPaths.has(state.selectedFolder) && !state.historyFolders.has(state.selectedFolder)) state.selectedFolder = root?.path || '';
}

function selectFolder(folderPath) {
  setAudioMode('');
  const mapped = state.videoLayout?.aliases.get(folderPath) || folderPath;
  state.selectedFolder = historyFolderForPath(mapped) || mapped || '';
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
  updateFolderActions();
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

function applyLibraryFolderRename(change) {
  if (!change || change.projectId !== activeProjectId()) return;
  const remap = value => FolderEditor.remap(value, change);
  state.selectedFolder = remap(state.selectedFolder);
  state.collapsedFolders = new Set([...state.collapsedFolders].map(remap));
  state.selectedPaths = new Set([...state.selectedPaths].map(remap));
  try { FolderEditor.rememberOrder(change); } catch {}
  applyLibraryAssetMoves(state.assets.filter(item => item.path?.startsWith(`${change.oldPath}/`))
    .map(item => ({ oldPath: item.path, path: remap(item.path), assetId: item.assetId })), change.projectId);
}

function applyLibraryAssetMoves(moves, projectId = activeProjectId()) {
  if (projectId && projectId !== activeProjectId()) return;
  for (const move of moves || []) {
    if (!move?.oldPath || !move.path || move.oldPath === move.path) continue;
    const remap = value => FolderEditor.remap(value, move);
    libraryRecentMoves.set(`${move.oldPath}\n${move.path}`, Date.now());
    state.selectedPaths = new Set([...state.selectedPaths].map(remap));
    state.lastCheckedPath = remap(state.lastCheckedPath);
    const previewMoved = state.preview && (state.preview.path === move.oldPath || (move.assetId && state.preview.assetId === move.assetId && state.preview.path !== move.path));
    for (const item of state.assets) {
      if (item.path !== move.oldPath && (!move.assetId || item.assetId !== move.assetId)) continue;
      Object.assign(item, { path: move.path, name: move.name || move.path.split('/').at(-1), folderPath: FolderEditor.parentPath(move.path) });
      if (move.videoDisposition) item.videoDisposition = move.videoDisposition;
    }
    if (previewMoved) {
      Object.assign(state.preview, { path: move.path, name: move.name || move.path.split('/').at(-1), folderPath: FolderEditor.parentPath(move.path) });
      el.previewName.textContent = state.preview.name;
      el.previewPath.textContent = `${state.preview.folderPath} · ${state.preview.sizeText || ''}`;
      FolderEditor.updateMediaPath(el.previewMedia, assetUrl(move.path));
    }
  }
}
function startLibraryFolderCreate(parentPath) {
  if (libraryActionBusy() || state.importBusy) { showToast('素材正在处理，请稍候'); return; }
  const parent = parentPath || state.config?.project?.folder;
  if (rejectHistoryWrite(parent)) return;
  if (!parent || el.folderTree.querySelector('.folder-rename-input')) return;
  for (const folder of state.folders) {
    if (parent === folder.node.path || parent.startsWith(`${folder.node.path}/`)) state.collapsedFolders.delete(folder.node.path);
  }
  renderFolders();
  const parentRow = el.folderTree.querySelector(`.folder-row[data-folder-path="${CSS.escape(parent)}"]`);
  const host = parentRow?.nextElementSibling?.querySelector(':scope > .folder-children-inner');
  if (!host) return;
  const row = document.createElement('div'); row.className = 'folder-row folder-create-row';
  const anchor = document.createElement('span'); anchor.className = 'folder-button'; anchor.textContent = '新建文件夹';
  row.append(anchor); host.prepend(row); row.scrollIntoView({ block: 'nearest' });
  const projectId = activeProjectId();
  libraryMutationDepth++; clearTimeout(reloadTimer);
  let finished = false;
  const finish = () => { if (finished) return; finished = true; libraryMutationDepth--; row.remove(); };
  FolderEditor.create(anchor, { parent, projectId }, { createFolder: async request => {
    if (activeProjectId() !== projectId) throw new Error('剧本已切换，未创建文件夹');
    return postAssetAction('folder', { parent: request.parent, name: request.name });
  } }, async data => {
    finish();
    if (activeProjectId() !== projectId) return;
    const path = data.folder?.path || parent;
    state.knownFolders.add(path); state.collapsedFolders.delete(path);
    await loadLibrary({ select: path });
    el.folderTree.querySelector(`.folder-row[data-folder-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
    showToast(`已创建：${path}`);
  }, showToast, () => { finish(); scheduleLibraryReload(); });
}
async function showLibraryFolderMenu(folder, event) {
  event.preventDefault(); event.stopPropagation();
  if (libraryActionBusy()) { showToast('素材正在处理，请稍候'); return; }
  const projectId = activeProjectId(), generation = state.projectGeneration;
  const current = () => projectId === activeProjectId() && generation === state.projectGeneration;
  if (folder?.generatedVideoGroup && (folder.composite || folder.virtualGenerated)) {
    const menu = [];
    const actionPath = folder.actionPath;
    if (actionPath && folder.capabilities?.create) menu.push({ label: '在真实主目录新建子文件夹', run: () => { if (current()) startLibraryFolderCreate(actionPath); } });
    if (actionPath && folder.capabilities?.reveal) menu.push({ label: '打开真实主目录（仅此目录）', run: () => current() && openLibraryPhysicalFolder(actionPath, projectId) });
    if (actionPath && folder.capabilities?.rename && typeof API.renameFolder === 'function') menu.push({ label: '改名真实主目录（仅此目录）', run: () => {
      if (!current()) return;
      const anchor = el.folderTree.querySelector(`.folder-row[data-folder-path="${CSS.escape(folder.node.path)}"] .folder-button`);
      FolderEditor.edit(anchor, { path: actionPath, projectId, name: actionPath.split('/').at(-1) }, API, async change => {
        if (!current()) return;
        applyLibraryFolderRename(change); await loadLibrary({ select: change.path }); showToast('真实主目录已改名，未搬动其他位置的素材');
      }, showToast);
    } });
    if (!actionPath && folder.downloadEpisode) for (const backing of folder.backingPaths || []) {
      menu.push({ label: `打开真实目录：${backing}`, run: () => current() && openLibraryPhysicalFolder(backing, projectId) });
      menu.push({ label: `在此真实目录新建子文件夹：${backing}`, run: () => { if (current()) openFolderDialog({ parent: backing }); } });
    }
    menu.push({ label: '查看汇总范围说明', run: () => showToast(folder.explanation || '只读汇总；请对具体素材操作，不会删除整组') });
    FolderEditor.menu(event, menu); return;
  }
  const parent = folder?.node.path || state.config?.project?.folder;
  if (rejectHistoryWrite(parent)) return;
  if (typeof API.showFolderMenu !== 'function') {
    FolderEditor.menu(event, [{ label: folder?.depth ? '新建子文件夹' : '新建文件夹', run: () => startLibraryFolderCreate(parent) }]);
    return;
  }
  try {
    const result = await API.showFolderMenu({ path: parent, projectId: activeProjectId(), x: event.clientX, y: event.clientY });
    if (result?.create) startLibraryFolderCreate(result.parent || parent);
    if (result?.rename) FolderEditor.edit(el.folderTree.querySelector(`.folder-row[data-folder-path="${CSS.escape(parent)}"] .folder-button`), result, API, async change => {
      applyLibraryFolderRename(change); await loadLibrary({ select: change.path }); showToast('已改名；新导入将使用新名称加序号');
    }, showToast);
    if (result?.deleted) { showToast('文件夹已移入废纸篓'); await loadLibrary(); }
  } catch (error) { showToast(error.message || '文件夹操作失败'); }
}

async function openLibraryPhysicalFolder(relative, projectId = activeProjectId()) {
  try {
    if (isHistoryFolderPath(relative)) throw new Error('汇总分组不是磁盘目录');
    await requestAction(`/api/open-creative-assets-folder?project=${encodeURIComponent(projectId)}&p=${encodeURIComponent(relative)}`);
    if (projectId === activeProjectId()) showToast(`已打开真实目录：${relative}`);
  } catch (error) { if (projectId === activeProjectId()) showToast(error.message || '目录打开失败'); }
}

function libraryEpisodeEntry(folder) {
  const path = folder.downloadEpisode?.platformPath || folder.node.path;
  const categoryIds = { video: 'generated-videos', image: 'generated-images', audio: 'audio' };
  return state.config?.downloadEpisodes?.states?.find(entry => {
    const category = state.config.project?.categories?.find(item => item.id === categoryIds[entry?.kind]);
    return entry?.projectId === activeProjectId() && entry.available === true && entry.platformPath === path
      && category?.path && typeof entry.platformFolder === 'string' && !!entry.platformFolder
      && !/[\\/]/.test(entry.platformFolder) && entry.platformFolder !== '.' && entry.platformFolder !== '..'
      && entry.platformPath === `${category.path}/${entry.platformFolder}`;
  });
}

function buildLibraryEpisodeControl(entry) {
  const controls = document.createElement('span'); controls.className = 'library-episode-control';
  const current = Number(entry.episode) || 1;
  const existing = [...new Set((entry.existingEpisodes || []).filter(value => Number.isInteger(value) && value > 0 && value <= 999999))].sort((a, b) => a - b);
  const select = document.createElement('select'); select.className = 'library-episode-select';
  select.setAttribute('aria-label', `${entry.platformFolder}当前下载集`);
  select.title = `当前下载第${current}集；可切回已有集，不改变正在查看的范围`;
  for (const number of [...new Set([...existing, current])].sort((a, b) => a - b)) {
    const option = document.createElement('option'); option.value = String(number); option.textContent = `第${number}集`;
    option.selected = number === current; option.disabled = number !== current && !existing.includes(number);
    select.append(option);
  }
  select.disabled = libraryActionBusy();
  select.addEventListener('change', event => { event.stopPropagation(); changeLibraryEpisode(entry, Number(select.value), 'select'); });
  const advance = document.createElement('button'); advance.type = 'button'; advance.className = 'library-episode-advance'; advance.textContent = '↻';
  advance.title = `保留第${current}集，切换到第${current + 1}集`; advance.setAttribute('aria-label', `${entry.platformFolder}下一集`);
  advance.disabled = libraryActionBusy();
  advance.addEventListener('click', event => { event.stopPropagation(); changeLibraryEpisode(entry, current + 1, 'advance'); });
  controls.append(select, advance); return controls;
}

async function changeLibraryEpisode(entry, episode, action) {
  if (libraryActionBusy() || state.importBusy || libraryMutationDepth) return;
  const projectId = activeProjectId(), generation = state.projectGeneration, selectedFolder = state.selectedFolder;
  const current = () => projectId === activeProjectId() && generation === state.projectGeneration;
  const payload = { projectId, serviceId: entry.serviceId, kind: entry.kind, expectedEpisode: Number(entry.episode) || 1,
    ...(action === 'select' ? { episode } : {}) };
  state.episodeBusy = true; libraryMutationDepth++; clearTimeout(reloadTimer); libraryRequestId++;
  updateSelectionBar(); updateFolderActions();
  try {
    const method = action === 'select' ? API.selectDownloadEpisode : API.advanceDownloadEpisode;
    let batch;
    if (typeof method === 'function') batch = await method(payload);
    else {
      const response = await fetch(`/api/download-episodes/${action}?project=${encodeURIComponent(projectId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      batch = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(batch.error || `HTTP ${response.status}`);
    }
    if (!current()) return;
    if (!validLibraryBatch(batch, projectId)) throw new Error('分集回执不完整，请刷新核对');
    state.config.downloadEpisodes = batch;
    await loadLibrary({ select: selectedFolder });
    if (current()) showToast(batch.selected === false || batch.advanced === false ? '网站当前集已变化，已刷新；查看范围保持不变' : `下载当前集已切为${batch.state?.label || `第${batch.state?.episode || episode}集`}；查看范围保持不变`);
  } catch (error) { if (current()) { renderFolders(); showToast(`切换下载集失败：${error.message}`); } }
  finally {
    state.episodeBusy = false; libraryMutationDepth--; updateSelectionBar(); updateFolderActions();
    if (projectRefreshNeeded) scheduleLibraryReload(true);
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
  button.title = folder.generatedVideoGroup ? `${folder.displayPath}${folder.explanation ? ' · ' + folder.explanation : ''}`
    : folder.virtualHistory ? `${folder.parentPath} · 未分集素材（只读汇总，原文件未搬动）`
    : key || state.config?.rootPath || '创作资产库';
  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = folder.depth ? folder.node.name : '全部资产';
  button.append(name);
  const episodeEntry = libraryEpisodeEntry(folder);
  if (folder.archiveUnclassified || episodeEntry?.archiveOnly) {
    const note = document.createElement('span'); note.className = 'folder-archive-note'; note.textContent = folder.archiveUnclassified ? '未归类' : '归档';
    button.append(note); button.title += ` · ${folder.explanation || '旧网站归档，保留原文件；不作为新下载入口'}`;
  }
  row.addEventListener('contextmenu', event => showLibraryFolderMenu(folder, event));
  button.addEventListener('click', () => {
    selectFolder(key);
    // Obsidian 习惯：选中收起中的文件夹时自动展开；收起只由箭头控制，避免误收。
    if (folder.hasChildren && state.collapsedFolders.has(key)) toggleFolderRow(row);
  });

  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = String(folder.node.fileCount || 0);
  row.append(disclosure, button, count);
  if (episodeEntry && episodeEntry.downloadable !== false && !episodeEntry.archiveOnly) row.append(buildLibraryEpisodeControl(episodeEntry));
  if (!folder.virtualHistory && !folder.virtualGenerated && !folder.fixedOrder && folder.depth > 0 && folder.node.name !== '浏览器下载'
    && !AssetOrder.dateFolderKey(folder.node.name) && !AssetOrder.episodeFolderKey(folder.node.name)) {
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'folder-order-grip';
    grip.draggable = false;
    grip.setAttribute('aria-label', `拖动调整「${folder.node.name}」的同级顺序；Alt+上或下键换位`);
    grip.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    grip.title = grip.getAttribute('aria-label');
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0 || folderOrderDrag) return;
      event.stopPropagation();
      grip.setPointerCapture(event.pointerId);
      folderOrderDrag = { folder, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        x: event.clientX, y: event.clientY, active: false, plan: null, scrollFrame: 0 };
    });
    grip.addEventListener('keydown', event => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      event.stopPropagation();
      moveFolderByKeyboard(folder, event.key === 'ArrowUp' ? -1 : 1);
    });
    row.appendChild(grip);
  }
  return row;
}

function appendFolderRows(parent, folders, parentPath, rendered) {
  // 根节点 path 与 parentPath 同为 ''，子级与根共用 '' 作为父路径；
  // 递归会提前渲染后续兄弟，循环体内必须实时检查 done 防止重复渲染。
  const done = rendered || new Set();
  const siblings = orderFolderSiblings(folders.filter(folder => folder.parentPath === parentPath && !done.has(folder)), parentPath);
  for (const folder of siblings) {
    if (done.has(folder)) continue;
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
    const files = folder.generatedVideoGroup ? state.assets.filter(item => item.displayFolderPath === key)
      : folder.virtualHistory ? state.assets.filter(item => folder.assetPaths.has(item.path))
        : state.assets.filter(item => item.folderPath === key);
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
  file.dataset.path = item.path;
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
  file.addEventListener('contextmenu', event => showLibraryFileMenu(item, event));
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
  updateFolderActions();
}

function visibleAssets() {
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  const history = state.historyFolders.get(state.selectedFolder);
  const filtered = state.assets.filter(item => {
    if (state.filter !== 'all' && item.type !== state.filter) return false;
    const generatedMembers = state.videoLayout?.members.get(state.selectedFolder);
    if (generatedMembers) return generatedMembers.has(item.path)
      && (!query || `${item.name}\n${item.path}`.toLocaleLowerCase('zh-CN').includes(query));
    if (isHistoryFolderPath(state.selectedFolder)) return !!history?.assetPaths.has(item.path)
      && (!query || `${item.name}\n${item.path}`.toLocaleLowerCase('zh-CN').includes(query));
    if (query) return `${item.name}\n${item.path}`.toLocaleLowerCase('zh-CN').includes(query);
    if (!state.selectedFolder) return true;
    return item.folderPath === state.selectedFolder || item.folderPath.startsWith(`${state.selectedFolder}/`);
  });
  return filtered.sort((a, b) => {
    if (state.sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (state.sort === 'folder') return AssetOrder.compareFolderPaths(a.folderPath, b.folderPath) || AssetOrder.newestFirst(a, b);
    return AssetOrder.newestFirst(a, b);
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
  if (libraryActionBusy()) { showToast('素材正在处理，请稍候'); return; }
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

async function postAssetAction(action, body, projectId = activeProjectId()) {
  if ([body.path, body.folder, body.parent].some(isHistoryFolderPath)) throw new Error('汇总分组不是磁盘目录，未执行写入');
  const response = await fetch(`/api/creative-assets/${action}?project=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

let renameTarget = null;
let renameBusy = false;

function openRenameDialog(item) {
  if (renameBusy) return;
  renameTarget = { ...item, projectId: activeProjectId() };
  el.renameDialogFrom.textContent = `位置：${item.folderPath || '创作资产库'}`;
  el.renameInput.value = item.name.replace(/\.[^.]+$/, '');
  openCreatorDialog(el.renameDialog);
  requestAnimationFrame(() => { el.renameInput.focus(); el.renameInput.select(); });
}

async function submitRename() {
  const item = renameTarget;
  const name = el.renameInput.value.trim();
  if (!item || !name || renameBusy) { el.renameInput.focus(); return; }
  renameBusy = true;
  try {
    if (item.projectId !== activeProjectId()) throw new Error('剧本已切换，请重新选择图片');
    const result = await postAssetAction('rename', { path: item.path, name }, item.projectId);
    applyLibraryAssetMoves([{ ...result, oldPath: item.path }], item.projectId);
    closeCreatorDialog(el.renameDialog);
    showToast(`已重命名为「${result.name}」`);
    if (item.projectId === activeProjectId()) await loadLibrary({ select: state.selectedFolder });
  } catch (error) {
    showToast(`重命名失败：${error.message}`);
  } finally {
    renameBusy = false;
  }
}

let moveTargets = null;
let moveAction = 'move';
let moveProjectId = null;

function openMoveDialog(paths, action = 'move') {
  if (libraryActionBusy()) { showToast('素材正在处理，请稍候'); return; }
  moveTargets = [...paths]; moveAction = action; moveProjectId = activeProjectId();
  const label = paths.length > 1 ? `${paths.length} 项资产` : paths[0].split('/').at(-1);
  el.moveDialogTitle.textContent = action === 'copy' ? '复制到…' : '移动到…';
  el.moveDialogHint.textContent = `将「${label}」${action === 'copy' ? '复制' : '移动'}到：`;
  el.moveFolderList.replaceChildren();
  for (const folder of state.folders) {
    if (folder.virtualHistory || folder.virtualGenerated) continue;
    if (action === 'move' && paths.every(path => FolderEditor.parentPath(path) === FolderEditor.normalizePath(folder.node.path))) continue;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'move-folder-row';
    row.dataset.folderPath = folder.node.path || '';
    const name = document.createElement('span');
    name.className = 'move-folder-name';
    name.textContent = folder.node.path || '全部资产';
    row.title = folder.node.path || '全部资产';
    row.appendChild(name);
    row.addEventListener('click', () => submitMove(folder.node.path || ''));
    el.moveFolderList.appendChild(row);
  }
  if (!el.moveFolderList.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'move-folder-empty';
    empty.textContent = '没有其他目标文件夹，可以先新建文件夹。';
    el.moveFolderList.appendChild(empty);
  }
  openCreatorDialog(el.moveDialog);
}

async function submitMove(folderPath) {
  if (rejectHistoryWrite(folderPath)) return;
  const paths = [...moveTargets];
  const action = moveAction, projectId = moveProjectId;
  if (!paths.length) { closeCreatorDialog(el.moveDialog); return; }
  closeCreatorDialog(el.moveDialog);
  if (projectId !== activeProjectId()) { showToast('剧本已切换，请重新选择素材'); return; }
  let moved = 0, skipped = 0;
  const failed = [];
  const dispositions = new Set();
  libraryMutationDepth++; clearTimeout(reloadTimer);
  try {
    for (const path of [...new Set(paths)]) {
      if (action === 'move' && FolderEditor.parentPath(path) === FolderEditor.normalizePath(folderPath)) { skipped++; continue; }
      try {
        if (projectId !== activeProjectId()) throw new Error('剧本已切换，未执行此项');
        const previousDisposition = state.assets.find(item => item.path === path)?.videoDisposition;
        const result = await postAssetAction(action, { path, folder: folderPath });
        if (action === 'move') applyLibraryAssetMoves([{ ...result, oldPath: result.oldPath || path }], projectId);
        else libraryRecentCopies.set(`${path}\n${result.path}`, Date.now());
        if (result.videoDisposition && previousDisposition !== result.videoDisposition) dispositions.add(result.videoDisposition);
        moved += 1;
      } catch (error) {
        failed.push(`${path.split('/').at(-1)}：${error.message}`);
      }
    }
  } finally {
    libraryMutationDepth--; clearTimeout(reloadTimer);
    if (projectId === activeProjectId()) await loadLibrary({ select: folderPath });
  }
  updateSelectionBar();
  const disposition = dispositions.size === 1 ? `；已归为${dispositions.has('processing') ? '待处理' : '可剪辑'}` : '';
  showToast(`${action === 'copy' ? '复制' : '移动'}到「${folderPath}」：成功 ${moved}，跳过 ${skipped}，失败 ${failed.length}${disposition}${failed.length ? `；${failed[0]}` : ''}`);
}
function showLibraryFileMenu(item, event) {
  event.preventDefault(); event.stopPropagation();
  const paths = state.selectedPaths.has(item.path) ? [...state.selectedPaths] : [item.path];
  const items = [
    { label: `移动到…${paths.length > 1 ? `（${paths.length} 项）` : ''}`, run: () => openMoveDialog(paths) },
    { label: `复制到…${paths.length > 1 ? `（${paths.length} 项）` : ''}`, run: () => openMoveDialog(paths, 'copy') },
    { label: '预览', run: () => openPreview(item) },
    { label: '在文件夹中显示', run: () => showItem(item) },
  ];
  if (item.type === 'image') items.unshift({ label: '改名…', run: () => openRenameDialog(item) });
  if (item.type === 'video') {
    const processing = VideoDisposition.of(item) === 'processing';
    items.unshift({ label: processing ? '改为可剪辑（此视频）' : '标为待处理（此视频）',
      run: () => changeLibraryVideoDisposition(item, processing ? 'editable' : 'processing') });
  }
  FolderEditor.menu(event, items);
}

async function changeLibraryVideoDisposition(item, disposition) {
  if (libraryActionBusy() || libraryMutationDepth || state.importBusy) { showToast('素材正在处理，请稍候'); return; }
  const projectId = activeProjectId(), generation = state.projectGeneration, selectedFolder = state.selectedFolder;
  const current = () => projectId === activeProjectId() && generation === state.projectGeneration;
  const target = state.assets.find(asset => asset.path === item.path && asset.type === 'video');
  if (!target) { showToast('该视频已变化，请刷新后重试'); return; }
  state.dispositionBusy = true; libraryMutationDepth++; clearTimeout(reloadTimer); libraryRequestId++;
  updateSelectionBar(); updateFolderActions();
  try {
    const result = await postAssetAction('disposition', { path: target.path, disposition }, projectId);
    if (!current()) return;
    if (!result?.path || result.projectId !== projectId || result.videoDisposition !== disposition) throw new Error('状态回执不完整，请刷新核对');
    applyLibraryAssetMoves([{ ...result, oldPath: result.oldPath || target.path }], projectId);
    await loadLibrary({ select: selectedFolder });
    if (current()) showToast(`已归为${disposition === 'processing' ? '待处理' : '可剪辑'}，网站和集数不变`);
  } catch (error) { if (current()) showToast(`状态转换失败：${error.message}`); }
  finally {
    state.dispositionBusy = false; libraryMutationDepth--; updateSelectionBar(); updateFolderActions();
    if (projectRefreshNeeded) scheduleLibraryReload(true);
  }
}

/* ---------- 多选批量操作 ---------- */

function libraryCreativeSelection(paths = state.selectedPaths) {
  const project = state.config?.project;
  const root = project?.folder;
  const downloads = project?.categories?.find(category => category.id === 'browser-downloads')?.path;
  const available = new Map(state.assets.map(item => [item.path, item]));
  return [...new Set(paths)].filter(path => {
    const item = available.get(path);
    return typeof path === 'string' && !!item && item.kind !== 'folder' && !item.browserDownload
      && !path.startsWith('download:') && !GeneratedVideoLayout.isVirtualPath(path)
      && (!root || path.startsWith(`${root}/`))
      && (!downloads || (path !== downloads && !path.startsWith(`${downloads}/`)))
      && item.downloadState !== 'progressing' && item.downloadState !== 'paused';
  });
}

function updateSelectionBar() {
  const count = state.selectedPaths.size;
  const deletable = libraryCreativeSelection().length;
  el.selectionBar.hidden = count === 0;
  el.selectionCount.textContent = `已选 ${count} 项${deletable !== count ? ` · 可删 ${deletable} 项` : ''}`;
  el.batchDelete.disabled = libraryActionBusy() || deletable === 0;
  el.batchDelete.title = deletable !== count ? '只删除创作资产；浏览器下载请使用专用删除' : '将选中素材移到废纸篓';
  el.batchDelete.textContent = state.batchDeleteBusy ? '正在删除…' : '批量删除';
  el.batchMove.disabled = libraryActionBusy();
  el.clearSelection.disabled = libraryActionBusy();
  el.selectVisible.disabled = libraryActionBusy();
  document.querySelectorAll('.asset-card').forEach(card => {
    card.classList.toggle('selected', state.selectedPaths.has(card.dataset.path));
  });
  document.querySelectorAll('.asset-check').forEach(button => {
    button.classList.toggle('checked', state.selectedPaths.has(button.dataset.checkPath));
    button.disabled = libraryActionBusy();
  });
  document.querySelectorAll('.asset-delete-button').forEach(button => { button.disabled = libraryActionBusy(); });
}

function toggleSelection(path) {
  if (libraryActionBusy()) return;
  if (state.selectedPaths.has(path)) state.selectedPaths.delete(path);
  else state.selectedPaths.add(path);
  state.lastCheckedPath = path;
  updateSelectionBar();
}

function clearSelection() {
  if (libraryActionBusy()) return;
  state.selectedPaths.clear();
  updateSelectionBar();
}

async function normalizeNames() {
  if (libraryActionBusy()) { showToast('素材正在处理，请稍候'); return; }
  if (rejectHistoryWrite(state.selectedFolder)) return;
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
    updateFolderActions();
  }
}

async function batchDeleteSelected() {
  if (libraryActionBusy()) return;
  const paths = libraryCreativeSelection();
  if (!paths.length) { showToast('请先选择创作资产；浏览器下载不参与普通素材批量删除'); return; }
  if (typeof API.deleteItems !== 'function') { showToast('批量删除需要最新版桌面软件'); return; }
  const projectId = activeProjectId(), generation = state.projectGeneration;
  const stillCurrent = () => projectId === activeProjectId() && generation === state.projectGeneration && !projectRefreshNeeded;
  state.batchDeleteBusy = true;
  libraryMutationDepth++; clearTimeout(reloadTimer);
  // 批次前发出的目录读取不能在确认或删除之后把旧卡片恢复到列表。
  libraryRequestId++;
  updateSelectionBar(); updateFolderActions();
  try {
    // 原生层一次确认并绑定本次剧本；不逐项调用无项目快照的旧接口。
    const result = await API.deleteItems({ projectId, paths });
    if (!stillCurrent()) return;
    if (result?.projectId !== projectId || !Array.isArray(result.deleted) || !Array.isArray(result.failed)
      || result.deleted.some(path => !paths.includes(path))) throw new Error('批量删除回执不完整，请刷新核对');
    if (result.cancelled && result.deleted.length === 0) { showToast('已取消删除，选择保留'); return; }
    const deleted = new Set(result.deleted);
    deleted.forEach(path => libraryRecentDeletes.set(`${projectId}\n${path}`, Date.now()));
    applyLibraryAssetDeletions([...deleted], projectId);
    const failed = result.failed;
    const summary = `已移到废纸篓 ${deleted.size} 项${result.cancelled ? '；已停止后续删除' : ''}${failed.length
      ? `；失败 ${failed.length} 项，仍存在的失败项保留选中；${failed[0].error || '请重试'}` : ''}`;
    try { await loadLibrary({ select: state.selectedFolder }); }
    catch (error) {
      if (stillCurrent()) showToast(`${summary}；列表刷新失败，请刷新核对：${error.message}`);
      return;
    }
    if (!stillCurrent()) return;
    showToast(summary);
  } catch (error) {
    if (stillCurrent()) showToast(`批量删除失败，选择保留：${error.message}`);
  } finally {
    state.batchDeleteBusy = false;
    libraryMutationDepth--;
    updateSelectionBar(); updateFolderActions();
    // 不能清掉切剧本事件的待刷新计时器，即使旧批次刚刚返回。
    if (projectRefreshNeeded) scheduleLibraryReload(true);
  }
}

function applyLibraryAssetDeletions(paths, projectId = activeProjectId()) {
  if (projectId !== activeProjectId() || !paths.length) return;
  const deleted = new Set(paths);
  deleted.forEach(path => state.selectedPaths.delete(path));
  if (state.preview && deleted.has(state.preview.path)) closePreviewNow();
  if (state.tree) {
    const prune = node => {
      if (node.kind === 'file') return deleted.has(node.path) ? null : node;
      node.children = (node.children || []).map(prune).filter(Boolean);
      node.fileCount = node.children.reduce((count, child) => count + (child.kind === 'file' ? 1 : child.fileCount || 0), 0);
      return node;
    };
    prune(state.tree);
    collectTree(state.tree);
    // GET 失败时也不沿用删除前的总数/总大小；只陈述当前已核对的缓存。
    el.librarySummary.textContent = `${state.config.project?.name || state.config.rootName || '创作资产库'} · 缓存剩 ${state.tree.fileCount || 0} 项 · 正在核对目录`;
    renderFolders(); renderAssets({ preserveScroll: true });
  }
  updateSelectionBar();
}

function setZoom(value) {
  const zoom = Math.max(50, Math.min(220, Number(value) || 100));
  el.zoomRange.value = String(zoom);
  el.zoomValue.textContent = `${zoom}%`;
  const image = el.previewMedia.querySelector('img');
  if (image) image.style.transform = `scale(${zoom / 100})`;
}

let voiceEditor = null;
function clearPreview() {
  voiceEditor?.destroy(); voiceEditor = null;
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
  // 清理改由 close 事件统一执行（bindEvents 已监听），退出动画期间预览画面保持原样。
  closeCreatorDialog(el.previewDialog);
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
    if (item.type === 'video') voiceEditor = window.VoiceClipEditor?.mount({
      host: document.getElementById('voiceClipHost'),
      actions: el.previewDialog.querySelector('.preview-primary-actions'),
      item, video: media, getProjectId: activeProjectId,
      exportAudio: typeof API.saveAudioAs === 'function' ? file => API.saveAudioAs(file) : undefined,
      onSaved: async () => { await loadLibrary(); showToast('人物音频已保存到本剧'); },
    });
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
  openCreatorDialog(el.previewDialog);
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
  card.addEventListener('contextmenu', event => showLibraryFileMenu(item, event));
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
  name.contentEditable = 'plaintext-only';
  name.tabIndex = 0;
  name.setAttribute('role', 'textbox');
  name.setAttribute('aria-label', '素材名称');
  name.title = '点击改名；Enter 保存，Esc 取消';
  name.addEventListener('click', event => event.stopPropagation());
  name.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation(); });
  name.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); name.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); name.textContent = item.name; name.blur(); }
  });
  name.addEventListener('blur', async () => {
    const value = name.textContent.trim();
    if (!value || value === item.name) { name.textContent = item.name; return; }
    try {
      const result = await postAssetAction('rename', { path: item.path, name: value });
      showToast(`已重命名为「${result.name}」`);
      await loadLibrary({ select: state.selectedFolder });
    } catch (error) {
      name.textContent = item.name;
      showToast(`重命名失败：${error.message}`);
    }
  });
  const meta = document.createElement('span');
  meta.textContent = `${item.sizeText || '未知大小'} · ${item.folderPath || '创作资产库'}`;
  const titleRow = document.createElement('div');
  titleRow.className = 'asset-card-title-row';
  titleRow.append(name);
  info.append(titleRow, meta);

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
  const moveButton = document.createElement('button');
  moveButton.type = 'button';
  moveButton.textContent = '移动';
  moveButton.addEventListener('click', () => openMoveDialog([item.path]));
  titleRow.append(firstAction);
  actions.append(showButton, moveButton);

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
    if (libraryActionBusy()) { event.preventDefault(); return; }
    card.classList.add('dragging');
    // 多选后拖动任一选中卡 = 整个选中序列一起拖出（Set 迭代序即点选顺序）；
    // 拖未选中的卡仍只拖该卡本身，避免误发整批。
    const dragSelection = NATIVE_API && state.selectedPaths.size && state.selectedPaths.has(item.path)
      ? [...state.selectedPaths]
      : null;
    el.assetStatus.textContent = dragSelection ? `正在拖拽：${dragSelection.length} 项选中资产` : `正在拖拽：${item.name}`;
    if (NATIVE_API) {
      event.preventDefault();
      // 旧版桌面壳可能没有 startDragSelection：回退单卡拖拽，保持兼容
      if (dragSelection && typeof API.startDragSelection === 'function') API.startDragSelection(dragSelection);
      else API.startDrag(item.path);
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
  updateLibraryScopeNote();
  el.assetHeading.textContent = state.filter === 'all' ? '常用资产' : `${TYPE_COPY[state.filter]}资产`;
  applyGridCollapse();
  updateFolderActions();

  if (!allItems.length) {
    const empty = document.createElement('div');
    empty.className = 'asset-state';
    empty.innerHTML = state.query
      ? '没有找到匹配资产。<br>可以换一个文件名或文件夹关键词。'
      : isHistoryFolderPath(state.selectedFolder)
        ? '暂无未分集素材。<br>这个入口只汇总查看，不接收新导入。'
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
  scheduleViewSave();
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
  if (rejectHistoryWrite(parent)) return;
  if (!parent) {
    showToast('请先选择一个资产文件夹');
    return;
  }
  state.folderParent = parent;
  el.folderDialogTitle.textContent = '新建子文件夹';
  el.folderDialogParent.textContent = `位置：${folderLabel(parent)}`;
  el.folderName.value = '';
  openCreatorDialog(el.folderDialog);
  requestAnimationFrame(() => el.folderName.focus());
}

async function createFolder() {
  if (rejectHistoryWrite(state.folderParent)) return;
  const name = el.folderName.value.trim();
  if (!name) { el.folderName.focus(); return; }
  const response = await fetch(`/api/creative-assets/folder?project=${encodeURIComponent(activeProjectId())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: activeProjectId(), parent: state.folderParent, name }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  closeCreatorDialog(el.folderDialog);
  await loadLibrary({ select: data.folder?.path || state.folderParent });
  showToast(`已创建：${data.folder?.path || name}`);
}

function setAudioMode(kind) {
  if (state.audioKind && state.audioKind !== kind) {
    document.querySelectorAll('#audioLibrary audio').forEach(audio => audio.pause());
  }
  state.audioKind = kind;
  updateFolderActions();
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
  openCreatorDialog(el.scriptSwitchDialog);
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
      if (project.id === activeId) { closeCreatorDialog(el.scriptSwitchDialog); return; }
      try {
        const response = await fetch(`/api/creative-projects?project=${encodeURIComponent(activeProjectId())}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'activate', id: project.id }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        adoptProject(data.project);
        closeCreatorDialog(el.scriptSwitchDialog);
        showToast(`已切换到「${project.name}」`);
        await loadLibrary();
      } catch (error) {
        showToast(`切换失败：${error.message}`);
      }
    });
    el.scriptSwitchList.appendChild(row);
  }
}

async function importFiles(files, { renameSequentially = false } = {}) {
  if (state.audioKind) return importAudioFiles(files);
  if (libraryActionBusy()) { showToast('素材正在处理，请稍候'); return; }
  if (rejectHistoryWrite(libraryWritableFolder())) return;
  if (state.importBusy) { showToast('正在导入，请稍候'); return; }
  const list = Array.from(files || []);
  if (!list.length) return;
  if (!state.selectedFolder) {
    showToast('请先选择或新建一个剧本文件夹');
    return;
  }
  if (libraryPaneEl.classList.contains('grid-collapsed')) setGridCollapsed(false);
  const projectId = activeProjectId(), generation = state.projectGeneration, selectedFolder = state.selectedFolder;
  const current = () => projectId === activeProjectId() && generation === state.projectGeneration;
  let folder = selectedFolder;
  state.importBusy = true;
  el.importAssets.disabled = true;
  let imported = 0;
  const failed = [];
  try {
    folder = await prepareLibraryImportTarget(projectId, selectedFolder, generation);
    for (const file of list) {
      el.assetStatus.textContent = `正在导入 ${imported + failed.length + 1}/${list.length}：${file.name}`;
      try {
        if (!current()) throw new Error('剧本已切换，该文件未导入');
        const url = `/api/creative-assets/import?project=${encodeURIComponent(projectId)}&folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}&naming=${renameSequentially ? 'sequential' : 'original'}`;
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        imported++;
      } catch (error) {
        failed.push(`${file.name}：${error.message}`);
      }
    }
  } catch (error) { failed.push(error.message); }
  finally { state.importBusy = false; updateFolderActions(); }
  el.assetFileInput.value = '';
  if (!current()) return;
  await loadLibrary({ select: state.selectedFolder }).catch(error => showToast(error.message));
  if (!current()) return;
  el.assetStatus.textContent = failed.length ? `已导入 ${imported} 项，${failed.length} 项失败` : `已导入 ${imported} 项到 ${folderLabel(folder)}`;
  showToast(failed.length ? `已导入 ${imported} 项；${failed[0]}` : `已导入 ${imported} 项资产`);
}

function bindEvents() {
  el.folderTree.addEventListener('contextmenu', event => {
    if (event.target.closest('.folder-row, .folder-file, input, button')) return;
    showLibraryFolderMenu(null, event);
  });
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
  el.scriptSwitchClose.addEventListener('click', () => closeCreatorDialog(el.scriptSwitchDialog));
  el.scriptSwitchCancel.addEventListener('click', () => closeCreatorDialog(el.scriptSwitchDialog));
  el.scriptSwitchDialog.addEventListener('click', event => {
    if (event.target === el.scriptSwitchDialog) closeCreatorDialog(el.scriptSwitchDialog);
  });
  el.importAssets.addEventListener('click', () => {
    if (state.audioKind) { pickAudioFile(); return; }
    if (rejectHistoryWrite(libraryWritableFolder())) return;
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
    if (isHistoryFolderPath(libraryWritableFolder())) { event.dataTransfer.dropEffect = 'none'; return; }
    assetDragDepth += 1;
    dropTarget.classList.add('is-drop-import');
    // 折叠状态下拖入文件：自动展开列表，让用户看到落点与导入结果。
    if (libraryPaneEl.classList.contains('grid-collapsed')) setGridCollapsed(false);
  });
  dropTarget.addEventListener('dragover', event => {
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    if (isHistoryFolderPath(libraryWritableFolder())) { event.dataTransfer.dropEffect = 'none'; return; }
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
    if (rejectHistoryWrite(libraryWritableFolder())) return;
    importFiles(event.dataTransfer.files, { renameSequentially: true });
  });
  el.newSubfolder.addEventListener('click', () => openFolderDialog({ parent: state.selectedFolder }));
  el.folderForm.addEventListener('submit', event => {
    event.preventDefault();
    createFolder().catch(error => showToast(`创建失败：${error.message}`));
  });
  const closeFolder = () => closeCreatorDialog(el.folderDialog);
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
  el.cancelRename.addEventListener('click', () => closeCreatorDialog(el.renameDialog));
  el.cancelRenameTop.addEventListener('click', () => closeCreatorDialog(el.renameDialog));
  el.renameDialog.addEventListener('click', event => { if (event.target === el.renameDialog) closeCreatorDialog(el.renameDialog); });
  el.cancelMove.addEventListener('click', () => closeCreatorDialog(el.moveDialog));
  el.cancelMoveTop.addEventListener('click', () => closeCreatorDialog(el.moveDialog));
  el.moveDialog.addEventListener('click', event => { if (event.target === el.moveDialog) closeCreatorDialog(el.moveDialog); });
  // Esc 走原生 cancel：默认立即 close 会跳过退出动画，统一转交动画关闭；
  // 关闭动画期间重复触发由 closeCreatorDialog 的幂等守卫兜住。
  [el.previewDialog, el.folderDialog, el.renameDialog, el.moveDialog, el.scriptSwitchDialog].forEach(dialog => {
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeCreatorDialog(dialog);
    });
  });
  // 与主窗口一致的开关回弹：本页大量 aria-pressed 开关，点击时统一播放一次 motion-tick。
  document.addEventListener('click', event => {
    const toggle = event.target.closest?.('button[aria-pressed]');
    if (toggle) playMotionClass(toggle, 'motion-tick', 320, ['motionTick']);
  });
  // 多选批量操作栏
  el.selectVisible.addEventListener('click', () => {
    if (libraryActionBusy()) return;
    document.querySelectorAll('.asset-card').forEach(card => state.selectedPaths.add(card.dataset.path));
    updateSelectionBar();
    // 网格有 120 项渲染上限：库更大时「全选」只覆盖已渲染部分，必须说清楚，避免误以为全库都已选中
    const rendered = document.querySelectorAll('.asset-card').length;
    if (state.assets.length > rendered) {
      showToast(`已选中当前显示的 ${rendered} 项；库共 ${state.assets.length} 项，可用搜索缩小范围后再全选`);
    }
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
    // ok:true 仅代表拖拽会话已发起（主进程 startDrag 已调用），不等于剪映等目标应用最终收到素材，
    // 文案据实说明；整批时主进程回执带 count，旧单卡回执无 count 则按默认措辞显示。
    if (result?.ok) el.assetStatus.textContent = `已开始拖拽${result.count > 1 ? ` ${result.count} 项` : ''}，松手放入目标窗口`;
    else {
      el.assetStatus.textContent = '拖拽失败；可改用平台上传按钮或 Finder 定位';
      showToast(result?.error || '资产拖拽失败');
    }
  });
  if (typeof API.onDownloadEpisodesChanged === 'function') API.onDownloadEpisodesChanged(batch => {
    applyLibraryDownloadBatch(batch);
  });
  bindResize();
}

async function loadLibrary({ select } = {}) {
  const requestId = ++libraryRequestId;
  const projectId = activeProjectId();
  if (typeof API.getConfig === 'function') {
    const config = await API.getConfig();
    if (requestId !== libraryRequestId || projectId !== activeProjectId()) return;
    if (config.project?.id === projectId) {
      state.config.downloadEpisodes = config.downloadEpisodes;
      state.config.archiveMetadataError = config.archiveMetadataError || '';
    }
  }
  if (NATIVE_API && typeof API.getDownloadEpisodes === 'function') {
    try {
      const batch = await API.getDownloadEpisodes();
      if (requestId !== libraryRequestId || projectId !== activeProjectId()) return;
      if (!validLibraryBatch(batch, projectId)) throw new Error('网站归档信息暂未读取');
      state.config.downloadEpisodes = batch; state.config.archiveMetadataError = '';
    } catch (error) { if (requestId !== libraryRequestId || projectId !== activeProjectId()) return; state.config.archiveMetadataError = error.message; }
  }
  if (!validLibraryBatch(state.config.downloadEpisodes, projectId)) {
    const archive = await readLibraryDownloadEpisodes(projectId);
    if (requestId !== libraryRequestId || projectId !== activeProjectId()) return;
    state.config.downloadEpisodes = archive.batch; state.config.archiveMetadataError = archive.error;
  }
  // 后台刷新（SSE creative-assets → scheduleLibraryReload）不再无条件清空多选：
  // 先留存本次刷新前的选择，新树就绪后做交集，只移除已不存在的路径，
  // 避免用户正在攒整批拖出时被“生成完成/其他窗口导入”的刷新打断。
  const previousSelection = new Set(state.selectedPaths);
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
  // 交集守卫：只保留当前树中仍存在的选中路径。
  // 跨项目切换时新树不含旧项目路径 → 交集自然为空，等效于旧的“整单清空”，无需特殊分支；
  // 资产被删除导致的失效收缩走同一交集，被收缩数量 >0 时给出提示。
  const existing = new Set(state.assets.map(item => item.path));
  const keptSelection = [...previousSelection].filter(path => existing.has(path));
  if (keptSelection.length < previousSelection.size) {
    showToast(`已自动移除 ${previousSelection.size - keptSelection.length} 个失效选项`);
  }
  state.selectedPaths = new Set(keptSelection);
  const stats = data.stats || {};
  el.librarySummary.textContent = `${state.config.project?.name || data.rootName || '创作资产库'} · ${stats.files || 0} 项 · ${stats.sizeText || '0 B'}`;
  renderFolders();
  renderAssets({ preserveScroll: true });
  if (pendingView) {
    el.assetGrid.scrollTop = Math.max(0, Number(pendingView.scroll) || 0);
    el.folderTree.scrollTop = Math.max(0, Number(pendingView.treeScroll) || 0);
    pendingView = null;
  }
  // 选择栏与卡片选中态跟随最终选择结果（renderAssets 已按 selectedPaths 渲染卡片），
  // 而不是每次刷新都无条件隐藏。
  updateSelectionBar();
  if (state.audioKind) await loadAudioLibrary();
  el.assetStatus.textContent = state.audioKind ? '填写名称或拖入音频；支持 MP3、WAV、M4A'
    : data.truncated
    ? '资产较多，当前只显示安全索引范围内的项目'
    : state.assets.length
      ? '选择本地文件保留原名；外部拖入按分类编号；汇总分组只查看，不作为存入目录'
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
    if (state.config.candidate) {
      document.querySelector('.asset-title strong').textContent = '创作资产库 · 候选版';
      document.title = `创作资产库 · 候选版 ${state.config.candidate.version || ''}｜视频制作 OS`;
    }
    restoreAssetView();
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
    events.addEventListener('creative-assets', event => {
      let duplicate = false;
      try {
        const data = JSON.parse(event.data);
        const mutations = [...(data.moves || []).map(move => Date.now() - (libraryRecentMoves.get(`${move.oldPath}\n${move.path}`) || 0) < 3000),
          ...(data.copies || []).map(copy => Date.now() - (libraryRecentCopies.get(`${copy.sourcePath}\n${copy.path}`) || 0) < 3000),
          ...(data.deleted || []).map(path => Date.now() - (libraryRecentDeletes.get(`${data.projectId}\n${path}`) || 0) < 3000)];
        duplicate = mutations.length && mutations.every(Boolean);
        applyLibraryFolderRename(data.folderRename);
        applyLibraryAssetMoves(data.moves, data.projectId);
        if (data.deleted?.length && !state.batchDeleteBusy) applyLibraryAssetDeletions(data.deleted, data.projectId);
      } catch {}
      if (!duplicate) scheduleLibraryReload();
    });
    // 剧本被其他入口（创作浏览器/主窗口）切换时，面板原地跟随新剧本。
    events.addEventListener('creative-projects', event => {
      try { adoptProject(JSON.parse(event.data).project); } catch {}
      scheduleLibraryReload(true);
    });
    events.addEventListener('download-episodes', event => {
      try { applyLibraryDownloadBatch(JSON.parse(event.data)); } catch {}
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
