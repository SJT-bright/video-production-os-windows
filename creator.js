/* ================= 创作浏览器工作台 ================= */
'use strict';

const API = typeof window.creatorOS?.getConfig === 'function' ? window.creatorOS : window.creatorAPI;
const LEGACY_STORAGE_KEY = 'videoOS.creator.workspace.v1';
const GLOBAL_STORAGE_KEY = 'videoOS.creator.global.v2';
const PROJECT_STORAGE_PREFIX = 'videoOS.creator.project.v2.';
const ASSET_LAYOUT_VERSION = 3;
const DEFAULT_ASSET_PANEL = Object.freeze({ open: false, layout: 'overlay', width: 520, layoutVersion: ASSET_LAYOUT_VERSION });

const MODE_COPY = Object.freeze({
  image: { label: '图片提示词', placeholder: '粘贴或输入图片提示词…' },
  video: { label: '视频提示词', placeholder: '粘贴或输入视频提示词…' },
});

function withoutLegacySkeleton(mode, value) {
  const text = typeof value === 'string' ? value : '';
  const isImageSkeleton = mode === 'image' && text.includes('【参考图清单】') && text.includes('【可复制图片提示词】');
  const isVideoSkeleton = mode === 'video' && text.includes('【时长预算】') && text.includes('【可复制视频提示词】');
  return isImageSkeleton || isVideoSkeleton ? '' : text;
}

const state = {
  config: null,
  projectId: new URLSearchParams(location.search).get('project') || 'inspiration',
  mode: new URLSearchParams(location.search).get('mode') === 'video' ? 'video' : 'image',
  prompts: { image: '', video: '' },
  services: { image: 'gpt', video: 'updream' },
  history: { image: [], video: [] },
  promptTemplates: { image: [], video: [] },
  accordions: { prompt: false, assets: true },
  quickFolders: [],
  quickAssetFolder: '',
  collapsedQuickFolders: new Set(),
  quickCollapseInit: false,
  quickSelectMode: false,
  quickSelectionOrder: [],
  skipClearConfirm: false,
  activeService: null,
  assetItems: [],
  downloads: new Map(),
  promptAtStart: new Map(), // 下载开始时的提示词快照，完成后写入血缘 sidecar
  lineageWritten: new Set(),
  production: { available: false, context: null, inbox: [], stats: {} },
  browser: null,
  modeSwitchPending: false,
  assetPanel: { ...DEFAULT_ASSET_PANEL },
};

const el = Object.fromEntries([
  'platformTabs', 'addPlatform', 'clearBrowserTabs', 'platformPopover', 'platformForm', 'platformName', 'platformUrl', 'cancelPlatform',
  'platformOpenList', 'duplicateTab', 'duplicateTabLabel',
  'renameDialog', 'renameForm', 'renameTitle', 'renameName', 'renameError', 'renameCancel', 'renameSave',
  'hiddenPlatforms', 'hiddenPlatformList', 'restoreAllPlatforms',
  'draftStatus',
  'promptAccordion', 'promptAccordionCount', 'assetAccordion', 'assetAccordionCount',
  'promptTemplateList',
  'templateCreate', 'templateCreateForm', 'templateCreateName', 'templateCreateBody', 'cancelTemplateCreate',
  'quickFolderTree', 'quickDropTarget', 'quickFileInput',
  'importLocalAssets', 'openAssetLibrary', 'toggleDragTray', 'assetDropZone',
  'quickTools', 'quickMultiSelect', 'quickSelInfo', 'quickSelClear',
  'downloadSummary', 'downloadList', 'openModeFolder', 'browserStage', 'addressService',
  'browserPlaceholderTitle', 'reconnectBrowser',
  'addressForm', 'addressInput', 'addressGo', 'loadDot', 'openExternal', 'togglePrompt', 'showMainWindow', 'creatorToast',
  'importDownloadedFiles', 'browserRecovery',
  'browserRecoveryMessage', 'browserRecoveryUrl', 'browserRecoveryReload',
  'browserRecoveryExternal', 'browserRecoveryImport', 'toggleAssets',
  'downloadBadge',
  'currentProject',
  'promptEditor', 'characterCount', 'copyPrompt',
  'clearPrompt', 'clearPromptDialog', 'clearPromptConfirm', 'clearPromptCancel', 'clearPromptNever',
  'quickPreviewDialog', 'quickPreviewName', 'quickPreviewMeta', 'quickPreviewStage', 'quickPreviewClose', 'quickPreviewDone', 'quickPreviewInLibrary',
].map(id => [id, document.getElementById(id)]));

let toastTimer = null;
let saveTimer = null;
let boundsFrame = null;
let assetPanelSaveTimer = null;
let assetDragDepth = 0;

function showToast(message, options = {}) {
  const text = document.createElement('span');
  text.textContent = message;
  el.creatorToast.replaceChildren(text);
  if (options.actionLabel && typeof options.onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = options.actionLabel;
    action.addEventListener('click', () => {
      clearTimeout(toastTimer);
      el.creatorToast.classList.remove('show');
      options.onAction();
    });
    el.creatorToast.appendChild(action);
  }
  el.creatorToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.creatorToast.classList.remove('show'), options.actionLabel ? 5200 : 2200);
}

function loadWorkspace() {
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{}');
    const global = JSON.parse(localStorage.getItem(GLOBAL_STORAGE_KEY) || '{}');
    const canMigrateLegacy = !localStorage.getItem(`${PROJECT_STORAGE_PREFIX}${state.projectId}`)
      && state.config?.project?.folder === '青春校园短剧';
    const saved = JSON.parse(localStorage.getItem(`${PROJECT_STORAGE_PREFIX}${state.projectId}`) || '{}');
    const project = canMigrateLegacy ? legacy : saved;
    const globalTemplatesMissing = !global.templates;
    for (const mode of ['image', 'video']) {
      if (typeof project.prompts?.[mode] === 'string') state.prompts[mode] = withoutLegacySkeleton(mode, project.prompts[mode]);
      if (typeof global.services?.[mode] === 'string') state.services[mode] = global.services[mode];
      else if (typeof legacy.services?.[mode] === 'string') state.services[mode] = legacy.services[mode];
      if (Array.isArray(project.history?.[mode])) {
        state.history[mode] = project.history[mode]
          .filter(item => item && typeof item.body === 'string' && item.at)
          .slice(0, 20);
      }
      // 固定提示词跨剧本通用：优先读全局；旧数据存在各剧本下时自动提升为全局。
      if (Array.isArray(global.templates?.[mode])) {
        state.promptTemplates[mode] = global.templates[mode]
          .filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string')
          .slice(0, 50);
      } else if (Array.isArray(project.promptTemplates?.[mode])) {
        state.promptTemplates[mode] = project.promptTemplates[mode]
          .filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string')
          .slice(0, 50);
      }
    }
    if (globalTemplatesMissing) saveWorkspace(true);
    const savedPanel = global.assetPanel || legacy.assetPanel;
    if (savedPanel && typeof savedPanel === 'object') {
      state.assetPanel = {
        open: savedPanel.open !== false,
        // 升级时改用按需浮窗；此后仍记住用户主动选择的并排方式。
        layout: savedPanel.layoutVersion === ASSET_LAYOUT_VERSION && savedPanel.layout === 'push' ? 'push' : 'overlay',
        layoutVersion: ASSET_LAYOUT_VERSION,
        width: Number.isFinite(Number(savedPanel.width))
          ? Math.max(360, Math.min(760, Math.round(Number(savedPanel.width))))
          : DEFAULT_ASSET_PANEL.width,
      };
    }
    if (typeof global.skipClearConfirm === 'boolean') state.skipClearConfirm = global.skipClearConfirm;
    if (global.accordions && typeof global.accordions === 'object') {
      state.accordions.prompt = global.accordions.prompt === true;
      state.accordions.assets = global.accordions.assets !== false;
    }
    const currentPromptHasContent = !!state.prompts[state.mode].trim();
    const currentModeHasTemplates = state.promptTemplates[state.mode].length > 0;
    if (!currentPromptHasContent && !currentModeHasTemplates) state.accordions.prompt = false;
    if (canMigrateLegacy) saveWorkspace(true);
  } catch {
    showToast('旧工作区状态无法读取，已使用空白创作栏');
  }
}

function resetProjectWorkspace() {
  state.prompts = { image: '', video: '' };
  state.history = { image: [], video: [] };
  // 固定提示词是全局资产，切换剧本时不清空。
  state.assetItems = [];
  state.accordions.prompt = false;
  // 框选导入序列属于旧剧本：整体清空，防止把旧项目资产拖进新项目上下文。
  state.quickSelectionOrder.length = 0;
}

function saveWorkspace(immediate = false) {
  clearTimeout(saveTimer);
  // 防抖提交可能在切换剧本之后才落地：调度时快照项目数据，提交时按快照写回原剧本，
  // 避免输入后立即切剧本把 A 的草稿/历史写进 B 的存储。
  const snapshot = {
    projectId: state.projectId,
    prompts: { ...state.prompts },
    history: { image: [...state.history.image], video: [...state.history.video] },
  };
  const commit = () => {
    localStorage.setItem(GLOBAL_STORAGE_KEY, JSON.stringify({
      version: 2,
      services: state.services,
      assetPanel: state.assetPanel,
      accordions: state.accordions,
      templates: state.promptTemplates,
      skipClearConfirm: state.skipClearConfirm,
    }));
    const projectKey = `${PROJECT_STORAGE_PREFIX}${snapshot.projectId}`;
    // 保留旧版本的存储字段；已停用功能不再读取或更新，避免清掉用户历史内容。
    let previous = {};
    try { previous = JSON.parse(localStorage.getItem(projectKey) || '{}'); } catch {}
    localStorage.setItem(projectKey, JSON.stringify({
      ...previous,
      version: 2,
      projectId: snapshot.projectId,
      prompts: snapshot.prompts,
      history: snapshot.history,
    }));
    el.draftStatus.textContent = '已在本机自动保存';
  };
  if (immediate) commit();
  else {
    el.draftStatus.textContent = '正在保存…';
    saveTimer = setTimeout(commit, 260);
  }
}

/* 提示词历史：编辑停顿 6 秒后落一版快照，最多保留 20 版 */
let historyTimer = null;
function pushHistorySnapshotNow() {
  const body = state.prompts[state.mode];
  const list = state.history[state.mode];
  if (list[0] && list[0].body === body) return;
  list.unshift({ at: Date.now(), body });
  if (list.length > 20) list.length = 20;
}

function scheduleHistorySnapshot() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    pushHistorySnapshotNow();
    saveWorkspace(true);
  }, 6000);
}


/* 下载血缘：开始时记住提示词，归档完成后写 sidecar 到素材旁边 */
async function writeLineageSidecar(download) {
  if (!download.savePath || !['video', 'audio', 'image'].includes(download.kind)) return 'skipped';
  const mode = download.mode === 'video' ? 'video' : 'image';
  const prompt = state.promptAtStart.has(download.id)
    ? state.promptAtStart.get(download.id)
    : state.prompts[mode] || '';
  if (!prompt.trim()) return 'empty';
  try {
    const response = await fetch('/api/prompt-sidecar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: download.savePath,
        prompt,
        service: download.serviceLabel || serviceLabel(serviceById(download.serviceId), mode),
        mode,
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return 'saved';
  } catch (error) {
    return `error:${error.message || '未知错误'}`;
  }
}

function serviceById(serviceId) {
  return state.config?.services.find(service => service.id === serviceId) || null;
}

function serviceLabel(service, mode = state.mode) {
  if (!service) return '创作平台';
  if (service.displayName) return service.displayName;
  return (mode === 'image' ? service.imageLabel : service.videoLabel) || service.label;
}

function validServiceForMode(mode, serviceId) {
  return !!state.config?.modeServices?.[mode]?.includes(serviceId);
}

function effectiveServiceForMode(mode) {
  const remembered = state.services[mode];
  if (validServiceForMode(mode, remembered)) return remembered;
  const configuredDefault = state.config?.defaults?.[mode];
  if (validServiceForMode(mode, configuredDefault)) return configuredDefault;
  return state.config?.modeServices?.[mode]?.[0] || null;
}

/* 编辑器草稿按剧本存于 state.prompts；输入即存，切模式/切剧本时由 renderMode 回填。 */
function updateCharacterCount() {
  el.characterCount.textContent = `${el.promptEditor.value.length} 字`;
}

function syncPromptEditor() {
  el.promptEditor.value = state.prompts[state.mode];
  updateCharacterCount();
}

/* 清空撤销：快照绑定清空发生时的剧本与模式，跨剧本/跨模式或已有新输入时拒绝恢复，
   避免 A 剧本草稿被覆盖到 B；撤销窗口与 toast 的 5.2 秒存活期一致。 */
let pendingClearUndo = null;
let clearUndoTimer = null;

function undoClearPrompt() {
  const snapshot = pendingClearUndo;
  pendingClearUndo = null;
  clearTimeout(clearUndoTimer);
  if (!snapshot) return;
  if (snapshot.projectId !== state.projectId || snapshot.mode !== state.mode) {
    showToast('已切换剧本或模式，原内容无法在此恢复');
    return;
  }
  if (el.promptEditor.value.length > 0) {
    showToast('编辑器已有新内容，未执行恢复');
    return;
  }
  state.prompts[state.mode] = snapshot.body;
  el.promptEditor.value = snapshot.body;
  updateCharacterCount();
  saveWorkspace(true);
}

function clearPromptEditor() {
  pendingClearUndo = { projectId: state.projectId, mode: state.mode, body: state.prompts[state.mode] };
  clearTimeout(clearUndoTimer);
  clearUndoTimer = setTimeout(() => { pendingClearUndo = null; }, 6000);
  pushHistorySnapshotNow();
  state.prompts[state.mode] = '';
  el.promptEditor.value = '';
  updateCharacterCount();
  saveWorkspace(true);
  showToast('已清空', { actionLabel: '撤销', onAction: undoClearPrompt });
}

function renderMode() {
  document.body.dataset.mode = state.mode;
  document.title = `${state.mode === 'image' ? '图片' : '视频'}创作浏览器｜视频制作 OS`;
  document.querySelectorAll('.mode-button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
  });
  renderPlatforms();
  renderPromptTemplates();
  syncPromptEditor();
  renderQuickFolderTree();
  renderDownloads();
  syncAccordionState();
  queueBoundsUpdate();
}

function renderProject() {
  const project = state.config?.project;
  const label = project?.name || (state.projectId === 'inspiration' ? '灵感生成' : '当前剧本');
  el.currentProject.textContent = `${label} ⌄`;
  el.currentProject.title = `当前：${label}。下拉快速切换剧本`;
  el.currentProject.setAttribute('aria-label', `当前剧本：${label}，下拉选择其他剧本`);
}

let projectChangeTask = Promise.resolve();
let projectMenuOpen = false;

function queueProjectChange(project) {
  projectChangeTask = projectChangeTask.catch(() => {}).then(() => applyProjectChange(project));
  return projectChangeTask;
}

async function openProjectMenu() {
  if (projectMenuOpen) return;
  if (typeof API.showProjectMenu !== 'function') {
    showToast('请完全退出并重新打开更新后的 Mac 版，以启用剧本下拉菜单');
    return;
  }
  projectMenuOpen = true;
  closePlatformPopover();
  el.currentProject.setAttribute('aria-expanded', 'true');
  try {
    await projectChangeTask.catch(() => {});
    saveWorkspace(true);
    const rect = el.currentProject.getBoundingClientRect();
    const result = await API.showProjectMenu({ mode: state.mode, x: rect.left, y: rect.bottom + 5 });
    el.currentProject.setAttribute('aria-expanded', 'false');
    if (result?.project) {
      el.currentProject.setAttribute('aria-busy', 'true');
      // Also handle the invoke result; queuing makes it safe if the project event arrived first.
      await queueProjectChange(result.project);
    }
    if (!result?.manage) el.currentProject.focus({ preventScroll: true });
  } catch (error) {
    showToast(`切换剧本失败：${error.message}`);
  } finally {
    projectMenuOpen = false;
    el.currentProject.setAttribute('aria-expanded', 'false');
    el.currentProject.removeAttribute('aria-busy');
  }
}

async function applyProjectChange(project) {
  if (!project?.id || project.id === state.projectId) {
    if (project) {
      state.config.project = project;
      renderProject();
    }
    return;
  }
  saveWorkspace(true);
  state.projectId = project.id;
  resetProjectWorkspace();
  state.config = await API.getConfig();
  state.config.project = state.config.project || project;
  loadWorkspace();
  state.downloads.clear();
  for (const download of await API.getDownloads()) state.downloads.set(download.id, download);
  try { await loadProduction(true); }
  catch (error) {
    state.production = { available: false, context: null, inbox: [], stats: {}, error: error.message };
  }
  state.activeService = effectiveServiceForMode(state.mode);
  renderProject();
  renderMode();
  if (state.browser) applyBrowserState(state.browser);
  await loadAssetItems();
  showToast(`已切换到「${project.name}」`);
}

function visibleTabs() {
  const tabs = state.browser?.tabs || [];
  return tabs.filter(tab => tab.mode === state.mode && validServiceForMode(state.mode, tab.serviceId));
}

function tabsWithIndexes(tabs) {
  const counts = new Map();
  return tabs.map(tab => {
    const index = (counts.get(tab.serviceId) || 0) + 1;
    counts.set(tab.serviceId, index);
    return { ...tab, index };
  });
}

function renderPlatforms() {
  const scrollLeft = el.platformTabs.scrollLeft;
  el.platformTabs.replaceChildren();
  for (const tab of tabsWithIndexes(visibleTabs())) {
    const service = serviceById(tab.serviceId);
    const baseLabel = serviceLabel(service);
    const label = tab.customName || (tab.index > 1 ? `${baseLabel}·${tab.index}` : baseLabel);
    const wrapper = document.createElement('span');
    wrapper.className = 'platform-tab-wrap closable';
    const button = document.createElement('button');
    button.className = 'platform-tab' + (tab.active ? ' active' : '');
    button.type = 'button';
    button.dataset.tabId = tab.id;
    button.dataset.service = tab.serviceId;
    button.textContent = label;
    button.title = `${label}｜双击、右键或按 F2 改名`;
    button.setAttribute('aria-current', tab.active ? 'page' : 'false');
    button.addEventListener('click', () => selectTab(tab.id));
    button.addEventListener('dblclick', () => openRenameDialog('tab', tab.id, label));
    button.addEventListener('contextmenu', event => {
      event.preventDefault();
      openRenameDialog('tab', tab.id, label);
    });
    button.addEventListener('keydown', event => {
      if (event.key !== 'F2') return;
      event.preventDefault();
      openRenameDialog('tab', tab.id, label);
    });
    wrapper.appendChild(button);
    // 复制标签：同一平台在旁边再开一个独立网页，可无限多开并行对话。
    const dup = document.createElement('button');
    dup.type = 'button';
    dup.className = 'platform-tab-dup';
    dup.dataset.dupTab = tab.id;
    dup.textContent = '⧉';
    dup.title = `再开一个「${label}」网页（多开并行）`;
    dup.setAttribute('aria-label', `复制标签 ${label}`);
    dup.addEventListener('click', event => {
      event.stopPropagation();
      duplicateTab(tab);
    });
    wrapper.appendChild(dup);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'platform-remove platform-tab-close';
    close.dataset.closeTab = tab.id;
    close.setAttribute('aria-label', `关闭网页 ${label}`);
    close.title = '关闭这个网页（登录保留）';
    close.textContent = '×';
    close.addEventListener('click', event => {
      event.stopPropagation();
      closeTab(tab.id);
    });
    wrapper.appendChild(close);
    el.platformTabs.appendChild(wrapper);
  }
  el.platformTabs.scrollLeft = scrollLeft;
  const duplicateService = serviceById(state.activeService);
  el.duplicateTabLabel.textContent = duplicateService ? serviceLabel(duplicateService) : '当前网站';
  el.duplicateTab.disabled = !duplicateService;
  el.clearBrowserTabs.disabled = !state.browser?.tabs?.length || state.modeSwitchPending;
  renderPlatformOpenList();
  renderHiddenPlatforms();
  renderPlatformCompatibility();
}

function renderPlatformOpenList() {
  el.platformOpenList.replaceChildren();
  const serviceIds = state.config?.modeServices?.[state.mode] || [];
  for (const serviceId of serviceIds) {
    const service = serviceById(serviceId);
    if (!service) continue;
    const wrapper = document.createElement('span');
    wrapper.className = 'platform-chip-wrap';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'platform-chip' + (state.activeService === serviceId ? ' active' : '');
    open.dataset.openService = serviceId;
    open.textContent = serviceLabel(service);
    open.title = `打开或聚焦 ${serviceLabel(service)}`;
    open.addEventListener('click', () => {
      closePlatformPopover();
      selectService(serviceId);
    });
    wrapper.appendChild(open);
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'platform-rename';
    rename.dataset.renameService = serviceId;
    rename.textContent = '✎';
    rename.title = '修改网站名称';
    rename.setAttribute('aria-label', `修改网站名称 ${serviceLabel(service)}`);
    rename.addEventListener('click', () => openRenameDialog('service', serviceId, serviceLabel(service)));
    wrapper.appendChild(rename);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'platform-remove';
    remove.dataset.removeService = serviceId;
    remove.setAttribute('aria-label', `${service.custom ? '删除' : '移除'}网站 ${service.label}`);
    remove.title = service.custom ? `删除 ${service.label}` : `从列表移除 ${service.label}`;
    remove.textContent = '×';
    remove.addEventListener('click', event => {
      event.stopPropagation();
      removePlatform(serviceId);
    });
    wrapper.appendChild(remove);
    el.platformOpenList.appendChild(wrapper);
  }
}

let renameTarget = null;

function openRenameDialog(kind, id, name) {
  renameTarget = { kind, id };
  el.renameTitle.textContent = kind === 'tab' ? '修改标签名称' : '修改网站名称';
  el.renameName.value = name;
  el.renameError.textContent = '';
  el.renameSave.disabled = false;
  openCreatorDialog(el.renameDialog);
  el.renameName.focus();
  el.renameName.select();
}

async function saveRenamedItem(event) {
  event.preventDefault();
  const target = renameTarget;
  const name = el.renameName.value.trim();
  if (!target || el.renameSave.disabled) return;
  if (!name) { el.renameError.textContent = '请输入名称'; return; }
  el.renameSave.disabled = true;
  try {
    if (target.kind === 'service') {
      await API.renameService(target.id, name);
      state.config = await API.getConfig();
      renderPlatforms();
    } else {
      applyBrowserState(await API.renameTab(target.id, name));
    }
    el.renameDialog.close();
    showToast('名称已保存');
    queueBoundsUpdate();
  } catch (error) {
    el.renameError.textContent = desktopBrowserError(error, '改名失败，请重试');
  } finally {
    el.renameSave.disabled = false;
  }
}

function renderHiddenPlatforms() {
  const hiddenIds = state.config?.hiddenBuiltinIds || [];
  el.hiddenPlatforms.hidden = hiddenIds.length === 0;
  el.hiddenPlatformList.replaceChildren();
  for (const serviceId of hiddenIds) {
    const service = serviceById(serviceId);
    if (!service || service.custom) continue;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'platform-restore';
    restore.dataset.restoreService = serviceId;
    restore.textContent = `＋ ${service.label}`;
    restore.setAttribute('aria-label', `恢复网站 ${service.label}`);
    restore.addEventListener('click', () => restorePlatform(serviceId));
    el.hiddenPlatformList.appendChild(restore);
  }
}

function renderPlatformCompatibility() {
  // Grok 常驻兼容提示条已移除（Chrome UA + 反自动化 + 权限放宽后不再成立）。
  // 平台真实加载失败时仍由 browserRecovery 恢复条接管提示。
}

function closePlatformPopover() {
  el.platformPopover.classList.add('hidden');
  el.addPlatform.setAttribute('aria-expanded', 'false');
}

function applyAddedCustomPlatform(service) {
  state.config.services.push(service);
  for (const mode of ['image', 'video']) {
    if (!state.config.modeServices[mode].includes(service.id)) state.config.modeServices[mode].push(service.id);
  }
}

async function addCustomPlatform(event) {
  event.preventDefault();
  const name = el.platformName.value.trim();
  const url = el.platformUrl.value.trim();
  const submit = el.platformForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    if (typeof API.addCustomService !== 'function') throw new Error('请在最新桌面版中添加网站');
    const service = await API.addCustomService({ name, url });
    applyAddedCustomPlatform(service);
    el.platformForm.reset();
    closePlatformPopover();
    await selectService(service.id);
    showToast(`已添加 ${service.label}`);
  } catch (error) {
    showToast(`网站添加失败：${error.message}`);
    if (!name) el.platformName.focus();
    else el.platformUrl.focus();
  } finally {
    submit.disabled = false;
  }
}

async function refreshPlatformConfig() {
  state.config = await API.getConfig();
  for (const mode of ['image', 'video']) state.services[mode] = effectiveServiceForMode(mode);
}

async function removePlatform(serviceId) {
  const service = serviceById(serviceId);
  if (!service) return;
  const action = service.custom ? '删除' : '从顶部移除';
  const detail = service.custom
    ? '不会删除该网站里的任何内容。'
    : '登录状态和网站数据会保留，可从＋菜单恢复。';
  if (!confirm(`${action}「${service.label}」？${detail}`)) return;
  try {
    if (typeof API.removeService !== 'function') throw new Error('请在最新桌面版中管理网站');
    await API.removeService(serviceId);
    await refreshPlatformConfig();
    if (state.activeService === serviceId) {
      state.activeService = effectiveServiceForMode(state.mode);
      await selectService(state.activeService);
    } else {
      renderPlatforms();
    }
    saveWorkspace(true);
    showToast(service.custom ? `已删除 ${service.label}` : `已从顶部移除 ${service.label}`);
  } catch (error) {
    showToast(`网站操作失败：${error.message}`);
  }
}

async function restorePlatform(serviceId) {
  try {
    if (typeof API.restoreBuiltinService !== 'function') throw new Error('请在最新桌面版中恢复网站');
    await API.restoreBuiltinService(serviceId);
    await refreshPlatformConfig();
    renderPlatforms();
    saveWorkspace(true);
    showToast(`已恢复 ${serviceById(serviceId)?.label || '网站'}`);
  } catch (error) {
    showToast(`网站恢复失败：${error.message}`);
  }
}

async function restoreAllPlatforms() {
  try {
    if (typeof API.restoreBuiltinServices !== 'function') throw new Error('请在最新桌面版中恢复网站');
    await API.restoreBuiltinServices();
    await refreshPlatformConfig();
    renderPlatforms();
    saveWorkspace(true);
    showToast('已恢复全部内置网站');
  } catch (error) {
    showToast(`网站恢复失败：${error.message}`);
  }
}

function syncAccordionState() {
  el.promptAccordion.open = !!state.accordions.prompt;
  el.assetAccordion.open = !!state.accordions.assets;
}

function copyTextToClipboard(text) {
  return navigator.clipboard.writeText(text).catch(() => {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    if (!ok) throw new Error('复制失败');
  });
}

const expandedTemplates = new Set();
const templateDrafts = new Map();
const activeTemplateIds = { image: '', video: '' };
function rememberTemplatePrompt(body, mode = state.mode) {
  if (state.prompts[mode] === body) return;
  if (mode === state.mode) pushHistorySnapshotNow();
  state.prompts[mode] = body;
  saveWorkspace(true);
}
function renderPromptTemplates() {
  const mode = state.mode;
  const items = state.promptTemplates[mode];
  el.promptAccordionCount.textContent = items.length + ' 条';
  el.promptTemplateList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'material-empty';
    empty.textContent = '暂无固定提示词';
    el.promptTemplateList.append(empty);
  }
  for (const item of items) {
    const key = mode + ':' + item.id;
    const draft = templateDrafts.get(key) || item;
    const row = document.createElement('div');
    row.className = 'saved-template-item' + (expandedTemplates.has(item.id) ? ' expanded' : '');
    row.dataset.templateId = item.id;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'saved-template-use';
    toggle.title = '展开编辑标题和正文';
    toggle.setAttribute('aria-expanded', String(expandedTemplates.has(item.id)));
    const name = document.createElement('strong');
    name.textContent = draft.title;
    const preview = document.createElement('span');
    preview.textContent = draft.body.replace(/\s+/g, ' ').slice(0, 54);
    toggle.append(name, preview);
    toggle.addEventListener('click', () => {
      activeTemplateIds[mode] = item.id;
      if (expandedTemplates.has(item.id)) expandedTemplates.delete(item.id);
      else expandedTemplates.add(item.id);
      renderPromptTemplates();
    });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'template-delete'; remove.textContent = '×';
    remove.setAttribute('aria-label', '删除固定提示词 ' + item.title);
    remove.addEventListener('click', () => {
      if (!confirm('删除固定提示词「' + item.title + '」？')) return;
      state.promptTemplates[mode] = items.filter(candidate => candidate.id !== item.id);
      templateDrafts.delete(key); expandedTemplates.delete(item.id);
      if (activeTemplateIds[mode] === item.id) activeTemplateIds[mode] = '';
      saveWorkspace(true); renderPromptTemplates();
    });
    row.append(toggle, remove);
    if (expandedTemplates.has(item.id)) {
      const body = document.createElement('div'); body.className = 'saved-template-body';
      const title = document.createElement('input');
      title.type = 'text'; title.maxLength = 40; title.className = 'saved-template-title-input';
      title.setAttribute('aria-label', '固定提示词标题'); title.value = draft.title;
      const text = document.createElement('textarea');
      text.className = 'saved-template-text'; text.spellcheck = false;
      text.setAttribute('aria-label', '固定提示词正文'); text.value = draft.body;
      const actions = document.createElement('div'); actions.className = 'saved-template-actions';
      const button = (label, handler, primary = false, extraClass = '') => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
        b.className = (primary ? 'primary-action' : 'secondary-action') + ' saved-template-load' + (extraClass ? ' ' + extraClass : '');
        b.addEventListener('click', handler); actions.append(b); return b;
      };
      const save = button('保存修改', () => {
        if (!title.value.trim() || !text.value.trim()) {
          showToast('请填写标题和提示词内容');
          (!title.value.trim() ? title : text).focus(); return;
        }
        item.title = title.value.trim(); item.body = text.value.trim(); item.updatedAt = Date.now();
        templateDrafts.delete(key); saveWorkspace(true); renderPromptTemplates();
        showToast('标题和提示词已保存');
      }, true);
      save.disabled = !templateDrafts.has(key);
      for (const input of [title, text]) {
        input.addEventListener('focus', () => { activeTemplateIds[mode] = item.id; });
        input.addEventListener('input', () => {
          activeTemplateIds[mode] = item.id;
          templateDrafts.set(key, { title: title.value, body: text.value });
          save.disabled = title.value === item.title && text.value === item.body;
        });
      }
      button('复制', async () => {
        if (!text.value.trim()) { showToast('提示词为空'); return; }
        try {
          await copyTextToClipboard(text.value);
          activeTemplateIds[mode] = item.id; rememberTemplatePrompt(text.value, mode);
          showToast('提示词已复制');
        } catch { showToast('复制失败，请手动选择文本'); }
      }, false, 'saved-template-copy');
      body.append(title, text, actions); row.append(body);
    }
    el.promptTemplateList.append(row);
  }
  queueBoundsUpdate();
}

function collectAssetItems(root) {
  const items = [];
  const folders = [];
  const walk = (node, depth, parentPath) => {
    if (!node) return;
    if (node.kind === 'folder') {
      const path = node.path || '';
      const childFolders = (node.children || []).filter(child => child.kind === 'folder');
      folders.push({ node, depth, parentPath, hasChildren: childFolders.length > 0 });
      for (const child of node.children || []) walk(child, depth + 1, path);
      return;
    }
    if (node.kind === 'file' && ['image', 'video', 'audio'].includes(node.type)) {
      items.push({ ...node, folderPath: parentPath || '' });
    }
  };
  walk(root, 0, '');
  state.quickFolders = folders;
  // 首次构建时把二级及更深文件夹收起来，只展开顶层分类。
  if (!state.quickCollapseInit) {
    for (const folder of folders) {
      if (folder.depth >= 1) state.collapsedQuickFolders.add(folder.node.path || '');
    }
    state.quickCollapseInit = true;
  }
  if (!folders.some(folder => (folder.node.path || '') === state.quickAssetFolder)) {
    state.quickAssetFolder = '';
  }
  return items.sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')));
}

function quickFolderLabel(path) {
  if (!path) return '全部资产';
  return path.split('/').filter(Boolean).at(-1) || '全部资产';
}

function isProjectRootFolder(folderPath) {
  if (!folderPath) return true;
  return folderPath === (state.config?.project?.folder || '');
}





async function moveQuickAsset(assetPath, folderPath) {
  const targetLabel = quickFolderLabel(folderPath);
  const currentLabel = quickFolderLabel(assetPath.split('/').slice(0, -1).join('/'));
  if (currentLabel === targetLabel) {
    showToast('已经在这个分类里了');
    return;
  }
  try {
    const response = await fetch(`/api/creative-assets/move?project=${encodeURIComponent(state.projectId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: assetPath, folder: folderPath }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    await loadAssetItems();
    showToast(`已移动到「${targetLabel}」`);
  } catch (error) {
    showToast(`移动失败：${error.message}`);
  }
}

async function importLocalFilesToFolder(files, folderPath) {
  // 原生拖拽传递的是本地文件；拖回左侧分类时仍应移动已有资产，而不是复制一份。
  const normalizePath = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/g, '').normalize('NFC');
  const root = normalizePath(state.config?.paths?.creativeAssetLibraryRoot);
  const incoming = [];
  for (const file of Array.from(files || [])) {
    let localPath = '';
    try { localPath = normalizePath(API.getPathForFile?.(file)); } catch {}
    const existing = root && localPath && state.assetItems.find(item => normalizePath(`${root}/${item.path}`) === localPath);
    if (!existing) { incoming.push(file); continue; }
    if (isProjectRootFolder(folderPath)) {
      showToast('请拖到具体分类（如 人物资产）；项目根目录不直接存放文件');
    } else {
      await moveQuickAsset(existing.path, folderPath);
    }
  }
  if (!incoming.length) return;
  files = incoming;
  // 目标是项目根（或未选择分类）时回退到按类别自动归档，不在根目录直接落盘。
  if (isProjectRootFolder(folderPath)) {
    const paths = files.map(file => {
      try { return API.getPathForFile ? API.getPathForFile(file) : ''; } catch { return ''; }
    }).filter(Boolean);
    if (!paths.length) {
      showToast('请先在左侧选择一个分类，再拖入文件');
      return;
    }
    try {
      const result = await API.importDroppedAssets({ paths });
      await loadAssetItems();
      showToast(`已按类别自动归档 ${Number(result?.imported) || 0} 项`);
    } catch (error) {
      showToast(`导入失败：${error.message}`);
    }
    return;
  }
  const list = [...files].filter(file => /\.(png|jpe?g|webp|gif|bmp|avif|mp4|mov|webm|mkv|avi|m4v|mp3|wav|m4a|aac|flac|ogg|opus|wma|aiff|aif|amr|ape)$/i.test(file.name));
  if (!list.length) {
    showToast('没有可导入的图片、视频或音频');
    return;
  }
  let imported = 0;
  const failed = [];
  for (const file of list) {
    try {
      const response = await fetch(`/api/creative-assets/import?project=${encodeURIComponent(state.projectId)}&folder=${encodeURIComponent(folderPath)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      imported += 1;
    } catch (error) {
      failed.push(`${file.name}：${error.message}`);
    }
  }
  await loadAssetItems();
  showToast(failed.length
    ? `已存入 ${quickFolderLabel(folderPath)} ${imported} 项；${failed[0]}`
    : `已存入「${quickFolderLabel(folderPath)}」${imported} 项`);
}

function assetImageUrl(relativePath) {
  return `/api/creative-assets/file?project=${encodeURIComponent(state.projectId)}&p=${encodeURIComponent(relativePath)}`;
}
function toggleQuickFolder(row, folder) {
  const key = folder.node.path || '';
  const wrapper = row.nextElementSibling;
  const collapsing = !state.collapsedQuickFolders.has(key);
  if (collapsing) {
    state.collapsedQuickFolders.add(key);
    if (state.quickAssetFolder === key) state.quickAssetFolder = folder.parentPath || '';
  } else {
    state.collapsedQuickFolders.delete(key);
    state.quickAssetFolder = key;
  }
  if (wrapper && wrapper.classList.contains('quick-children')) wrapper.classList.toggle('collapsed', collapsing);
  const disclosure = row.querySelector('.quick-folder-chevron-wrap');
  if (disclosure) {
    disclosure.classList.toggle('expanded', !collapsing);
    disclosure.setAttribute('aria-expanded', String(!collapsing));
    const label = `${collapsing ? '展开' : '收起'}${folder.depth ? folder.node.name : '全部资产'}`;
    disclosure.setAttribute('aria-label', label);
    disclosure.title = label;
  }
  row.querySelector('.quick-folder-name')?.setAttribute('aria-expanded', String(!collapsing));
  updateQuickDropLabel();
}

function updateQuickDropLabel() {
  if (!el.quickDropTarget) return;
  el.quickDropTarget.textContent = !state.quickAssetFolder || isProjectRootFolder(state.quickAssetFolder)
    ? '当前存入：全部资产（按类别自动归档）'
    : `当前存入：${quickFolderLabel(state.quickAssetFolder)}`;
}

function updateQuickCounts() {
  const imageCount = state.assetItems.filter(item => item.type === 'image').length;
  const videoCount = state.assetItems.filter(item => item.type === 'video').length;
  const audioCount = state.assetItems.filter(item => item.type === 'audio').length;
  el.assetAccordionCount.textContent = `${imageCount} 张图片${videoCount ? ` · ${videoCount} 个视频` : ''}${audioCount ? ` · ${audioCount} 条音频` : ''}`;
}

function buildQuickFileCard(item) {
  const wrapper = document.createElement('span');
  wrapper.className = 'asset-card-wrap';
  wrapper.draggable = true;
  wrapper.dataset.assetPath = item.path;
  wrapper.title = '拖到网页上传；拖到分类整理';
  let dragged = false;
  wrapper.addEventListener('pointerdown', () => { dragged = false; });
  wrapper.addEventListener('dragstart', event => {
    dragged = true;
    wrapper.classList.add('asset-dragging');
    // 框选模式下拖动任一选中卡 = 按选入顺序整批拖出（原生多文件拖动进剪映）
    if (state.quickSelectMode && state.quickSelectionOrder.length && typeof API.startAssetDragSelection === 'function') {
      event.preventDefault();
      event.stopPropagation();
      API.startAssetDragSelection([...state.quickSelectionOrder]);
      return;
    }
    if (state.config?.nativeQuickAssetDrag && typeof API.startAssetDrag === 'function') {
      event.preventDefault();
      event.stopPropagation();
      API.startAssetDrag(item.path);
    } else if (event.dataTransfer) {
      event.dataTransfer.setData('application/x-vos-asset', item.path);
      event.dataTransfer.effectAllowed = 'move';
      showToast('拖入网页需要最新版桌面程序，请保存网页内容后完全退出并重新打开应用');
    }
  });
  wrapper.addEventListener('dragend', () => wrapper.classList.remove('asset-dragging'));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `asset-image-card ${item.type}`;
  button.title = `${item.name}\n点击放大或预览，可再跳转完整库`;
  let preview;
  if (item.type === 'image') {
    preview = document.createElement('img');
    preview.src = assetImageUrl(item.path);
    preview.alt = item.name;
    preview.loading = 'lazy';
    preview.draggable = false;
  } else if (item.type === 'video') {
    // 视频封面：#t=0.1 seek 到开头附近的帧作封面（约等于首帧）；preload=metadata 为加载提示，
    // seek 时浏览器会按需下载开头一段数据（非严格只取文件头）。懒加载：进入预加载区才挂 src。
    const cover = document.createElement('video');
    cover.className = 'asset-video-cover';
    cover.preload = 'metadata';
    registerQuickCoverLazy(cover, `${assetImageUrl(item.path)}#t=0.1`);
    cover.muted = true;
    cover.defaultMuted = true;
    cover.playsInline = true;
    cover.tabIndex = -1;
    cover.setAttribute('aria-hidden', 'true');
    cover.draggable = false;
    cover.addEventListener('error', () => cover.classList.add('cover-failed'), { once: true });
    const coverWrap = document.createElement('span');
    coverWrap.className = 'asset-video-preview video-cover-wrap';
    coverWrap.appendChild(cover);
    const badge = document.createElement('span');
    badge.className = 'play-badge';
    badge.setAttribute('aria-hidden', 'true');
    coverWrap.appendChild(badge);
    preview = coverWrap;
  } else {
    preview = document.createElement('span');
    preview.className = 'asset-video-preview';
    preview.dataset.mediaType = item.type;
    preview.setAttribute('aria-hidden', 'true');
    const icon = document.createElement('img');
    icon.className = 'asset-video-icon';
    icon.src = UIIcons.src(item.type === 'video' ? 'video' : item.type === 'audio' ? 'audio' : 'document');
    icon.alt = '';
    icon.draggable = false;
    preview.appendChild(icon);
  }
  const label = document.createElement('span');
  label.className = 'asset-card-label';
  label.textContent = item.name;
  button.append(preview, label);
  button.addEventListener('click', event => {
    if (dragged) { event.preventDefault(); return; }
    // 框选模式下单击卡片 = 按点击顺序选入/移出导入序列；单击仍预览与选入互斥
    if (state.quickSelectMode) {
      toggleQuickSelection(item.path);
      return;
    }
    if (item.type === 'image' || item.type === 'video' || item.type === 'audio') openQuickPreview(item);
    else openFullAssetLibrary();
  });
  wrapper.appendChild(button);
  if (['image', 'video', 'audio'].includes(item.type) && typeof API.automation === 'function') {
    const sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.className = 'asset-send-button';
    sendButton.textContent = '传网页';
    sendButton.title = '直接传入当前网页的上传框';
    sendButton.setAttribute('aria-label', `将 ${item.name} 传入网页`);
    sendButton.addEventListener('click', event => {
      event.stopPropagation();
      window.creatorAutomationUI?.sendAsset(item.path);
    });
    wrapper.appendChild(sendButton);
  }
  if (item.type === 'image' && typeof API.copyAsset === 'function') {
  const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'asset-copy-button';
      copyButton.dataset.copyAsset = item.path;
      copyButton.textContent = '复制';
      copyButton.title = '复制图片到剪贴板，可到平台直接粘贴';
      copyButton.setAttribute('aria-label', `复制图片 ${item.name}`);
    copyButton.addEventListener('click', async event => {
      event.stopPropagation();
      copyButton.disabled = true;
      try {
        await API.copyAsset(item.path);
        showToast('已复制图片；到平台输入框直接粘贴');
      } catch (error) {
        showToast(error.message || '复制失败');
      } finally {
        copyButton.disabled = false;
      }
    });
    wrapper.appendChild(copyButton);
  }
  if (typeof API.deleteAsset === 'function') {
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'asset-quick-delete';
    deleteButton.dataset.deleteAsset = item.path;
    deleteButton.textContent = '✕';
    deleteButton.title = '删除（移到废纸篓）';
    deleteButton.setAttribute('aria-label', `删除 ${item.name}`);
    deleteButton.addEventListener('click', async event => {
      event.stopPropagation();
      if (!confirm(`删除「${item.name}」？文件会移到废纸篓，可随时恢复。`)) return;
      deleteButton.disabled = true;
      try {
        await API.deleteAsset(item.path);
        // 已删资产不再留在框选导入序列，避免整批拖出时因缺失文件失败
        const selIdx = state.quickSelectionOrder.indexOf(item.path);
        if (selIdx !== -1) {
          state.quickSelectionOrder.splice(selIdx, 1);
          updateQuickSelectionUI();
        }
        showToast(`已移到废纸篓：${item.name}`);
        await loadAssetItems();
      } catch (error) {
        showToast(error.message || '删除失败');
        deleteButton.disabled = false;
      }
    });
    wrapper.appendChild(deleteButton);
  }
  return wrapper;
}

function buildQuickFolderRow(folder) {
  const key = folder.node.path || '';
  const collapsed = state.collapsedQuickFolders.has(key);
  const row = document.createElement('div');
  row.className = 'quick-folder-row' + (isProjectRootFolder(state.quickAssetFolder) && folder.depth === 0 ? ' selected' : '');
  row.dataset.folderPath = key;

  // 每个分类都能展开资产内容，不仅仅是包含下级文件夹的分类。
  const disclosure = document.createElement('button');
  disclosure.type = 'button';
  disclosure.className = `quick-folder-chevron-wrap${collapsed ? '' : ' expanded'}`;
  disclosure.setAttribute('aria-expanded', String(!collapsed));
  disclosure.setAttribute('aria-label', `${collapsed ? '展开' : '收起'}${folder.depth ? folder.node.name : '全部资产'}`);
  disclosure.title = disclosure.getAttribute('aria-label');
  const chevron = document.createElement('span');
  chevron.className = 'folder-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  disclosure.appendChild(chevron);

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'quick-folder-name';
  name.setAttribute('aria-expanded', String(!collapsed));
  name.textContent = folder.depth ? folder.node.name : '全部资产';
  name.title = folder.depth ? `展开或收起 ${folder.node.name}` : '展开或收起全部分类';
  const toggle = () => {
    toggleQuickFolder(row, folder);
    // 根目录代表「全部资产」：导入走按类别自动归档，不作为直接落盘目标。
    if (!state.collapsedQuickFolders.has(key) && folder.depth === 0) state.quickAssetFolder = '';
  };
  disclosure.addEventListener('click', event => {
    event.stopPropagation();
    toggle();
  });
  name.addEventListener('click', toggle);

  const count = document.createElement('span');
  count.className = 'quick-folder-count';
  count.textContent = String(folder.node.fileCount || 0);

  // 行级拖放：拖入外部文件 = 导入该分类；拖入已有资产 = 移动到该分类。
  // 项目根目录不接受直接存放：外部文件回退到按类别自动归档。
  const dropHint = document.createElement('span');
  dropHint.className = 'quick-drop-hint';
  dropHint.hidden = true;
  row.addEventListener('dragover', event => {
    if (!event.dataTransfer) return;
    const types = [...event.dataTransfer.types];
    const isFileDrop = types.includes('Files');
    const isAssetMove = types.includes('application/x-vos-asset') && !!key;
    if (!isFileDrop && !isAssetMove) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = isAssetMove ? 'move' : 'copy';
    row.classList.add('drop-target');
    dropHint.hidden = false;
    dropHint.textContent = isAssetMove ? '移动' : '导入';
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-target');
    dropHint.hidden = true;
  });
  row.addEventListener('drop', event => {
    row.classList.remove('drop-target');
    dropHint.hidden = true;
    if (!event.dataTransfer) return;
    const types = [...event.dataTransfer.types];
    if (types.includes('application/x-vos-asset')) {
      if (!key) return;
      event.preventDefault();
      event.stopPropagation();
      if (isProjectRootFolder(key)) {
        showToast('请拖到具体分类（如 人物资产）；项目根目录不直接存放文件');
        return;
      }
      const assetPath = event.dataTransfer.getData('application/x-vos-asset');
      if (assetPath) moveQuickAsset(assetPath, key);
      return;
    }
    if (!event.dataTransfer.files.length || !key) return;
    event.preventDefault();
    event.stopPropagation();
    importLocalFilesToFolder(event.dataTransfer.files, key);
  });

  row.append(disclosure, name, count, dropHint);

  // Obsidian 式：展开文件夹后，里面的图片直接嵌在树下（连同子文件夹一起收纳）。
  // wrapper 必须与行平级（作为兄弟节点），折叠动画才能切换到正确的元素。
  const wrapper = document.createElement('div');
  wrapper.className = 'quick-children' + (collapsed ? ' collapsed' : '');
  const inner = document.createElement('div');
  inner.className = 'quick-children-inner';
  const directFiles = state.assetItems.filter(item => item.folderPath === key).slice(0, 30);
  if (directFiles.length) {
    const grid = document.createElement('div');
    grid.className = 'quick-file-grid';
    for (const item of directFiles) grid.appendChild(buildQuickFileCard(item));
    inner.appendChild(grid);
  }
  wrapper.appendChild(inner);
  appendQuickFolderRows(inner, state.quickFolders || [], key, new Set());
  if (!inner.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'quick-folder-empty-hint';
    empty.textContent = folder.node.fileCount ? '此分类暂无图片、视频或音频' : '暂无资产';
    inner.appendChild(empty);
  }
  row.dataset.wrapperReady = '1';
  return { row, wrapper };
}

function appendQuickFolderRows(parent, folders, parentPath, done) {
  const pending = folders.filter(item => item.parentPath === parentPath && !done.has(item));
  for (const folder of pending) {
    done.add(folder);
    const { row, wrapper } = buildQuickFolderRow(folder);
    parent.appendChild(row);
    parent.appendChild(wrapper);
  }
}

/* ---------- 快捷面板框选导入（剪映联动） ---------- */
// 框选模式：点卡片按点击顺序选入；在树容器空白处按住拖动画框，相交卡片全部选入（按位置排序）。
// 拖动任一选中卡 = 整批按选入顺序原生拖出（剪映等多文件拖放目标直接接收）。
function toggleQuickSelection(assetPath) {
  const idx = state.quickSelectionOrder.indexOf(assetPath);
  if (idx === -1) state.quickSelectionOrder.push(assetPath);
  else state.quickSelectionOrder.splice(idx, 1);
  updateQuickSelectionUI();
}

function updateQuickSelectionUI() {
  const count = state.quickSelectionOrder.length;
  el.quickSelInfo.textContent = count ? `已选 ${count} 项 · 拖动任一选中卡整批拖入剪映` : '点卡片选入，或按住拖动画框';
  el.quickSelClear.hidden = count === 0;
  el.quickFolderTree.querySelectorAll('[data-asset-path]').forEach(node => {
    const path = node.dataset.assetPath;
    const order = state.quickSelectionOrder.indexOf(path);
    node.classList.toggle('sel-on', order !== -1);
    node.dataset.selOrder = order === -1 ? '' : String(order + 1);
  });
}

function setQuickSelectMode(on) {
  state.quickSelectMode = !!on;
  el.quickMultiSelect.setAttribute('aria-pressed', String(state.quickSelectMode));
  el.quickMultiSelect.textContent = `框选模式：${state.quickSelectMode ? '开' : '关'}`;
  el.quickTools.hidden = false;
  if (!state.quickSelectMode) {
    state.quickSelectionOrder.length = 0;
  }
  updateQuickSelectionUI();
  el.quickFolderTree.classList.toggle('select-mode', state.quickSelectMode);
}

function setupQuickMarquee() {
  const container = el.quickFolderTree;
  if (!container || container.dataset.marqueeWired === '1') return;
  container.dataset.marqueeWired = '1';
  let marquee = null;
  let origin = null;
  const cardRects = () => [...container.querySelectorAll('[data-asset-path]')]
    .map(node => ({ node, rect: node.getBoundingClientRect() }));
  container.addEventListener('contextmenu', event => {
    // 右键拖动画框：与卡片拖拽/单击互不冲突
    if (!state.quickSelectMode || event.button !== 2) return;
    if (event.target.closest('button, input, textarea, select')) return;
    event.preventDefault();
    origin = { x: event.clientX, y: event.clientY };
    marquee = document.createElement('div');
    marquee.className = 'quick-marquee';
    marquee.style.left = `${origin.x}px`;
    marquee.style.top = `${origin.y}px`;
    document.body.appendChild(marquee);
    const onMove = moveEvent => {
      if (!origin) return;
      const x = Math.min(origin.x, moveEvent.clientX);
      const y = Math.min(origin.y, moveEvent.clientY);
      const w = Math.abs(moveEvent.clientX - origin.x);
      const h = Math.abs(moveEvent.clientY - origin.y);
      marquee.style.left = `${x}px`;
      marquee.style.top = `${y}px`;
      marquee.style.width = `${w}px`;
      marquee.style.height = `${h}px`;
      const box = { left: x, top: y, right: x + w, bottom: y + h };
      // 按树内文档顺序（自上而下）选入，与视觉顺序一致；不做字典序重排
      const hits = [];
      cardRects().forEach(({ node, rect }) => {
        const hit = rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top;
        if (hit) hits.push(node.dataset.assetPath);
      });
      state.quickSelectionOrder.length = 0;
      hits.forEach(path => state.quickSelectionOrder.push(path));
      updateQuickSelectionUI();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (marquee) { marquee.remove(); marquee = null; }
      origin = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function renderQuickFolderTree() {
  updateQuickCounts();
  updateQuickDropLabel();
  resetQuickCoverObserver();  // 树与卡片整体重建：先解除旧封面节点的观察登记
  el.quickFolderTree.replaceChildren();
  appendQuickFolderRows(el.quickFolderTree, state.quickFolders || [], '', new Set());
  setupQuickMarquee();
  updateQuickSelectionUI();
  if (el.quickTools) el.quickTools.hidden = false;  // 有资产分类即提供框选导入入口
}



// 请求代号守卫：快速切换剧本时后完成的旧响应不得写进新剧本视图（也不得误报失效选项提示）
let assetItemsRequestId = 0;

async function loadAssetItems() {
  const requestId = ++assetItemsRequestId;
  const requestProjectId = state.projectId;
  try {
    const response = await fetch(`/api/creative-assets?project=${encodeURIComponent(state.projectId)}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (requestId !== assetItemsRequestId || state.projectId !== requestProjectId) return;
    if (!response.ok || !data.tree) throw new Error(data.error || `HTTP ${response.status}`);
    state.assetItems = collectAssetItems(data.tree);
    // 框选导入序列按现存资产过滤：已删除/已不存在的选项自动剔除并明确提示，避免整批拖出失败。
    const existingPaths = new Set(state.assetItems.map(item => item.path));
    const before = state.quickSelectionOrder.length;
    if (before) {
      state.quickSelectionOrder = state.quickSelectionOrder.filter(path => existingPaths.has(path));
      const removed = before - state.quickSelectionOrder.length;
      if (removed > 0) showToast(`已自动移除 ${removed} 个失效选项`);
    }
    renderQuickFolderTree();
  } catch (error) {
    // 请求代号或项目身份已变化：这是被取代的旧请求，其失败不得覆盖新项目的成功渲染
    if (requestId !== assetItemsRequestId || state.projectId !== requestProjectId) return;
    state.assetItems = [];
    renderQuickFolderTree();
    el.assetAccordionCount.textContent = '读取失败';
    showToast(`创作资产读取失败：${error.message}`);
  }
}

async function loadProduction(force = false) {
  if (!force && state.production && state.production.available) return state.production;
  const response = await fetch('/api/production');
  if (!response.ok) throw new Error(`入库记录读取失败（HTTP ${response.status}）`);
  const data = await response.json();
  if (!data || typeof data.available !== 'boolean' || !Array.isArray(data.inbox)) throw new Error('入库记录格式无效');
  state.production = data;
  return data;
}

async function loadMoreInbox() {
  const page = state.production?.inboxPage;
  if (!state.production?.available || !page?.hasMore) return;
  try {
    const response = await fetch(`/api/inbox?project=${encodeURIComponent(state.projectId)}&limit=${encodeURIComponent(page.limit || 200)}&offset=${encodeURIComponent((page.offset || 0) + (page.limit || 200))}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    const existing = new Map((state.production.inbox || []).map(item => [item.id, item]));
    for (const item of next.items || []) existing.set(item.id, item);
    state.production.inbox = [...existing.values()];
    state.production.inboxPage = next.pagination || { ...page, hasMore: false };
    renderDownloads();
  } catch (error) {
    showToast(`加载更早入库结果失败：${error.message}`);
  }
}

// 创作窗口的模态对话框是 HTML 层，而平台网页/资产浮层是原生视图（永远在 HTML 之上）。
// 打开对话框期间临时隐藏原生视图，关闭后恢复，否则对话框会被盖住无法操作。
// 恢复钩子按对话框持久挂载（幂等推送），避免 once 监听被提前消耗导致视图滞留隐藏。
function syncCreatorDialogVisibility() {
  if (typeof API.setPlatformViewHidden === 'function') {
    API.setPlatformViewHidden(!!document.querySelector('dialog[open]')).catch(() => {});
  }
}

function openCreatorDialog(dialog) {
  if (!dialog.__overlayRestoreHooked) {
    dialog.__overlayRestoreHooked = true;
    dialog.addEventListener('close', syncCreatorDialogVisibility);
  }
  dialog.showModal();
  syncCreatorDialogVisibility();
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function downloadStateLabel(download) {
  if (download.source === 'import') {
    return ({
      progressing: '正在导入', paused: '导入已暂停', completed: '已导入并归档',
      cancelled: '导入已取消', interrupted: '导入失败',
    })[download.state] || download.state;
  }
  return ({
    progressing: '下载中', paused: '已暂停', completed: '已归档',
    cancelled: '已取消', interrupted: '已中断',
  })[download.state] || download.state;
}

function downloadKindLabel(download) {
  if (download.kind === 'image') return '图片';
  if (download.kind === 'video') return '视频';
  if (download.kind === 'audio') return '音频';
  return '文件';
}

function actionButton(label, action, actionName = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary-action';
  button.textContent = label;
  if (actionName) button.dataset.action = actionName;
  button.addEventListener('click', action);
  return button;
}

function captureDownloadFocus() {
  const focused = document.activeElement;
  if (!focused || !el.downloadList.contains(focused)) return null;
  if (focused.dataset.focusKey === 'load-more') return { kind: 'load-more' };
  const card = focused.closest('[data-download-id]');
  if (!card) return null;
  return { kind: 'download', id: card.dataset.downloadId, action: focused.dataset.action || '' };
}

function restoreDownloadFocus(target) {
  if (!target) return;
  requestAnimationFrame(() => {
    if (target.kind === 'load-more') {
      const more = el.downloadList.querySelector('[data-focus-key="load-more"]');
      if (more) {
        more.focus();
        return;
      }
      const heading = document.getElementById('downloadsHeading');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
      return;
    }
    if (!target.id) return;
    const selector = `[data-download-id="${CSS.escape(target.id)}"]`;
    const card = el.downloadList.querySelector(selector);
    const action = target.action ? card?.querySelector(`[data-action="${CSS.escape(target.action)}"]`) : null;
    const fallback = card?.querySelector('.download-main');
    if (action) action.focus();
    else if (fallback) {
      fallback.tabIndex = -1;
      fallback.focus();
    }
  });
}

function renderDownloads() {
  // 最近入库列表已按用户要求隐藏；下载进行中用顶栏小徽标给出最小反馈。
  const activeCount = [...state.downloads.values()]
    .filter(download => ['progressing', 'paused'].includes(download.state)).length;
  el.downloadBadge.hidden = activeCount === 0;
  el.downloadBadge.textContent = `⬇ 正在下载 ${activeCount} 项`;
  const focusTarget = captureDownloadFocus();
  const inboxByDownload = new Map((state.production?.inbox || []).map(item => [item.download_key, item]));
  const downloads = [...state.downloads.values()]
    .filter(download => download.mode === state.mode && (!download.projectId || download.projectId === state.projectId))
    .map(download => ({ ...download, inbox: inboxByDownload.get(download.id) || null }));
  for (const item of state.production?.inbox || []) {
    if (item.mode !== state.mode || state.downloads.has(item.download_key)) continue;
    downloads.push({
      id: item.download_key, serviceId: item.service_id, serviceLabel: item.service_label,
      mode: item.mode, kind: item.kind, filename: item.filename, savePath: item.asset_path,
      state: 'completed', source: item.source, startedAt: item.created_at, endedAt: item.updated_at,
      receivedBytes: Number(item.size_bytes) || 0, totalBytes: Number(item.size_bytes) || 0, inboxId: item.id, ingestState: item.state,
      shotId: item.captured_shot_id, shotNo: item.shot_no, shotTitle: item.shot_title, inbox: item,
      persistedOnly: true,
    });
  }
  const attentionRank = download => {
    if (download.ingestState === 'error' || download.lineageState === 'error' || ['interrupted', 'cancelled'].includes(download.state)) return 0;
    if (['progressing', 'paused'].includes(download.state)) return 1;
    return 3;
  };
  downloads.sort((a, b) => attentionRank(a) - attentionRank(b)
    || String(b.endedAt || b.startedAt).localeCompare(String(a.endedAt || a.startedAt)));
  el.downloadList.replaceChildren();
  el.downloadSummary.textContent = downloads.length
    ? `${downloads.length} 条${activeCount ? `，${activeCount} 条进行中` : ''}`
    : '还没有下载任务';
  if (!downloads.length) {
    const empty = document.createElement('div');
    empty.className = 'download-empty';
    empty.textContent = '暂无下载';
    el.downloadList.appendChild(empty);
    return;
  }

  for (const download of downloads) {
    const card = document.createElement('article');
    card.className = 'download-item';
    card.dataset.downloadId = download.id;
    card.dataset.state = download.state;
    card.dataset.source = download.source || 'platform';
    card.title = download.savePath || download.filename;

    const main = document.createElement('div');
    main.className = 'download-main';
    const kind = document.createElement('span');
    kind.className = 'download-kind';
    kind.textContent = downloadKindLabel(download);
    const name = document.createElement('span');
    name.className = 'download-name';
    name.textContent = download.filename;
    const status = document.createElement('span');
    status.className = 'download-state';
    status.textContent = downloadStateLabel(download);
    main.append(kind, name, status);
    card.appendChild(main);

    const total = Number(download.totalBytes) || 0;
    const received = Number(download.receivedBytes) || 0;
    const progress = document.createElement('progress');
    progress.className = 'download-progress';
    progress.setAttribute('aria-label', `${download.filename}：${downloadStateLabel(download)}`);
    progress.max = total || 1;
    progress.value = total ? Math.min(received, total) : (download.state === 'completed' ? 1 : 0);
    if (!total && download.state === 'progressing') progress.removeAttribute('value');
    card.appendChild(progress);

    const meta = document.createElement('div');
    meta.className = 'download-meta';
    const source = document.createElement('span');
    source.textContent = download.source === 'import'
      ? `本机导入${download.serviceLabel ? ` · ${download.serviceLabel}` : ''}`
      : download.serviceLabel;
    const size = document.createElement('span');
    // 历史入库项没有字节快照，显示“已归档”而不是误导性的 0 B。
    size.textContent = (total || received)
      ? (total ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received))
      : '已归档';
    meta.append(source, size);
    card.appendChild(meta);
    const diagnostics = [download.error, download.ingestError, download.lineageError].filter(Boolean);
    if (diagnostics.length) {
      const error = document.createElement('p');
      error.className = 'download-error';
      error.textContent = diagnostics.join('；');
      card.appendChild(error);
    }

    const actions = document.createElement('div');
    actions.className = 'download-actions';
    if (download.source !== 'import' && download.state === 'progressing') {
      actions.appendChild(actionButton('暂停', () => API.downloadAction(download.id, 'pause'), 'pause'));
      actions.appendChild(actionButton('取消', () => API.downloadAction(download.id, 'cancel'), 'cancel'));
    } else if (download.source !== 'import' && download.state === 'paused') {
      actions.appendChild(actionButton('继续', () => API.downloadAction(download.id, 'resume'), 'resume'));
      actions.appendChild(actionButton('取消', () => API.downloadAction(download.id, 'cancel'), 'cancel'));
    } else if (download.state === 'completed') {
      if (download.savePath && typeof API.automation === 'function') {
        actions.appendChild(actionButton('传入网页', () => window.creatorAutomationUI?.sendDownload(download), 'send-to-page'));
      }
      if (!download.persistedOnly) actions.appendChild(actionButton('在文件夹中显示', () => API.openDownload(download.id), 'reveal'));
    }
    if (actions.childElementCount) card.appendChild(actions);
    el.downloadList.appendChild(card);
  }
  if (state.production?.inboxPage?.hasMore) {
    const more = actionButton(`加载更早入库结果（还有 ${Math.max(0, state.production.inboxPage.total - (state.production.inbox || []).length)} 条）`, loadMoreInbox, 'load-more');
    more.classList.add('download-load-more');
    more.dataset.focusKey = 'load-more';
    el.downloadList.appendChild(more);
  }
  restoreDownloadFocus(focusTarget);
}

// 快捷面板视频封面懒加载：与完整资产库同策略，预加载区（视口外扩 200px）内才挂 src；
// 分类树/资产列表整体重建前先解除旧节点登记，避免持有脱离 DOM 的元素。
const quickCoverObserver = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const video = entry.target;
    quickCoverObserver.unobserve(video);
    trackedQuickCovers.delete(video);
    const coverSrc = video.dataset.coverSrc;
    if (coverSrc) {
      delete video.dataset.coverSrc;
      video.src = coverSrc;
    }
  }
}, { rootMargin: '200px' }) : null;
const trackedQuickCovers = new Set();

function resetQuickCoverObserver() {
  if (!quickCoverObserver) return;
  for (const video of trackedQuickCovers) quickCoverObserver.unobserve(video);
  trackedQuickCovers.clear();
}

function registerQuickCoverLazy(video, coverUrl) {
  if (!quickCoverObserver) { video.src = coverUrl; return; }
  video.dataset.coverSrc = coverUrl;
  quickCoverObserver.observe(video);
  trackedQuickCovers.add(video);
}

/* 快捷面板内置预览：图片放大查看（点击切换原始大小），视频/音频直接播放。 */
let quickPreviewItem = null;

function openQuickPreview(item) {
  quickPreviewItem = item;
  el.quickPreviewName.textContent = item.name;
  el.quickPreviewMeta.textContent = `${item.folder || '创作资产库'} · ${item.type === 'image' ? '点击图片可在适配与原始大小间切换' : item.type === 'video' ? '视频预览' : '音频预览'}`;
  const stage = el.quickPreviewStage;
  stage.replaceChildren();
  stage.classList.remove('zoom-100');
  if (item.type === 'image') {
    const image = document.createElement('img');
    image.className = 'quick-preview-media';
    image.src = assetImageUrl(item.path);
    image.alt = item.name;
    image.addEventListener('click', () => stage.classList.toggle('zoom-100'));
    stage.appendChild(image);
  } else if (item.type === 'video') {
    const video = document.createElement('video');
    video.className = 'quick-preview-media';
    video.src = assetImageUrl(item.path);
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    stage.appendChild(video);
  } else if (item.type === 'audio') {
    const audio = document.createElement('audio');
    audio.className = 'quick-preview-audio';
    audio.src = assetImageUrl(item.path);
    audio.controls = true;
    audio.autoplay = true;
    stage.appendChild(audio);
  } else {
    const note = document.createElement('p');
    note.className = 'quick-preview-note';
    note.textContent = '该类型不支持预览，可在完整资产库中查看。';
    stage.appendChild(note);
  }
  openCreatorDialog(el.quickPreviewDialog);
}

function closeQuickPreview() {
  el.quickPreviewStage.replaceChildren();
  quickPreviewItem = null;
  el.quickPreviewDialog.close();
}

async function copyPrompt(focusBrowser) {  const body = (el.promptEditor?.value ?? state.prompts[state.mode]) || '';
  if (!body.trim()) { showToast('提示词为空'); return; }
  try {
    await copyTextToClipboard(body);
    if (focusBrowser) await API.focusBrowser();
    showToast(focusBrowser ? '已复制，可粘贴到右侧网页' : '提示词已复制');
  } catch { showToast('复制失败，请手动选择文本'); }
}

async function selectService(serviceId) {
  if (state.modeSwitchPending) return;
  if (!validServiceForMode(state.mode, serviceId)) return;
  state.services[state.mode] = serviceId;
  state.activeService = serviceId;
  saveWorkspace(true);
  renderPlatforms();
  const service = serviceById(serviceId);
  el.addressService.textContent = serviceLabel(service);
  el.addressInput.value = service?.url || '';
  el.addressInput.setAttribute('aria-invalid', 'false');
  el.loadDot.classList.add('loading');
  try {
    const browser = await API.selectService(serviceId, state.mode);
    if (browser) applyBrowserState(browser);
    queueBoundsUpdate();
  } catch (error) {
    applyBrowserState({
      serviceId,
      loading: false,
      url: state.browser?.serviceId === serviceId ? state.browser.url : service?.url || '',
      title: '',
      canGoBack: false,
      canGoForward: false,
      error: `平台打开失败：${error.message}`,
      tabs: state.browser?.tabs || [],
    });
  }
}

async function setMode(mode) {
  if (state.modeSwitchPending) return false;
  const nextMode = mode === 'video' ? 'video' : 'image';
  return restoreModeBrowser(nextMode);
}

function desktopBrowserError(error, fallback) {
  const message = error?.message || fallback;
  return /No handler registered|API\.(setMode|renameService|renameTab) is not a function/.test(message)
    ? '桌面程序仍在运行旧版本。请先保存网页内容，按 ⌘Q 完全退出后重新打开；刷新网页不能更新桌面程序。'
    : message;
}

async function restoreModeBrowser(mode = state.mode) {
  if (state.modeSwitchPending) return false;
  state.modeSwitchPending = true;
  document.querySelectorAll('.mode-button').forEach(button => { button.disabled = true; });
  try {
    const browser = await API.setMode(mode, effectiveServiceForMode(mode));
    if (browser?.mode !== mode || !Array.isArray(browser.tabs)
      || browser.tabs.some(tab => !['image', 'video'].includes(tab.mode))) {
      throw new Error('桌面浏览器版本不匹配，请保存网页内容后完全退出并重新打开应用。');
    }
    // 只有原生浏览器确认成功，才提交界面模式；失败时保留原标签和草稿。
    state.mode = mode;
    state.accordions.prompt = !!state.prompts[mode].trim() || state.promptTemplates[mode].length > 0;
    state.activeService = effectiveServiceForMode(mode);
    renderMode();
    applyBrowserState(browser);
    saveWorkspace(true);

    queueBoundsUpdate();
    return true;
  } catch (error) {
    showToast(desktopBrowserError(error, '切换创作模式失败，已保留原网页'));
    return false;
  } finally {
    state.modeSwitchPending = false;
    document.querySelectorAll('.mode-button').forEach(button => { button.disabled = false; });
    renderPlatforms();
  }
}

function applyBrowserState(browser) {
  if (!browser) return;
  if (browser.mode && browser.mode !== state.mode) return;
  state.browser = {
    ...state.browser,
    ...browser,
    tabs: Array.isArray(browser.tabs) ? browser.tabs : (state.browser?.tabs || []),
  };
  if (Object.hasOwn(browser, 'serviceId')) {
    state.activeService = browser.serviceId;
    if (validServiceForMode(state.mode, browser.serviceId)) state.services[state.mode] = browser.serviceId;
  }
  const service = serviceById(browser.serviceId);
  const empty = !browser.tabId && !browser.serviceId;
  el.addressService.textContent = empty ? '网页' : browser.displayLabel || serviceLabel(service);
  if (document.activeElement !== el.addressInput) {
    el.addressInput.value = browser.url || service?.url || '';
  }
  el.addressInput.title = browser.url || '';
  el.addressInput.disabled = empty;
  el.addressGo.disabled = empty;
  el.openExternal.disabled = empty;
  el.loadDot.classList.toggle('loading', !!browser.loading);
  el.loadDot.classList.toggle('error', !!browser.error && !browser.loading);
  document.querySelector('[data-nav="back"]').disabled = !browser.canGoBack;
  document.querySelector('[data-nav="forward"]').disabled = !browser.canGoForward;
  document.querySelector('[data-nav="reload"]').textContent = browser.loading ? '×' : '↻';
  document.querySelector('[data-nav="reload"]').dataset.action = browser.loading ? 'stop' : 'reload';
  document.querySelector('[data-nav="reload"]').disabled = empty;
  document.querySelector('[data-nav="home"]').disabled = empty;
  el.browserPlaceholderTitle.textContent = empty ? '尚未打开网页' : browser.error
    ? '平台网页未显示'
    : browser.loading ? '正在连接创作平台' : '平台网页已连接';
  el.browserStage.querySelector('.browser-placeholder p').textContent = empty
    ? '点击上方 ＋ 打开网站，标签会自动保留。'
    : '切换大厅或资产库后，网页仍会保留。';
  el.reconnectBrowser.textContent = empty ? '打开创作网站' : '重新显示网页';
  renderPlatforms();
  renderBrowserRecovery(browser);
  if (browser.error) showToast(browser.error);
}

async function selectTab(tabId) {
  if (state.modeSwitchPending) return;
  if (!tabId) return;
  try {
    if (tabId === state.browser?.tabId) {
      await API.focusBrowser();
      return;
    }
    const browser = await API.selectTab(tabId);
    if (browser) applyBrowserState(browser);
    queueBoundsUpdate();
  } catch (error) {
    showToast(error.message || '切换网页失败');
  }
}

async function closeTab(tabId) {
  if (state.modeSwitchPending) return;
  try {
    const browser = await API.closeTab(tabId);
    if (browser) applyBrowserState(browser);
    queueBoundsUpdate();
    showToast('已关闭网页；网站登录仍保留');
  } catch (error) {
    showToast(error.message || '关闭网页失败');
  }
}

async function clearBrowserTabs() {
  if (state.modeSwitchPending || !state.browser?.tabs?.length) return;
  el.clearBrowserTabs.disabled = true;
  try {
    const browser = await API.clearTabs();
    applyBrowserState(browser);
    closePlatformPopover();
    queueBoundsUpdate();
    showToast('已清空全部网页；登录和素材保留');
  } catch (error) {
    showToast(desktopBrowserError(error, '清空网页失败'));
  } finally { renderPlatforms(); }
}

async function duplicateTab(tab) {
  if (state.modeSwitchPending) return;
  const service = serviceById(tab.serviceId);
  const label = serviceLabel(service);
  try {
    const browser = await API.openTab(tab.serviceId, tab.mode, tab.id);
    if (browser) applyBrowserState(browser);
    queueBoundsUpdate();
    showToast(`已复制「${label}」标签，可同时开多个并行使用`);
  } catch (error) {
    showToast(error.message || '复制标签失败');
  }
}

async function duplicateActiveTab() {
  if (state.modeSwitchPending) return;
  if (!state.activeService) {
    showToast('请先选择一个创作网站');
    return;
  }
  el.duplicateTab.disabled = true;
  try {
    const browser = await API.openTab(state.activeService, state.mode);
    if (browser) applyBrowserState(browser);
    closePlatformPopover();
    queueBoundsUpdate();
    showToast(`已再开一个「${serviceLabel(serviceById(state.activeService))}」网页`);
  } catch (error) {
    showToast(error.message || '再开网页失败');
  } finally {
    el.duplicateTab.disabled = !state.activeService;
  }
}

async function navigateToAddress() {
  const address = el.addressInput.value.trim();
  if (!address) {
    el.addressInput.setAttribute('aria-invalid', 'true');
    showToast('请输入网址');
    el.addressInput.focus();
    return;
  }
  el.addressGo.disabled = true;
  el.addressInput.setAttribute('aria-invalid', 'false');
  try {
    const browser = await API.navigateUrl(address);
    el.addressInput.blur();
    if (browser) applyBrowserState(browser);
  } catch (error) {
    el.addressInput.setAttribute('aria-invalid', 'true');
    showToast(error.message || '网页打开失败');
    el.addressInput.focus();
  } finally {
    el.addressGo.disabled = false;
  }
}

function renderBrowserRecovery(browser) {
  const rejected = !!browser.loginRejected;
  const timedOut = !rejected && !!browser.loadTimedOut;
  const failed = !rejected && !timedOut && !!browser.error && !browser.loading;
  const showBar = rejected || timedOut || failed;
  const visibilityChanged = el.browserRecovery.hidden === showBar;
  el.browserRecovery.hidden = !showBar;
  if (rejected) {
    // 只陈述事实与可用出路，不推断账号风控原因。
    el.browserRecoveryMessage.textContent = '当前站点拒绝了这次内嵌登录；可改用系统浏览器或站点提供的其他登录方式。';
    el.browserRecoveryUrl.textContent = browser.url ? `当前地址：${browser.url}` : '当前平台地址暂不可用';
    el.browserRecoveryReload.disabled = false;
    el.browserRecoveryExternal.disabled = !browser.url;
  } else if (timedOut) {
    // 超时为非破坏性提示：重试/停止按钮仍可用，不自动重启、不清会话。
    el.browserRecoveryMessage.textContent = '加载超时：站点长时间无响应。可重试、停止，或改用系统浏览器打开。';
    el.browserRecoveryUrl.textContent = browser.url ? `当前地址：${browser.url}` : '';
    el.browserRecoveryReload.disabled = false;
    el.browserRecoveryExternal.disabled = !browser.url;
  } else if (failed) {
    el.browserRecoveryMessage.textContent = browser.error;
    el.browserRecoveryUrl.textContent = browser.url ? `当前地址：${browser.url}` : '当前平台地址暂不可用';
    el.browserRecoveryReload.disabled = false;
    el.browserRecoveryExternal.disabled = !browser.url;
  }
  if (visibilityChanged) queueBoundsUpdate();
}

async function reloadCurrentPlatform() {
  el.browserRecoveryReload.disabled = true;
  try {
    const reloaded = await API.navigate('reload');
    if (!reloaded) await selectService(state.activeService);
  } catch (error) {
    showToast(`重新加载失败：${error.message}`);
  } finally {
    if (!el.browserRecovery.hidden) el.browserRecoveryReload.disabled = false;
  }
}

async function openCurrentInSystemBrowser() {
  try {
    const opened = await API.openExternal();
    showToast(opened ? '已在系统浏览器打开当前页面；其登录状态不会同步回内嵌浏览器' : '测试模式或当前页面无法外部打开');
  } catch (error) {
    showToast(`系统浏览器打开失败：${error.message}`);
  }
}

async function importDownloadedFiles() {
  const hasCreatorOSImporter = typeof window.creatorOS?.importFiles === 'function';
  if (!hasCreatorOSImporter && typeof API?.importFiles !== 'function') {
    showToast('当前桌面版不支持导入文件，请更新后重试');
    return;
  }
  const mode = state.mode;
  const buttons = [el.importDownloadedFiles, el.browserRecoveryImport];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const result = hasCreatorOSImporter
      ? await window.creatorOS.importFiles(mode)
      : await API.importFiles(mode);
    if (!result || result.cancelled) return;
    const imported = Number(result.imported) || 0;
    const failed = Array.isArray(result.failed) ? result.failed.length : 0;
    if (imported && failed) showToast(`已导入 ${imported} 个文件，另有 ${failed} 个失败`);
    else if (failed) showToast(`${failed} 个文件导入失败，请检查文件类型或归档目录`);
    else showToast(`已导入并归档 ${imported} 个文件`);
  } catch (error) {
    showToast(`文件导入失败：${error.message}`);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

async function importLocalAssets() {
  if (typeof API?.importAssets !== 'function') {
    showToast('请更新桌面版后添加图片、视频或音频');
    return;
  }
  el.importLocalAssets.disabled = true;
  try {
    const result = await API.importAssets();
    if (!result || result.cancelled) return;
    const imported = Number(result.imported) || 0;
    const failed = Array.isArray(result.failed) ? result.failed.length : 0;
    await loadAssetItems();
    if (failed) showToast(`已添加 ${imported} 项，${failed} 项失败`);
    else showToast(`已添加 ${imported} 项创作资产`);
  } catch (error) {
    showToast(`素材添加失败：${error.message}`);
  } finally {
    el.importLocalAssets.disabled = false;
  }
}

function droppedUrls(dataTransfer) {
  const urls = new Set();
  const add = value => {
    try {
      const url = new URL(String(value || '').trim());
      if (['http:', 'https:', 'data:'].includes(url.protocol)) urls.add(url.href);
    } catch {}
  };
  for (const line of (dataTransfer.getData('text/uri-list') || '').split(/\r?\n/)) {
    if (line && !line.startsWith('#')) add(line);
  }
  const html = dataTransfer.getData('text/html');
  if (html) {
    const document = new DOMParser().parseFromString(html, 'text/html');
    document.querySelectorAll('img[src]').forEach(image => add(image.getAttribute('src')));
  }
  const plain = dataTransfer.getData('text/plain');
  if (/^(https?:|data:image\/)/i.test(plain.trim())) add(plain);
  return [...urls].slice(0, 20);
}

function droppedLocalPaths(dataTransfer) {
  if (typeof API?.getPathForFile !== 'function') return [];
  const paths = [];
  for (const file of Array.from(dataTransfer.files || [])) {
    try {
      const filePath = API.getPathForFile(file);
      if (filePath) paths.push(filePath);
    } catch {}
  }
  return paths.slice(0, 100);
}

async function importDroppedAssets(dataTransfer) {
  if (typeof API?.importDroppedAssets !== 'function') {
    showToast('拖拽导入需要最新版桌面软件');
    return;
  }
  const paths = droppedLocalPaths(dataTransfer);
  const urls = droppedUrls(dataTransfer);
  if (!paths.length && !urls.length) {
    showToast('没有识别到可导入的图片、视频或音频');
    return;
  }
  el.assetDropZone.classList.add('is-importing');
  el.assetDropZone.setAttribute('aria-busy', 'true');
  showToast(`正在导入 ${paths.length + urls.length} 项素材…`);
  try {
    const result = await API.importDroppedAssets({ paths, urls });
    const imported = Number(result?.imported) || 0;
    const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
    await loadAssetItems();
    if (failed) showToast(`已拖入 ${imported} 项，${failed} 项未能导入`);
    else showToast(`已拖入 ${imported} 项创作资产`);
  } catch (error) {
    showToast(`拖拽导入失败：${error.message}`);
  } finally {
    el.assetDropZone.classList.remove('is-importing');
    el.assetDropZone.setAttribute('aria-busy', 'false');
  }
}

function queueBoundsUpdate() {
  cancelAnimationFrame(boundsFrame);
  boundsFrame = requestAnimationFrame(() => {
    const rect = el.browserStage.getBoundingClientRect();
    API.setBrowserBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }).catch(() => {});
  });
}

function applyAssetPanelState(panel) {
  if (!panel || typeof panel !== 'object') return;
  state.assetPanel = {
    open: panel.open !== false,
    layout: panel.layout === 'push' ? 'push' : 'overlay',
    layoutVersion: ASSET_LAYOUT_VERSION,
    width: Number.isFinite(Number(panel.width))
      ? Math.max(360, Math.min(760, Math.round(Number(panel.width))))
      : state.assetPanel.width,
  };
  const available = panel.creativeAssetAvailable !== false && state.config?.paths?.creativeAssetAvailable !== false;
  el.toggleAssets.disabled = !available;
  el.toggleAssets.classList.toggle('active', state.assetPanel.open && available);
  el.toggleAssets.setAttribute('aria-pressed', String(state.assetPanel.open && available));
  el.toggleAssets.title = available
    ? (state.assetPanel.open ? '关闭创作资产库' : '打开创作资产库')
    : '创作资产库暂不可用';
  clearTimeout(assetPanelSaveTimer);
  assetPanelSaveTimer = setTimeout(() => saveWorkspace(true), 180);
}

async function toggleAssetPanel() {
  if (typeof API?.setAssetPanel !== 'function') {
    showToast('创作资产库需要通过桌面版启动');
    return;
  }
  el.toggleAssets.disabled = true;
  try {
    const panel = await API.setAssetPanel({
      ...state.assetPanel,
      open: !state.assetPanel.open,
    });
    applyAssetPanelState(panel);
    showToast(panel.open ? '已打开创作资产库' : '已关闭创作资产库');
  } catch (error) {
    showToast(`创作资产库切换失败：${error.message}`);
  } finally {
    el.toggleAssets.disabled = state.config?.paths?.creativeAssetAvailable === false;
  }
}

async function openFullAssetLibrary({ focusPath } = {}) {
  if (typeof API?.setAssetPanel !== 'function') {
    showToast('完整资产库需要通过桌面版打开');
    return;
  }
  try {
    const panel = await API.setAssetPanel({ ...state.assetPanel, open: true });
    applyAssetPanelState(panel);
    // 带目标资产时，让完整库自动定位到它（选中文件夹 + 高亮 + 直接预览）；
    // 同时携带发起时的剧本 id，防止切换剧本的瞬间把旧目标误投到新剧本的面板。
    if (focusPath && typeof API.focusAssetInLibrary === 'function') {
      const delivered = await API.focusAssetInLibrary(focusPath, state.projectId);
      if (delivered?.delivered === 'stale-project') {
        showToast('剧本已切换，旧资产定位已取消');
      }
    }
  } catch (error) {
    showToast(`资产库打开失败：${error.message}`);
  }
}

function bindEvents() {
  // 统一跟踪预览、改名等所有对话框；关闭一个时，不能盖住另一个仍打开的对话框。
  const dialogObserver = new MutationObserver(syncCreatorDialogVisibility);
  document.querySelectorAll('dialog').forEach(dialog => {
    dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  });
  syncCreatorDialogVisibility();
  document.querySelectorAll('.mode-button').forEach(button => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });
  el.addPlatform.addEventListener('click', () => {
    const opening = el.platformPopover.classList.contains('hidden');
    el.platformPopover.classList.toggle('hidden', !opening);
    el.addPlatform.setAttribute('aria-expanded', String(opening));
    if (opening) requestAnimationFrame(() => el.platformName.focus());
    queueBoundsUpdate();
  });
  el.cancelPlatform.addEventListener('click', () => {
    closePlatformPopover();
    queueBoundsUpdate();
  });
  el.platformForm.addEventListener('submit', addCustomPlatform);
  el.restoreAllPlatforms.addEventListener('click', restoreAllPlatforms);
  el.duplicateTab.addEventListener('click', duplicateActiveTab);
  el.clearBrowserTabs.addEventListener('click', clearBrowserTabs);
  el.platformForm.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closePlatformPopover();
    el.addPlatform.focus();
    queueBoundsUpdate();
  });
  // 固定提示词：支持不经过编辑器直接新建（内容完全由你自己填写，系统不提供任何预设）。
  el.templateCreate.addEventListener('click', () => {
    const opening = el.templateCreateForm.classList.contains('hidden');
    el.templateCreateForm.classList.toggle('hidden', !opening);
    if (opening) requestAnimationFrame(() => el.templateCreateName.focus());
  });
  el.cancelTemplateCreate.addEventListener('click', () => {
    el.templateCreateForm.classList.add('hidden');
    el.templateCreateName.value = '';
    el.templateCreateBody.value = '';
  });
  el.templateCreateForm.addEventListener('submit', event => {
    event.preventDefault();
    const title = el.templateCreateName.value.trim();
    const body = el.templateCreateBody.value.trim();
    if (!title || !body) {
      showToast(title ? '请填写提示词内容' : '请填写名称');
      (title ? el.templateCreateBody : el.templateCreateName).focus();
      return;
    }
    state.promptTemplates[state.mode].unshift({
      id: `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      body,
      at: Date.now(),
    });
    state.promptTemplates[state.mode] = state.promptTemplates[state.mode].slice(0, 50);
    expandedTemplates.add(state.promptTemplates[state.mode][0].id);
    activeTemplateIds[state.mode] = state.promptTemplates[state.mode][0].id;
    el.templateCreateForm.classList.add('hidden');
    el.templateCreateName.value = '';
    el.templateCreateBody.value = '';
    state.accordions.prompt = true;
    saveWorkspace(true);
    renderPromptTemplates();
    showToast(`已保存固定提示词「${title}」，所有剧本通用`);
  });
  el.promptAccordion.addEventListener('toggle', () => {
    state.accordions.prompt = el.promptAccordion.open;
    saveWorkspace();
    queueBoundsUpdate();
  });
  el.assetAccordion.addEventListener('toggle', () => {
    state.accordions.assets = el.assetAccordion.open;
    saveWorkspace();
    queueBoundsUpdate();
  });
  el.openModeFolder.addEventListener('click', () => API.openFolder(state.mode).catch(error => showToast(error.message)));
  el.toggleAssets.addEventListener('click', toggleAssetPanel);
  el.renameForm.addEventListener('submit', saveRenamedItem);
  el.renameCancel.addEventListener('click', () => el.renameDialog.close());
  el.importLocalAssets.addEventListener('click', () => {
    el.quickFileInput.click();
  });
  el.quickFileInput.addEventListener('change', () => {
    const files = [...el.quickFileInput.files];
    el.quickFileInput.value = '';
    if (!files.length) return;
    const target = state.quickAssetFolder || '';
    importLocalFilesToFolder(files, target);
  });
  el.openAssetLibrary.addEventListener('click', openFullAssetLibrary);
  el.toggleDragTray.addEventListener('click', async () => {
    try {
      const result = await API.toggleDragTray();
      showToast(result?.open
        ? '悬浮窗已开启（置顶小窗）：拖卡片进剪映，或点卡片复制后 ⌘V 粘贴'
        : '剪映悬浮窗已关闭');
    } catch (error) { showToast(error.message || '悬浮窗开启失败'); }
  });
  el.quickMultiSelect.addEventListener('click', () => setQuickSelectMode(!state.quickSelectMode));
  el.quickSelClear.addEventListener('click', () => {
    state.quickSelectionOrder.length = 0;
    updateQuickSelectionUI();
  });
  el.assetDropZone.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    importLocalAssets();
  });
  el.assetDropZone.addEventListener('dragenter', event => {
    event.preventDefault();
    assetDragDepth++;
    el.assetDropZone.classList.add('is-dragging');
  });
  el.assetDropZone.addEventListener('dragover', event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  el.assetDropZone.addEventListener('dragleave', () => {
    assetDragDepth = Math.max(0, assetDragDepth - 1);
    if (!assetDragDepth) el.assetDropZone.classList.remove('is-dragging');
  });
  el.assetDropZone.addEventListener('drop', event => {
    event.preventDefault();
    assetDragDepth = 0;
    el.assetDropZone.classList.remove('is-dragging');
    const targetFolder = state.quickAssetFolder;
    if (targetFolder && !isProjectRootFolder(targetFolder) && event.dataTransfer && event.dataTransfer.files.length) {
      importLocalFilesToFolder(event.dataTransfer.files, targetFolder);
      return;
    }
    importDroppedAssets(event.dataTransfer);
  });
  el.currentProject.addEventListener('click', openProjectMenu);
  el.currentProject.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    openProjectMenu();
  });
  el.showMainWindow.addEventListener('click', () => API.showMainWindow());
  el.importDownloadedFiles.addEventListener('click', importDownloadedFiles);
  el.browserRecoveryImport.addEventListener('click', importDownloadedFiles);
  el.openExternal.addEventListener('click', openCurrentInSystemBrowser);
  el.browserRecoveryExternal.addEventListener('click', openCurrentInSystemBrowser);
  el.browserRecoveryReload.addEventListener('click', reloadCurrentPlatform);
  el.reconnectBrowser.addEventListener('click', () => {
    if (state.browser?.tabId) selectService(state.activeService);
    else el.addPlatform.click();
  });
  el.addressForm.addEventListener('submit', event => {
    event.preventDefault();
    navigateToAddress();
  });
  el.addressInput.addEventListener('input', () => el.addressInput.setAttribute('aria-invalid', 'false'));
  el.addressInput.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const service = serviceById(state.activeService);
    el.addressInput.value = state.browser?.url || service?.url || '';
    el.addressInput.setAttribute('aria-invalid', 'false');
    el.addressInput.blur();
  });
  el.togglePrompt.addEventListener('click', () => {
    const compact = window.matchMedia('(max-width: 900px)').matches;
    const collapsed = compact
      ? !document.body.classList.toggle('prompt-expanded')
      : document.body.classList.toggle('prompt-collapsed');
    el.togglePrompt.setAttribute('aria-expanded', String(!collapsed));
    el.togglePrompt.title = collapsed ? '展开创作材料栏' : '收起创作材料栏';
    queueBoundsUpdate();
  });
  el.promptEditor.addEventListener('input', () => {
    state.prompts[state.mode] = el.promptEditor.value;
    updateCharacterCount();
    saveWorkspace();
    scheduleHistorySnapshot();
  });
  el.copyPrompt.addEventListener('click', () => { copyPrompt(false); });
  el.quickPreviewClose.addEventListener('click', closeQuickPreview);
  el.quickPreviewDone.addEventListener('click', closeQuickPreview);
  el.quickPreviewDialog.addEventListener('click', event => { if (event.target === el.quickPreviewDialog) closeQuickPreview(); });
  el.quickPreviewInLibrary.addEventListener('click', () => {
    const focusPath = quickPreviewItem?.path || '';
    closeQuickPreview();
    openFullAssetLibrary({ focusPath });
  });
  el.clearPrompt.addEventListener('click', () => {
    if (!el.promptEditor.value.trim()) { showToast('提示词已经是空的'); return; }
    if (state.skipClearConfirm) { clearPromptEditor(); return; }
    openCreatorDialog(el.clearPromptDialog);
  });
  el.clearPromptConfirm.addEventListener('click', () => {
    el.clearPromptDialog.close();
    clearPromptEditor();
  });
  el.clearPromptNever.addEventListener('click', () => {
    state.skipClearConfirm = true;
    saveWorkspace(true);
    el.clearPromptDialog.close();
    clearPromptEditor();
  });
  el.clearPromptCancel.addEventListener('click', () => el.clearPromptDialog.close());
  document.querySelectorAll('[data-nav]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.action || button.dataset.nav;
      API.navigate(action).catch(error => showToast(error.message));
    });
  });
  new ResizeObserver(queueBoundsUpdate).observe(el.browserStage);
  window.addEventListener('resize', queueBoundsUpdate);
  window.addEventListener('beforeunload', () => saveWorkspace(true));
  API.onBrowserState(applyBrowserState);
  API.onAssetDragResult?.(result => {
    document.querySelectorAll('.asset-card-wrap.asset-dragging').forEach(card => card.classList.remove('asset-dragging'));
    if (!result?.ok) showToast(result?.error || '文件拖拽失败，请重试');
  });
  API.onDownload(download => {
    const isNew = !state.downloads.has(download.id);
    if (isNew) {
      // 血缘：按下载记录自己的模式快照，避免用户切换模式后串线
      const mode = download.mode === 'video' ? 'video' : 'image';
      state.promptAtStart.set(download.id, state.prompts[mode] || '');
    }
    state.downloads.set(download.id, download);
    renderDownloads();
    if (download.state === 'completed' && !state.lineageWritten.has(download.id)) {
      state.lineageWritten.add(download.id);
      writeLineageSidecar(download).then(result => {
        const current = state.downloads.get(download.id);
        if (!current) return;
        if (typeof result === 'string' && result.startsWith('error:')) {
          current.lineageState = 'error';
          current.lineageError = `提示词血缘写入失败：${result.slice(6)}`;
          showToast(`${download.filename} 已归档，但提示词血缘未写入`);
        } else if (result === 'saved') {
          current.lineageState = 'saved';
        }
        renderDownloads();
      });
      loadProduction(true).then(() => {

        renderDownloads();
      }).catch(() => {});
      showToast(`${download.filename} 已自动归档`);
    }
  });
  API.onSetMode(mode => setMode(mode));
  if (typeof API.onProjectChanged === 'function') {
    API.onProjectChanged(project => queueProjectChange(project).catch(error => showToast(`切换剧本失败：${error.message}`)));
  }
  if (typeof API.onAssetPanelState === 'function') API.onAssetPanelState(applyAssetPanelState);

  // 高频快捷键（标准浏览器习惯）：
  // Cmd/Ctrl+数字 切多开网页；Enter 复制并切网页；E 导入下载；R/F5 刷新；
  // L 聚焦地址栏；W 关闭当前标签；[ / ] 后退/前进；+ / - / 0 页面缩放。
  document.addEventListener('keydown', event => {
    if (event.key === 'F5') {
      event.preventDefault();
      API.navigate('reload').catch(error => showToast(error.message));
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      copyPrompt(true);
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const tabs = tabsWithIndexes(visibleTabs());
      const tab = tabs[Number(event.key) - 1];
      if (tab) {
        event.preventDefault();
        selectTab(tab.id);
      }
      return;
    }
    const lower = event.key.toLowerCase();
    if (lower === 'e') {
      event.preventDefault();
      importDownloadedFiles();
      return;
    }
    if (lower === 'r') {
      event.preventDefault();
      API.navigate('reload').catch(error => showToast(error.message));
      return;
    }
    if (lower === 'l') {
      event.preventDefault();
      el.addressInput.focus();
      el.addressInput.select();
      return;
    }
    if (lower === 'w') {
      event.preventDefault();
      if (state.browser?.tabId) closeTab(state.browser.tabId);
      return;
    }
    if (event.key === '[') {
      event.preventDefault();
      API.navigate('back').catch(error => showToast(error.message));
      return;
    }
    if (event.key === ']') {
      event.preventDefault();
      API.navigate('forward').catch(error => showToast(error.message));
      return;
    }
    if (event.key === '=' || event.key === '+') {
      event.preventDefault();
      if (typeof API.pageZoom === 'function') API.pageZoom('in');
      return;
    }
    if (event.key === '-') {
      event.preventDefault();
      if (typeof API.pageZoom === 'function') API.pageZoom('out');
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      if (typeof API.pageZoom === 'function') API.pageZoom('reset');
    }
  });

  // 接收主窗口 Agent 经验库推送的模板（同源 localStorage）
  window.addEventListener('storage', event => {
    if (event.key === 'vos.pendingPrompt' && event.newValue) applyPendingPrompt().catch(() => {});
  });
}

async function applyPendingPrompt() {
  let payload = null;
  try { payload = JSON.parse(localStorage.getItem('vos.pendingPrompt') || 'null'); } catch {}
  if (!payload || typeof payload.body !== 'string') return;
  if (Date.now() - (payload.at || 0) > 10 * 60 * 1000) { localStorage.removeItem('vos.pendingPrompt'); return; }
  localStorage.removeItem('vos.pendingPrompt');
  if (state.config && ['image', 'video'].includes(payload.mode) && payload.mode !== state.mode) {
    if (!await setMode(payload.mode)) return;
  }
  el.templateCreateName.value = String(payload.title || '导入提示词').slice(0, 40);
  el.templateCreateBody.value = payload.body;
  el.templateCreateForm.classList.remove('hidden');
  state.accordions.prompt = true;
  el.promptAccordion.open = true;
  el.templateCreateName.focus();
  const source = 'Agent 经验库';
  showToast(`已填入来自${source}的「${payload.title || '模板'}」`);
}

async function boot() {
  document.documentElement.classList.toggle('is-electron', !!API);
  document.documentElement.classList.toggle('is-macos', /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  if (!API) {
    document.body.dataset.ready = 'error';
    document.body.classList.add('api-unavailable');
    el.addressInput.value = '';
    el.addressInput.placeholder = '创作浏览器需要通过桌面版启动';
    el.addressInput.disabled = true;
    el.addressGo.disabled = true;
    el.browserStage.querySelector('strong').textContent = '请从项目目录打开视频制作 OS 桌面版';
    return;
  }
  try {
    state.config = await API.getConfig();
    if (!new URLSearchParams(location.search).has('mode') && state.config.browser?.mode) {
      state.mode = state.config.browser.mode;
    }
    state.browser = state.config.browser || null;
    if (state.config?.project?.id) state.projectId = state.config.project.id;
    loadWorkspace();
    bindEvents();
    renderProject();
    await applyPendingPrompt(); // 主窗口先推送、后打开创作浏览器的场景
    try { await loadProduction(true); }
    catch (error) {
      state.production = { available: false, context: null, inbox: [], stats: {}, error: error.message };
    }
    if (typeof API.setAssetPanel === 'function') {
      const panel = await API.setAssetPanel(state.assetPanel);
      applyAssetPanelState(panel);
    } else {
      applyAssetPanelState({ ...state.assetPanel, creativeAssetAvailable: false });
    }
    await loadAssetItems();
    for (const download of await API.getDownloads()) state.downloads.set(download.id, download);
    state.activeService = effectiveServiceForMode(state.mode);
    renderMode();
    await restoreModeBrowser();
    const productionEvents = new EventSource('/api/events');
    productionEvents.addEventListener('production', () => {
      loadProduction(true).then(() => {

        renderDownloads();
      }).catch(() => {});
    });
    productionEvents.addEventListener('creative-assets', () => {
      loadAssetItems().catch(() => {});
    });
    // 资产面板/HTTP activate 的全局权威通知：广播载荷携带实时激活项目，走既有串行切换链。
    // 同项目重复事件被 applyProjectChange 的同 id 守卫吸收，不会重置草稿；主窗口选剧器的定向 IPC 保留原语义。
    productionEvents.addEventListener('creative-projects', event => {
      try {
        const payload = JSON.parse(event.data || 'null');
        if (payload?.project?.id) queueProjectChange(payload.project);
      } catch {}
    });
    document.body.dataset.ready = 'true';
  } catch (error) {
    document.body.dataset.ready = 'error';
    el.addressInput.value = '';
    el.addressInput.placeholder = `工作台初始化失败：${error.message}`;
    showToast(`工作台初始化失败：${error.message}`);
  }
}

boot();
