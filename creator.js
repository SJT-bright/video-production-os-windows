/* ================= 创作浏览器工作台 ================= */
'use strict';

const API = typeof window.creatorOS?.getConfig === 'function' ? window.creatorOS : window.creatorAPI;
const LEGACY_STORAGE_KEY = 'videoOS.creator.workspace.v1';
const GLOBAL_STORAGE_KEY = 'videoOS.creator.global.v2';
const PROJECT_STORAGE_PREFIX = 'videoOS.creator.project.v2.';
const promptTemplateStore = window.PromptTemplateStore.create(localStorage);
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
  templateCreateDrafts: {
    image: { name: '', body: '', open: false },
    video: { name: '', body: '', open: false },
  },
  scripts: { groups: [] },
  accordions: { prompt: false, scripts: true, assets: true },
  sidebarCollapsed: null,
  quickFolders: [],
  quickAssetFolder: '',
  quickViewFolder: '',
  quickIndexes: null,
  collapsedQuickFolders: new Set(),
  quickCollapseInit: false,
  quickSelectMode: false,
  quickSelectionOrder: [],
  // 已浮出为置顶小窗的视频资产（key=卡片相对路径，value=浮窗侧返回的路径）。
  // 仅存在于本次会话内存：切换剧本清空、刷新自动复位，绝不持久化，避免留下与真实浮窗不符的假状态。
  floatedVideoPaths: new Map(),
  skipClearConfirm: false,
  activeService: null,
  assetItems: [],
  browserDownloadLimit: 60,
  browserDownloadFolderFilter: '',
  downloads: new Map(),
  archiveNotified: new Set(),
  production: { available: false, context: null, inbox: [], stats: {} },
  browser: null,
  modeSwitchPending: false,
  assetPanel: { ...DEFAULT_ASSET_PANEL },
};

const el = Object.fromEntries([
  'platformTabs', 'addPlatform', 'clearBrowserTabs', 'platformPopover', 'platformForm', 'platformName', 'platformUrl', 'cancelPlatform',
  'platformOpenList', 'duplicateTab', 'duplicateTabLabel',
  'allTabsButton', 'allTabsPopover', 'allTabsSearch', 'allTabsList',
  'tabContextMenu', 'findBar', 'findInput', 'findCount', 'findPrev', 'findNext', 'findClose',
  'renameDialog', 'renameForm', 'renameTitle', 'renameName', 'renameError', 'renameCancel', 'renameSave',
  'hiddenPlatforms', 'hiddenPlatformList', 'restoreAllPlatforms',
  'draftStatus',
  'promptAccordion', 'promptAccordionCount', 'scriptAccordion', 'scriptAccordionCount', 'addScriptGroup', 'scriptGroups', 'assetAccordion', 'assetAccordionCount',
  'promptTemplateList',
  'templateCreate', 'templateCreateForm', 'templateCreateName', 'templateCreateBody', 'cancelTemplateCreate',
  'quickFolderTree', 'quickDropTarget', 'quickDropTargetHint', 'quickViewNotice', 'quickFileInput',
  'quickMoveDialog', 'quickMoveDialogTitle', 'quickMoveDialogHint', 'quickMoveFolderList', 'quickCancelMove', 'quickCancelMoveTop',
  'importLocalAssets', 'openAssetLibrary', 'assetDropZone',
  'quickTools', 'quickMultiSelect', 'quickSelInfo', 'quickSelAll', 'quickSelDelete', 'quickSelClear',
  'downloadSummary', 'downloadList', 'openModeFolder', 'browserStage', 'platformBackdrop', 'platformBackdropLayer', 'platformBackdropPrimary', 'addressService',
  'browserPlaceholderTitle', 'reconnectBrowser',
  'addressForm', 'addressInput', 'addressGo', 'loadDot', 'openExternal', 'togglePrompt', 'collapseMaterialSidebar', 'showMainWindow', 'creatorToast',
  'splitViewToggle', 'splitBar', 'splitFocusLeft', 'splitFocusRight', 'splitReplace', 'splitClose', 'splitGutter',
  'splitPickerDialog', 'splitPickerTitle', 'splitPickerHint', 'splitPickerBody', 'splitPickerClose',
  'importDownloadedFiles', 'browserRecovery',
  'browserRecoveryMessage', 'browserRecoveryUrl', 'browserRecoveryReload',
  'browserRecoveryExternal', 'browserRecoveryImport', 'toggleAssets',
  'downloadBadge',
  'currentProject',
  'projectPopover', 'projectMenuList', 'projectMenuManage',
  'promptEditor', 'characterCount', 'copyPrompt',
  'clearPrompt', 'clearPromptDialog', 'clearPromptConfirm', 'clearPromptCancel', 'clearPromptNever',
  'quickPreviewDialog', 'quickPreviewName', 'quickPreviewMeta', 'quickPreviewStage', 'quickPreviewClose', 'quickPreviewDone', 'quickPreviewInLibrary',
].map(id => [id, document.getElementById(id)]));

let toastTimer = null;
let saveTimer = null;
let boundsFrame = null;
let assetPanelSaveTimer = null;
let assetDragDepth = 0;
let workspaceReadFailed = false;
let quickProjectViewEpoch = 0;

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

function setTemplateCreateFormOpen(open) {
  const visible = !!open;
  el.templateCreateForm.hidden = !visible;
  el.templateCreateForm.classList.toggle('hidden', !visible);
  el.templateCreate.setAttribute('aria-expanded', String(visible));
  state.templateCreateDrafts[state.mode].open = visible;
}

function captureTemplateCreateDraft() {
  state.templateCreateDrafts[state.mode] = {
    name: el.templateCreateName.value,
    body: el.templateCreateBody.value,
    open: !el.templateCreateForm.hidden && !el.templateCreateForm.classList.contains('hidden'),
  };
}

function restoreTemplateCreateDraft() {
  const draft = state.templateCreateDrafts[state.mode];
  el.templateCreateName.value = draft.name;
  el.templateCreateBody.value = draft.body;
  // 模式切回也不自动展开空白表单；非空的未保存草稿仍按用户原选择恢复。
  setTemplateCreateFormOpen(draft.open && !!(draft.name.trim() || draft.body.trim()));
}

function loadWorkspace() {
  workspaceReadFailed = false;
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{}');
    const global = JSON.parse(localStorage.getItem(GLOBAL_STORAGE_KEY) || '{}');
    const canMigrateLegacy = !localStorage.getItem(`${PROJECT_STORAGE_PREFIX}${state.projectId}`)
      && state.config?.project?.folder === '青春校园短剧';
    const saved = JSON.parse(localStorage.getItem(`${PROJECT_STORAGE_PREFIX}${state.projectId}`) || '{}');
    const project = canMigrateLegacy ? legacy : saved;
    promptTemplateStore.claimLegacy(state.projectId);
    for (const mode of ['image', 'video']) {
      if (typeof project.prompts?.[mode] === 'string') state.prompts[mode] = withoutLegacySkeleton(mode, project.prompts[mode]);
      if (typeof global.services?.[mode] === 'string') state.services[mode] = global.services[mode];
      else if (typeof legacy.services?.[mode] === 'string') state.services[mode] = legacy.services[mode];
      if (Array.isArray(project.history?.[mode])) {
        state.history[mode] = project.history[mode]
          .filter(item => item && typeof item.body === 'string' && item.at)
          .slice(0, 20);
      }
      const draft = project.templateCreateDrafts?.[mode];
      const name = typeof draft?.name === 'string' ? draft.name : '';
      const body = typeof draft?.body === 'string' ? draft.body : '';
      state.templateCreateDrafts[mode] = {
        name,
        body,
        // 刷新只恢复用户已打开的非空草稿，不把空白新建表单自动铺开。
        open: draft?.open === true && !!(name.trim() || body.trim()),
      };
    }
    state.promptTemplates = promptTemplateStore.load(state.projectId, canMigrateLegacy ? legacy : null);
    // 剧本面板按剧本项目存储：每个剧本各自的集数分组与段落内容。
    if (project.scripts && Array.isArray(project.scripts.groups)) {
      state.scripts = {
        groups: project.scripts.groups
          .filter(group => group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.items))
          .slice(0, 200)
          .map(group => ({
            id: group.id,
            name: group.name.slice(0, 60),
            items: group.items
              .filter(item => item && typeof item.id === 'string' && typeof item.text === 'string')
              .slice(0, 100)
              .map(item => ({ id: item.id, title: String(item.title || '').slice(0, 60), text: item.text.slice(0, 200000), updatedAt: Number(item.updatedAt) || 0 })),
          })),
      };
    }
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
    if (typeof global.sidebarCollapsed === 'boolean') state.sidebarCollapsed = global.sidebarCollapsed;
    if (global.accordions && typeof global.accordions === 'object') {
      for (const key of ['prompt', 'scripts', 'assets']) {
        if (typeof global.accordions[key] === 'boolean') state.accordions[key] = global.accordions[key];
      }
    }
    restoreTemplateCreateDraft();
    syncAccordionState();
    if (canMigrateLegacy || saved.promptTemplatesVersion !== 3) saveWorkspace(true);
  } catch {
    workspaceReadFailed = true;
    showToast('工作区记录无法读取，已保留原数据，暂不写入或迁移');
  }
}

function resetProjectWorkspace() {
  // 即便 A → B → A，旧批量删除的回执也不能清除新一轮 A 页面里的选择。
  quickProjectViewEpoch++;
  state.prompts = { image: '', video: '' };
  state.history = { image: [], video: [] };
  state.promptTemplates = { image: [], video: [] };
  state.templateCreateDrafts = {
    image: { name: '', body: '', open: false },
    video: { name: '', body: '', open: false },
  };
  expandedTemplates.clear(); templateDrafts.clear();
  activeTemplateIds.image = ''; activeTemplateIds.video = '';
  restoreTemplateCreateDraft();
  state.assetItems = [];
  state.quickViewFolder = '';
  state.quickIndexes = null;
  el.assetDropZone.classList.remove('is-importing');
  el.assetDropZone.setAttribute('aria-busy', 'false');
  state.browserDownloadFolderFilter = '';
  // 剧本面板按剧本项目存储：切换后由 loadWorkspace 读入新剧本的分组。
  state.scripts = { groups: [] };
  expandedScriptGroups.clear(); expandedScriptItems.clear();
  // 框选导入序列属于旧剧本：整体清空，防止把旧项目资产拖进新项目上下文。
  state.quickSelectionOrder.length = 0;
  state.quickSelectMode = false;
  // 浮出角标同样按剧本隔离：切换后旧路径不再匹配新剧本卡片，直接清空防止假状态。
  state.floatedVideoPaths.clear();
}

function saveWorkspace(immediate = false) {
  clearTimeout(saveTimer);
  if (workspaceReadFailed) return false;
  captureTemplateCreateDraft();
  // 防抖提交可能在切换剧本之后才落地：调度时快照项目数据，提交时按快照写回原剧本，
  // 避免输入后立即切剧本把 A 的草稿/历史写进 B 的存储。
  const snapshot = {
    projectId: state.projectId,
    prompts: { ...state.prompts },
    history: { image: [...state.history.image], video: [...state.history.video] },
    scripts: JSON.parse(JSON.stringify(state.scripts)),
    promptTemplates: JSON.parse(JSON.stringify(state.promptTemplates)),
    templateCreateDrafts: JSON.parse(JSON.stringify(state.templateCreateDrafts)),
  };
  const commit = () => {
    // localStorage 写满（超大纲剧本/素材积累）会抛 QuotaExceededError：必须接住并明确提示，不能静默丢保存
    try {
      const global = JSON.parse(localStorage.getItem(GLOBAL_STORAGE_KEY) || '{}');
      localStorage.setItem(GLOBAL_STORAGE_KEY, JSON.stringify({
        ...global,
        version: 2,
        services: state.services,
        assetPanel: state.assetPanel,
        accordions: state.accordions,
        sidebarCollapsed: state.sidebarCollapsed,
        skipClearConfirm: state.skipClearConfirm,
      }));
      const projectKey = `${PROJECT_STORAGE_PREFIX}${snapshot.projectId}`;
      // 保留旧版本的存储字段；已停用功能不再读取或更新，避免清掉用户历史内容。
      const previous = JSON.parse(localStorage.getItem(projectKey) || '{}');
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('工作区记录无效');
      localStorage.setItem(projectKey, JSON.stringify({
        ...previous,
        version: 2,
        projectId: snapshot.projectId,
        prompts: snapshot.prompts,
        history: snapshot.history,
        scripts: snapshot.scripts,
        promptTemplatesVersion: 3,
        promptTemplates: snapshot.promptTemplates,
        templateCreateDrafts: snapshot.templateCreateDrafts,
      }));
    } catch (error) {
      const quota = error.name === 'QuotaExceededError';
      el.draftStatus.textContent = quota ? '保存失败：本机存储空间不足' : '保存失败：原记录未覆盖';
      showToast(quota ? '工作区保存失败：本机存储空间不足，请拆分超大剧本'
        : '工作区保存失败：原记录未覆盖，请先检查本机记录');
      return false;
    }
    el.draftStatus.textContent = '已在本机自动保存';
    return true;
  };
  if (immediate) return commit();
  else {
    el.draftStatus.textContent = '正在保存…';
    saveTimer = setTimeout(commit, 260);
  }
  return true;
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

/* 成就计时：视频模式下累计创作时长。窗口可见时每秒累加、每 60 秒落盘一次；
   时长存全局 localStorage（主页总览据此解锁时间类成就），图片模式与窗口隐藏时不计时。 */
const ACHIEVEMENT_KEY = 'videoOS.achievements.v1';
let videoWorkTimer = null;
let videoWorkBuffer = 0;

function readAchievementState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACHIEVEMENT_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function flushVideoWorkSeconds() {
  if (videoWorkBuffer <= 0) return;
  const saved = readAchievementState();
  saved.videoSeconds = (Number(saved.videoSeconds) || 0) + videoWorkBuffer;
  saved.updatedAt = Date.now();
  try { localStorage.setItem(ACHIEVEMENT_KEY, JSON.stringify(saved)); } catch {}
  videoWorkBuffer = 0;
}

function startVideoWorkTimer() {
  stopVideoWorkTimer();
  videoWorkTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    videoWorkBuffer += 1;
    if (videoWorkBuffer >= 60) flushVideoWorkSeconds();
  }, 1000);
}

function stopVideoWorkTimer() {
  if (videoWorkTimer) { clearInterval(videoWorkTimer); videoWorkTimer = null; }
  flushVideoWorkSeconds();
}

window.addEventListener('beforeunload', flushVideoWorkSeconds);

function renderMode() {
  document.body.dataset.mode = state.mode;
  const candidateTitle = state.config?.candidate ? ` · 候选版 ${state.config.candidate.version || ''}` : '';
  document.title = `${state.mode === 'image' ? '图片' : '视频'}创作浏览器${candidateTitle}｜视频制作 OS`;
  document.querySelectorAll('.mode-button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
  });
  // 计时只跟视频模式走：切到视频开始累计，切回图片即落盘停止。
  if (state.mode === 'video') startVideoWorkTimer();
  else stopVideoWorkTimer();
  renderPlatforms();
  renderPromptTemplates();
  restoreTemplateCreateDraft();
  renderScripts();
  syncPromptEditor();
  renderQuickFolderTree();
  renderDownloads();
  syncAccordionState();
  syncMaterialSidebar();
  queueBoundsUpdate();
}

function materialSidebarCollapsed() {
  return state.sidebarCollapsed === null ? window.matchMedia('(max-width: 900px)').matches : state.sidebarCollapsed;
}

function syncMaterialSidebar() {
  const collapsed = materialSidebarCollapsed();
  const visibilityChanged = document.body.classList.contains('prompt-collapsed') !== collapsed;
  document.body.classList.toggle('prompt-collapsed', collapsed);
  document.body.classList.toggle('prompt-expanded', !collapsed);
  for (const button of [el.togglePrompt, el.collapseMaterialSidebar]) {
    if (!button) continue;
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? '展开创作材料栏' : '收起创作材料栏';
    button.setAttribute('aria-label', button.title);
  }
  if (visibilityChanged && state.config) renderQuickFolderTree();
}

function toggleMaterialSidebar() {
  state.sidebarCollapsed = !materialSidebarCollapsed();
  syncMaterialSidebar();
  saveWorkspace(true);
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
let nativeProjectMenuOpen = false;
let projectMenuRequest = 0;
let templateMigrationBusy = false;

function queueProjectChange(project) {
  projectChangeTask = projectChangeTask.catch(() => {}).then(() => applyProjectChange(project));
  return projectChangeTask;
}

function closeProjectMenu(restoreFocus = false) {
  projectMenuRequest++;
  if (nativeProjectMenuOpen) {
    nativeProjectMenuOpen = false;
    API.closeWorkspaceMenu?.().catch(() => {});
  }
  projectMenuOpen = false;
  el.projectPopover.classList.add('hidden');
  el.currentProject.setAttribute('aria-expanded', 'false');
  syncCreatorDialogVisibility();
  if (restoreFocus) el.currentProject.focus({ preventScroll: true });
}

async function migrateProjectTemplates(project, event) {
  event?.preventDefault();
  if (templateMigrationBusy) return;
  templateMigrationBusy = true;
  try {
    await projectChangeTask.catch(() => {});
    if (!saveWorkspace(true)) throw new Error('当前工作区未保存，请先检查本机存储');
    const source = promptTemplateStore.load(project.id);
    const counts = { image: source.image.length, video: source.video.length };
    if (!counts.image && !counts.video) { showToast('这个剧本没有已保存的固定提示词'); return; }
    if (typeof API.showProjectTemplateMenu !== 'function') throw new Error('请重启更新后的 App，以启用迁移菜单');
    closeProjectMenu();
    const rect = el.currentProject.getBoundingClientRect();
    const result = await API.showProjectTemplateMenu({ sourceProjectId: project.id, counts,
      x: event?.clientX || rect.left, y: event?.clientY || rect.bottom });
    if (!result?.targetProjectId) return;
    if (!saveWorkspace(true)) throw new Error('当前工作区未保存，未执行迁移');
    const moved = promptTemplateStore.migrate(project.id, result.targetProjectId);
    if (state.projectId === result.targetProjectId) {
      state.promptTemplates = moved.templates;
      renderPromptTemplates();
    }
    const targetName = result.targetName || '目标剧本';
    showToast(moved.added ? `已新增到「${targetName}」：图片 ${moved.counts.image} 条、视频 ${moved.counts.video} 条，原有模板未覆盖`
      : '目标剧本已包含这些模板，无需重复添加');
  } catch (error) { showToast(`迁移未完成：${error.message}`); }
  finally { templateMigrationBusy = false; }
}

async function openProjectMenu() {
  if (templateMigrationBusy) return;
  if (projectMenuOpen) { closeProjectMenu(true); return; }
  if (typeof API.selectProject !== 'function') {
    showToast('请重启更新后的 App，以启用剧本切换与迁移'); return;
  }
  closePlatformPopover();
  closeAllTabsPopover();
  projectMenuOpen = true;
  let menuRequest = ++projectMenuRequest;
  let pickedAction = false;
  el.currentProject.setAttribute('aria-expanded', 'true');
  try {
    await projectChangeTask.catch(() => {});
    if (!saveWorkspace(true)) throw new Error('当前工作区未保存');
    if (!projectMenuOpen || menuRequest !== projectMenuRequest) return;
    if (typeof API.showWorkspaceMenu === 'function') {
      const rect = el.currentProject.getBoundingClientRect();
      nativeProjectMenuOpen = true;
      const picked = await API.showWorkspaceMenu({ kind: 'projects', x: rect.left, y: rect.bottom + 4 });
      if (menuRequest !== projectMenuRequest) return;
      nativeProjectMenuOpen = false;
      closeProjectMenu();
      menuRequest = projectMenuRequest;
      if (!picked || picked.cancelled) return;
      pickedAction = true;
      if (picked.action === 'manage') {
        API.showProjectPicker(state.mode).catch(error => showToast(error.message));
      } else if (picked.action === 'migrate') {
        const response = await fetch('/api/creative-projects');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const catalog = await response.json();
        const source = (catalog.projects || []).find(project => project.id === picked.id);
        if (!source) throw new Error('这个剧本已不存在，请重新打开列表');
        await migrateProjectTemplates(source, { clientX: picked.x, clientY: picked.y, preventDefault() {} });
      } else if (picked.action === 'select' && picked.id) {
        el.currentProject.setAttribute('aria-busy', 'true');
        try {
          const result = await API.selectProject({ projectId: picked.id, mode: state.mode });
          if (result?.project) await queueProjectChange(result.project);
        } finally { el.currentProject.removeAttribute('aria-busy'); }
      }
      return;
    }
    const response = await fetch('/api/creative-projects');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    if (!projectMenuOpen || menuRequest !== projectMenuRequest) return;
    el.projectMenuList.replaceChildren();
    for (const project of catalog.projects || []) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'project-menu-item'; button.dataset.projectId = project.id;
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(project.id === state.projectId));
      button.disabled = project.available === false;
      button.textContent = project.name + (button.disabled ? '（目录不可用）' : '');
      button.title = `${project.name}｜右键迁移此剧本的固定提示词`;
      button.addEventListener('contextmenu', event => migrateProjectTemplates(project, event));
      button.addEventListener('keydown', event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) migrateProjectTemplates(project, event);
      });
      button.addEventListener('click', async () => {
        if (templateMigrationBusy) return;
        closeProjectMenu();
        try {
          el.currentProject.setAttribute('aria-busy', 'true');
          const result = await API.selectProject({ projectId: project.id, mode: state.mode });
          if (result?.project) await queueProjectChange(result.project);
        } catch (error) { showToast(`切换剧本失败：${error.message}`); }
        finally { el.currentProject.removeAttribute('aria-busy'); }
      });
      el.projectMenuList.append(button);
    }
    el.projectPopover.classList.remove('hidden');
    const rect = el.currentProject.getBoundingClientRect();
    const header = el.projectPopover.offsetParent.getBoundingClientRect();
    el.projectPopover.style.left = Math.max(8, Math.min(rect.left - header.left,
      header.width - el.projectPopover.offsetWidth - 8)) + 'px';
    syncCreatorDialogVisibility();
    el.projectMenuList.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  } catch (error) {
    if (!pickedAction && menuRequest !== projectMenuRequest) return;
    if (!pickedAction) closeProjectMenu(true);
    showToast(`切换剧本失败：${error.message}`);
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
  closeProjectMenu();
  if (!saveWorkspace(true)) throw new Error('原剧本工作区未保存，未切换创作材料');
  // 原生模式通知和面板自动保存可在 getConfig 等待期间到达。
  // 先获取配置，再同步切换键/重置/加载；不能把目标键暴露给尚未加载的空工作区。
  const config = await API.getConfig();
  if (!saveWorkspace(true)) throw new Error('原剧本工作区未保存，未切换创作材料');
  state.projectId = project.id;
  resetProjectWorkspace();
  state.config = config;
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

// 激活标签滚入可视范围：标签溢出一屏时，切换或新开网页后保证当前网页标签可见（配合滚轮横向滚动）。
function scrollActiveTabIntoView() {
  const active = el.platformTabs.querySelector('.platform-tab.active');
  if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// —— 标签拖拽换位（指针方案，对标 Chrome 自己的标签拖拽实现）——
// 不依赖 HTML5 DnD：Electron 打包环境下 dataTransfer/拖影行为不可控且版本敏感，
// pointer 事件完全由自己掌握。按住标签移动超过阈值进入拖动，光泽拖影实时跟随光标；
// 落到另一标签左右 1/3 显示插入线（松手插到该侧），中间 1/3 高亮互换；标签条空白处＝
// 移到末尾；Esc 取消；靠近标签条左右边缘自动横滚。未超过阈值＝普通点击，与点击选择、
// 双击/右键/F2 改名互不干扰。
const TAB_DRAG_THRESHOLD = 5;
let tabDrag = null; // { pointerId, sourceId, label, startX, startY, active, ghost, lastX, lastY, scrollFrame }
let tabDropPlan = null; // { targetId, zone: 'before' | 'after' | 'swap' }
let tabClickSuppressed = false;
const tabPopIds = new Set(); // 松手后要做 Q 弹落定动画的标签

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

function setTabStripDragging(on) {
  el.platformTabs.classList.toggle('tab-drag-active', on);
  document.body.classList.toggle('tab-dragging-cursor', on);
}

function removeTabDragGhost() {
  tabDrag?.ghost?.remove();
  if (tabDrag) tabDrag.ghost = null;
}

function clearTabDropFeedback() {
  for (const wrap of el.platformTabs.querySelectorAll('.platform-tab-wrap')) {
    wrap.classList.remove('drop-before', 'drop-after', 'drop-swap');
  }
}

function planTabDrop(wrapper, tabId, clientX) {
  const rect = wrapper.getBoundingClientRect();
  const ratio = (clientX - rect.left) / Math.max(rect.width, 1);
  const zone = ratio < 1 / 3 ? 'before' : ratio > 2 / 3 ? 'after' : 'swap';
  clearTabDropFeedback();
  wrapper.classList.add(zone === 'swap' ? 'drop-swap' : zone === 'before' ? 'drop-before' : 'drop-after');
  tabDropPlan = { targetId: tabId, zone };
}

function updateTabDragPlan(clientX, clientY) {
  if (!tabDrag?.active) return;
  const stripRect = el.platformTabs.getBoundingClientRect();
  // 拖出标签条范围：保留上一个放置计划（回到标签条内继续改）
  if (clientX < stripRect.left || clientX > stripRect.right || clientY < stripRect.top - 10 || clientY > stripRect.bottom + 10) return;
  for (const wrap of el.platformTabs.querySelectorAll('.platform-tab-wrap[data-tab-id]')) {
    const rect = wrap.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right) continue;
    if (wrap.dataset.tabId === tabDrag.sourceId) { tabDropPlan = null; clearTabDropFeedback(); return; }
    planTabDrop(wrap, wrap.dataset.tabId, clientX);
    return;
  }
  // 标签条空白处＝移到末尾
  const last = el.platformTabs.querySelector('.platform-tab-wrap[data-tab-id]:last-of-type');
  if (!last) return;
  clearTabDropFeedback();
  last.classList.add('drop-after');
  tabDropPlan = { targetId: last.dataset.tabId, zone: 'after' };
}

// 光泽 3D 拖影：真实 DOM 胶囊用 transform 跟随光标（比 setDragImage 的静态快照更顺滑），
// 带顶部高光、悬浮投影和轻微倾斜；结束时统一移除
function buildTabDragGhost(label) {
  const ghost = document.createElement('div');
  ghost.className = 'tab-drag-ghost';
  ghost.textContent = label || '网页';
  document.body.appendChild(ghost);
  return ghost;
}

function moveTabDragGhost(clientX, clientY) {
  if (!tabDrag?.ghost) return;
  tabDrag.ghost.style.transform = `translate(${Math.round(clientX + 14)}px, ${Math.round(clientY + 16)}px) rotate(-3deg) scale(1.06)`;
}

// 拖到标签条左右边缘时自动横滚，让溢出一屏的标签也能拖到
function startTabAutoScroll() {
  if (tabDrag.scrollFrame) return;
  const step = () => {
    if (!tabDrag?.active) { if (tabDrag) tabDrag.scrollFrame = 0; return; }
    const rect = el.platformTabs.getBoundingClientRect();
    const edge = 44;
    let delta = 0;
    if (tabDrag.lastX < rect.left + edge) delta = -Math.ceil((rect.left + edge - tabDrag.lastX) / 4);
    else if (tabDrag.lastX > rect.right - edge) delta = Math.ceil((tabDrag.lastX - (rect.right - edge)) / 4);
    if (delta && el.platformTabs.scrollWidth > el.platformTabs.clientWidth) {
      el.platformTabs.scrollLeft = Math.max(0, Math.min(el.platformTabs.scrollWidth, el.platformTabs.scrollLeft + delta));
      updateTabDragPlan(tabDrag.lastX, tabDrag.lastY);
    }
    tabDrag.scrollFrame = requestAnimationFrame(step);
  };
  tabDrag.scrollFrame = requestAnimationFrame(step);
}

function stopTabAutoScroll() {
  if (tabDrag?.scrollFrame) cancelAnimationFrame(tabDrag.scrollFrame);
  if (tabDrag) tabDrag.scrollFrame = 0;
}

function beginTabDrag(sourceId, label, event) {
  tabDrag = {
    pointerId: event.pointerId, sourceId, label,
    startX: event.clientX, startY: event.clientY,
    active: false, ghost: null,
    lastX: event.clientX, lastY: event.clientY, scrollFrame: 0,
  };
}

function activateTabDrag() {
  if (!tabDrag || tabDrag.active) return;
  tabDrag.active = true;
  tabDropPlan = null;
  setTabStripDragging(true);
  el.platformTabs.querySelector(`.platform-tab-wrap[data-tab-id="${CSS.escape(tabDrag.sourceId)}"]`)?.classList.add('dragging');
  tabDrag.ghost = buildTabDragGhost(tabDrag.label);
  moveTabDragGhost(tabDrag.lastX, tabDrag.lastY);
  startTabAutoScroll();
}

function endTabDrag({ commit }) {
  if (!tabDrag) return;
  const plan = commit ? tabDropPlan : null;
  const sourceId = tabDrag.sourceId;
  stopTabAutoScroll();
  setTabStripDragging(false);
  clearTabDropFeedback();
  removeTabDragGhost();
  el.platformTabs.querySelectorAll('.platform-tab-wrap.dragging').forEach(wrap => wrap.classList.remove('dragging'));
  tabDrag = null;
  tabDropPlan = null;
  if (commit && plan) commitTabReorder(sourceId, plan);
}

async function commitTabReorder(dragTabId, plan) {
  if (!plan || !dragTabId || plan.targetId === dragTabId) return;
  const ids = tabsWithIndexes(visibleTabs()).map(tab => tab.id);
  // 拖拽途中列表可能已被刷新（SSE 推送、项目切换）：源或目标不在当前模式就安静放弃，不弹错误
  if (!ids.includes(dragTabId) || !ids.includes(plan.targetId)) return;
  let payload;
  if (plan.zone === 'swap') {
    payload = { swapTabId: dragTabId, withTabId: plan.targetId };
  } else {
    const targetIndex = ids.indexOf(plan.targetId);
    // “插到目标之后”＝插到目标的下一个标签之前；目标已是当前模式最后一个则移到末尾。
    // 下一个标签若正是被拖标签自己，说明拖回了原位，不提交。
    const beforeTabId = plan.zone === 'before' ? plan.targetId : (ids[targetIndex + 1] || '');
    if (beforeTabId === dragTabId) return;
    payload = { moveTabId: dragTabId, beforeTabId };
  }
  tabPopIds.add(dragTabId);
  if (plan.zone === 'swap') tabPopIds.add(plan.targetId);
  try {
    const browser = await API.reorderTabs(payload);
    if (browser) applyBrowserState(browser);
    showToast(plan.zone === 'swap' ? '已互换两个网页的位置' : '已调整网页顺序');
  } catch (error) {
    tabPopIds.clear();
    showToast(error.message || '调整网页顺序失败');
  }
}

// FLIP：重渲染前后按标签 id 记录横向位置，位置变化的标签滑入新槽位；
// 被移动／互换的标签再叠加一次 Q 弹落定。reduced-motion 用户直接跳过动画。
function captureTabLefts() {
  const containerLeft = el.platformTabs.getBoundingClientRect().left;
  const lefts = new Map();
  for (const wrap of el.platformTabs.querySelectorAll('.platform-tab-wrap[data-tab-id]')) {
    lefts.set(wrap.dataset.tabId, wrap.getBoundingClientRect().left - containerLeft + el.platformTabs.scrollLeft);
  }
  return lefts;
}

function playTabFlip(previousLefts) {
  const containerRect = el.platformTabs.getBoundingClientRect();
  const animate = !reducedMotion();
  for (const wrap of el.platformTabs.querySelectorAll('.platform-tab-wrap[data-tab-id]')) {
    const id = wrap.dataset.tabId;
    if (animate && previousLefts.has(id)) {
      const dx = previousLefts.get(id) - (wrap.getBoundingClientRect().left - containerRect.left + el.platformTabs.scrollLeft);
      if (Math.abs(dx) > 1) {
        wrap.style.transition = 'none';
        wrap.style.transform = `translateX(${Math.round(dx)}px)`;
        requestAnimationFrame(() => {
          wrap.style.transition = '';
          wrap.style.transform = '';
          wrap.classList.add('flip-move');
          const settle = () => { wrap.classList.remove('flip-move'); wrap.removeEventListener('transitionend', settle); };
          wrap.addEventListener('transitionend', settle);
          setTimeout(settle, 480);
        });
      }
    }
    if (animate && tabPopIds.has(id)) {
      wrap.classList.add('flip-pop');
      const clear = () => wrap.classList.remove('flip-pop');
      wrap.addEventListener('animationend', clear, { once: true });
      setTimeout(clear, 620);
    }
  }
  tabPopIds.clear();
}

// —— 浏览器级标签操作（固定 / 静音 / 关闭其他与右侧）——

async function pinTab(tab) {
  try {
    const browser = await API.pinTab(tab.id, !tab.pinned);
    if (browser) applyBrowserState(browser);
    showToast(tab.pinned ? '已取消固定' : '已固定：常用网页钉在列表最前，不怕误关');
  } catch (error) {
    showToast(error.message || '操作失败');
  }
}

async function toggleTabMuted(tab) {
  try {
    const browser = await API.setTabMuted(tab.id, !tab.muted);
    if (browser) applyBrowserState(browser);
    showToast(tab.muted ? '已恢复声音' : `已静音「${tab.label || '网页'}」`);
  } catch (error) {
    showToast(error.message || '操作失败');
  }
}

async function closeSiblingTabs(tab, scope) {
  try {
    const result = await API.closeOtherTabs(tab.id, scope);
    if (result) applyBrowserState(result);
    const count = Number(result?.closed) || 0;
    const area = scope === 'left' ? '左侧' : scope === 'right' ? '右侧' : '其他';
    showToast(count ? `已关闭${area} ${count} 个网页（Ctrl/⌘+Shift+T 可撤销）` : '没有可关闭的网页');
  } catch (error) {
    showToast(error.message || '关闭失败');
  }
}

// —— 标签右键菜单：桌面版走系统原生菜单（WebContentsView 内嵌网页盖不住），浏览器版退回 DOM 浮层 ——

const TAB_MENU_DISMISS_DELAY = 500;

// 消失先驻留再播退出动画；驻留期只认第一个触发时刻，不重排，避免连续触发把驻留时间越推越晚
function scheduleContextMenuDismissal(menu) {
  if (menu.__dismissTimer) return;
  // 驻留期是"纯视觉告别"：指针穿透，用户对下层内容（标签、按钮）的操作不被悬着的菜单挡住
  menu.classList.add('context-menu-dismissing');
  menu.__dismissTimer = setTimeout(() => {
    menu.__dismissTimer = 0;
    playPopOut(menu, () => { menu.hidden = true; menu.classList.remove('context-menu-dismissing'); });
  }, TAB_MENU_DISMISS_DELAY);
}

function cancelContextMenuDismissal(menu) {
  if (menu?.__dismissTimer) { clearTimeout(menu.__dismissTimer); menu.__dismissTimer = 0; }
  menu.classList.remove('context-menu-dismissing');
}

function cancelTabMenuLeaveDismissal(menu = el.tabContextMenu) {
  if (menu?.__leaveDismissTimer) {
    clearTimeout(menu.__leaveDismissTimer);
    menu.__leaveDismissTimer = 0;
  }
}

function scheduleTabMenuLeaveDismissal() {
  const menu = el.tabContextMenu;
  cancelTabMenuLeaveDismissal(menu);
  if (!menu || menu.hidden) return;
  menu.__leaveDismissTimer = setTimeout(() => {
    menu.__leaveDismissTimer = 0;
    // 已经等待了 500 ms，不再叠加通用关闭的驻留时间。
    closeTabContextMenu({ instant: true });
  }, TAB_MENU_DISMISS_DELAY);
}

function closeTabContextMenu({ instant = false, picked = false } = {}) {
  const menu = el.tabContextMenu;
  cancelTabMenuLeaveDismissal(menu);
  if (!menu || menu.hidden) return;
  if (instant) {
    // 即时收起（包括离开计时结束）不再叠加驻留或退出动画。
    cancelContextMenuDismissal(menu);
    cancelPendingPopOut(menu);
    menu.hidden = true;
    return;
  }
  if (picked) {
    // 菜单项点击＝选择已完成：不驻留（驻留的菜单悬在标签条上方会挡住紧随的拖拽/点击），直接播退出
    cancelContextMenuDismissal(menu);
    playPopOut(menu, () => { menu.hidden = true; });
    return;
  }
  // 用户触发的关闭先原地驻留 TAB_MENU_DISMISS_DELAY 再播退出动画，hidden 延迟到动画播完
  scheduleContextMenuDismissal(menu);
}

function appendTabMenuItem(menu, label, { hint = '', disabled = false, danger = false, onPick = null } = {}) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'tab-context-item' + (danger ? ' danger' : '');
  item.setAttribute('role', 'menuitem');
  item.disabled = disabled;
  item.innerHTML = `<span class="tab-context-label"></span>${hint ? '<span class="tab-context-hint"></span>' : ''}`;
  item.querySelector('.tab-context-label').textContent = label;
  if (hint) item.querySelector('.tab-context-hint').textContent = hint;
  item.addEventListener('click', () => {
    closeTabContextMenu({ picked: true });
    onPick?.();
  });
  menu.appendChild(item);
}

function appendTabMenuSeparator(menu) {
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'tab-context-separator' }));
}

function buildTabContextMenuItems(tab, label) {
  return [
    { id: 'rename', label: '改名…' },
    { id: 'duplicate', label: '复制标签' },
    { id: 'close', label: '删除标签', danger: true, hint: '中键' },
  ];
}

async function runTabContextMenuAction(tab, label, action) {
  switch (action) {
    case 'rename':
      openRenameDialog('tab', tab.id, label);
      break;
    case 'duplicate':
      duplicateTab(tab);
      break;
    case 'copy-url':
      await copyTextToClipboard(tab.url).then(() => showToast('已复制网页地址')).catch(error => showToast(error.message || '复制网址失败'));
      break;
    case 'pin':
      pinTab(tab);
      break;
    case 'mute':
      toggleTabMuted(tab);
      break;
    case 'restore':
      await API.restoreClosedTab().then(applyBrowserState).catch(error => showToast(error.message || '恢复标签失败'));
      break;
    case 'close-left':
      closeSiblingTabs(tab, 'left');
      break;
    case 'close-others':
      closeSiblingTabs(tab, 'others');
      break;
    case 'close-right':
      closeSiblingTabs(tab, 'right');
      break;
    case 'close':
      closeTab(tab.id);
      break;
  }
}

async function openNativeTabContextMenu(tab, label, event) {
  const result = await API.showTabContextMenu({
    x: event.clientX,
    y: event.clientY,
    // 只传条目描述；动作由主进程按白名单 id 回传，再在渲染端分发。
    items: buildTabContextMenuItems(tab, label).map(item => item.separator
      ? { separator: true }
      : { id: item.id, label: item.label, enabled: !item.disabled, accelerator: item.accelerator }),
  });
  if (!result || result.cancelled || !result.action) return;
  await runTabContextMenuAction(tab, label, result.action);
}

function openDomTabContextMenu(tab, label, event) {
  const menu = el.tabContextMenu;
  cancelTabMenuLeaveDismissal(menu);
  menu.replaceChildren();
  for (const item of buildTabContextMenuItems(tab, label)) {
    if (item.separator) {
      appendTabMenuSeparator(menu);
      continue;
    }
    appendTabMenuItem(menu, item.label, {
      hint: item.hint,
      disabled: item.disabled,
      danger: item.danger,
      onPick: () => { runTabContextMenuAction(tab, label, item.id); },
    });
  }
  cancelPendingPopOut(menu);
  // 驻留期内再次右键呼出：取消消失排程，菜单原地换内容换位置，不闪烁
  cancelContextMenuDismissal(menu);
  menu.hidden = false;
  playMotionClass(menu, 'motion-pop', 400, ['motionPopIn']);
  // 贴近光标弹出并收进视口内
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(event.clientX, window.innerWidth - width - 8);
  const top = Math.min(event.clientY, window.innerHeight - height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.querySelector('.tab-context-item:not(:disabled)')?.focus({ preventScroll: true });
}

function openTabContextMenu(tab, label, event) {
  if (typeof API?.showTabContextMenu === 'function') {
    openNativeTabContextMenu(tab, label, event).catch(error => showToast(error.message || '操作失败'));
    return;
  }
  openDomTabContextMenu(tab, label, event);
}

// —— 页内查找（对标 Chrome 的 Ctrl/⌘+F）——

let findBarVisible = false;

function showFindBar() {
  if (typeof API?.findInPage !== 'function') {
    showToast('页内查找需要桌面版创作浏览器');
    return;
  }
  findBarVisible = true;
  el.findBar.hidden = false;
  el.findInput.focus();
  el.findInput.select();
}

function closeFindBar() {
  if (!findBarVisible) return;
  findBarVisible = false;
  el.findBar.hidden = true;
  if (typeof API?.stopFindInPage === 'function') API.stopFindInPage(false).catch(() => {});
  if (state.browser?.tabId && typeof API?.focusBrowser === 'function') API.focusBrowser().catch(() => {});
}

async function runFind(forward, findNext) {
  const text = el.findInput.value;
  if (!text.trim()) {
    el.findCount.textContent = '';
    return;
  }
  try {
    await API.findInPage(text, forward, findNext);
  } catch (error) {
    showToast(error.message || '查找失败');
  }
}

function applyFindResult(result) {
  if (!findBarVisible) return;
  el.findCount.textContent = result.matches ? `${result.activeMatchOrdinal}/${result.matches}` : '无结果';
}

function renderPlatforms() {
  const scrollLeft = el.platformTabs.scrollLeft;
  const previousLefts = captureTabLefts();
  el.platformTabs.replaceChildren();
  for (const tab of tabsWithIndexes(visibleTabs())) {
    const service = serviceById(tab.serviceId);
    const baseLabel = serviceLabel(service);
    const label = tab.customName || (tab.index > 1 ? `${baseLabel}·${tab.index}` : baseLabel);
    const wrapper = document.createElement('span');
    wrapper.className = 'platform-tab-wrap' + (tab.pinned ? ' pinned' : ' closable');
    wrapper.dataset.tabId = tab.id;
    const button = document.createElement('button');
    button.className = 'platform-tab' + (tab.active ? ' active' : '');
    button.type = 'button';
    button.dataset.tabId = tab.id;
    button.dataset.service = tab.serviceId;
    // 固定标签对标浏览器：收缩为单字小钉位，悬停提示完整名称
    button.textContent = tab.pinned ? label.slice(0, 1) : label;
    if (tab.pinned) button.setAttribute('aria-label', `${label}（已固定）`);
    button.title = tab.pinned
      ? `${label}｜已固定，拖动可调整顺序；右键可改名、复制或删除`
      : `${label}｜双击或 F2 改名，右键可改名、复制或删除`;
    button.setAttribute('aria-current', tab.active ? 'page' : 'false');
    button.addEventListener('click', () => selectTab(tab.id));
    button.addEventListener('dblclick', () => openRenameDialog('tab', tab.id, label));
    button.addEventListener('keydown', event => {
      if (event.key === 'F2') {
        event.preventDefault();
        openRenameDialog('tab', tab.id, label);
      } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        const rect = button.getBoundingClientRect();
        openTabContextMenu(tab, label, { clientX: rect.left + 10, clientY: rect.bottom });
      }
    });
    // 标签任何位置右键都能呼出操作菜单。
    wrapper.addEventListener('contextmenu', event => {
      event.preventDefault();
      openTabContextMenu(tab, label, event);
    });
    wrapper.appendChild(button);
    // 标签声音角标：网页出声即显示，点一下整页静音（对标 Chrome 的页面声音管理）
    if (tab.audible || tab.muted) {
      const audio = document.createElement('button');
      audio.type = 'button';
      audio.className = 'platform-tab-audio' + (tab.muted ? ' muted' : '');
      audio.textContent = tab.muted ? '🔇' : '🔊';
      audio.title = `${label}｜${tab.muted ? '已静音，点击恢复声音' : '正在播放声音，点击静音'}`;
      audio.setAttribute('aria-label', `${label} ${tab.muted ? '取消静音' : '静音'}`);
      audio.addEventListener('click', event => {
        event.stopPropagation();
        toggleTabMuted(tab);
      });
      wrapper.appendChild(audio);
    }
    // 中键关闭（浏览器习惯）：pointerdown 阻止中键自动滚动，auxclick 触发关闭；
    // 左键按下记录拖拽起点，移动超过阈值由 window 级 pointermove 接管为拖拽
    wrapper.addEventListener('pointerdown', event => {
      if (event.button === 1) { event.preventDefault(); return; }
      if (event.button !== 0 || state.modeSwitchPending) return;
      // 声音按钮上的按下不进入拖拽，保留其点击语义
      if (event.target.closest('.platform-tab-audio')) return;
      beginTabDrag(tab.id, label, event);
    });
    wrapper.addEventListener('auxclick', event => {
      if (event.button !== 1) return;
      event.preventDefault();
      closeTab(tab.id);
    });
    el.platformTabs.appendChild(wrapper);
  }
  el.platformTabs.scrollLeft = scrollLeft;
  playTabFlip(previousLefts);
  // 拖拽途中被 SSE 等触发重渲染时，恢复整条标签栏的压暗与源标签拖动态
  if (tabDrag?.active) {
    setTabStripDragging(true);
    el.platformTabs.querySelector(`.platform-tab-wrap[data-tab-id="${CSS.escape(tabDrag.sourceId)}"]`)?.classList.add('dragging');
  }
  const duplicateService = serviceById(state.activeService);
  el.duplicateTabLabel.textContent = duplicateService ? serviceLabel(duplicateService) : '当前网站';
  el.duplicateTab.disabled = !duplicateService;
  el.clearBrowserTabs.disabled = !state.browser?.tabs?.length || state.modeSwitchPending;
  renderPlatformOpenList();
  renderHiddenPlatforms();
  renderPlatformCompatibility();
  // 弹层打开期间同步刷新：增删/复制/重命名/拖拽换位都经 applyBrowserState → renderPlatforms 到达这里
  refreshAllTabsList();
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
  const material = kind === 'asset' || kind === 'folder-create';
  if (material && quickAssetDeletionBusy()) { showToast('正在删除素材，请稍后操作'); return; }
  renameTarget = { kind, id, projectId: material ? state.projectId : null, epoch: quickProjectViewEpoch };
  el.renameTitle.textContent = kind === 'folder-create' ? '在真实目录中新建子文件夹' : kind === 'asset' ? '修改图片名称' : kind === 'tab' ? '修改标签名称' : '修改网站名称';
  el.renameName.maxLength = kind === 'asset' ? 120 : kind === 'folder-create' ? 80 : 40;
  el.renameSave.textContent = kind === 'folder-create' ? '创建' : '保存';
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
  if (['asset', 'folder-create'].includes(target.kind) && quickAssetDeletionBusy()) { showToast('正在删除素材，请稍后操作'); return; }
  if (!name) { el.renameError.textContent = '请输入名称'; return; }
  el.renameSave.disabled = true;
  let successMessage = '名称已保存';
  try {
    if (target.kind === 'folder-create') {
      if (target.projectId !== state.projectId || target.epoch !== quickProjectViewEpoch) throw new Error('剧本已切换，请重新选择真实目录');
      const response = await fetch(`/api/creative-assets/folder?project=${encodeURIComponent(target.projectId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: target.id, name }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (target.projectId !== state.projectId || target.epoch !== quickProjectViewEpoch) return;
      state.quickAssetFolder = result.folder?.path || target.id;
      await loadAssetItems();
      if (target.projectId !== state.projectId || target.epoch !== quickProjectViewEpoch) return;
      expandQuickFolderAncestors(state.quickAssetFolder);
      successMessage = '已在指定真实目录中新建子文件夹；其他汇总位置不变';
    } else if (target.kind === 'asset') {
      if (target.projectId !== state.projectId) throw new Error('剧本已切换，请重新选择图片');
      const response = await fetch(`/api/creative-assets/rename?project=${encodeURIComponent(target.projectId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target.id, name }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      applyQuickAssetMoves([{ ...result, oldPath: target.id }], target.projectId);
      if (target.projectId === state.projectId) await loadAssetItems();
    } else if (target.kind === 'service') {
      await API.renameService(target.id, name);
      state.config = await API.getConfig();
      renderPlatforms();
    } else {
      applyBrowserState(await API.renameTab(target.id, name));
    }
    closeCreatorDialog(el.renameDialog);
    showToast(successMessage);
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

/* —— 「全部网页」弹层：搜索并切换当前模式已打开的网页 ——
   弹层 DOM 由 creator.html 提供（allTabsButton / allTabsPopover / allTabsSearch / allTabsList），
   任一 ID 缺失时整体静默停用，不影响标签条其余功能。显隐沿用 .hidden class（同 platformPopover）。 */

// 仅对内置默认长名套短名显示；tooltip、aria、搜索匹配仍用完整名，用户改过名的一律原样显示。
// 短名不能含 ·N 序号样式，避免与多开序号（GPT 提示词·4）和模型名混淆。
const ALL_TABS_SHORT_NAMES = new Map([
  ['GPT 提示词', 'GPT'],
]);

let allTabsWired = false;
let nativeAllTabsOpen = false;
let allTabsMenuRequest = 0;

function allTabsOpen() {
  if (nativeAllTabsOpen) return true;
  if (!el.allTabsPopover) return false;
  const marks = el.allTabsPopover.classList;
  // 退出动画进行中（hidden 尚未落地）对交互而言已是"关"：开关按钮此刻必须能立刻重开
  return !marks.contains('hidden') && !marks.contains('motion-unpop');
}

function allTabFullLabel(tab) {
  const baseLabel = serviceLabel(serviceById(tab.serviceId));
  return tab.customName || (tab.index > 1 ? `${baseLabel}·${tab.index}` : baseLabel);
}

// 剧本和全部网页选择器由独立原生弹层呈现，不能撤下正在使用的平台。
// 只有阻止误操作的模态对话框才临时隐藏原生平台视图；纯网页模式沿用 DOM 弹层。
function syncAllTabsNativeShield() {
  if (typeof API?.setPlatformViewHidden !== 'function') return;
  const hidden = !!document.querySelector('dialog[open]');
  API.setPlatformViewHidden(hidden).catch(() => {});
}

function renderAllTabsList() {
  if (!el.allTabsList) return;
  const rawQuery = el.allTabsSearch?.value.trim() || '';
  const query = rawQuery.toLowerCase();
  const tabs = tabsWithIndexes(visibleTabs());
  const matched = query
    ? tabs.filter(tab => {
        const full = allTabFullLabel(tab);
        const platform = serviceById(tab.serviceId)?.label || '';
        const numberedAlias = tab.index > 1 ? `${platform}·${tab.index}` : '';
        return full.toLowerCase().includes(query)
          || (ALL_TABS_SHORT_NAMES.get(full) || '').toLowerCase().includes(query)
          || platform.toLowerCase().includes(query)
          || numberedAlias.toLowerCase().includes(query);
      })
    : tabs;
  el.allTabsList.replaceChildren();
  if (!matched.length) {
    const empty = document.createElement('div');
    empty.className = 'all-tabs-empty';
    empty.textContent = tabs.length ? `没有匹配「${rawQuery}」的网页` : '当前模式还没有打开的网页';
    el.allTabsList.appendChild(empty);
    return;
  }
  for (const tab of matched) {
    const full = allTabFullLabel(tab);
    const platform = serviceById(tab.serviceId)?.label || '';
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'all-tabs-item' + (tab.active ? ' active' : '');
    item.dataset.tabId = tab.id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(!!tab.active));
    item.title = `${full}｜平台：${platform}`;
    item.setAttribute('aria-label', `切换到「${full}」（平台：${platform}）${tab.active ? '，当前网页' : ''}`);
    const name = document.createElement('span');
    name.className = 'all-tabs-name';
    // 多开序号（·2 ·3）和用户自定义名不套短名，保证列表名称始终能对应完整标签。
    name.textContent = (!tab.customName && tab.index === 1 && ALL_TABS_SHORT_NAMES.get(full)) || full;
    const badge = document.createElement('span');
    badge.className = 'all-tabs-platform';
    badge.textContent = platform;
    item.append(name, badge);
    item.addEventListener('click', () => {
      closeAllTabsPopover();
      selectTab(tab.id);
    });
    el.allTabsList.appendChild(item);
  }
}

function refreshAllTabsList() {
  if (allTabsOpen() && !nativeAllTabsOpen) renderAllTabsList();
}

async function openAllTabsPopover() {
  closeProjectMenu();
  if (typeof API.showWorkspaceMenu === 'function') {
    const request = ++allTabsMenuRequest;
    nativeAllTabsOpen = true;
    el.allTabsButton.setAttribute('aria-expanded', 'true');
    const rect = el.allTabsButton.getBoundingClientRect();
    try {
      const result = await API.showWorkspaceMenu({ kind: 'tabs', x: rect.left, y: rect.bottom + 4 });
      if (request !== allTabsMenuRequest) return;
      nativeAllTabsOpen = false;
      el.allTabsButton.setAttribute('aria-expanded', 'false');
      if (result?.action === 'select' && result.id) selectTab(result.id);
    } catch (error) {
      if (request !== allTabsMenuRequest) return;
      nativeAllTabsOpen = false;
      el.allTabsButton.setAttribute('aria-expanded', 'false');
      showToast(error.message || '全部网页打开失败');
    }
    return;
  }
  // 上一场退出动画还没播完就重开：先取消退出排程，再进入弹入动画
  cancelPendingPopOut(el.allTabsPopover);
  el.allTabsPopover.classList.remove('hidden');
  playMotionClass(el.allTabsPopover, 'motion-pop', 400, ['motionPopIn']);
  el.allTabsButton.setAttribute('aria-expanded', 'true');
  if (el.allTabsSearch) el.allTabsSearch.value = '';
  renderAllTabsList();
  requestAnimationFrame(() => {
    el.allTabsSearch?.focus();
    syncAllTabsNativeShield();
  });
}

function closeAllTabsPopover({ refocus = false } = {}) {
  if (nativeAllTabsOpen) {
    nativeAllTabsOpen = false;
    allTabsMenuRequest++;
    el.allTabsButton.setAttribute('aria-expanded', 'false');
    API.closeWorkspaceMenu?.().catch(() => {});
    if (refocus) el.allTabsButton.focus({ preventScroll: true });
    return;
  }
  if (!allTabsOpen()) return;
  if (el.allTabsPopover.classList.contains('motion-unpop')) return; // 退出动画已在播，不重复排程
  el.allTabsButton.setAttribute('aria-expanded', 'false');
  if (refocus) el.allTabsButton.focus({ preventScroll: true });
  // 纯网页模式保留退出动画；不会影响桌面平台视图。
  playPopOut(el.allTabsPopover, () => {
    el.allTabsPopover.classList.add('hidden');
    syncAllTabsNativeShield();
  });
}

function wireAllTabs() {
  if (allTabsWired) return;
  allTabsWired = true;
  if (!el.allTabsButton || !el.allTabsPopover || !el.allTabsSearch || !el.allTabsList) return;
  el.allTabsPopover.classList.add('hidden');
  el.allTabsButton.setAttribute('aria-haspopup', 'dialog');
  el.allTabsButton.setAttribute('aria-controls', 'allTabsPopover');
  el.allTabsButton.setAttribute('aria-expanded', 'false');
  el.allTabsButton.addEventListener('click', () => {
    if (allTabsOpen()) closeAllTabsPopover({ refocus: true });
    else openAllTabsPopover();
  });
  el.allTabsSearch.setAttribute('aria-label', '按名称或平台搜索已打开的网页');
  if (!el.allTabsSearch.placeholder) el.allTabsSearch.placeholder = '搜索网页名称或平台…';
  el.allTabsList.setAttribute('role', 'listbox');
  el.allTabsList.setAttribute('aria-label', '全部网页');
  // 搜索框按键就地消化，不进全局快捷键（Cmd/Ctrl+数字、F5、Esc 关菜单等）
  el.allTabsSearch.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAllTabsPopover({ refocus: true });
    }
  });
  el.allTabsSearch.addEventListener('input', renderAllTabsList);
  // 点击按钮与弹层之外关闭；窗口失焦时同右键菜单一并收起
  document.addEventListener('pointerdown', event => {
    if (!allTabsOpen()) return;
    if (event.target.closest?.('#allTabsPopover, #allTabsButton')) return;
    closeAllTabsPopover();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !allTabsOpen()) return;
    event.preventDefault();
    closeAllTabsPopover({ refocus: true });
  });
  // 原生弹层会自然获取焦点，由它自身处理失焦关闭，不能因宿主失焦立刻撤回菜单。
  window.addEventListener('blur', () => { if (!nativeAllTabsOpen) closeAllTabsPopover(); });
  window.addEventListener('resize', () => {
    if (allTabsOpen()) closeAllTabsPopover();
  });
}

function closePlatformPopover() {
  if (el.platformPopover.classList.contains('hidden')) return;
  if (el.platformPopover.classList.contains('motion-unpop')) return; // 退出动画已在播，不重复排程
  el.addPlatform.setAttribute('aria-expanded', 'false');
  // hidden 延迟到退出动画播完（动画期间 pointer-events:none 由 CSS 负责）；收起后再量一次舞台，
  // 避免窗口按展开高度驻留
  playPopOut(el.platformPopover, () => {
    el.platformPopover.classList.add('hidden');
    queueBoundsUpdate();
  });
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

/* 剧本面板：按集数/范围命名的分组存放剧本段落，展开即可编辑与复制；按剧本项目存储。 */
const expandedScriptGroups = new Set();
const expandedScriptItems = new Set();
const scriptDrafts = new Map(); // itemId -> {title, text}：编辑中的未保存草稿

function scriptUid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function renderScripts() {
  const groups = state.scripts.groups;
  const totalItems = groups.reduce((sum, group) => sum + group.items.length, 0);
  el.scriptAccordionCount.textContent = groups.length ? `${groups.length} 组 · ${totalItems} 段` : '0 组';
  el.scriptGroups.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'material-empty';
    empty.textContent = '暂无剧本分组；点上方「＋ 新建分组」，按 第01集 / 前10集 / 自定义名称 建立';
    el.scriptGroups.append(empty);
    return;
  }
  for (const group of groups) el.scriptGroups.append(buildScriptGroup(group));
}

function buildScriptGroup(group) {
  const expanded = expandedScriptGroups.has(group.id);
  const block = document.createElement('section');
  block.className = 'script-group' + (expanded ? ' expanded' : '');
  block.dataset.groupId = group.id;

  const head = document.createElement('div');
  head.className = 'script-group-head';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'script-group-toggle';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.title = expanded ? '收起这一组' : '展开这一组';
  const name = document.createElement('strong');
  name.textContent = group.name;
  editableCardName(name, '分组名称', 60, value => {
    group.name = value;
    saveWorkspace(true);
  });
  const meta = document.createElement('span');
  meta.textContent = `${group.items.length} 段`;
  toggle.append(name, meta);
  toggle.addEventListener('click', () => {
    if (expandedScriptGroups.has(group.id)) expandedScriptGroups.delete(group.id);
    else expandedScriptGroups.add(group.id);
    renderScripts();
  });
  head.append(toggle);

  const copyAll = document.createElement('button');
  copyAll.type = 'button';
  copyAll.className = 'text-action';
  copyAll.textContent = '复制全部';
  copyAll.title = '按顺序复制这一组的全部段落';
  copyAll.addEventListener('click', async () => {
    const body = group.items.map(item => {
      const draft = scriptDrafts.get(item.id);
      return (draft ? draft.text : item.text).trim();
    }).filter(Boolean).join('\n\n');
    if (!body) { showToast('这一组还没有可复制的剧本内容'); return; }
    // 按实际复制到的非空段计数，避免组内有空段时虚报数量
    const copiedCount = body.split('\n\n').length;
    try { await copyTextToClipboard(body); showToast(`已复制「${group.name}」共 ${copiedCount} 段`); }
    catch { showToast('复制失败，请重试'); }
  });
  head.append(copyAll);


  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-action script-remove';
  remove.textContent = '删除';
  remove.setAttribute('aria-label', `删除分组 ${group.name}`);
  remove.addEventListener('click', () => {
    if (!confirm(`删除分组「${group.name}」及其 ${group.items.length} 段剧本？此操作不可撤销。`)) return;
    state.scripts.groups = state.scripts.groups.filter(candidate => candidate.id !== group.id);
    group.items.forEach(item => { scriptDrafts.delete(item.id); expandedScriptItems.delete(item.id); });
    expandedScriptGroups.delete(group.id);
    saveWorkspace(true); renderScripts();
    showToast(`已删除分组「${group.name}」`);
  });
  head.append(remove);
  block.append(head);


  if (expanded) {
    const list = document.createElement('div');
    list.className = 'script-items';
    if (!group.items.length) {
      const empty = document.createElement('div');
      empty.className = 'material-empty';
      empty.textContent = '这一组还没有段落；点下方「＋ 新建段落」粘贴剧本';
      list.append(empty);
    }
    for (const item of group.items) list.append(buildScriptItem(group, item, group.items.indexOf(item)));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'text-action script-add-item';
    add.textContent = '＋ 新建段落';
    add.addEventListener('click', () => {
      const item = { id: scriptUid('si'), title: `段落 ${group.items.length + 1}`, text: '', updatedAt: Date.now() };
      group.items.push(item);
      expandedScriptItems.add(item.id);
      saveWorkspace(true); renderScripts();
    });
    list.append(add);
    block.append(list);
  }
  return block;
}

// 在原名称位置编辑，不额外占一行；Enter 提交，Escape 恢复。
function editableCardName(node, label, maxLength, commit) {
  node.contentEditable = 'plaintext-only';
  node.tabIndex = 0;
  node.setAttribute('role', 'textbox');
  node.setAttribute('aria-label', label);
  node.title = '点击改名；Enter 保存，Esc 取消';
  let original = node.textContent;
  node.addEventListener('click', event => event.stopPropagation());
  node.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); node.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); node.textContent = original; node.blur(); }
  });
  node.addEventListener('focus', () => { original = node.textContent; });
  node.addEventListener('blur', () => {
    const value = node.textContent.trim().slice(0, maxLength);
    node.textContent = value || original;
    if (value && value !== original) commit(value);
  });
}

function buildScriptItem(group, item, index) {
  const key = item.id;
  const draft = scriptDrafts.get(key);
  const expanded = expandedScriptItems.has(key);
  const wrap = document.createElement('div');
  wrap.className = 'script-item' + (expanded ? ' expanded' : '');
  wrap.dataset.itemId = item.id;

  const head = document.createElement('div');
  head.className = 'script-item-head';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'script-item-toggle';
  toggle.setAttribute('aria-expanded', String(expanded));
  const title = document.createElement('strong');
  title.textContent = (draft ? draft.title : item.title) || '未命名段落';
  editableCardName(title, '段落标题', 60, value => {
    item.title = value; item.updatedAt = Date.now();
    if (scriptDrafts.has(key)) scriptDrafts.get(key).title = value;
    saveWorkspace(true);
  });
  const preview = document.createElement('span');
  preview.textContent = (draft ? draft.text : item.text).replace(/\s+/g, ' ').slice(0, 48) || '（空）';
  toggle.append(title, preview);
  toggle.addEventListener('click', () => {
    if (expandedScriptItems.has(key)) expandedScriptItems.delete(key);
    else expandedScriptItems.add(key);
    renderScripts();
  });
  head.append(toggle);

  // 段落调序：单集顺序跟着剧情走，导入顺序不对时直接上下移动
  const move = offset => {
    const current = group.items.indexOf(item);
    const target = current + offset;
    if (target < 0 || target >= group.items.length) return;
    [group.items[current], group.items[target]] = [group.items[target], group.items[current]];
    saveWorkspace(true); renderScripts();
  };
  if (index > 0) {
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'text-action script-move';
    up.textContent = '↑';
    up.title = '上移一段';
    up.setAttribute('aria-label', `上移 ${title.textContent}`);
    up.addEventListener('click', () => move(-1));
    head.append(up);
  }
  if (index < group.items.length - 1) {
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'text-action script-move';
    down.textContent = '↓';
    down.title = '下移一段';
    down.setAttribute('aria-label', `下移 ${title.textContent}`);
    down.addEventListener('click', () => move(1));
    head.append(down);
  }

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'text-action';
  copy.textContent = '复制';
  copy.title = '复制这一段剧本全文';
  copy.addEventListener('click', async () => {
    const body = draft ? draft.text : item.text;
    if (!body.trim()) { showToast('这一段还没有内容'); return; }
    try { await copyTextToClipboard(body); showToast(`已复制「${title.textContent}」`); }
    catch { showToast('复制失败，请重试'); }
  });
  head.append(copy);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-action script-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `删除段落 ${(draft ? draft.title : item.title) || '未命名段落'}`);
  remove.addEventListener('click', () => {
    if (!confirm(`删除段落「${(draft ? draft.title : item.title) || '未命名段落'}」？`)) return;
    group.items = group.items.filter(candidate => candidate.id !== item.id);
    scriptDrafts.delete(key); expandedScriptItems.delete(key);
    saveWorkspace(true); renderScripts();
  });
  head.append(remove);
  wrap.append(head);

  if (expanded) {
    const editor = document.createElement('div');
    editor.className = 'script-item-editor';
    const text = document.createElement('textarea');
    text.className = 'script-item-text';
    text.spellcheck = false;
    text.setAttribute('aria-label', '剧本内容');
    text.value = (draft ? draft.text : item.text) || '';
    text.placeholder = '粘贴或输入这一段的剧本内容…';
    const actions = document.createElement('div');
    actions.className = 'script-item-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'text-action script-save';
    save.textContent = '保存';
    save.disabled = !scriptDrafts.has(key);
    save.addEventListener('click', () => {
      const current = scriptDrafts.get(key);
      if (!current) return;
      if (!current.text.trim()) { showToast('剧本内容为空，无法保存'); return; }
      item.title = current.title.trim() || '未命名段落';
      item.text = current.text;
      item.updatedAt = Date.now();
      scriptDrafts.delete(key);
      saveWorkspace(true); renderScripts();
      showToast(`已保存「${item.title}」`);
    });
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'text-action';
    discard.textContent = '取消';
    discard.disabled = !scriptDrafts.has(key);
    discard.addEventListener('click', () => { scriptDrafts.delete(key); renderScripts(); });
    for (const input of [text]) {
      input.addEventListener('input', () => {
        scriptDrafts.set(key, { title: title.textContent, text: text.value });
        save.disabled = text.value === item.text;
        discard.disabled = false;
      });
    }
    actions.append(save, discard);
    editor.append(text, actions);
    wrap.append(editor);
  }
  return wrap;
}

function addScriptGroup() {
  if (state.scripts.groups.length >= 200) { showToast('分组已达上限（200 组）'); return; }
  const used = new Set(state.scripts.groups.map(group => group.name));
  let index = state.scripts.groups.length + 1;
  let name = `第${String(index).padStart(2, '0')}集`;
  while (used.has(name)) { index += 1; name = `第${String(index).padStart(2, '0')}集`; }
  const group = { id: scriptUid('sg'), name, items: [] };
  state.scripts.groups.push(group);
  expandedScriptGroups.add(group.id);
  saveWorkspace(true); renderScripts();
  el.scriptAccordion.open = true;
  state.accordions.scripts = true;
}

/* 剧本拖拽导入：txt（自动识别 UTF-8 / GB18030 / UTF-16）与 docx（解析 ZIP 里的 word/document.xml），
   内容里带「第X集/话/章」标记时自动拆成单集段落。只在面板内处理文件内容，不改任何真实素材。 */
const SCRIPT_IMPORT_ACCEPT = new Set(['txt', 'md', 'docx']);

async function readTextFileSmart(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    try { return new TextDecoder('gb18030').decode(bytes); }
    catch { return new TextDecoder('utf-8').decode(bytes); }
  }
}

async function extractDocxText(file) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 docx（ZIP）文件');
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  let target = null;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(buffer.subarray(cursor + 46, cursor + 46 + nameLen));
    if (name === 'word/document.xml') { target = { method, compressedSize, localOffset }; break; }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (!target) throw new Error('docx 里没有找到正文（word/document.xml）');
  const localNameLen = view.getUint16(target.localOffset + 26, true);
  const localExtraLen = view.getUint16(target.localOffset + 28, true);
  const dataStart = target.localOffset + 30 + localNameLen + localExtraLen;
  const rawData = buffer.subarray(dataStart, dataStart + target.compressedSize);
  let xml;
  if (target.method === 0) xml = new TextDecoder('utf-8').decode(rawData);
  else {
    const stream = new Blob([rawData]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    xml = await new Response(stream).text();
  }
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function splitScriptByEpisodes(text) {
  // Word 标题常含空格、全角数字或不可见分隔符；仅规范化识别用的副本，正文保持原样。
  // 行首完整分集标记只提供候选边界，不等于正文：目录、梗概和第 0 集不能增加集数。
  const marker = /^\s*(?:#{1,6}\s*)?(?:[【\[(（]\s*)?第\s*([0-9一二三四五六七八九十百千零〇两](?:\s*[0-9一二三四五六七八九十百千零〇两])*)\s*([集话回章])(?=$|\s|[】\])）:：、.．\-—])/;
  const invisible = /[\u200b-\u200d\u2060\ufeff]/g;
  const lines = String(text || '').split(/\r\n?|\n/);
  const normalized = lines.map(line => line.normalize('NFKC').replace(invisible, '').trim());
  const cleanHeading = line => line.replace(invisible, '').trim().replace(/^#+\s*/, '').slice(0, 60);
  const sectionText = value => value.replace(/^#{1,6}\s*/, '').replace(/^[【\[(（]\s*/, '')
    .replace(/[】\])）]\s*$/, '').trim();
  const outlineLabel = /^(?:(?:剧本|分集|故事|剧情|全剧|内容)\s*)?(?:大纲|目录|梗概|概要|简介|剧情概述)(?=$|[\s:：])/;
  const bodyLabel = /^(?:正文|剧本正文|分集正文|正式剧本|完整剧本|详细剧本|剧本内容|分集剧本)(?:开始|部分|如下)?(?=$|[\s:：])/;
  const sectionKind = value => outlineLabel.test(sectionText(value)) ? 'outline'
    : bodyLabel.test(sectionText(value)) ? 'body' : '';
  const numberValue = value => {
    const compact = value.replace(/\s/g, '');
    if (/^\d+$/.test(compact)) return Number(compact);
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if ([...compact].every(char => char in digits)) return Number([...compact].map(char => digits[char]).join(''));
    let total = 0;
    let digit = 0;
    for (const char of compact) {
      if (char in digits) digit = digits[char];
      else if ({ 十: 10, 百: 100, 千: 1000 }[char]) {
        total += (digit || 1) * { 十: 10, 百: 100, 千: 1000 }[char];
        digit = 0;
      } else return NaN;
    }
    return total + digit;
  };
  const headers = [];
  const sections = [];
  let context = 'none';
  let contextId = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = normalized[index].match(marker);
    if (match) {
      const number = numberValue(match[1]);
      if (!Number.isSafeInteger(number) || number < 0) continue;
      const rest = normalized[index].slice(match[0].length).replace(/^[】\])）\s:：、.．\-—]+/, '').trim();
      const ownOutline = number === 0 || outlineLabel.test(rest);
      if (ownOutline) { context = 'outline'; contextId += 1; }
      headers.push({ start: index, number, key: `${match[2]}:${number}`, context, contextId, ownOutline,
        toc: /(?:\.{2,}|…{2,}|·{2,})\s*\d+\s*$/.test(rest), title: cleanHeading(lines[index]) });
    } else {
      const kind = sectionKind(normalized[index]);
      if (!kind) continue;
      context = kind; contextId += 1;
      sections.push({ start: index, contextId, kind });
    }
  }
  if (!headers.length) return null;
  const sectionPositions = new Map(sections.map(section => [section.start, section.kind]));
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    header.end = headers[index + 1]?.start ?? lines.length;
    // 分集正文后若接目录/正文区标题，不把后面的元信息拼进上一集。
    for (let line = header.start + 1; line < header.end; line += 1) {
      const kind = sectionPositions.get(line);
      if (kind === 'outline' || (kind === 'body' && header.context === 'outline')) { header.end = line; break; }
    }
    const content = normalized.slice(header.start + 1, header.end).filter(Boolean);
    header.hasBodyLines = content.some(line => !/^\d+$/.test(line));
    const scene = /^(?:【\s*)?(?:\d+\s*[-—–]\s*\d+(?=$|\s|[.:：、】])|(?:第\s*)?\d+\s*场(?=$|\s|[:：、】])|场景\s*\d+(?=$|\s|[:：、】]))/;
    const dialogue = /^[^\s:：]{1,16}(?:\s*[（(][^）)]*[）)])?\s*[:：]\s*\S/;
    const nonSpeaker = /^(?:剧情|故事|大纲|梗概|人物|角色|场景|时间|地点|作者|备注|说明|标题|正文|简介|概要)\s*[:：]/;
    header.strongBody = content.some(line => scene.test(line))
      || content.filter(line => dialogue.test(line) && !nonSpeaker.test(line)).length >= 2;
  }
  // 大纲通常先列 1..N，再从第 1 集重开正文；场次/对白或带正文的重复号是区间切换证据。
  // 不根据文件名、行数或固定集数截断，也不把只有一行简介的列表假造为分集正文。
  const seen = new Set();
  const inferredBodyStart = new Map();
  for (const header of headers) {
    if (header.number > 0 && !header.ownOutline && !header.toc && header.context === 'outline'
      && (header.strongBody || (seen.has(header.key) && header.hasBodyLines))) {
      if (!inferredBodyStart.has(header.contextId)) inferredBodyStart.set(header.contextId, header.start);
    }
    if (header.number > 0) seen.add(header.key);
  }
  const candidates = headers.filter(header => header.number > 0 && !header.ownOutline && !header.toc
    && (header.context !== 'outline' || header.start >= (inferredBodyStart.get(header.contextId) ?? Infinity)));
  if (!candidates.some(header => header.hasBodyLines || header.strongBody || header.context === 'body')) return null;
  let runId = 0;
  let previousKey = '';
  for (const header of candidates) {
    if (header.key !== previousKey) runId += 1;
    header.runId = runId; previousKey = header.key;
  }
  const laterBodies = new Map();
  const kept = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const header = candidates[index];
    const laterBodyRun = laterBodies.get(header.key) ?? -1;
    // 无“大纲”标记的行内梗概列表：在别的集之后再次出现本集正文才排除。
    // 相邻同号续段或有正文段落的旧块不靠长度/强弱丢弃，避免删掉真实正文首段。
    if (header.hasBodyLines || laterBodyRun <= header.runId) kept.push(header);
    if (header.hasBodyLines) laterBodies.set(header.key, Math.max(laterBodyRun, header.runId));
  }
  kept.reverse();
  const result = [];
  const byEpisode = new Map();
  for (const header of kept) {
    const body = lines.slice(header.start, header.end).join('\n').trim();
    if (!body) continue;
    const existing = byEpisode.get(header.key);
    if (existing) existing.text += '\n\n' + body; // 同集的非大纲续段仍保留，不重复生成一个集。
    else {
      const chunk = { title: header.title, text: body };
      byEpisode.set(header.key, chunk); result.push(chunk);
    }
  }
  if (!result.length) return null;
  const keptHeaders = new Set(kept);
  const filteredMetadata = headers.some(header => !keptHeaders.has(header)) || sections.some(section => section.kind === 'outline');
  const preambleEnd = Math.min(headers[0].start, sections[0]?.start ?? lines.length);
  const preamble = lines.slice(0, preambleEnd).join('\n').trim();
  if (preamble && !filteredMetadata) result[0].text = preamble + '\n\n' + result[0].text;
  // 普通单集仍沿用单段导入；若已识别并剔除目录/大纲，则单集也只导入实际正文。
  return result.length >= 2 || filteredMetadata ? result : null;
}

// 拖拽导入剧本文件。保护一：目标分组达到 100 段上限后，统计并提示被丢弃的剩余段数，不再静默丢弃。
// 保护二：单段文本超过 20 万字时截断保留前 20 万字入库并计数提示，与 loadWorkspace 的截尾兜底一致。
async function importScriptFiles(files, targetGroupId) {
  let groupsCreated = 0;
  let itemsAdded = 0;
  let splitCount = 0;
  let droppedTotal = 0;
  let truncatedCount = 0;
  for (const file of Array.from(files || [])) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!SCRIPT_IMPORT_ACCEPT.has(ext)) {
      showToast(ext === 'doc' ? '暂不支持旧版 .doc：请在 Word 里另存为 .docx 或 .txt 再拖入' : `跳过不支持的文件：${file.name}`);
      continue;
    }
    let text = '';
    try {
      text = ext === 'docx' ? await extractDocxText(file) : await readTextFileSmart(file);
    } catch (error) {
      showToast(`读取失败 ${file.name}：${error.message}`);
      continue;
    }
    text = text.replace(/\r\n/g, '\n').trim();
    if (!text) { showToast(`文件是空的：${file.name}`); continue; }
    let group = targetGroupId ? state.scripts.groups.find(candidate => candidate.id === targetGroupId) : null;
    if (!group) {
      if (state.scripts.groups.length >= 200) { showToast('分组已达上限（200 组）'); break; }
      group = { id: scriptUid('sg'), name: file.name.replace(/\.[^.]+$/, '').slice(0, 60), items: [] };
      state.scripts.groups.push(group);
      groupsCreated += 1;
    }
    const chunks = splitScriptByEpisodes(text);
    const pending = chunks || [{ title: file.name.replace(/\.[^.]+$/, '').slice(0, 60), text }];
    for (let chunkIndex = 0; chunkIndex < pending.length; chunkIndex += 1) {
      const chunk = pending[chunkIndex];
      if (group.items.length >= 100) {
        droppedTotal += pending.length - chunkIndex;
        showToast(`分组「${group.name}」段落已达上限（100 段）`);
        break;
      }
      if (chunk.text.length > 200000) {
        chunk.text = chunk.text.slice(0, 200000);
        truncatedCount += 1;
      }
      group.items.push({ id: scriptUid('si'), title: chunk.title, text: chunk.text, updatedAt: Date.now() });
      itemsAdded += 1;
    }
    if (chunks) splitCount += 1;
    expandedScriptGroups.add(group.id);
    targetGroupId = '';
  }
  if (itemsAdded) {
    saveWorkspace(true); renderScripts();
    el.scriptAccordion.open = true;
    state.accordions.scripts = true;
    showToast(`已导入 ${itemsAdded} 段剧本${groupsCreated ? `（新建 ${groupsCreated} 组）` : ''}${splitCount ? `，按集数自动拆分 ${splitCount} 个文件` : ''}${droppedTotal ? `；分组段落超上限，已丢弃 ${droppedTotal} 段（可拆分文件后重拖）` : ''}${truncatedCount ? `；${truncatedCount} 段超 20 万字已截断保留前 20 万字` : ''}`);
  }
}

function wireScriptImportDrop() {
  const panel = el.scriptAccordion;
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  panel.addEventListener('dragover', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    panel.classList.add('script-drag-over');
    panel.querySelectorAll('.script-group.drop-target').forEach(el => el.classList.remove('drop-target'));
    const groupEl = event.target.closest?.('.script-group[data-group-id]');
    if (groupEl) groupEl.classList.add('drop-target');
  });
  panel.addEventListener('dragleave', event => {
    if (event.target !== panel) return;
    panel.classList.remove('script-drag-over');
    panel.querySelectorAll('.script-group.drop-target').forEach(el => el.classList.remove('drop-target'));
  });
  panel.addEventListener('drop', async event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    panel.classList.remove('script-drag-over');
    panel.querySelectorAll('.script-group.drop-target').forEach(el => el.classList.remove('drop-target'));
    const groupEl = event.target.closest?.('.script-group[data-group-id]');
    try {
      await importScriptFiles(event.dataTransfer.files, groupEl?.dataset.groupId || '');
    } catch (error) {
      showToast(`导入失败：${error.message}`);
    }
  });
}

function syncAccordionState() {
  el.promptAccordion.open = !!state.accordions.prompt;
  el.scriptAccordion.open = !!state.accordions.scripts;
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
    editableCardName(name, '固定提示词标题', 40, value => {
      item.title = value; item.updatedAt = Date.now();
      if (templateDrafts.has(key)) templateDrafts.get(key).title = value;
      saveWorkspace(true);
    });
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
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'text-action saved-template-copy'; copy.textContent = '复制';
    copy.title = '复制提示词全文';
    copy.addEventListener('click', async () => {
      const value = (templateDrafts.get(key) || item).body;
      if (!value.trim()) { showToast('提示词为空'); return; }
      try {
        await copyTextToClipboard(value);
        activeTemplateIds[mode] = item.id; rememberTemplatePrompt(value, mode);
        showToast('提示词已复制');
      } catch { showToast('复制失败，请手动选择文本'); }
    });
    row.append(toggle, copy, remove);
    if (expandedTemplates.has(item.id)) {
      const body = document.createElement('div'); body.className = 'saved-template-body';
      const text = document.createElement('textarea');
      text.className = 'saved-template-text'; text.spellcheck = false;
      text.setAttribute('aria-label', '固定提示词正文'); text.value = draft.body;
      const actions = document.createElement('div'); actions.className = 'saved-template-actions';
      const button = (label, handler, primary = false, extraClass = '') => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
        b.className = (primary ? 'primary-action' : 'secondary-action') + ' saved-template-load' + (extraClass ? ' ' + extraClass : '');
        b.addEventListener('click', handler); actions.append(b); return b;
      };
      const save = button('保存', () => {
        if (!text.value.trim()) {
          showToast('请填写提示词内容');
          text.focus(); return;
        }
        item.body = text.value.trim(); item.updatedAt = Date.now();
        templateDrafts.delete(key); saveWorkspace(true); renderPromptTemplates();
        showToast('标题和提示词已保存');
      }, true);
      save.disabled = !templateDrafts.has(key);
      for (const input of [text]) {
        input.addEventListener('focus', () => { activeTemplateIds[mode] = item.id; });
        input.addEventListener('input', () => {
          activeTemplateIds[mode] = item.id;
          templateDrafts.set(key, { title: name.textContent, body: text.value });
          save.disabled = text.value === item.body;
        });
      }
      body.append(text, actions); row.append(body);
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
    if (node.kind === 'file' && ['image', 'video', 'audio', 'document', 'other'].includes(node.type)) {
      items.push({ ...node, folderPath: parentPath || '' });
    }
  };
  walk(root, 0, '');
  const layout = GeneratedVideoLayout.organize({ folders, assets: items, project: state.config?.project, batch: state.config?.downloadEpisodes });
  state.quickVideoLayout = layout;
  state.quickFolders = layout.folders;
  state.quickIndexes = null;
  state.quickViewFolder = layout.aliases.get(state.quickViewFolder) || state.quickViewFolder;
  if (!layout.folders.some(folder => folder.node.path === state.quickViewFolder)) state.quickViewFolder = '';
  state.quickAssetFolder = layout.aliases.get(state.quickAssetFolder) || state.quickAssetFolder;
  if (GeneratedVideoLayout.isVirtualPath(state.quickAssetFolder)) state.quickAssetFolder = '';
  // 首次构建时把二级及更深文件夹收起来，只展开顶层分类。浏览器下载固定在列表最下方，不进这棵树。
  if (!state.quickCollapseInit) {
    for (const folder of layout.folders) {
      if (folder.depth >= 1) state.collapsedQuickFolders.add(folder.node.path || '');
    }
    state.quickCollapseInit = true;
  }
  // 旧网站可能只有历史素材；已登记的当前集在实际导入前尚无实体目录，刷新时保留此存入意图。
  if (!layout.folders.some(folder => (folder.node.path || '') === state.quickAssetFolder)
    && quickDownloadEpisodeForImport(state.quickAssetFolder)?.episodePath !== state.quickAssetFolder) {
    state.quickAssetFolder = '';
  }
  return layout.assets.sort(AssetOrder.newestFirst);
}

function quickFolderLabel(path) {
  if (!path) return '全部资产';
  return path.split('/').filter(Boolean).at(-1) || '全部资产';
}

function rebuildQuickIndexes() {
  const folders = new Map(), children = new Map(), directFiles = new Map(), descendants = new Map(), filesByPath = new Map();
  const append = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
  for (const folder of state.quickFolders) {
    folders.set(folder.node.path || '', folder);
    append(children, folder.parentPath || '', folder);
  }
  for (const item of state.assetItems) {
    filesByPath.set(item.path, item);
    append(directFiles, item.displayFolderPath || item.folderPath || '', item);
    let parent = item.folderPath || '';
    while (parent) {
      append(descendants, parent, item);
      parent = FolderEditor.parentPath(parent);
    }
  }
  state.quickIndexes = { folders, children, directFiles, descendants, filesByPath };
}

function quickDownloadEpisodeForImport(folderPath) {
  const folder = state.quickIndexes?.folders.get(folderPath) || state.quickFolders.find(item => item.node.path === folderPath);
  const entry = folder?.downloadEpisode || downloadEpisodeForFolder(folderPath)
    || state.config?.downloadEpisodes?.states?.find(item => item?.episodePath === folderPath && item.projectId === state.projectId);
  return entry?.available && entry.projectId === state.projectId && entry.downloadable !== false ? entry : null;
}

function quickWritableFolder(folderPath) {
  const entry = quickDownloadEpisodeForImport(folderPath);
  // 选择网站行导入时使用该网站当前集，不把新素材放入未分集组。
  return entry?.downloadable !== false && entry?.episodePath ? entry.episodePath : folderPath;
}

async function prepareQuickImportFolder(folderPath, projectId, epoch) {
  const entry = quickDownloadEpisodeForImport(folderPath);
  if (GeneratedVideoLayout.isVirtualPath(folderPath) && !entry) throw new Error('这是只读查看组，请选择真实文件夹存入');
  if (!entry) return folderPath;
  const categoryIds = { image: 'generated-images', video: 'generated-videos', audio: 'audio' };
  const category = state.config?.project?.categories?.find(item => item.id === categoryIds[entry.kind]);
  if (!category?.path || FolderEditor.parentPath(entry.platformPath) !== category.path
    || entry.episodePath !== entry.platformPath + '/' + entry.label) throw new Error('网站归档身份无效，未创建目录');
  for (const target of [category.path, entry.platformPath, entry.episodePath]) {
    if (state.quickFolders.some(folder => folder.node.path === target)) continue;
    if (projectId !== state.projectId || epoch !== quickProjectViewEpoch) throw new Error('剧本已切换，未继续准备导入目录');
    const response = await fetch(`/api/creative-assets/folder?project=${encodeURIComponent(projectId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: FolderEditor.parentPath(target), name: target.split('/').at(-1) }),
    });
    if (!response.ok && response.status !== 409) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '网站当前集目录创建失败');
    }
  }
  return entry.episodePath;
}

const advancingDownloadEpisodes = new Set();

function downloadEpisodeKey(entry) {
  return JSON.stringify([entry.projectId, entry.serviceId, entry.kind]);
}

function applyDownloadEpisodes(batch, { render = true } = {}) {
  if (!batch || batch.projectId !== state.projectId || !Array.isArray(batch.states)) return false;
  state.config.downloadEpisodes = batch;
  if (render) renderQuickFolderTree();
  return true;
}

function downloadEpisodeForFolder(folderPath) {
  const batch = state.config?.downloadEpisodes;
  if (batch?.projectId !== state.projectId) return null;
  return batch.states.find(entry => entry?.available && entry.projectId === state.projectId
    && entry.platformPath === folderPath) || null;
}

async function changeQuickDownloadEpisode(entry, episode = null) {
  const key = downloadEpisodeKey(entry);
  const epoch = quickProjectViewEpoch;
  const currentView = () => entry.projectId === state.projectId && epoch === quickProjectViewEpoch;
  if (!currentView() || entry.downloadable === false || advancingDownloadEpisodes.has(key) || quickAssetDeletionBusy()) return;
  const select = episode !== null;
  const invoke = select ? API.selectDownloadEpisode : API.advanceDownloadEpisode;
  if (typeof invoke !== 'function') { showToast('切换下载集数需要更新桌面程序后使用'); return; }
  advancingDownloadEpisodes.add(key);
  renderQuickFolderTree();
  try {
    const result = await invoke({ projectId: entry.projectId, serviceId: entry.serviceId,
      kind: entry.kind, expectedEpisode: entry.episode, ...(select ? { episode } : {}) });
    if (!currentView() || !applyDownloadEpisodes(result, { render: false })) return;
    const current = result.states.find(item => item?.serviceId === entry.serviceId && item.kind === entry.kind);
    if (!current?.episodePath) throw new Error('下载集目录读取失败');
    if (select ? result.selected : result.advanced) {
      // 只切此剧本、此网站和此媒体的新下载目的地；已有素材和进行中的下载不改变。
      state.collapsedQuickFolders.add(entry.episodePath);
      for (const folder of [state.config.project.folder, FolderEditor.parentPath(current.platformPath),
        current.platformPath, current.episodePath]) state.collapsedQuickFolders.delete(folder);
      state.quickAssetFolder = current.episodePath;
      state.quickViewFolder = current.episodePath;
      await loadAssetItems({ preserveOnError: true });
    }
    if (currentView()) showToast(`${current.serviceLabel}新下载存入「${current.label}」；已有素材和进行中的下载不移动`);
  } catch (error) {
    if (currentView()) showToast(`切换下载集失败：${error.message}`);
  } finally {
    advancingDownloadEpisodes.delete(key);
    if (currentView()) renderQuickFolderTree();
  }
}

function showQuickEpisodeMenu(entry, event) {
  event.preventDefault(); event.stopPropagation();
  if (advancingDownloadEpisodes.has(downloadEpisodeKey(entry)) || quickAssetDeletionBusy()) return;
  const existing = Array.isArray(entry.existingEpisodes) ? entry.existingEpisodes
    : (state.quickIndexes?.children.get(entry.platformPath) || []).map(folder => AssetOrder.episodeFolderKey(folder.node.name));
  const episodes = [...new Set([...existing, entry.episode].filter(value => Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b);
  FolderEditor.menu(event, episodes.map(episode => ({
    label: `第${episode}集${episode === entry.episode ? '（当前下载）' : ''}`,
    run: () => { if (episode !== entry.episode) changeQuickDownloadEpisode(entry, episode); },
  })), el.quickFolderTree);
}

function buildDownloadEpisodeControl(entry) {
  if (entry.downloadable === false) {
    const archived = document.createElement('span'); archived.className = 'quick-view-badge'; archived.textContent = '仅归档';
    archived.title = '此网站保留历史归档身份，不是当前可下载平台';
    return [archived];
  }
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'quick-episode-current';
  badge.textContent = entry.label;
  badge.title = `新下载存入 ${entry.episodePath}；点击选择已有集（只影响此网站的${entry.kind === 'image' ? '图片' : entry.kind === 'audio' ? '音频' : '视频'}）`;
  badge.setAttribute('aria-label', `${entry.serviceLabel}：下载当前${entry.label}，选择已有集`);
  badge.setAttribute('aria-haspopup', 'menu');
  badge.disabled = advancingDownloadEpisodes.has(downloadEpisodeKey(entry));
  badge.addEventListener('pointerdown', event => event.stopPropagation());
  badge.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); });
  badge.addEventListener('click', event => showQuickEpisodeMenu(entry, event));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'quick-episode-advance';
  button.dataset.serviceId = entry.serviceId;
  button.dataset.kind = entry.kind;
  button.dataset.episode = String(entry.episode);
  button.disabled = advancingDownloadEpisodes.has(downloadEpisodeKey(entry));
  button.setAttribute('aria-busy', String(button.disabled));
  button.setAttribute('aria-label', `${entry.serviceLabel}：保存${entry.label}，切到第${entry.episode + 1}集`);
  button.title = `${entry.label}素材保留；点击后，新下载存入第${entry.episode + 1}集`;
  button.innerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16 7a6.4 6.4 0 1 0 .4 5M16 3v4h-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); });
  button.addEventListener('pointerdown', event => event.stopPropagation());
  button.addEventListener('click', event => {
    event.stopPropagation();
    changeQuickDownloadEpisode(entry);
  });
  return [badge, button];
}

function isProjectRootFolder(folderPath) {
  if (!folderPath) return true;
  return folderPath === (state.config?.project?.folder || '');
}





let quickAssetMutationDepth = 0;
let quickAssetReloadTimer = 0;
let quickDeferredAssetReload = null;
let quickDeleteOperation = null;
let quickSingleDeleteDepth = 0;
const quickRecentMoves = new Map();
const quickRecentCopies = new Map();
const quickRecentDeletes = new Map();

function quickAssetDeletionBusy() {
  return !!quickDeleteOperation || quickSingleDeleteDepth > 0;
}

function quickCreativeSelection(paths = state.quickSelectionOrder) {
  const root = state.config?.project?.folder;
  const downloadRoot = state.config?.project?.categories?.find(category => category.id === 'browser-downloads')?.path
    || browserDownloadFolderPath();
  const available = state.quickIndexes?.filesByPath || new Map(state.assetItems.map(item => [item.path, item]));
  return [...new Set(paths)].filter(path => {
    const item = available.get(path);
    return typeof path === 'string' && !path.startsWith('download:') && !!item && item.kind !== 'folder'
      && !item.browserDownload && (!root || path.startsWith(`${root}/`))
      && path !== downloadRoot && !path.startsWith(`${downloadRoot}/`)
      && item.downloadState !== 'progressing' && item.downloadState !== 'paused';
  });
}

function applyQuickAssetDeletions(paths, projectId = state.projectId) {
  if (projectId !== state.projectId) return;
  const deleted = new Set(paths);
  const removedItems = state.assetItems.filter(item => deleted.has(item.path));
  // 只扣除回执确认且当前缓存里确实存在的文件。刷新失败仍能保留未删素材与真实剩余计数；
  // 重复的 SSE/回执不会再次减数，汇总组按成员集合、真实目录按原路径分别核对。
  for (const folder of state.quickFolders || []) {
    const folderPath = folder.node.path || '';
    const members = state.quickVideoLayout?.members?.get(folderPath);
    if (members) {
      for (const item of removedItems) members.delete(item.path);
      folder.node.fileCount = members.size;
    } else {
      const removedCount = new Set(removedItems.filter(item => !folderPath || item.path.startsWith(`${folderPath}/`))
        .map(item => item.path)).size;
      if (removedCount) folder.node.fileCount = Math.max(0, (Number(folder.node.fileCount) || 0) - removedCount);
    }
  }
  state.quickSelectionOrder = state.quickSelectionOrder.filter(path => !deleted.has(path));
  if (quickPreviewItem && deleted.has(quickPreviewItem.path)) closeQuickPreview({ instant: true });
  for (const [assetPath, floatedPath] of state.floatedVideoPaths) {
    if (deleted.has(assetPath) || deleted.has(floatedPath)) {
      state.floatedVideoPaths.delete(assetPath);
      applyFloatedVideoCardState(assetPath);
    }
  }
  state.assetItems = state.assetItems.filter(item => !deleted.has(item.path));
  state.quickIndexes = null;
}

function finishQuickDeletionReload(operation, refreshed) {
  // 删除时新项目的下载或资产事件可以排队；旧批次结束不能抹掉这次刷新。
  const deferred = quickDeferredAssetReload;
  if (!deferred) return;
  if (refreshed && deferred.projectId === operation.projectId && deferred.epoch === operation.epoch) {
    quickDeferredAssetReload = null;
  } else if (deferred.projectId === state.projectId && deferred.epoch === quickProjectViewEpoch) {
    scheduleQuickAssetReload();
  }
}

async function deleteQuickSelectedAssets(paths = state.quickSelectionOrder) {
  if (quickAssetDeletionBusy() || quickAssetMutationDepth
    || (renameTarget?.kind === 'asset' && el.renameSave.disabled)) {
    showToast('素材正在处理，请稍后删除'); return;
  }
  const selected = quickCreativeSelection(paths);
  if (!selected.length) { showToast('请先点击“批量选择”勾选素材；浏览器下载不参与批量删除'); return; }
  if (selected.length > QUICK_SELECTION_LIMIT) { showToast(`每次最多删除 ${QUICK_SELECTION_LIMIT} 项，请缩小选择范围`); return; }
  if (typeof API.deleteAssets !== 'function') { showToast('批量删除需要更新桌面程序后使用'); return; }
  const operation = { projectId: state.projectId, epoch: quickProjectViewEpoch, paths: selected };
  const stillCurrent = () => operation.projectId === state.projectId && operation.epoch === quickProjectViewEpoch;
  quickDeleteOperation = operation;
  quickAssetMutationDepth++;
  clearTimeout(quickAssetReloadTimer);
  // 撤销批量开始前的扫描响应，避免它在删除后又把旧卡片放回列表。
  assetItemsRequestId++;
  updateQuickSelectionUI();
  let shouldReload = false;
  let knownSummary = '';
  try {
    // 主进程负责一次确认和默认取消。此处不叠加 confirm，也不循环调用隐式项目的单项删除。
    const result = await API.deleteAssets({ projectId: operation.projectId, paths: selected });
    if (!stillCurrent()) return;
    if (!result || result.projectId !== operation.projectId || !Array.isArray(result.deleted) || !Array.isArray(result.failed)) {
      throw new Error('批量删除回执无效，请刷新资产库核对');
    }
    if (result.cancelled && result.deleted.length === 0) { showToast('已取消删除，选择保留'); return; }
    const requested = new Set(selected);
    const deleted = [...new Set(result.deleted.filter(path => requested.has(path)))];
    const failures = result.failed.filter(item => requested.has(item?.path));
    const firstError = failures[0]?.error;
    knownSummary = `已移到废纸篓 ${deleted.length} 项；失败 ${failures.length} 项${result.cancelled ? '；已停止后续删除' : ''}${failures.length ? `，仍存在的选项已保留，可重试${firstError ? `：${firstError}` : ''}` : ''}`;
    for (const path of deleted) quickRecentDeletes.set(`${operation.projectId}\n${path}`, Date.now());
    applyQuickAssetDeletions(deleted, operation.projectId);
    shouldReload = true;
    const refreshed = await loadAssetItems({ preserveOnError: true, quiet: true });
    if (!stillCurrent()) return;
    showToast(knownSummary + (refreshed ? '' : '；列表刷新失败，未删素材保留，请重试刷新'));
  } catch (error) {
    if (!stillCurrent()) return;
    // 回执不确定时只重读一次；不能推定整批成功，也不能自动重试删除。
    if (!shouldReload) { shouldReload = true; await loadAssetItems({ preserveOnError: true, quiet: true }); }
    if (stillCurrent()) showToast(knownSummary
      ? `${knownSummary}；列表刷新失败，未删素材保留，请重试刷新`
      : (error.message || '批量删除结果未确认，选择已保留，请刷新核对'));
  } finally {
    quickAssetMutationDepth--;
    if (quickDeleteOperation === operation) quickDeleteOperation = null;
    finishQuickDeletionReload(operation, shouldReload && stillCurrent());
    // 切剧本只更新操作锁，不使用旧路径/旧选择去重画新项目。
    updateQuickSelectionUI();
  }
}
function applyQuickAssetMoves(moves, projectId = state.projectId) {
  if (projectId && projectId !== state.projectId) return;
  state.quickIndexes = null;
  for (const move of moves || []) {
    if (!move?.oldPath || !move.path || move.oldPath === move.path) continue;
    const remap = value => FolderEditor.remap(value, move);
    const previewMoved = quickPreviewItem && (quickPreviewItem.path === move.oldPath || (move.assetId && quickPreviewItem.assetId === move.assetId && quickPreviewItem.path !== move.path));
    quickRecentMoves.set(`${move.oldPath}\n${move.path}`, Date.now());
    state.quickSelectionOrder = state.quickSelectionOrder.map(remap);
    state.floatedVideoPaths = new Map([...state.floatedVideoPaths].map(([key, value]) => [remap(key), remap(value)]));
    for (const item of state.assetItems) {
      if (item.path !== move.oldPath && (!move.assetId || item.assetId !== move.assetId)) continue;
      Object.assign(item, { path: move.path, name: move.name || move.path.split('/').at(-1), folderPath: FolderEditor.parentPath(move.path) });
      if (move.videoDisposition) item.videoDisposition = move.videoDisposition;
    }
    for (const download of state.downloads.values()) {
      for (const field of ['path', 'relativePath', 'assetPath', 'creativeAssetPath']) {
        if (download[field]) download[field] = remap(download[field]);
      }
      if (download.savePath?.replace(/\\/g, '/').endsWith(`/${move.oldPath}`)) {
        download.savePath = download.savePath.slice(0, -move.oldPath.length) + move.path;
      }
    }
    if (previewMoved) {
      Object.assign(quickPreviewItem, { path: move.path, name: move.name || move.path.split('/').at(-1), folderPath: FolderEditor.parentPath(move.path) });
      el.quickPreviewName.textContent = quickPreviewItem.name;
      el.quickPreviewMeta.textContent = `${quickPreviewItem.folderPath} · ${quickPreviewItem.type === 'video' ? '视频预览' : '资产预览'}`;
      FolderEditor.updateMediaPath(el.quickPreviewStage, assetImageUrl(move.path));
    }
  }
}
function scheduleQuickAssetReload() {
  if (quickAssetMutationDepth) {
    quickDeferredAssetReload = { projectId: state.projectId, epoch: quickProjectViewEpoch };
    return;
  }
  quickDeferredAssetReload = null;
  clearTimeout(quickAssetReloadTimer);
  quickAssetReloadTimer = setTimeout(() => loadAssetItems().catch(() => {}), 180);
}
async function transferQuickAssets(paths, folderPath, action = 'move', { reload = true } = {}) {
  const projectId = state.projectId;
  const result = { succeeded: 0, skipped: 0, failed: [], dispositions: new Set() };
  if (quickAssetDeletionBusy()) {
    result.failed.push('正在删除素材，请稍后整理');
    return result;
  }
  quickAssetMutationDepth++; clearTimeout(quickAssetReloadTimer);
  try {
    for (const assetPath of [...new Set(paths)]) {
      if (action === 'move' && FolderEditor.parentPath(assetPath) === FolderEditor.normalizePath(folderPath)) { result.skipped++; continue; }
      try {
        if (projectId !== state.projectId) throw new Error('剧本已切换，未执行此项');
        const previousDisposition = state.assetItems.find(item => item.path === assetPath)?.videoDisposition;
        const response = await fetch(`/api/creative-assets/${action}?project=${encodeURIComponent(projectId)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: assetPath, folder: folderPath }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (action === 'move') applyQuickAssetMoves([{ ...data, oldPath: data.oldPath || assetPath }], projectId);
        else quickRecentCopies.set(`${assetPath}\n${data.path}`, Date.now());
        result.succeeded++;
        if (data.videoDisposition && data.videoDisposition !== previousDisposition) result.dispositions.add(data.videoDisposition);
      } catch (error) { result.failed.push(`${assetPath.split('/').at(-1)}：${error.message}`); }
    }
  } finally {
    quickAssetMutationDepth--; clearTimeout(quickAssetReloadTimer);
    if (reload && projectId === state.projectId) await loadAssetItems();
  }
  return result;
}
function quickTransferSummary(result, folderPath, action) {
  const disposition = result.dispositions.size === 1 ? `；已归为${result.dispositions.has('processing') ? '待处理' : '可剪辑'}` : '';
  return `${action === 'copy' ? '复制' : '移动'}到「${folderPath}」：成功 ${result.succeeded}，跳过 ${result.skipped}，失败 ${result.failed.length}${disposition}${result.failed.length ? `；${result.failed[0]}` : ''}`;
}
async function moveQuickAsset(assetPath, folderPath) {
  const result = await transferQuickAssets([assetPath], folderPath);
  showToast(quickTransferSummary(result, folderPath, 'move'));
}
let quickTransferTargets = null;
function openQuickTransferDialog(paths, action = 'move') {
  if (quickAssetDeletionBusy()) { showToast('正在删除素材，请稍后整理'); return; }
  quickTransferTargets = { paths: [...paths], action, projectId: state.projectId };
  el.quickMoveDialogTitle.textContent = action === 'copy' ? '复制到…' : '移动到…';
  el.quickMoveDialogHint.textContent = `已选 ${paths.length} 项，选择完整目标位置`;
  el.quickMoveFolderList.replaceChildren();
  for (const folder of state.quickFolders) {
    const path = folder.node.path;
    if (folder.virtualGenerated) continue;
    if (!path || isProjectRootFolder(path) || (action === 'move' && paths.every(item => FolderEditor.parentPath(item) === FolderEditor.normalizePath(path)))) continue;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'move-folder-row'; button.dataset.folderPath = path;
    button.textContent = path; button.title = path;
    button.addEventListener('click', async () => {
      const targets = quickTransferTargets;
      closeCreatorDialog(el.quickMoveDialog);
      if (!targets || targets.projectId !== state.projectId) { showToast('剧本已切换，请重新选择素材'); return; }
      const result = await transferQuickAssets(targets.paths, path, targets.action);
      showToast(quickTransferSummary(result, path, targets.action));
    });
    el.quickMoveFolderList.append(button);
  }
  if (!el.quickMoveFolderList.childElementCount) el.quickMoveFolderList.textContent = '没有其他目标文件夹，可以先新建文件夹。';
  openCreatorDialog(el.quickMoveDialog);
}
function showQuickFileMenu(item, event) {
  event.preventDefault(); event.stopPropagation();
  if (quickAssetDeletionBusy()) { showToast('正在删除素材，请稍后操作'); return; }
  const selected = state.quickSelectionOrder.includes(item.path) ? state.quickSelectionOrder.filter(path => state.assetItems.some(asset => asset.path === path)) : [item.path];
  if (!selected.length) return;
  const items = [
    { label: `移动到…${selected.length > 1 ? `（${selected.length} 项）` : ''}`, run: () => openQuickTransferDialog(selected) },
    { label: `复制到…${selected.length > 1 ? `（${selected.length} 项）` : ''}`, run: () => openQuickTransferDialog(selected, 'copy') },
  ];
  if (item.type === 'image') items.unshift({ label: '改名…', run: () => openRenameDialog('asset', item.path, item.name.replace(/\.[^.]+$/, '')) });
  const videos = quickCreativeSelection(selected).filter(path => state.assetItems.some(asset => asset.path === path && asset.type === 'video'));
  if (videos.length) {
    const suffix = videos.length > 1 ? `（${videos.length} 项视频）` : '';
    items.push({ label: `改为可剪辑${suffix}`, run: () => changeQuickVideoDisposition(videos, 'editable') },
      { label: `改为待处理${suffix}`, run: () => changeQuickVideoDisposition(videos, 'processing') });
  }
  const deletable = quickCreativeSelection(selected);
  if (deletable.length) {
    const projectId = state.projectId, epoch = quickProjectViewEpoch;
    items.push({ label: deletable.length > 1 ? `删除所选（${deletable.length} 项）` : '删除（移到废纸篓）', run: () => {
      if (projectId !== state.projectId || epoch !== quickProjectViewEpoch) { showToast('剧本已切换，请重新选择素材'); return; }
      return deleteQuickSelectedAssets(deletable);
    } });
  }
  if (selected.length === 1) items.push({ label: '在完整库中查看', run: () => API.focusAssetInLibrary?.(item.path, state.projectId) });
  FolderEditor.menu(event, items, el.quickFolderTree);
}

async function changeQuickVideoDisposition(paths, disposition) {
  if (quickAssetDeletionBusy() || quickAssetMutationDepth) { showToast('素材正在处理，请稍后归类'); return; }
  const selected = quickCreativeSelection(paths).filter(path => state.assetItems.some(item => item.path === path && item.type === 'video'));
  if (!selected.length || !['editable', 'processing'].includes(disposition)) return;
  const projectId = state.projectId, epoch = quickProjectViewEpoch;
  const currentView = () => projectId === state.projectId && epoch === quickProjectViewEpoch;
  let succeeded = 0;
  const failed = [];
  quickAssetMutationDepth++;
  clearTimeout(quickAssetReloadTimer);
  try {
    for (const path of selected) {
      if (!currentView()) return;
      try {
        const response = await fetch(`/api/creative-assets/disposition?project=${encodeURIComponent(projectId)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, disposition }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.path) throw new Error(data.error || `HTTP ${response.status}`);
        if (!currentView()) return;
        applyQuickAssetMoves([{ ...data, oldPath: data.oldPath || path }], projectId);
        const item = state.assetItems.find(asset => asset.path === data.path);
        if (item) item.videoDisposition = disposition;
        succeeded++;
      } catch (error) { failed.push(`${path.split('/').at(-1)}：${error.message}`); }
    }
    if (!currentView()) return;
    const refreshed = await loadAssetItems({ preserveOnError: true, quiet: true });
    if (currentView()) showToast(`已归为${disposition === 'editable' ? '可剪辑' : '待处理'} ${succeeded} 项；失败 ${failed.length} 项${failed[0] ? `：${failed[0]}` : ''}${refreshed ? '' : '；列表刷新失败，请重试刷新'}`);
  } finally {
    quickAssetMutationDepth--;
    finishQuickDeletionReload({ projectId, epoch }, currentView());
  }
}

async function importLocalFilesToFolder(files, folderPath, options = {}) {
  if (quickAssetDeletionBusy()) { showToast('正在删除素材，请稍后导入'); return; }
  const operation = { projectId: state.projectId, epoch: quickProjectViewEpoch };
  const readBefore = assetItemsRequestId;
  quickAssetMutationDepth++;
  clearTimeout(quickAssetReloadTimer);
  try { return await performQuickLocalFilesImport(files, folderPath, options); }
  finally {
    quickAssetMutationDepth--;
    finishQuickDeletionReload(operation, operation.projectId === state.projectId && operation.epoch === quickProjectViewEpoch
      && assetItemsRequestId > readBefore);
  }
}

async function performQuickLocalFilesImport(files, folderPath, { naming = 'sequential' } = {}) {
  if (quickAssetDeletionBusy()) { showToast('正在删除素材，请稍后导入'); return; }
  files = Array.from(files || []);
  if (!files.length) return;
  const supportedMediaName = /\.(png|jpe?g|webp|gif|bmp|avif|mp4|mov|webm|mkv|avi|m4v|mp3|wav|m4a|aac|flac|ogg|opus|wma|aiff|aif|amr|ape)$/i;
  if (quickDownloadEpisodeForImport(folderPath) && !files.some(file => supportedMediaName.test(file.name))) {
    showToast('没有可导入的图片、视频或音频'); return;
  }
  const projectId = state.projectId;
  const epoch = quickProjectViewEpoch;
  const currentView = () => projectId === state.projectId && epoch === quickProjectViewEpoch;
  try { folderPath = await prepareQuickImportFolder(folderPath, projectId, epoch); }
  catch (error) { if (currentView()) showToast(error.message || '导入目录准备失败'); return; }
  if (!currentView()) return;
  // 原生拖拽传递的是本地文件；拖回左侧分类时仍应移动已有资产，而不是复制一份。
  const normalizePath = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/g, '').normalize('NFC');
  const root = normalizePath(state.config?.paths?.creativeAssetLibraryRoot);
  const incoming = [];
  const existingPaths = [];
  for (const file of Array.from(files || [])) {
    let localPath = '';
    try { localPath = normalizePath(API.getPathForFile?.(file)); } catch {}
    const existing = root && localPath && state.assetItems.find(item => normalizePath(`${root}/${item.path}`) === localPath);
    if (!existing) { incoming.push(file); continue; }
    if (isProjectRootFolder(folderPath)) {
      showToast('请拖到具体分类（如 人物资产）；项目根目录不直接存放文件');
    } else {
      existingPaths.push(existing.path);
    }
  }
  if (existingPaths.length) {
    const result = await transferQuickAssets(existingPaths, folderPath, 'move', { reload: !incoming.length });
    showToast(quickTransferSummary(result, folderPath, 'move'));
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
      const result = await API.importDroppedAssets({ paths, naming, projectId });
      if (!currentView()) return;
      await loadAssetItems();
      if (currentView()) showToast(`已按类别自动归档 ${Number(result?.imported) || 0} 项${naming === 'original' ? '，保留原文件名' : '，拖入自动编号'}`);
    } catch (error) {
      if (currentView()) showToast(`导入失败：${error.message}`);
    }
    return;
  }
  const list = [...files].filter(file => supportedMediaName.test(file.name));
  if (!list.length) {
    showToast('没有可导入的图片、视频或音频');
    return;
  }
  let imported = 0;
  const failed = [];
  for (const file of list) {
    try {
      if (!currentView()) return;
      const response = await fetch(`/api/creative-assets/import?project=${encodeURIComponent(projectId)}&folder=${encodeURIComponent(folderPath)}&name=${encodeURIComponent(file.name)}&naming=${encodeURIComponent(naming)}`, {
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
  if (!currentView()) return;
  await loadAssetItems();
  if (currentView()) showToast(failed.length
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
    // 普通真实目录延续收起当前目录后存入上级的契约；网站/集/汇总的下载意图独立保留。
    if (state.quickAssetFolder === key && !folder.generatedVideoGroup && !folder.virtualGenerated) {
      const parent = folder.parentPath || '';
      state.quickAssetFolder = GeneratedVideoLayout.isVirtualPath(parent) ? FolderEditor.parentPath(key) : quickWritableFolder(parent);
    }
  } else {
    state.collapsedQuickFolders.delete(key);
    if (!folder.virtualGenerated || quickDownloadEpisodeForImport(key)) state.quickAssetFolder = quickWritableFolder(key);
  }
  state.quickViewFolder = key;
  if (!collapsing) ensureQuickFolderContents(wrapper);
  else releaseQuickFolderContents(wrapper);
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
  updateQuickSelectionUI();
}

function updateQuickDropLabel() {
  if (!el.quickDropTarget) return;
  const automatic = !state.quickAssetFolder || isProjectRootFolder(state.quickAssetFolder);
  const root = state.config?.project?.folder || '';
  const relative = root && state.quickAssetFolder.startsWith(`${root}/`)
    ? state.quickAssetFolder.slice(root.length + 1) : state.quickAssetFolder;
  const fullLabel = automatic ? '全部资产' : relative.split('/').filter(Boolean).join(' / ');
  const parentLabel = relative.split('/').filter(Boolean).slice(0, -1).join(' / ');
  el.quickDropTarget.textContent = automatic ? '全部资产' : quickFolderLabel(state.quickAssetFolder);
  el.quickDropTarget.title = fullLabel;
  el.quickDropTarget.dataset.folderPath = state.quickAssetFolder;
  if (el.quickDropTargetHint) {
    el.quickDropTargetHint.textContent = automatic ? '按类别自动归档' : parentLabel;
    el.quickDropTargetHint.title = automatic ? '按类别自动归档' : fullLabel;
    el.quickDropTargetHint.hidden = !automatic && !parentLabel;
  }
  const targetDescription = `当前存入：${fullLabel}${automatic ? '（按类别自动归档）' : ''}`;
  el.assetDropZone.title = targetDescription;
  el.assetDropZone.setAttribute('aria-label', `拖入图片、视频或音频；${targetDescription}`);
  const viewing = state.quickIndexes?.folders.get(state.quickViewFolder);
  if (el.quickViewNotice) {
    const website = viewing?.downloadEpisode && quickDownloadEpisodeForImport(state.quickViewFolder);
    const readonly = (!!viewing?.virtualGenerated && !website) || state.quickViewFolder.startsWith('@legacy:');
    el.quickViewNotice.hidden = !readonly && !website;
    const label = viewing?.displayPath || viewing?.node.name || '未分集素材';
    el.quickViewNotice.textContent = website
      ? `查看「${viewing.node.name}」全部素材；选文件或拖入存入当前「${website.label}」`
      : readonly ? `只读查看「${label.replace(root + '/', '')}」；当前存入仍为「${fullLabel}」` : '';
  }
  el.quickFolderTree.querySelectorAll('.quick-folder-row[data-folder-path]').forEach(row => {
    row.classList.toggle('view-selected', row.dataset.folderPath === state.quickViewFolder);
  });
}

function assetRelativeFromSavePath(savePath) {
  const library = String(state.config?.paths?.creativeAssetLibraryRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const absolute = String(savePath || '').replace(/\\/g, '/');
  if (!library || !(absolute === library || absolute.startsWith(`${library}/`))) return '';
  return absolute.slice(library.length + 1);
}

function downloadCardType(kind) {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'audio';
  return 'other';
}

function isBrowserDownloadFile(item) {
  if (!item || ['image', 'video', 'audio'].includes(item.type)) return false;
  // 老下载记录有时把媒体标成 other/file；扩展名仍须兜底排除。
  return !/\.(?:png|jpe?g|webp|gif|bmp|avif|svg|heic|heif|tiff?|ico|psd|dng|cr2|mp4|mov|webm|mkv|avi|m4v|mpeg|mpg|wmv|flv|3gp|ogv|m2ts|mts|mp3|wav|m4a|aac|flac|ogg|opus|wma|aiff?|amr|ape)$/i.test(item.name || item.filename || '');
}

function browserDownloadRecords() {
  const records = [];
  const seen = new Set();
  for (const download of state.downloads.values()) {
    if (download.projectId && download.projectId !== state.projectId) continue;
    if (download.source === 'import' || download.state === 'cancelled') continue;
    seen.add(download.id);
    records.push(download);
  }
  for (const item of state.production?.inbox || []) {
    if (seen.has(item.download_key) || item.source === 'import') continue;
    records.push({
      id: item.download_key,
      kind: item.kind,
      filename: item.filename,
      savePath: item.asset_path,
      state: 'completed',
      source: item.source || 'platform',
      startedAt: item.created_at,
      endedAt: item.updated_at,
      receivedBytes: Number(item.size_bytes) || 0,
      totalBytes: Number(item.size_bytes) || 0,
    });
  }
  return records;
}

function browserDownloadFolderPath() {
  const folder = (state.quickFolders || []).find(item => item.node?.name === '浏览器下载');
  if (folder?.node?.path) return folder.node.path;
  const project = (state.quickFolders || []).find(item => item.depth === 0);
  const base = project?.node?.path || '';
  return base ? `${base}/浏览器下载` : '浏览器下载';
}

function downloadDragToken(item) {
  if (!item || item.downloadState === 'progressing' || item.downloadState === 'paused') return '';
  if (item.path) return item.path;
  if (item.downloadId) return `download:${item.downloadId}`;
  return '';
}

function collectBrowserDownloadCards(folderPath) {
  const byPath = new Map();
  const loose = [];
  for (const item of state.assetItems) {
    const inDownloadFolder = item.folderPath === folderPath || (folderPath && item.folderPath.startsWith(`${folderPath}/`));
    if (!item.path || !inDownloadFolder || !isBrowserDownloadFile(item)) continue;
    byPath.set(item.path, { ...item, browserDownload: true });
  }
  for (const download of browserDownloadRecords()) {
    if (!isBrowserDownloadFile({ type: downloadCardType(download.kind), name: download.filename })) continue;
    const relative = assetRelativeFromSavePath(download.savePath);
    if (!relative || !relative.startsWith(`${folderPath}/`)) continue;
    const existing = relative && byPath.get(relative);
    // 已完成的文件以磁盘扫描结果为准；历史入库记录不能复活已经删除的卡片。
    if (!existing && download.state !== 'progressing' && download.state !== 'paused') continue;
    const card = {
      ...(existing || {}),
      name: existing?.name || download.filename,
      path: existing?.path || relative || '',
      type: existing?.type || downloadCardType(download.kind),
      folderPath: existing?.folderPath || (relative ? relative.split('/').slice(0, -1).join('/') : folderPath),
      mtime: download.endedAt || download.startedAt || existing?.mtime || '',
      downloadId: download.id,
      downloadState: download.state,
      downloadSource: download.source,
      receivedBytes: download.receivedBytes,
      totalBytes: download.totalBytes,
      browserDownload: true,
    };
    if (card.path) byPath.set(card.path, card);
    else loose.push(card);
  }
  const merged = [...byPath.values(), ...loose];
  merged.sort((a, b) => {
    const rank = item => (item.downloadState === 'progressing' || item.downloadState === 'paused') ? 0 : 1;
    return rank(a) - rank(b) || AssetOrder.newestFirst(a, b);
  });
  return merged;
}

function bindBrowserDownloadDock() {
  const toggle = document.getElementById('browserDownloadToggle');
  const name = document.getElementById('browserDownloadName');
  const children = document.getElementById('browserDownloadChildren');
  if (!toggle || !children || toggle.dataset.bound === '1') return;
  toggle.dataset.bound = '1';
  const flip = () => {
    const collapsed = children.classList.toggle('collapsed');
    toggle.classList.toggle('expanded', !collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', `${collapsed ? '展开' : '收起'}浏览器下载`);
    name?.setAttribute('aria-expanded', String(!collapsed));
  };
  toggle.addEventListener('click', flip);
  name?.addEventListener('click', flip);
}

function refreshBrowserDownloadCards() {
  bindBrowserDownloadDock();
  const grid = document.getElementById('browserDownloadGrid');
  if (!grid) return;
  const rootPath = browserDownloadFolderPath();
  const items = collectBrowserDownloadCards(rootPath);
  if (!el.assetAccordion.open || materialSidebarCollapsed()) {
    grid.replaceChildren();
    const count = document.getElementById('browserDownloadCount');
    if (count) count.textContent = String(items.length);
    return;
  }
  const folders = state.quickFolders.filter(folder => folder.node?.path === rootPath || folder.node?.path?.startsWith(`${rootPath}/`));
  if (state.browserDownloadFolderFilter && !folders.some(folder => folder.node.path === state.browserDownloadFolderFilter)) {
    state.browserDownloadFolderFilter = '';
  }
  const current = state.browserDownloadFolderFilter || rootPath;
  const nav = document.getElementById('browserDownloadNav');
  if (nav) {
    nav.replaceChildren();
    if (current !== rootPath) {
      const back = document.createElement('button');
      back.type = 'button'; back.className = 'browser-download-folder';
      back.textContent = '← 全部文件';
      back.addEventListener('click', () => { state.browserDownloadFolderFilter = ''; refreshBrowserDownloadCards(); });
      nav.appendChild(back);
    }
    for (const folder of AssetOrder.orderFolders(folders.filter(folder => folder.parentPath === current))) {
      const path = folder.node.path;
      const count = items.filter(item => item.path === path || item.path?.startsWith(`${path}/`)).length;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'browser-download-folder';
      button.textContent = `📁 ${folder.node.name} · ${count}`;
      button.title = `打开文件夹「${folder.node.name}」`;
      button.addEventListener('click', () => { state.browserDownloadFolderFilter = path; refreshBrowserDownloadCards(); });
      nav.appendChild(button);
    }
    nav.hidden = !nav.childElementCount;
  }
  const shownItems = current === rootPath ? items : items.filter(item => item.path?.startsWith(`${current}/`));
  const visible = shownItems.slice(0, state.browserDownloadLimit || 60);
  grid.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'quick-folder-empty-hint';
    empty.textContent = '这里暂无文件；浏览器下载的文档和压缩包会自动出现';
    grid.appendChild(empty);
  } else {
    for (const item of visible) grid.appendChild(buildQuickFileCard(item));
    if (shownItems.length > visible.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'text-action browser-download-more';
      more.textContent = `还有 ${shownItems.length - visible.length} 个文件`;
      more.addEventListener('click', () => {
        state.browserDownloadLimit = (state.browserDownloadLimit || 60) + 60;
        refreshBrowserDownloadCards();
      });
      grid.appendChild(more);
    }
  }
  const count = document.getElementById('browserDownloadCount');
  if (count) count.textContent = String(items.length);
  updateQuickSelectionUI();
}

function updateQuickCounts() {
  const imageCount = state.assetItems.filter(item => item.type === 'image').length;
  const videoCount = state.assetItems.filter(item => item.type === 'video').length;
  const audioCount = state.assetItems.filter(item => item.type === 'audio').length;
  const downloadCount = collectBrowserDownloadCards(browserDownloadFolderPath()).length;
  el.assetAccordionCount.textContent = `${imageCount} 张图片${videoCount ? ` · ${videoCount} 个视频` : ''}${audioCount ? ` · ${audioCount} 条音频` : ''}${downloadCount ? ` · ${downloadCount} 个浏览器下载` : ''}`;
}

function buildQuickFileCard(item) {
  const wrapper = document.createElement('span');
  wrapper.className = 'asset-card-wrap';
  wrapper.draggable = true;
  const dragToken = downloadDragToken(item);
  if (dragToken) wrapper.dataset.assetPath = dragToken;
  wrapper.title = item.downloadId
    ? '可以拖到网页或剪映'
    : (item.path ? '拖到网页上传；拖到分类整理' : (item.name || '浏览器下载'));
  // 视频卡右键浮出：重建卡片时按内存状态恢复「已浮出」角标，不靠 DOM 残留
  if (item.type === 'video' && item.path) {
    wrapper.dataset.assetName = item.name;
    wrapper.classList.toggle('is-floated', state.floatedVideoPaths.has(item.path));
  }
  let dragged = false;
  wrapper.addEventListener('pointerdown', () => { dragged = false; });
  wrapper.addEventListener('dragstart', event => {
    if (quickAssetDeletionBusy()) { event.preventDefault(); showToast('正在删除素材，请稍后拖动'); return; }
    dragged = true;
    wrapper.classList.add('asset-dragging');
    if (item.downloadState === 'progressing' || item.downloadState === 'paused') {
      event.preventDefault();
      showToast('文件还在下载');
      return;
    }
    if (!dragToken) {
      event.preventDefault();
      showToast('这个下载还不能拖出');
      return;
    }
    // 框选模式下拖动任一选中卡 = 按选入顺序整批拖出（原生多文件拖动进剪映）
    if (state.quickSelectMode && state.quickSelectionOrder.includes(dragToken) && typeof API.startAssetDragSelection === 'function') {
      event.preventDefault();
      event.stopPropagation();
      API.startAssetDragSelection([...state.quickSelectionOrder]);
      return;
    }
    if (state.config?.nativeQuickAssetDrag && typeof API.startAssetDrag === 'function') {
      event.preventDefault();
      event.stopPropagation();
      API.startAssetDrag(dragToken);
    } else if (event.dataTransfer && item.path) {
      event.dataTransfer.setData('application/x-vos-asset', item.path);
      event.dataTransfer.effectAllowed = 'move';
      showToast('拖入网页需要最新版桌面程序，请保存网页内容后完全退出并重新打开应用');
    }
  });
  wrapper.addEventListener('dragend', () => wrapper.classList.remove('asset-dragging'));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `asset-image-card ${item.type}`;
  button.draggable = true;
  button.title = `${item.name}\n点击放大或预览，可再跳转完整库`;
  if (typeof API.floatVideoAsset === 'function' && item.type === 'video' && item.path && item.downloadState !== 'progressing' && item.downloadState !== 'paused') {
    button.title += state.floatedVideoPaths.has(item.path)
      ? '\n已浮出置顶小窗；拖出后自动收起，也可点 × 关闭'
      : (typeof API.floatVideoAsset === 'function' ? '\n右键浮出置顶小窗，可直接拖进剪映' : '');
  }
  let preview;
  if (item.type === 'image' && item.path) {
    preview = document.createElement('img');
    preview.src = assetImageUrl(item.path);
    preview.alt = item.name;
    preview.loading = 'lazy';
    preview.draggable = false;
  } else if (item.type === 'video' && item.path) {
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
    icon.src = UIIcons.src(item.type === 'video' ? 'video' : item.type === 'audio' ? 'audio' : item.type === 'image' ? 'image' : 'document');
    icon.alt = '';
    icon.draggable = false;
    preview.appendChild(icon);
  }
  const label = document.createElement('span');
  label.className = 'asset-card-label';
  label.textContent = item.name;
  button.append(preview, label);
  if (item.downloadState === 'progressing' || item.downloadState === 'paused') {
    button.classList.add('is-downloading');
    const progress = document.createElement('progress');
    progress.className = 'browser-download-progress';
    const total = Number(item.totalBytes) || 0;
    const received = Number(item.receivedBytes) || 0;
    progress.max = total || 1;
    progress.value = total ? Math.min(received, total) : 0;
    if (!total && item.downloadState === 'progressing') progress.removeAttribute('value');
    progress.setAttribute('aria-label', `${item.name}：${downloadStateLabel({ state: item.downloadState, source: item.downloadSource })}`);
    button.appendChild(progress);
  }
  button.addEventListener('click', event => {
    if (dragged) { event.preventDefault(); return; }
    // 框选模式下单击卡片 = 按点击顺序选入/移出导入序列；单击仍预览与选入互斥
    if (state.quickSelectMode && dragToken) {
      toggleQuickSelection(dragToken);
      return;
    }
    if (item.downloadState === 'progressing' || item.downloadState === 'paused') {
      showToast('文件还在下载');
      return;
    }
    if (item.path && (item.type === 'image' || item.type === 'video' || item.type === 'audio')) openQuickPreview(item);
    else if (item.path && typeof API.showCreativeAsset === 'function') {
      API.showCreativeAsset(item.path).catch(error => showToast(error.message || '无法在文件夹中显示'));
    } else if (item.downloadId && typeof API.openDownload === 'function') {
      Promise.resolve(API.openDownload(item.downloadId)).then(opened => {
        if (opened === false) showToast('文件不在本机项目目录里，不能定位');
      }).catch(error => showToast(error.message || '无法在文件夹中显示'));
    } else openFullAssetLibrary();
  });
  // 视频右键仍直接浮出；整理菜单限制在左侧，不覆盖原生网页。
  if (item.path && !item.browserDownload && item.downloadState !== 'progressing' && item.downloadState !== 'paused') {
    button.addEventListener('contextmenu', event => {
      if (quickAssetDeletionBusy()) { event.preventDefault(); event.stopPropagation(); showToast('正在删除素材，请稍后操作'); return; }
      if (item.type === 'video') floatQuickVideo(item, button.getBoundingClientRect());
      showQuickFileMenu(item, event);
    });
  }
  wrapper.appendChild(button);
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
  const deleteAsset = item.browserDownload ? API.deleteBrowserDownload : API.deleteAssets;
  if (item.path && item.downloadState !== 'progressing' && item.downloadState !== 'paused' && typeof deleteAsset === 'function') {
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'asset-quick-delete';
    deleteButton.dataset.deleteAsset = item.path;
    deleteButton.textContent = '✕';
    deleteButton.title = item.browserDownload ? '永久删除下载文件' : '删除（移到废纸篓）';
    deleteButton.setAttribute('aria-label', `删除 ${item.name}`);
    deleteButton.disabled = quickAssetDeletionBusy();
    deleteButton.addEventListener('click', async event => {
      event.stopPropagation();
      if (quickAssetDeletionBusy() || quickAssetMutationDepth) { showToast('素材正在处理，请稍后删除'); return; }
      // 单张和批量共用主进程确认（包括临时免确认）；不要修改其他已选素材。
      if (!item.browserDownload) { await deleteQuickSelectedAssets([item.path]); return; }
      const projectId = state.projectId;
      const epoch = quickProjectViewEpoch;
      const stillCurrent = () => projectId === state.projectId && epoch === quickProjectViewEpoch;
      let refreshed = false;
      // 浏览器下载永久删除始终单独询问，不复用创作素材的临时免确认。
      const prompt = `永久删除「${item.name}」？此操作不会移到废纸篓，无法撤销。`;
      if (!confirm(prompt)) return;
      if (!stillCurrent() || quickAssetDeletionBusy()) return;
      quickSingleDeleteDepth++;
      quickAssetMutationDepth++;
      clearTimeout(quickAssetReloadTimer);
      assetItemsRequestId++;
      updateQuickSelectionUI();
      try {
        await deleteAsset(item.path);
        if (!stillCurrent()) return;
        quickRecentDeletes.set(`${projectId}\n${item.path}`, Date.now());
        applyQuickAssetDeletions([item.path], projectId);
        if (item.downloadId) state.downloads.delete(item.downloadId);
        showToast(`${item.browserDownload ? '已永久删除' : '已移到废纸篓'}：${item.name}`);
        refreshed = true;
        await loadAssetItems();
      } catch (error) {
        if (stillCurrent()) showToast(error.message || '删除失败');
      } finally {
        quickSingleDeleteDepth--;
        quickAssetMutationDepth--;
        finishQuickDeletionReload({ projectId, epoch }, refreshed && stillCurrent());
        updateQuickSelectionUI();
      }
    });
    wrapper.appendChild(deleteButton);
  }
  return wrapper;
}

function applyQuickFolderRename(change) {
  if (!change || change.projectId !== state.projectId) return;
  const remap = value => FolderEditor.remap(value, change);
  state.quickAssetFolder = remap(state.quickAssetFolder);
  state.collapsedQuickFolders = new Set([...state.collapsedQuickFolders].map(remap));
  state.quickSelectionOrder = state.quickSelectionOrder.map(remap);
  try { FolderEditor.rememberOrder(change); } catch {}
  assetFolderOrderCache = { projectId: null, data: {} };
  const moves = state.assetItems.filter(item => item.path?.startsWith(`${change.oldPath}/`))
    .map(item => ({ oldPath: item.path, path: remap(item.path), assetId: item.assetId }));
  applyQuickAssetMoves(moves, change.projectId);
}

function startQuickFolderCreate(parentPath) {
  if (quickAssetDeletionBusy()) { showToast('正在删除素材，请稍后新建文件夹'); return; }
  const parent = parentPath || state.config?.project?.folder;
  if (!parent || el.quickFolderTree.querySelector('.folder-rename-input')) return;
  for (const folder of state.quickFolders) {
    if (parent === folder.node.path || parent.startsWith(`${folder.node.path}/`)) state.collapsedQuickFolders.delete(folder.node.path);
  }
  renderQuickFolderTree();
  const parentRow = quickFolderRowByPath(parent);
  const host = parentRow?.nextElementSibling?.querySelector(':scope > .quick-children-inner');
  if (!host) return;
  const row = document.createElement('div'); row.className = 'quick-folder-row folder-create-row';
  const anchor = document.createElement('span'); anchor.className = 'quick-folder-name'; anchor.textContent = '新建文件夹';
  row.append(anchor); host.prepend(row); row.scrollIntoView({ block: 'nearest' });
  const projectId = state.projectId;
  quickAssetMutationDepth++; clearTimeout(quickAssetReloadTimer);
  let finished = false;
  const finish = () => { if (finished) return; finished = true; quickAssetMutationDepth--; row.remove(); };
  FolderEditor.create(anchor, { parent, projectId }, { createFolder: async request => {
    if (projectId !== state.projectId) throw new Error('剧本已切换，未创建文件夹');
    const response = await fetch(`/api/creative-assets/folder?project=${encodeURIComponent(projectId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: request.parent, name: request.name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } }, async data => {
    finish();
    const path = data.folder?.path;
    if (projectId !== state.projectId) return;
    state.quickAssetFolder = path || parent;
    state.collapsedQuickFolders.delete(path);
    await loadAssetItems();
    if (projectId !== state.projectId) return;
    expandQuickFolderAncestors(path);
    quickFolderRowByPath(path)?.scrollIntoView({ block: 'nearest' });
    showToast(`已创建：${path || parent}`);
  }, showToast, () => { finish(); scheduleQuickAssetReload(); });
}
async function showQuickFolderMenu(folder, event) {
  event.preventDefault(); event.stopPropagation();
  if (quickAssetDeletionBusy()) { showToast('正在删除素材，请稍后操作文件夹'); return; }
  if (folder?.virtualGenerated || folder?.composite) {
    const capability = folder.capabilities || {};
    const actionPath = folder.actionPath || (!folder.virtualGenerated ? folder.node.path : '');
    const projectId = state.projectId, epoch = quickProjectViewEpoch;
    const currentView = () => projectId === state.projectId && epoch === quickProjectViewEpoch;
    const actions = [];
    if (actionPath && capability.create) actions.push({ label: '在真实主目录中新建子文件夹', run: () => {
      if (currentView()) startQuickFolderCreate(actionPath);
    } });
    if (actionPath && capability.rename && typeof API.renameFolder === 'function') actions.push({ label: '改名真实主目录…', run: () => {
      if (!currentView() || quickAssetDeletionBusy()) return;
      FolderEditor.edit(quickFolderRowByPath(folder.node.path)?.querySelector('.quick-folder-name'),
        { path: actionPath, projectId, name: actionPath.split('/').at(-1) }, API, async change => {
          if (!currentView()) return;
          applyQuickFolderRename(change); await loadAssetItems();
          if (currentView()) showToast('真实主目录已改名；旧位置素材仍保留');
        }, showToast);
    } });
    if (actionPath && capability.reveal) actions.push({ label: '打开真实主目录', run: async () => {
      if (!currentView()) return;
      try {
        const response = await fetch(`/api/open-creative-assets-folder?project=${encodeURIComponent(projectId)}&p=${encodeURIComponent(actionPath)}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      } catch (error) { if (currentView()) showToast(error.message || '真实目录无法打开'); }
    } });
    if (folder.downloadEpisode && !actionPath) {
      for (const backing of folder.backingPaths || []) {
        if (typeof backing !== 'string' || GeneratedVideoLayout.isVirtualPath(backing)) continue;
        actions.push({ label: `打开真实目录：${backing}`, run: async () => {
          if (!currentView()) return;
          try {
            const response = await fetch(`/api/open-creative-assets-folder?project=${encodeURIComponent(projectId)}&p=${encodeURIComponent(backing)}`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
          } catch (error) { if (currentView()) showToast(error.message || '真实目录无法打开'); }
        } }, { label: `在此真实目录新建子文件夹：${backing}`, run: () => {
          if (currentView()) openRenameDialog('folder-create', backing, '新建文件夹');
        } });
      }
    }
    if (actions.length) FolderEditor.menu(event, actions, el.quickFolderTree);
    else showToast('这是只读查看组；当前存入位置不变，请对具体素材操作');
    return; // 汇总的真实主目录不是整个汇总的删除范围。
  }
  const parent = folder?.node.path || state.config?.project?.folder;
  if (typeof API.showFolderMenu !== 'function') {
    FolderEditor.menu(event, [{ label: folder?.depth ? '新建子文件夹' : '新建文件夹', run: () => startQuickFolderCreate(parent) }], el.quickFolderTree);
    return;
  }
  try {
    const result = await API.showFolderMenu({ path: parent, projectId: state.projectId, x: event.clientX, y: event.clientY });
    if (result?.create) startQuickFolderCreate(result.parent || parent);
    if (result?.rename) FolderEditor.edit(quickFolderRowByPath(parent)?.querySelector('.quick-folder-name'), result, API, async change => {
      applyQuickFolderRename(change); await loadAssetItems(); showToast('已改名；新导入将使用新名称加序号');
    }, showToast);
    if (result?.deleted) { showToast('文件夹已移入废纸篓'); await loadAssetItems(); }
  } catch (error) { showToast(error.message || '文件夹操作失败'); }
}

function ensureQuickFolderContents(wrapper) {
  if (!wrapper?.__quickFolder) return;
  clearTimeout(wrapper.__releaseTimer);
  if (wrapper.dataset.populated === 'true') return;
  if (!state.quickIndexes) rebuildQuickIndexes();
  const { folder, inner } = wrapper.__quickFolder;
  const key = folder.node.path || '';
  inner.replaceChildren();
  const files = folder.node.name === '浏览器下载' ? [] : state.quickIndexes.directFiles.get(key) || [];
  if (files.length) {
    const grid = document.createElement('div'); grid.className = 'quick-file-grid';
    let shown = 0;
    const more = document.createElement('button'); more.type = 'button'; more.className = 'quick-legacy-more quick-file-more';
    const append = () => {
      files.slice(shown, shown + 30).forEach(item => grid.appendChild(buildQuickFileCard(item)));
      shown = Math.min(files.length, shown + 30);
      if (shown === files.length) more.remove();
      else more.textContent = `再显示 ${Math.min(30, files.length - shown)} 项（共 ${files.length} 项）`;
    };
    inner.append(grid);
    if (files.length > 30) inner.append(more);
    more.addEventListener('click', () => { append(); updateQuickSelectionUI(); queueBoundsUpdate(); });
    append();
  }
  if (folder.node.name !== '浏览器下载') appendQuickFolderRows(inner, state.quickFolders, key, new Set());
  if (!inner.childElementCount) {
    const empty = document.createElement('div'); empty.className = 'quick-folder-empty-hint';
    empty.textContent = folder.node.fileCount ? '此分类暂无可预览素材' : '暂无资产';
    inner.append(empty);
  }
  wrapper.dataset.populated = 'true';
}

function releaseQuickFolderContents(wrapper) {
  if (!wrapper?.__quickFolder || wrapper.dataset.populated !== 'true') return;
  clearTimeout(wrapper.__releaseTimer);
  // 保留原有220ms收起动画；动画后释放隐藏媒体节点和封面观察器。
  wrapper.__releaseTimer = setTimeout(() => {
    if (!wrapper.isConnected || !wrapper.classList.contains('collapsed')) return;
    for (const cover of wrapper.querySelectorAll('.asset-video-cover')) {
      quickCoverObserver?.unobserve(cover); trackedQuickCovers.delete(cover);
    }
    wrapper.__quickFolder.inner.replaceChildren();
    wrapper.dataset.populated = 'false';
  }, 230);
}

function buildQuickFolderRow(folder) {
  const key = folder.node.path || '';
  const collapsed = state.collapsedQuickFolders.has(key);
  const row = document.createElement('div');
  row.className = 'quick-folder-row' + ((isProjectRootFolder(state.quickAssetFolder) && folder.depth === 0) || state.quickAssetFolder === key ? ' selected' : '');
  row.dataset.folderPath = key;
  if (folder.virtualGenerated) row.dataset.virtualFolder = 'true';
  if (state.quickViewFolder === key) row.classList.add('view-selected');
  if (folder.archiveUnclassified) row.title = folder.explanation || '该目录尚未统一归类，保留真实目录与素材';
  if (folder.legacyParent) { row.classList.add('quick-legacy-row'); row.dataset.legacyParent = folder.legacyParent; }

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
  row.addEventListener('contextmenu', event => showQuickFolderMenu(folder, event));

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
    if (quickAssetDeletionBusy()) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'none'; return; }
    if (folder.virtualGenerated && !quickDownloadEpisodeForImport(key)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'none'; return; }
    const types = [...event.dataTransfer.types];
    const isFileDrop = types.includes('Files');
    const isAssetMove = types.includes('application/x-vos-asset') && !!key;
    if (!isFileDrop && !isAssetMove) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = isAssetMove ? 'move' : 'copy';
    row.classList.add('drop-target');
    dropHint.hidden = false;
    dropHint.textContent = `${isAssetMove ? '移动到' : '导入到'}：${key}`;
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-target');
    dropHint.hidden = true;
  });
  row.addEventListener('drop', async event => {
    row.classList.remove('drop-target');
    dropHint.hidden = true;
    if (!event.dataTransfer) return;
    if (quickAssetDeletionBusy()) { event.preventDefault(); event.stopPropagation(); showToast('正在删除素材，请稍后导入或移动'); return; }
    if (folder.virtualGenerated && !quickDownloadEpisodeForImport(key)) { event.preventDefault(); event.stopPropagation(); showToast('这是只读汇总，请选择真实的集文件夹存入'); return; }
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
      if (assetPath) {
        const projectId = state.projectId, epoch = quickProjectViewEpoch;
        try {
          const target = await prepareQuickImportFolder(key, projectId, epoch);
          if (projectId === state.projectId && epoch === quickProjectViewEpoch) await moveQuickAsset(assetPath, target);
        } catch (error) { if (projectId === state.projectId && epoch === quickProjectViewEpoch) showToast(error.message || '整理目录准备失败'); }
      }
      return;
    }
    if (!event.dataTransfer.files.length || !key) return;
    event.preventDefault();
    event.stopPropagation();
    importLocalFilesToFolder(event.dataTransfer.files, key);
  });

  // 非根分类行末尾的独立拖动手柄：只做同级显示排序；根「全部资产」固定，不给手柄。
  row.append(disclosure, name);
  if (folder.virtualGenerated || folder.archiveUnclassified) {
    const badge = document.createElement('span'); badge.className = 'quick-view-badge';
    badge.textContent = folder.virtualGenerated ? quickDownloadEpisodeForImport(key) ? '汇总' : '只读' : '未归类';
    row.append(badge);
  }
  row.append(count);
  const downloadEpisode = downloadEpisodeForFolder(folder.downloadEpisode?.platformPath || key);
  if (downloadEpisode && typeof API?.advanceDownloadEpisode === 'function') row.append(...buildDownloadEpisodeControl(downloadEpisode));
  if (!folder.virtualGenerated && !folder.fixedOrder && folder.depth > 0 && !AssetOrder.dateFolderKey(folder.node.name)
    && !AssetOrder.episodeFolderKey(folder.node.name)) row.append(buildQuickFolderGrip(row, folder));
  row.append(dropHint);

  // Obsidian 式：展开文件夹后，里面的图片直接嵌在树下（连同子文件夹一起收纳）。
  // wrapper 必须与行平级（作为兄弟节点），折叠动画才能切换到正确的元素。
  const wrapper = document.createElement('div');
  wrapper.className = 'quick-children' + (collapsed ? ' collapsed' : '');
  const inner = document.createElement('div');
  inner.className = 'quick-children-inner';
  wrapper.appendChild(inner);
  wrapper.__quickFolder = { folder, inner };
  wrapper.dataset.populated = 'false';
  if (!collapsed) ensureQuickFolderContents(wrapper);
  row.dataset.wrapperReady = '1';
  return { row, wrapper };
}

function appendQuickFolderRows(parent, folders, parentPath, done) {
  const indexed = state.quickIndexes?.children.get(parentPath) || [];
  const pending = indexed.filter(item => !done.has(item) && item.node?.name !== '浏览器下载');
  const legacyDates = isLegacyDownloadDateParent(parentPath)
    ? pending.filter(folder => AssetOrder.dateFolderKey(folder.node.name)) : [];
  const legacySet = new Set(legacyDates);
  // 按剧本持久化的同级顺序渲染；未记录的新分类按接口树原始顺序追加在后。
  for (const folder of orderAssetFolderEntries(pending.filter(folder => !legacySet.has(folder)), parentPath)) {
    done.add(folder);
    const { row, wrapper } = buildQuickFolderRow(folder);
    parent.appendChild(row);
    parent.appendChild(wrapper);
  }
  if (legacyDates.length) {
    legacyDates.forEach(folder => done.add(folder));
    const { row, wrapper } = buildQuickLegacyGroup(parentPath, legacyDates);
    parent.append(row, wrapper);
  }
}

// 旧日期不能推断属于哪一集。只收拢展示，不迁移文件、不生成可写的伪目录。
const quickLegacyLimits = new Map();
const expandedQuickLegacyGroups = new Set();
function isLegacyDownloadDateParent(parentPath) {
  const batch = state.config?.downloadEpisodes;
  if (batch?.projectId !== state.projectId || !Array.isArray(batch.states)) return false;
  return batch.states.some(entry => entry?.available && entry.projectId === state.projectId
    && (parentPath === entry.platformPath || (entry.kind === 'video'
      && ['可剪辑', '待处理'].some(disposition => parentPath ===
        `${FolderEditor.parentPath(entry.platformPath)}/${disposition}/${entry.platformFolder}`))));
}

function buildQuickLegacyGroup(parentPath, folders) {
  const key = `@legacy:${state.projectId}:${parentPath}`;
  // 避免生成界面虚拟 path；文件卡片始终使用扫描所得的真实资产 path。
  const paths = folders.map(folder => folder.node.path);
  const files = [...new Map(paths.flatMap(path => state.quickIndexes?.descendants.get(path) || [])
    .map(item => [item.path, item])).values()].sort(AssetOrder.newestFirst);
  const row = document.createElement('div');
  row.className = 'quick-folder-row quick-legacy-row';
  row.dataset.legacyParent = parentPath;
  const arrow = document.createElement('button');
  arrow.type = 'button'; arrow.className = 'quick-folder-chevron-wrap';
  arrow.innerHTML = '<span class="folder-chevron" aria-hidden="true"></span>';
  const name = document.createElement('button');
  name.type = 'button'; name.className = 'quick-folder-name'; name.textContent = '未分集素材';
  name.title = '旧素材保留原位置；确认所属集数后，可将文件移动到对应的第N集';
  const count = document.createElement('span');
  count.className = 'quick-folder-count'; count.textContent = String(files.length);
  row.append(arrow, name, count);
  const wrapper = document.createElement('div'); wrapper.className = 'quick-children';
  const inner = document.createElement('div'); inner.className = 'quick-children-inner';
  wrapper.append(inner);
  wrapper.__quickFolder = { inner };
  wrapper.dataset.populated = 'false';
  const populate = () => {
    const limit = quickLegacyLimits.get(key) || 30;
    inner.replaceChildren();
    const hint = document.createElement('div'); hint.className = 'quick-folder-empty-hint';
    hint.textContent = '尚未指定所属集，原文件未移动；这里只查看，不改变当前存入位置';
    const grid = document.createElement('div'); grid.className = 'quick-file-grid';
    files.slice(0, limit).forEach(item => grid.appendChild(buildQuickFileCard(item)));
    inner.append(hint, grid);
    if (files.length > limit) {
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'quick-legacy-more';
      more.textContent = `再显示 ${Math.min(30, files.length - limit)} 项（共 ${files.length} 项）`;
      more.addEventListener('click', () => { quickLegacyLimits.set(key, limit + 30); populate(); queueBoundsUpdate(); });
      inner.append(more);
    }
    wrapper.dataset.populated = 'true';
  };
  const sync = () => {
    const expanded = expandedQuickLegacyGroups.has(key);
    wrapper.classList.toggle('collapsed', !expanded);
    arrow.classList.toggle('expanded', expanded);
    for (const button of [arrow, name]) button.setAttribute('aria-expanded', String(expanded));
    arrow.setAttribute('aria-label', `${expanded ? '收起' : '展开'}未分集素材`);
    if (expanded) {
      clearTimeout(wrapper.__releaseTimer);
      if (wrapper.dataset.populated !== 'true') populate();
    } else releaseQuickFolderContents(wrapper);
  };
  const toggle = () => {
    if (expandedQuickLegacyGroups.has(key)) expandedQuickLegacyGroups.delete(key);
    else expandedQuickLegacyGroups.add(key);
    state.quickViewFolder = key;
    sync(); updateQuickDropLabel(); queueBoundsUpdate();
  };
  arrow.addEventListener('click', toggle); name.addEventListener('click', toggle);
  // 虚拟入口没有 data-folder-path，不参与目录右键、重排或落盘；真实文件操作不受限。
  row.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); });
  row.addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; });
  row.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); showToast('未分集素材是只读查看组，请选择实际集文件夹存入'); });
  sync();
  return { row, wrapper };
}

/* ---------- 分类同级排序（仅显示顺序，按剧本持久化到 localStorage） ---------- */
// 只重排左侧分类树的显示次序，不调用任何移动接口：磁盘上的文件夹与资产路径不动。
// 顺序键 videoOS.assetFolderOrder.v1.<projectId>，值 { "<parentPath>": ["<childFolderPath>", ...] }。
// 读取时忽略失效路径；未记录的分类按接口树原始顺序排在已记录项之后；根「全部资产」固定不参与。
const ASSET_FOLDER_ORDER_KEY_PREFIX = 'videoOS.assetFolderOrder.v1.';
let assetFolderOrderCache = { projectId: null, data: {} };

function assetFolderOrderStorageKey() {
  return `${ASSET_FOLDER_ORDER_KEY_PREFIX}${state.projectId}`;
}

function loadAssetFolderOrder() {
  if (assetFolderOrderCache.projectId === state.projectId) return assetFolderOrderCache.data;
  let data = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(assetFolderOrderStorageKey()) || 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [parentPath, list] of Object.entries(parsed)) {
        if (!Array.isArray(list)) continue;
        const paths = [...new Set(list.filter(path => typeof path === 'string' && path))];
        if (paths.length) data[parentPath] = paths;
      }
    }
  } catch { data = {}; }
  assetFolderOrderCache = { projectId: state.projectId, data };
  return data;
}

function saveAssetFolderOrder(order) {
  try {
    localStorage.setItem(assetFolderOrderStorageKey(), JSON.stringify(order));
    assetFolderOrderCache = { projectId: state.projectId, data: order };
    return true;
  } catch (error) {
    showToast(`分类顺序保存失败：${error.message}`);
    return false;
  }
}

// 普通分类保留手动顺序；第N集按集号排列，历史日期仅维持旧数据兼容。
function orderAssetFolderEntries(entries, parentPath) {
  return AssetOrder.orderFolders(entries, loadAssetFolderOrder()[parentPath]);
}

function commitAssetFolderOrder(parentPath, entries) {
  const paths = entries.map(item => item.node.path || '');
  const order = { ...loadAssetFolderOrder() };
  if (JSON.stringify(order[parentPath] || []) === JSON.stringify(paths)) return false;
  order[parentPath] = paths;
  return saveAssetFolderOrder(order);
}

// 当前同级分类（含顺序应用结果）：排除根「全部资产」与固定入口浏览器下载。
function quickFolderSiblings(folder) {
  return orderAssetFolderEntries(
    (state.quickIndexes?.children.get(folder.parentPath || '') || []).filter(item =>
      item.depth > 0 && item.parentPath === folder.parentPath && item.node?.name !== '浏览器下载'
        && !item.virtualGenerated && !item.fixedOrder && !AssetOrder.dateFolderKey(item.node?.name) && !AssetOrder.episodeFolderKey(item.node?.name)),
    folder.parentPath || ''
  );
}

function persistQuickFolderSiblingOrder(source, ordered) {
  if (!commitAssetFolderOrder(source.parentPath || '', ordered)) return false;
  renderQuickFolderTree();
  return true;
}

function quickFolderRowByPath(folderPath) {
  return el.quickFolderTree.querySelector(`[data-folder-path="${CSS.escape(folderPath)}"]`);
}

function expandQuickFolderAncestors(folderPath) {
  if (!state.quickIndexes) rebuildQuickIndexes();
  let folder = state.quickIndexes.folders.get(folderPath);
  const seen = new Set();
  while (folder && !seen.has(folder.node.path)) {
    seen.add(folder.node.path); state.collapsedQuickFolders.delete(folder.node.path);
    folder = state.quickIndexes.folders.get(folder.parentPath);
  }
  renderQuickFolderTree();
}

function refocusQuickFolderGrip(folderPath) {
  el.quickFolderTree
    .querySelector(`[data-folder-path="${CSS.escape(folderPath)}"] > .quick-folder-grip`)
    ?.focus();
}

function moveQuickFolderByKeyboard(folder, delta) {
  if (folder.depth === 0) return;
  const siblings = quickFolderSiblings(folder);
  const sourcePath = folder.node.path || '';
  const index = siblings.findIndex(item => (item.node.path || '') === sourcePath);
  const nextIndex = index + delta;
  if (index === -1 || siblings.length < 2 || nextIndex < 0 || nextIndex >= siblings.length) {
    showToast(delta < 0 ? '已经在同级最前面' : '已经在同级最后面');
    return;
  }
  const ordered = [...siblings];
  const [moved] = ordered.splice(index, 1);
  ordered.splice(nextIndex, 0, moved);
  if (persistQuickFolderSiblingOrder(folder, ordered)) refocusQuickFolderGrip(sourcePath);
}

// —— 分类手柄拖拽换位（指针方案，与标签拖拽同一套实现习惯）——
// 从手柄按下移动超过阈值才进入拖动；候选插入位置只在同一父文件夹的兄弟行之间解析，
// 指到其他层级、素材卡片或空白时不产生插入计划。Esc 取消；靠近树上/下边缘自动纵滚。
const QUICK_FOLDER_DRAG_THRESHOLD = 5;
let folderGripDrag = null; // { pointerId, row, folder, startX, startY, lastX, lastY, active, plan, markedPath, markedPosition, scrollFrame }

function beginQuickFolderGripDrag(event, row, folder) {
  if (event.button !== 0 || folder.depth === 0) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  folderGripDrag = {
    pointerId: event.pointerId, row, folder,
    startX: event.clientX, startY: event.clientY,
    lastX: event.clientX, lastY: event.clientY,
    active: false, plan: null, markedPath: '', markedPosition: '', scrollFrame: 0,
  };
}

function activateQuickFolderDrag() {
  if (!folderGripDrag || folderGripDrag.active) return;
  folderGripDrag.active = true;
  folderGripDrag.plan = null;
  folderGripDrag.row?.classList.add('folder-drag-source');
  document.body.classList.add('folder-reordering');
  startQuickFolderAutoScroll();
}

function clearQuickFolderDropMarkers() {
  el.quickFolderTree.querySelectorAll('.folder-drop-above, .folder-drop-below')
    .forEach(node => node.classList.remove('folder-drop-above', 'folder-drop-below'));
}

function markQuickFolderDropPlan(plan) {
  const drag = folderGripDrag;
  if (!drag) return;
  // 每次移动都全量重标：SSE 刷新会重建行节点，按 plan 短路会让指示线留在游离节点上丢失
  clearQuickFolderDropMarkers();
  drag.markedPath = plan?.path || '';
  drag.markedPosition = plan?.position || '';
  if (plan?.path) {
    quickFolderRowByPath(plan.path)?.classList.add(plan.position === 'before' ? 'folder-drop-above' : 'folder-drop-below');
  }
}

function reattachQuickFolderDragSourceRow() {
  const drag = folderGripDrag;
  if (!drag) return;
  // 拖拽中途 SSE 刷新重建 DOM：旧行游离，重新定位当前源行并补回拖动中视觉态
  if (drag.row?.isConnected) return;
  drag.row = quickFolderRowByPath(drag.folder.node.path || '');
  drag.row?.classList.add('folder-drag-source');
}

function updateQuickFolderDropPlan(clientY) {
  if (!folderGripDrag?.active) return;
  reattachQuickFolderDragSourceRow();
  const sourcePath = folderGripDrag.folder.node.path || '';
  // 只接受树视口内的落点：指针移出左侧树（如拖到右侧网页列或面板底部）不产生插入计划，
  // 松手不会误排序；候选行每次实时解析，拖拽途中刷新重建 DOM 后指示线仍落在最新行上
  const treeRect = el.quickFolderTree.getBoundingClientRect();
  if (clientY < treeRect.top || clientY > treeRect.bottom
    || folderGripDrag.lastX < treeRect.left || folderGripDrag.lastX > treeRect.right) {
    folderGripDrag.plan = null;
    markQuickFolderDropPlan(null);
    return;
  }
  const candidates = quickFolderSiblings(folderGripDrag.folder)
    .map(item => quickFolderRowByPath(item.node.path || ''))
    .filter(node => node?.isConnected && (node.dataset.folderPath || '') !== sourcePath);
  let plan = null;
  for (const node of candidates) {
    const rect = node.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      plan = { path: node.dataset.folderPath || '', position: 'before' };
      break;
    }
  }
  if (!plan && candidates.length) {
    const last = candidates[candidates.length - 1];
    plan = { path: last.dataset.folderPath || '', position: 'after' };
  }
  folderGripDrag.plan = plan;
  markQuickFolderDropPlan(plan);
}

function startQuickFolderAutoScroll() {
  if (folderGripDrag.scrollFrame) return;
  const step = () => {
    if (!folderGripDrag?.active) { if (folderGripDrag) folderGripDrag.scrollFrame = 0; return; }
    const scroller = el.quickFolderTree;
    const rect = scroller.getBoundingClientRect();
    const edge = 32;
    let delta = 0;
    if (folderGripDrag.lastY < rect.top + edge) delta = -Math.ceil((rect.top + edge - folderGripDrag.lastY) / 4);
    else if (folderGripDrag.lastY > rect.bottom - edge) delta = Math.ceil((folderGripDrag.lastY - (rect.bottom - edge)) / 4);
    if (delta) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
      updateQuickFolderDropPlan(folderGripDrag.lastY);
    }
    folderGripDrag.scrollFrame = requestAnimationFrame(step);
  };
  folderGripDrag.scrollFrame = requestAnimationFrame(step);
}

function stopQuickFolderAutoScroll() {
  if (folderGripDrag?.scrollFrame) cancelAnimationFrame(folderGripDrag.scrollFrame);
  if (folderGripDrag) folderGripDrag.scrollFrame = 0;
}

function endQuickFolderGripDrag({ commit }) {
  if (!folderGripDrag) return;
  const plan = commit ? folderGripDrag.plan : null;
  const source = folderGripDrag.folder;
  stopQuickFolderAutoScroll();
  document.body.classList.remove('folder-reordering');
  clearQuickFolderDropMarkers();
  el.quickFolderTree.querySelectorAll('.folder-drag-source').forEach(node => node.classList.remove('folder-drag-source'));
  folderGripDrag = null;
  if (commit && plan && source) commitQuickFolderReorder(source, plan);
}

function commitQuickFolderReorder(source, plan) {
  // 拖拽途中树可能已被 SSE 刷新：以当前 state 的同级表为准，源或目标不存在就安静放弃
  const siblings = quickFolderSiblings(source);
  const sourcePath = source.node.path || '';
  const fromIndex = siblings.findIndex(item => (item.node.path || '') === sourcePath);
  if (fromIndex === -1 || !plan.path || plan.path === sourcePath) return;
  const ordered = [...siblings];
  const [moved] = ordered.splice(fromIndex, 1);
  let insertIndex = ordered.findIndex(item => (item.node.path || '') === plan.path);
  if (insertIndex === -1) return;
  if (plan.position === 'after') insertIndex += 1;
  ordered.splice(insertIndex, 0, moved);
  if (persistQuickFolderSiblingOrder(source, ordered)) refocusQuickFolderGrip(sourcePath);
}

function onQuickFolderGripKeydown(event, folder) {
  if (event.key === 'Escape' && folderGripDrag?.active) {
    event.preventDefault();
    endQuickFolderGripDrag({ commit: false });
    return;
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
  if (folderGripDrag?.active) return;
  event.preventDefault();
  event.stopPropagation();
  moveQuickFolderByKeyboard(folder, event.key === 'ArrowUp' ? -1 : 1);
}

function buildQuickFolderGrip(row, folder) {
  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'quick-folder-grip';
  grip.draggable = false;
  const label = `拖动调整「${folder.node.name}」的同级顺序（只在本级前后插入）；聚焦后按 Alt+↑ 或 Alt+↓ 与相邻同级换位`;
  grip.title = label;
  grip.setAttribute('aria-label', label);
  grip.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
  grip.addEventListener('pointerdown', event => beginQuickFolderGripDrag(event, row, folder));
  grip.addEventListener('keydown', event => onQuickFolderGripKeydown(event, folder));
  return grip;
}

/* ---------- 快捷面板框选与多文件拖动 ---------- */
// 框选模式：点卡片按点击顺序选入；在树容器空白处按住拖动画框，相交卡片全部选入（按位置排序）。
// 拖动任一选中卡 = 整批按选入顺序原生拖出（剪映等多文件拖放目标直接接收）。
const QUICK_SELECTION_LIMIT = 1000;

function quickVisibleCreativePaths() {
  // 展开的树可能只加载了前 30 项；只取已显示卡片，不暗中选中折叠/未加载文件。
  const paths = [...el.quickFolderTree.querySelectorAll('[data-asset-path]')]
    .filter(node => !node.closest('.quick-children.collapsed') && node.getClientRects().length > 0)
    .map(node => node.dataset.assetPath);
  return quickCreativeSelection(paths);
}

function selectAllQuickAssets() {
  if (quickAssetDeletionBusy()) return;
  const paths = quickVisibleCreativePaths();
  if (paths.length > QUICK_SELECTION_LIMIT) {
    showToast(`当前显示 ${paths.length} 项，每次最多选择 ${QUICK_SELECTION_LIMIT} 项；请先收起部分分类`);
    return;
  }
  state.quickSelectionOrder = paths;
  updateQuickSelectionUI();
  showToast(paths.length ? `已选当前显示的 ${paths.length} 项素材（不含浏览器下载或尚未显示的素材）` : '请先展开分类，显示要选择的素材');
}

function toggleQuickSelection(assetPath) {
  if (quickAssetDeletionBusy()) return;
  const idx = state.quickSelectionOrder.indexOf(assetPath);
  if (idx === -1) {
    if (state.quickSelectionOrder.length >= QUICK_SELECTION_LIMIT) { showToast(`每次最多选择 ${QUICK_SELECTION_LIMIT} 项`); return; }
    state.quickSelectionOrder.push(assetPath);
  }
  else state.quickSelectionOrder.splice(idx, 1);
  updateQuickSelectionUI();
}

function updateQuickSelectionUI() {
  const count = state.quickSelectionOrder.length;
  const deletable = quickCreativeSelection();
  const busy = quickAssetDeletionBusy();
  el.quickTools.hidden = !state.quickSelectMode && count === 0;
  el.quickSelInfo.textContent = busy ? '正在处理删除，请稍候…'
    : count ? `已选 ${count} 项${deletable.length !== count ? ` · 可删 ${deletable.length} 项` : ''} · 可整批拖出` : '点卡片勾选，或右键拖动画框；全选仅当前显示';
  // 点击全选时才计算可见矩形，逐卡勾选不反复触发布局读取。
  el.quickSelAll.disabled = busy || !el.quickFolderTree.querySelector('[data-asset-path]');
  el.quickSelClear.hidden = count === 0;
  el.quickSelClear.disabled = busy;
  el.quickMultiSelect.disabled = busy;
  el.quickMultiSelect.setAttribute('aria-pressed', String(state.quickSelectMode));
  el.quickMultiSelect.textContent = state.quickSelectMode ? '退出选择' : '批量选择';
  el.quickMultiSelect.title = state.quickSelectMode ? '退出批量选择并清空选择' : '批量勾选素材后，一次删除或整批拖出';
  el.quickFolderTree.classList.toggle('select-mode', state.quickSelectMode);
  el.quickSelDelete.hidden = false;
  el.quickSelDelete.disabled = busy || deletable.length === 0;
  el.quickSelDelete.textContent = quickDeleteOperation ? '正在删除…' : `删除所选（${deletable.length}）`;
  el.quickSelDelete.setAttribute('aria-busy', String(!!quickDeleteOperation));
  document.querySelectorAll('.asset-quick-delete').forEach(button => { button.disabled = busy; });
  const selectionIndexes = new Map(state.quickSelectionOrder.map((path, index) => [path, index]));
  el.quickFolderTree.querySelectorAll('[data-asset-path]').forEach(node => {
    const path = node.dataset.assetPath;
    const order = selectionIndexes.get(path);
    node.classList.toggle('sel-on', order !== undefined);
    node.dataset.selOrder = order === undefined ? '' : String(order + 1);
    const card = node.querySelector('.asset-image-card');
    if (state.quickSelectMode) {
      card?.setAttribute('aria-pressed', String(order !== undefined));
      card?.setAttribute('aria-description', order === undefined ? '未选择，点击勾选' : `已选择，第 ${order + 1} 项，点击取消勾选`);
    } else {
      card?.removeAttribute('aria-pressed');
      card?.removeAttribute('aria-description');
    }
  });
}

function setQuickSelectMode(on) {
  if (quickAssetDeletionBusy()) return;
  state.quickSelectMode = !!on;
  if (!state.quickSelectMode) {
    state.quickSelectionOrder.length = 0;
  }
  updateQuickSelectionUI();
}

/* ---------- 视频卡右键浮出（置顶小窗拖进剪映） ---------- */
// 浮窗本体是桌面程序的原生置顶窗口，这里只负责右键触发、角标状态与关闭事件回流。
// 同一视频重复右键 = 再次调用 floatVideoAsset（桌面程序把已有浮窗置前），UI 不把它当作关闭开关；
// 浮窗拖出后自动收起，也可点 × 关闭；事件经 onFloatVideoClosed 回流后撤掉角标。
// 浮出状态只存内存（floatedVideoPaths）：切换剧本清空、刷新自动复位，绝不写 localStorage，
// 避免浮窗早已关闭时左栏还残留「已浮出」假角标。
function floatedVideoCardNodes(assetPath) {
  return document.querySelectorAll(`[data-asset-path="${CSS.escape(assetPath)}"]`);
}

function applyFloatedVideoCardState(assetPath) {
  const floated = state.floatedVideoPaths.has(assetPath);
  floatedVideoCardNodes(assetPath).forEach(node => {
    node.classList.toggle('is-floated', floated);
    const card = node.querySelector('.asset-image-card');
    if (!card) return;
    if (floated) card.setAttribute('aria-label', `${node.dataset.assetName || ''} 已浮出为置顶小窗`);
    else card.removeAttribute('aria-label');
  });
}

function applyAllFloatedVideoCardState() {
  for (const assetPath of state.floatedVideoPaths.keys()) applyFloatedVideoCardState(assetPath);
}

async function floatQuickVideo(item, rect) {
  if (quickAssetDeletionBusy()) { showToast('正在删除素材，请稍后浮出'); return; }
  if (typeof API.floatVideoAsset !== 'function') {
    showToast('右键浮出视频小窗需要更新桌面程序后使用');
    return;
  }
  const projectId = state.projectId;
  const epoch = quickProjectViewEpoch;
  try {
    const result = await API.floatVideoAsset({ path: item.path, origin: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined });
    if (projectId !== state.projectId || epoch !== quickProjectViewEpoch || !state.assetItems.some(asset => asset.path === item.path)) return;
    // 以卡片携带的相对路径为准记状态；桌面程序返回的 path 仅作关闭事件对账。
    state.floatedVideoPaths.set(item.path, result?.path || item.path);
    applyFloatedVideoCardState(item.path);
    showToast(`已浮出置顶小窗：${item.name}`);
  } catch (error) {
    if (projectId === state.projectId && epoch === quickProjectViewEpoch) showToast(error.message || '浮出视频小窗失败，请重试');
  }
}

function handleFloatVideoClosed(payload) {
  const closedPath = payload?.path;
  if (!closedPath) return;
  // 关闭事件可能带卡片相对路径，也可能带桌面程序登记的返回路径，两种都对上账。
  for (const [assetPath, floatedPath] of state.floatedVideoPaths) {
    if (assetPath !== closedPath && floatedPath !== closedPath) continue;
    state.floatedVideoPaths.delete(assetPath);
    applyFloatedVideoCardState(assetPath);
  }
}

function setupQuickMarquee() {
  const container = el.quickFolderTree;
  if (!container || container.dataset.marqueeWired === '1') return;
  container.dataset.marqueeWired = '1';
  container.addEventListener('contextmenu', event => {
    if (state.quickSelectMode || event.target.closest('.quick-folder-row, .asset-card-wrap, input, button')) return;
    showQuickFolderMenu(null, event);
  });
  let marquee = null;
  let origin = null;
  const cardRects = () => [...container.querySelectorAll('[data-asset-path]')]
    .filter(node => !node.closest('.quick-children.collapsed') && node.getClientRects().length > 0)
    .map(node => ({ node, rect: node.getBoundingClientRect() }));
  container.addEventListener('contextmenu', event => {
    // 右键拖动画框：与卡片拖拽/单击互不冲突
    if (!state.quickSelectMode || event.button !== 2 || quickAssetDeletionBusy()) return;
    if (event.target.closest('button, input, textarea, select')) return;
    event.preventDefault();
    origin = { x: event.clientX, y: event.clientY };
    marquee = document.createElement('div');
    marquee.className = 'quick-marquee';
    marquee.style.left = `${origin.x}px`;
    marquee.style.top = `${origin.y}px`;
    document.body.appendChild(marquee);
    let limitNotified = false;
    const onMove = moveEvent => {
      if (!origin || quickAssetDeletionBusy()) return;
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
      const uniqueHits = [...new Set(hits)];
      if (uniqueHits.length > QUICK_SELECTION_LIMIT) {
        if (!limitNotified) showToast(`每次最多选择 ${QUICK_SELECTION_LIMIT} 项，请缩小框选范围`);
        limitNotified = true;
        return;
      }
      limitNotified = false;
      state.quickSelectionOrder = uniqueHits;
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
  rebuildQuickIndexes();
  updateQuickCounts();
  updateQuickDropLabel();
  resetQuickCoverObserver();  // 树与卡片整体重建：先解除旧封面节点的观察登记
  el.quickFolderTree.replaceChildren();
  if (el.assetAccordion.open && !materialSidebarCollapsed()) appendQuickFolderRows(el.quickFolderTree, state.quickFolders || [], '', new Set());
  refreshBrowserDownloadCards();
  setupQuickMarquee();
  updateQuickSelectionUI();
}



// 请求代号守卫：快速切换剧本时后完成的旧响应不得写进新剧本视图（也不得误报失效选项提示）
let assetItemsRequestId = 0;

async function loadAssetItems({ preserveOnError = false, quiet = false } = {}) {
  const requestId = ++assetItemsRequestId;
  const requestProjectId = state.projectId;
  const cached = preserveOnError ? { assetItems: state.assetItems, quickFolders: state.quickFolders,
    quickVideoLayout: state.quickVideoLayout, quickAssetFolder: state.quickAssetFolder } : null;
  try {
    const response = await fetch(`/api/creative-assets?project=${encodeURIComponent(state.projectId)}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (requestId !== assetItemsRequestId || state.projectId !== requestProjectId) return false;
    if (!response.ok || !data.tree) throw new Error(data.error || `HTTP ${response.status}`);
    if (data.project) state.config.project = data.project;
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
    el.assetAccordionCount.removeAttribute('title');
    return true;
  } catch (error) {
    // 请求代号或项目身份已变化：这是被取代的旧请求，其失败不得覆盖新项目的成功渲染
    if (requestId !== assetItemsRequestId || state.projectId !== requestProjectId) return false;
    if (cached) Object.assign(state, cached);
    else state.assetItems = [];
    renderQuickFolderTree();
    if (cached) el.assetAccordionCount.title = '列表刷新失败，当前保留已读取的未删素材';
    else el.assetAccordionCount.textContent = '读取失败';
    if (!quiet) showToast(`创作资产读取失败：${error.message}`);
    return false;
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
let platformBackdropSequence = -1;

function applyPlatformBackdrop(payload = {}) {
  if (!el.platformBackdrop || !el.platformBackdropLayer) return;
  const sequence = Number(payload.sequence);
  if (!Number.isFinite(sequence) || sequence < platformBackdropSequence) return;
  platformBackdropSequence = sequence;
  const validImage = image => typeof image === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(image);
  const region = payload.region;
  const frames = Array.isArray(payload.frames) && Number(region?.width) > 0 && Number(region?.height) > 0
    ? payload.frames.slice(0, 3).filter(frame => frame?.bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(frame.bounds[key])) && frame.bounds.width > 0 && frame.bounds.height > 0)
    : validImage(payload.image) ? [{ image: payload.image, bounds: { x: 0, y: 0, width: 1, height: 1 } }] : [];
  const width = Number(region?.width) > 0 ? region.width : 1;
  const height = Number(region?.height) > 0 ? region.height : 1;
  el.platformBackdropLayer.querySelectorAll('.platform-backdrop-secondary').forEach(pane => pane.remove());
  el.platformBackdropLayer.hidden = !frames.length;
  el.platformBackdropPrimary.hidden = !frames.length;
  el.platformBackdrop.hidden = true;
  el.platformBackdrop.removeAttribute('src');
  frames.forEach((frame, index) => {
    const pane = index ? document.createElement('div') : el.platformBackdropPrimary;
    const image = index ? document.createElement('img') : el.platformBackdrop;
    pane.className = `platform-backdrop-pane${index ? ' platform-backdrop-secondary' : ''}`;
    pane.dataset.pane = frame.pane || 'single';
    Object.assign(pane.style, { left: `${frame.bounds.x / width * 100}%`, top: `${frame.bounds.y / height * 100}%`,
      width: `${frame.bounds.width / width * 100}%`, height: `${frame.bounds.height / height * 100}%`, right: 'auto', bottom: 'auto' });
    image.className = 'platform-backdrop';
    image.alt = '';
    image.hidden = !validImage(frame.image);
    if (!image.hidden) image.src = frame.image;
    if (index) { pane.append(image); el.platformBackdropLayer.append(pane); }
  });
}

function syncCreatorDialogVisibility() {
  if (typeof API.setPlatformViewHidden === 'function') {
    // 仅模态会隐藏原生网页；非模态功能菜单不影响其可见性。
    API.setPlatformViewHidden(!!document.querySelector('dialog[open]')).catch(() => {});
  }
}

function openCreatorDialog(dialog) {
  if (!dialog.__overlayRestoreHooked) {
    dialog.__overlayRestoreHooked = true;
    dialog.addEventListener('close', syncCreatorDialogVisibility);
  }
  if (!dialog.__motionCloseCleanup) {
    dialog.__motionCloseCleanup = true;
    // 关闭完成后清掉动效类残留，避免下次打开时旧类再次命中退出动画选择器
    dialog.addEventListener('close', () => {
      dialog.classList.remove('motion-close', 'motion-open');
    });
  }
  // 动画关闭期间 dialog 仍 open（约180ms）：取消未完成的关闭排程并原地恢复，
  // 不能让"关了马上再开"表现为按钮点了没反应
  if (dialog.open) {
    dialog.__motionCloseCancel?.();
    return;
  }
  dialog.showModal();
  // 清掉上一次动画退出被打断时的残留；进入动画由 CSS 按 [open] 自动播放
  dialog.classList.remove('motion-close');
  syncCreatorDialogVisibility();
}

// —— 浮层／对话框动效工具：类名与兜底时长遵守动效类名契约 ——

// 给节点加动效类，animationend（须校验 target 与动画名：子元素动画会冒泡上来）
// 与兜底定时器先到先移除，另一方作废。
function playMotionClass(node, cls, fallbackMs, animationNames) {
  if (!node) return;
  let timer = 0;
  const finish = () => {
    node.removeEventListener('animationend', onAnimationEnd);
    if (timer) { clearTimeout(timer); timer = 0; }
    node.classList.remove(cls);
  };
  function onAnimationEnd(event) {
    if (event.target !== node || !animationNames.includes(event.animationName)) return;
    finish();
  }
  node.classList.add(cls);
  node.addEventListener('animationend', onAnimationEnd);
  timer = setTimeout(finish, fallbackMs);
}

// 取消尚未播完的浮层退出动画（定时器＋监听＋类），供重新打开前清场防闪动
function cancelPendingPopOut(node) {
  if (!node || (!node.__motionUnpopTimer && !node.__motionUnpopHandler)) return;
  if (node.__motionUnpopTimer) { clearTimeout(node.__motionUnpopTimer); node.__motionUnpopTimer = 0; }
  if (node.__motionUnpopHandler) { node.removeEventListener('animationend', node.__motionUnpopHandler); node.__motionUnpopHandler = null; }
  node.classList.remove('motion-unpop');
}

// 浮层退出：加 motion-unpop，motionPopOut 动画或兜底到点后移除类并执行 onHidden（真正落 hidden）。
// 已在退出中时直接返回，保证重复调用不重复播动画、不重复排程。
function playPopOut(node, onHidden, fallbackMs = 220) {
  if (!node || node.classList.contains('motion-unpop')) return;
  cancelPendingPopOut(node);
  node.classList.add('motion-unpop');
  const finish = () => {
    node.removeEventListener('animationend', node.__motionUnpopHandler);
    node.__motionUnpopHandler = null;
    node.__motionUnpopTimer = 0;
    node.classList.remove('motion-unpop');
    onHidden?.();
  };
  const handler = event => {
    if (event.target !== node || event.animationName !== 'motionPopOut') return;
    finish();
  };
  node.__motionUnpopHandler = handler;
  node.addEventListener('animationend', handler);
  node.__motionUnpopTimer = setTimeout(finish, fallbackMs);
}

// 对话框动画关闭：加 motion-close，表单（dialogSheetOut）或背板（backdropOut，
// ::backdrop 的 animationend 也派发到宿主元素）动画结束或 260ms 兜底后真正 close。
// instant 用于"关完立刻切走"的路径（如跳转完整资产库）：动画没有意义，直接关。
function closeCreatorDialog(dialog, { instant = false } = {}) {
  if (!dialog || !dialog.open || dialog.classList.contains('motion-close')) return;
  if (instant) {
    dialog.__motionCloseCancel?.();
    dialog.classList.remove('motion-close');
    dialog.close();
    return;
  }
  let timer = 0;
  const finish = () => {
    dialog.removeEventListener('animationend', onAnimationEnd);
    if (timer) { clearTimeout(timer); timer = 0; }
    dialog.__motionCloseCancel = null;
    dialog.classList.remove('motion-close');
    dialog.close();
  };
  function onAnimationEnd(event) {
    if (event.target !== dialog || !['dialogSheetOut', 'backdropOut'].includes(event.animationName)) return;
    finish();
  }
  // 重开路径（openCreatorDialog）用它取消未播完的退出，让对话框原地恢复
  dialog.__motionCloseCancel = () => {
    dialog.removeEventListener('animationend', onAnimationEnd);
    if (timer) { clearTimeout(timer); timer = 0; }
    dialog.__motionCloseCancel = null;
    dialog.classList.remove('motion-close');
  };
  dialog.classList.add('motion-close');
  dialog.addEventListener('animationend', onAnimationEnd);
  timer = setTimeout(finish, 260);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function downloadStateLabel(download) {
  if (download.pendingReview && download.state === 'paused') return download.error ? '归档待重试' : '等待分类归档';
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
    if (download.ingestState === 'error' || ['interrupted', 'cancelled'].includes(download.state)) return 0;
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
    const diagnostics = [download.error, download.ingestError].filter(Boolean);
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
  refreshBrowserDownloadCards();
  updateQuickCounts();
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
let quickVoiceEditor = null;

function openQuickPreview(item) {
  quickVoiceEditor?.destroy(); quickVoiceEditor = null;
  el.quickPreviewStage.querySelector('audio, video')?.pause();
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
    quickVoiceEditor = window.VoiceClipEditor?.mount({
      host: document.getElementById('quickVoiceClipHost'),
      actions: el.quickPreviewDialog.querySelector('.creator-dialog-foot'),
      item, video, getProjectId: () => state.projectId,
      exportAudio: typeof API.saveAudioAs === 'function' ? file => API.saveAudioAs(file) : undefined,
      onSaved: async () => { await loadAssetItems(); showToast('人物音频已保存到本剧'); },
    });
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

function closeQuickPreview({ instant = false } = {}) {
  quickVoiceEditor?.destroy(); quickVoiceEditor = null;
  el.quickPreviewStage.querySelector('audio, video')?.pause();
  closeCreatorDialog(el.quickPreviewDialog, { instant });
  el.quickPreviewStage.replaceChildren();
  quickPreviewItem = null;
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
  closeTabContextMenu();
  closeFindBar();
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
    captureTemplateCreateDraft();
    // 读取用户此刻的折叠选择，两个模式共享它，不因新模式有没有模板而重开。
    state.accordions.prompt = el.promptAccordion.open;
    state.accordions.scripts = el.scriptAccordion.open;
    state.accordions.assets = el.assetAccordion.open;
    state.mode = mode;
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
    renderSplitChrome();
  }
}

const SPLIT_GUTTER = 4;
const SPLIT_RATIO_MIN = 0.2;
const SPLIT_RATIO_MAX = 0.8;
const SPLIT_KEY_STEP = 0.05;

let splitDrag = null;
let splitRatioFrame = 0;
let splitRatioPending = null;
let splitRatioTicket = 0;
let splitRatioCommitted = 0.5;
let splitRatioRejected = false;
let splitApiMissingNotified = false;
let splitPickerSession = null;
let splitPickerRendered = '';
let splitPickerDismissReason = '';
let splitChoicePending = false;
let splitExitPending = false;

function clampSplitRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, number));
}

function normalizeSplit(split) {
  if (!split || typeof split !== 'object' || split.enabled !== true) {
    return { enabled: false, leftTabId: '', rightTabId: '', focusedPane: 'left', ratio: 0.5, gutter: SPLIT_GUTTER };
  }
  return {
    enabled: true,
    leftTabId: typeof split.leftTabId === 'string' ? split.leftTabId : '',
    rightTabId: typeof split.rightTabId === 'string' ? split.rightTabId : '',
    focusedPane: split.focusedPane === 'right' ? 'right' : 'left',
    ratio: clampSplitRatio(split.ratio),
    gutter: SPLIT_GUTTER,
  };
}

function isBrowserStatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Array.isArray(value.tabs)
    || typeof value.tabId === 'string'
    || typeof value.serviceId === 'string'
    || typeof value.mode === 'string'
    || (!!value.split && typeof value.split === 'object');
}

function splitApiMissing() {
  if (splitApiMissingNotified) return;
  splitApiMissingNotified = true;
  showToast('当前桌面版还没有双拼。请保存网页内容，按 ⌘Q 完全退出后重新打开新版；刷新网页不会更新桌面程序。');
}

function stageLayoutWidth() {
  const rect = el.browserStage?.getBoundingClientRect();
  return rect && Number.isFinite(rect.width) ? Math.max(0, rect.width) : 0;
}

// 与主进程 applyCreatorLayout 同一条推开宽度：只有 push 才扣资产库，overlay 不缩。
// 与原生 View 一样，先取整再分配；4px 分隔条必须完全填满，不能露出底层占位页。
function platformContentWidth(stageWidth) {
  const width = Math.max(0, Math.round(Number(stageWidth) || 0));
  const panel = state.assetPanel;
  if (!panel?.open || panel.layout !== 'push') return width;
  const minimumBrowserWidth = Math.min(420, Math.floor(width / 2));
  const panelWidth = Math.max(1, Math.min(Number(panel.width) || 0, width - minimumBrowserWidth));
  return Math.max(0, width - panelWidth);
}

function tabLabelFromList(tabs, tab) {
  if (!tab) return '';
  const mode = tab.mode || state.mode;
  const sameMode = (Array.isArray(tabs) ? tabs : []).filter(item => item && item.mode === mode && validServiceForMode(mode, item.serviceId));
  const indexed = tabsWithIndexes(sameMode).find(item => item.id === tab.id);
  const base = serviceLabel(serviceById(tab.serviceId), mode);
  if (tab.customName) return tab.customName;
  if (indexed && indexed.index > 1) return `${base}·${indexed.index}`;
  return base;
}

function labeledModeTabs() {
  return tabsWithIndexes(visibleTabs()).map(tab => ({ ...tab, displayLabel: tabLabelFromList(state.browser?.tabs, tab) }));
}

function tabLabelById(tabId) {
  if (!tabId) return '';
  const labeled = labeledModeTabs().find(tab => tab.id === tabId);
  if (labeled) return labeled.displayLabel;
  const tab = (state.browser?.tabs || []).find(item => item.id === tabId);
  return tab ? tabLabelFromList(state.browser?.tabs, tab) : '';
}

function tabStillPresent(tabId) {
  if (!tabId) return false;
  const tabs = state.browser?.tabs;
  if (!Array.isArray(tabs) || !tabs.length) return state.browser?.tabId === tabId;
  return tabs.some(tab => tab.id === tabId && (!tab.mode || tab.mode === state.mode));
}

function hasSplitSourcePage() {
  const browser = state.browser;
  if (!browser?.tabId) return false;
  return !!(browser.serviceId || browser.url || tabStillPresent(browser.tabId));
}

function focusedPanePresentation(browser, split) {
  if (!split?.enabled || !browser?.tabId) return {};
  const focusedId = split.focusedPane === 'right' ? split.rightTabId : split.leftTabId;
  if (!focusedId || browser.tabId === focusedId) return {};
  const otherId = split.focusedPane === 'right' ? split.leftTabId : split.rightTabId;
  if (browser.tabId !== otherId) return {};
  const tabs = Array.isArray(browser.tabs) ? browser.tabs : [];
  const tab = tabs.find(item => item.id === focusedId);
  if (!tab) return {};
  return {
    serviceId: tab.serviceId,
    displayLabel: tabLabelFromList(tabs, tab),
    url: tab.url || '',
  };
}

function ratioFromClientX(clientX) {
  const rect = el.browserStage.getBoundingClientRect();
  const content = Math.max(1, platformContentWidth(rect.width) - SPLIT_GUTTER);
  return clampSplitRatio((clientX - rect.left) / content);
}

function positionSplitGutter() {
  const gutter = el.splitGutter;
  if (!gutter) return;
  const split = normalizeSplit(state.browser?.split);
  el.browserStage.classList.toggle('is-split', split.enabled);
  if (!split.enabled) {
    gutter.hidden = true;
    return;
  }
  const rect = el.browserStage.getBoundingClientRect();
  const content = Math.max(0, platformContentWidth(rect.width) - SPLIT_GUTTER);
  const percent = Math.round(split.ratio * 100);
  gutter.hidden = false;
  gutter.style.left = `${Math.round(rect.left) - rect.left + Math.round(content * split.ratio)}px`;
  gutter.style.top = `${Math.round(rect.top) - rect.top}px`;
  gutter.style.height = `${Math.round(rect.height)}px`;
  gutter.style.width = `${SPLIT_GUTTER}px`;
  gutter.setAttribute('aria-valuenow', String(percent));
  gutter.setAttribute('aria-valuetext', `左侧 ${percent}%`);
}

function previewSplitRatio(ratio) {
  const next = clampSplitRatio(ratio);
  if (!state.browser?.split?.enabled) return;
  state.browser.split.ratio = next;
  if (splitDrag) splitDrag.ratio = next;
  positionSplitGutter();
  splitRatioPending = next;
  if (splitRatioFrame || splitRatioRejected) return;
  splitRatioFrame = requestAnimationFrame(() => {
    splitRatioFrame = 0;
    const pending = splitRatioPending;
    splitRatioPending = null;
    if (pending == null || splitRatioRejected) return;
    void pushSplitRatio(pending, { apply: !splitDrag });
  });
}

function flushSplitRatio() {
  if (splitRatioFrame) {
    cancelAnimationFrame(splitRatioFrame);
    splitRatioFrame = 0;
  }
  const pending = splitRatioPending;
  splitRatioPending = null;
  if (pending == null || splitRatioRejected) return;
  void pushSplitRatio(pending, { apply: true });
}

async function pushSplitRatio(ratio, { apply = true } = {}) {
  const requested = clampSplitRatio(ratio);
  if (!normalizeSplit(state.browser?.split).enabled) return;
  if (typeof API?.setSplitRatio !== 'function') {
    splitApiMissing();
    splitRatioRejected = true;
    return;
  }
  const ticket = ++splitRatioTicket;
  try {
    const browser = await API.setSplitRatio(requested);
    if (ticket !== splitRatioTicket) return;
    if (!isBrowserStatePayload(browser) || !normalizeSplit(browser.split).enabled) {
      splitRatioRejected = true;
      if (state.browser?.split?.enabled) {
        state.browser.split.ratio = splitRatioCommitted;
        positionSplitGutter();
      }
      showToast('双拼比例没有生效，请确认桌面程序已更新到新版');
      return;
    }
    splitRatioCommitted = normalizeSplit(browser.split).ratio;
    splitRatioRejected = false;
    if (apply) applyBrowserState(browser);
  } catch (error) {
    if (ticket !== splitRatioTicket) return;
    splitRatioRejected = true;
    if (state.browser?.split?.enabled) {
      state.browser.split.ratio = splitRatioCommitted;
      positionSplitGutter();
    }
    showToast(error.message || '调整双拼宽度失败');
  }
}

function renderSplitChrome() {
  const toggle = el.splitViewToggle;
  if (!toggle || !el.splitBar || !el.splitGutter) return;
  const split = normalizeSplit(state.browser?.split);
  const enabled = split.enabled;
  const available = hasSplitSourcePage();
  const barChanged = el.splitBar.hidden !== !enabled;
  toggle.disabled = !!state.modeSwitchPending || (!enabled && !available);
  toggle.setAttribute('aria-pressed', String(enabled));
  if (state.modeSwitchPending) {
    toggle.title = '正在切换创作模式';
    toggle.setAttribute('aria-label', '双拼，正在切换创作模式');
  } else if (enabled) {
    toggle.title = '退出双拼，回到单页';
    toggle.setAttribute('aria-label', '双拼，已开启，再按一次回到单页');
  } else if (!available) {
    toggle.title = '先打开一个网页，才能左右双拼';
    toggle.setAttribute('aria-label', '双拼，先打开一个网页');
  } else {
    toggle.title = '双拼：选择另一个网页，左右并排';
    toggle.setAttribute('aria-label', '双拼，选择另一个网页左右并排');
  }
  el.splitBar.hidden = !enabled;
  if (enabled && el.splitFocusLeft && el.splitFocusRight) {
    const left = tabLabelById(split.leftTabId) || '左侧网页';
    const right = tabLabelById(split.rightTabId) || '右侧网页';
    el.splitFocusLeft.textContent = left;
    el.splitFocusRight.textContent = right;
    el.splitFocusLeft.title = `聚焦左侧：${left}`;
    el.splitFocusRight.title = `聚焦右侧：${right}`;
    el.splitFocusLeft.setAttribute('aria-label', `聚焦左侧网页 ${left}`);
    el.splitFocusRight.setAttribute('aria-label', `聚焦右侧网页 ${right}`);
    el.splitFocusLeft.setAttribute('aria-pressed', String(split.focusedPane !== 'right'));
    el.splitFocusRight.setAttribute('aria-pressed', String(split.focusedPane === 'right'));
  }
  positionSplitGutter();
  syncSplitPicker();
  if (barChanged) queueBoundsUpdate();
}

function splitPickerContextAlive(session) {
  if (!session) return false;
  if (session.mode !== state.mode || session.projectId !== state.projectId) return false;
  if (!tabStillPresent(session.primaryTabId)) return false;
  const currentId = state.browser?.tabId;
  if (currentId && currentId !== session.primaryTabId) {
    const split = normalizeSplit(state.browser?.split);
    const focusedId = split.focusedPane === 'right' ? split.rightTabId : split.leftTabId;
    const otherId = split.focusedPane === 'right' ? split.leftTabId : split.rightTabId;
    const laggingOtherPane = split.enabled && focusedId === session.primaryTabId && currentId === otherId;
    if (!laggingOtherPane) return false;
  }
  return true;
}

function splitPickerSignature(session) {
  const tabs = labeledModeTabs().map(tab => `${tab.id}:${tab.displayLabel}`).join('|');
  const services = (state.config?.modeServices?.[state.mode] || []).join('|');
  const otherId = normalizeSplit(state.browser?.split).rightTabId;
  return `${session?.primaryTabId || ''}|${otherId}|${tabs}|${services}`;
}

function splitChoiceButton(name, meta, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'split-picker-choice';
  const label = document.createElement('span');
  label.className = 'split-picker-name';
  label.textContent = name;
  const aside = document.createElement('span');
  aside.className = 'split-picker-meta';
  aside.textContent = meta;
  button.append(label, aside);
  button.addEventListener('click', onClick);
  return button;
}

function renderSplitPickerList({ focus = false } = {}) {
  const body = el.splitPickerBody;
  const session = splitPickerSession;
  if (!body || !session) return;
  body.replaceChildren();
  const primary = labeledModeTabs().find(tab => tab.id === session.primaryTabId)
    || (state.browser?.tabs || []).find(tab => tab.id === session.primaryTabId);
  const primaryLabel = primary ? (primary.displayLabel || tabLabelFromList(state.browser?.tabs, primary)) : '';
  if (el.splitPickerHint) {
    el.splitPickerHint.textContent = primaryLabel
      ? `当前网页是「${primaryLabel}」。选另一侧要并排的网页，文字和图片可以左右拖。`
      : '选另一侧要并排的网页。';
  }
  const tabsHeading = document.createElement('h3');
  tabsHeading.className = 'split-picker-label';
  tabsHeading.textContent = '已打开的网页';
  body.appendChild(tabsHeading);
  const others = labeledModeTabs().filter(tab => tab.id !== session.primaryTabId);
  const split = normalizeSplit(state.browser?.split);
  const pairedId = split.enabled
    ? (session.primaryTabId === split.leftTabId ? split.rightTabId : split.leftTabId)
    : '';
  if (!others.length) {
    const empty = document.createElement('p');
    empty.className = 'split-picker-empty';
    empty.textContent = '当前模式没有其他已打开的网页。';
    body.appendChild(empty);
  } else {
    for (const tab of others) {
      const meta = tab.id === pairedId ? '当前另一侧' : '已打开';
      body.appendChild(splitChoiceButton(tab.displayLabel, meta, () => confirmSplitChoice({ tabId: tab.id })));
    }
  }
  const serviceHeading = document.createElement('h3');
  serviceHeading.className = 'split-picker-label';
  serviceHeading.textContent = '新开网站';
  body.appendChild(serviceHeading);
  const serviceIds = state.config?.modeServices?.[state.mode] || [];
  const services = serviceIds.map(serviceId => serviceById(serviceId)).filter(Boolean);
  if (!services.length) {
    const empty = document.createElement('p');
    empty.className = 'split-picker-empty';
    empty.textContent = '没有可新开的已配置网站。';
    body.appendChild(empty);
  } else {
    for (const service of services) {
      body.appendChild(splitChoiceButton(serviceLabel(service), '新开', () => confirmSplitChoice({ serviceId: service.id })));
    }
  }
  splitPickerRendered = splitPickerSignature(session);
  if (focus) requestAnimationFrame(() => body.querySelector('button')?.focus());
}

function syncSplitPicker() {
  const dialog = el.splitPickerDialog;
  if (!dialog?.open || !splitPickerSession) return;
  if (!splitPickerContextAlive(splitPickerSession)) {
    splitPickerDismissReason = 'stale';
    closeCreatorDialog(dialog, { instant: true });
    return;
  }
  if (splitPickerSignature(splitPickerSession) === splitPickerRendered) return;
  renderSplitPickerList();
}

function openSplitPicker() {
  if (state.modeSwitchPending || splitChoicePending) return;
  const primaryTabId = state.browser?.tabId || '';
  if (!primaryTabId || !hasSplitSourcePage()) {
    showToast('先打开一个网页，再使用双拼');
    return;
  }
  splitPickerSession = { mode: state.mode, projectId: state.projectId, primaryTabId };
  splitPickerRendered = '';
  renderSplitPickerList({ focus: true });
  openCreatorDialog(el.splitPickerDialog);
}

async function cancelSplitAfterStale(browser) {
  if (normalizeSplit(browser?.split).enabled && typeof API?.closeSplitView === 'function') {
    try {
      const closed = await API.closeSplitView();
      if (isBrowserStatePayload(closed)) {
        applyBrowserState(closed);
        showToast('页面已切换，已取消双拼');
        return;
      }
    } catch {}
  }
  if (isBrowserStatePayload(browser)) applyBrowserState(browser);
  showToast('页面已切换，未开启双拼');
}

async function confirmSplitChoice(choice) {
  const session = splitPickerSession;
  if (!session || splitChoicePending) return;
  if (!splitPickerContextAlive(session)) {
    splitPickerDismissReason = 'stale';
    closeCreatorDialog(el.splitPickerDialog, { instant: true });
    return;
  }
  if (choice.tabId) {
    if (choice.tabId === session.primaryTabId) return;
    if (!tabStillPresent(choice.tabId)) {
      showToast('这个网页已经关闭，请重新选择');
      splitPickerRendered = '';
      renderSplitPickerList();
      return;
    }
  } else if (!choice.serviceId || !validServiceForMode(session.mode, choice.serviceId)) {
    showToast('这个网站已不在当前模式，请重新选择');
    splitPickerRendered = '';
    renderSplitPickerList();
    return;
  }
  const tabsBefore = new Set((state.browser?.tabs || []).map(tab => tab.id));
  const tabIdBefore = state.browser?.tabId || '';
  splitChoicePending = true;
  splitPickerDismissReason = 'chosen';
  closeCreatorDialog(el.splitPickerDialog, { instant: true });
  try {
    if (session.mode !== state.mode || session.projectId !== state.projectId || !tabStillPresent(session.primaryTabId)) {
      showToast('页面已切换，未开启双拼');
      return;
    }
    if (typeof API?.setSplitView !== 'function') {
      splitApiMissing();
      return;
    }
    const payload = choice.tabId
      ? { enabled: true, primaryTabId: session.primaryTabId, secondaryTabId: choice.tabId }
      : { enabled: true, primaryTabId: session.primaryTabId, serviceId: choice.serviceId };
    const browser = await API.setSplitView(payload);
    const switchedAway = session.mode !== state.mode
      || session.projectId !== state.projectId
      || !tabStillPresent(session.primaryTabId);
    const currentId = state.browser?.tabId || '';
    const currentTab = (state.browser?.tabs || []).find(tab => tab.id === currentId);
    const openedService = !!choice.serviceId && currentTab?.serviceId === choice.serviceId;
    const movedToExistingThirdPage = !!currentId
      && currentId !== tabIdBefore
      && currentId !== session.primaryTabId
      && currentId !== choice.tabId
      && tabsBefore.has(currentId)
      && !openedService;
    if (switchedAway || movedToExistingThirdPage) {
      await cancelSplitAfterStale(browser);
      return;
    }
    if (!isBrowserStatePayload(browser) || !normalizeSplit(browser.split).enabled) {
      showToast('双拼没有生效，请确认桌面程序已更新到新版');
      if (isBrowserStatePayload(browser)) applyBrowserState(browser);
      return;
    }
    applyBrowserState(browser);
    queueBoundsUpdate();
  } catch (error) {
    showToast(error.message || '开启双拼失败');
  } finally {
    splitChoicePending = false;
  }
}

async function focusSplitPane(pane) {
  if (pane !== 'left' && pane !== 'right') return;
  const split = normalizeSplit(state.browser?.split);
  if (!split.enabled || splitFocusPending()) return;
  if (!(pane === 'right' ? split.rightTabId : split.leftTabId)) {
    showToast('这一侧没有网页');
    return;
  }
  if (typeof API?.focusSplitPane !== 'function') {
    splitApiMissing();
    return;
  }
  focusSplitPane.pending = true;
  try {
    const browser = await API.focusSplitPane(pane);
    if (!isBrowserStatePayload(browser) || !normalizeSplit(browser.split).enabled || normalizeSplit(browser.split).focusedPane !== pane) {
      showToast('切换双拼焦点没有生效，请确认桌面程序已更新到新版');
      if (isBrowserStatePayload(browser)) applyBrowserState(browser);
      return;
    }
    applyBrowserState(browser);
  } catch (error) {
    showToast(error.message || '切换双拼页面失败');
  } finally {
    focusSplitPane.pending = false;
  }
}

function splitFocusPending() {
  return focusSplitPane.pending === true;
}

async function exitSplitView() {
  if (!normalizeSplit(state.browser?.split).enabled || splitExitPending) return;
  if (typeof API?.closeSplitView !== 'function') {
    splitApiMissing();
    return;
  }
  splitExitPending = true;
  try {
    const browser = await API.closeSplitView();
    if (!isBrowserStatePayload(browser)) {
      showToast('退出双拼没有生效，请确认桌面程序已更新到新版');
      return;
    }
    if (normalizeSplit(browser.split).enabled) {
      showToast('退出双拼没有生效，请确认桌面程序已更新到新版');
      applyBrowserState(browser);
      return;
    }
    applyBrowserState(browser);
    queueBoundsUpdate();
    showToast('已回到单页，两边的网页标签都还在');
  } catch (error) {
    showToast(error.message || '退出双拼失败');
  } finally {
    splitExitPending = false;
  }
}

function onSplitToggleClick() {
  if (!el.splitViewToggle || el.splitViewToggle.disabled || splitChoicePending) return;
  if (normalizeSplit(state.browser?.split).enabled) {
    void exitSplitView();
    return;
  }
  openSplitPicker();
}

function bindSplitGutter() {
  const gutter = el.splitGutter;
  if (!gutter || gutter.dataset.bound === '1') return;
  gutter.dataset.bound = '1';
  const endDrag = (event, commit) => {
    if (!splitDrag || event.pointerId !== splitDrag.pointerId) return;
    const ratio = commit ? ratioFromClientX(event.clientX) : splitDrag.ratio;
    splitDrag = null;
    gutter.classList.remove('is-dragging');
    try { gutter.releasePointerCapture(event.pointerId); } catch {}
    previewSplitRatio(ratio);
    flushSplitRatio();
  };
  gutter.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !normalizeSplit(state.browser?.split).enabled) return;
    event.preventDefault();
    splitRatioRejected = false;
    splitDrag = { pointerId: event.pointerId, ratio: normalizeSplit(state.browser.split).ratio };
    gutter.classList.add('is-dragging');
    gutter.setPointerCapture(event.pointerId);
    gutter.focus();
  });
  gutter.addEventListener('pointermove', event => {
    if (!splitDrag || event.pointerId !== splitDrag.pointerId) return;
    event.preventDefault();
    previewSplitRatio(ratioFromClientX(event.clientX));
  });
  gutter.addEventListener('pointerup', event => endDrag(event, true));
  gutter.addEventListener('pointercancel', event => endDrag(event, false));
  gutter.addEventListener('lostpointercapture', event => endDrag(event, false));
  gutter.addEventListener('dblclick', event => {
    if (!normalizeSplit(state.browser?.split).enabled) return;
    event.preventDefault();
    splitRatioRejected = false;
    previewSplitRatio(0.5);
    flushSplitRatio();
  });
  gutter.addEventListener('keydown', event => {
    if (!normalizeSplit(state.browser?.split).enabled) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    splitRatioRejected = false;
    const current = normalizeSplit(state.browser.split).ratio;
    previewSplitRatio(current + (event.key === 'ArrowLeft' ? -SPLIT_KEY_STEP : SPLIT_KEY_STEP));
  });
}

function bindSplitControls() {
  if (!el.splitViewToggle || el.splitViewToggle.dataset.bound === '1') return;
  el.splitViewToggle.dataset.bound = '1';
  el.splitViewToggle.addEventListener('click', onSplitToggleClick);
  el.splitFocusLeft?.addEventListener('click', () => { void focusSplitPane('left'); });
  el.splitFocusRight?.addEventListener('click', () => { void focusSplitPane('right'); });
  el.splitReplace?.addEventListener('click', openSplitPicker);
  el.splitClose?.addEventListener('click', () => { void exitSplitView(); });
  bindSplitGutter();
  const dialog = el.splitPickerDialog;
  if (!dialog) return;
  el.splitPickerClose?.addEventListener('click', () => closeCreatorDialog(dialog));
  dialog.addEventListener('click', event => {
    if (event.target === dialog) closeCreatorDialog(dialog);
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeCreatorDialog(dialog);
  });
  dialog.addEventListener('close', () => {
    const reason = splitPickerDismissReason;
    splitPickerDismissReason = '';
    splitPickerSession = null;
    splitPickerRendered = '';
    if (reason === 'stale') showToast('页面已切换，已关闭双拼选择');
  });
}

let browserChromeSignature = '';

function applyBrowserState(browser) {
  if (!browser) return;
  if (browser.mode && browser.mode !== state.mode) return;
  const split = normalizeSplit(browser.split);
  // Resizing changes geometry, not tab contents. Avoid replacing the entire
  // tab strip on every pointer frame (and keep any focused controls intact).
  const { split: ignoredSplit, ...chrome } = browser;
  const signature = JSON.stringify(chrome);
  const previousSplit = state.browser?.split;
  const ratioOnly = signature === browserChromeSignature && split.enabled && previousSplit?.enabled
    && split.leftTabId === previousSplit.leftTabId && split.rightTabId === previousSplit.rightTabId
    && split.focusedPane === previousSplit.focusedPane;
  browserChromeSignature = signature;
  state.browser = {
    ...state.browser,
    ...browser,
    tabs: Array.isArray(browser.tabs) ? browser.tabs : (state.browser?.tabs || []),
    split,
  };
  if (splitDrag && state.browser.split.enabled) state.browser.split.ratio = clampSplitRatio(splitDrag.ratio);
  else if (split.enabled) splitRatioCommitted = state.browser.split.ratio;
  if (ratioOnly) { positionSplitGutter(); return; }
  if (Object.hasOwn(browser, 'serviceId')) {
    state.activeService = browser.serviceId;
    if (validServiceForMode(state.mode, browser.serviceId)) state.services[state.mode] = browser.serviceId;
  }
  const focusedView = focusedPanePresentation(browser, split);
  const followsFocusedPane = Object.hasOwn(focusedView, 'url');
  const shownService = serviceById(followsFocusedPane ? focusedView.serviceId : browser.serviceId);
  const shownUrl = followsFocusedPane ? (focusedView.url || shownService?.url || '') : (browser.url || shownService?.url || '');
  const empty = !browser.tabId && !browser.serviceId;
  el.addressService.textContent = empty ? '网页' : (focusedView.displayLabel || browser.displayLabel || serviceLabel(shownService));
  if (document.activeElement !== el.addressInput) {
    el.addressInput.value = shownUrl;
  }
  el.addressInput.title = followsFocusedPane ? (focusedView.url || '') : (browser.url || '');
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
  renderSplitChrome();
  if (browser.error) showToast(browser.error);
}

async function selectTab(tabId) {
  if (state.modeSwitchPending) return;
  if (!tabId) return;
  closeTabContextMenu();
  closeFindBar();
  try {
    if (tabId === state.browser?.tabId) {
      await API.focusBrowser();
      scrollActiveTabIntoView();
      return;
    }
    const browser = await API.selectTab(tabId);
    if (browser) applyBrowserState(browser);
    scrollActiveTabIntoView();
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
    if (browser?.clearCancelled) return;
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

async function openAddressInNewTab() {
  const address = el.addressInput.value.trim();
  if (!address) {
    el.addressInput.setAttribute('aria-invalid', 'true');
    showToast('请输入网址');
    return;
  }
  if (!state.activeService) {
    await navigateToAddress();
    return;
  }
  try {
    // 复制当前平台再导航：新标签沿用同一登录分区，原网页保持不动
    await API.openTab(state.activeService, state.mode);
    await navigateToAddress();
  } catch (error) {
    showToast(error.message || '新标签打开失败');
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
  if (quickAssetDeletionBusy()) { showToast('正在删除素材，请稍后导入'); return; }
  const projectId = state.projectId, epoch = quickProjectViewEpoch;
  const currentView = () => projectId === state.projectId && epoch === quickProjectViewEpoch;
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
  const readBefore = assetItemsRequestId;
  quickAssetMutationDepth++;
  clearTimeout(quickAssetReloadTimer);
  showToast(`正在导入 ${paths.length + urls.length} 项素材…`);
  try {
    const result = await API.importDroppedAssets({ paths, urls, naming: 'sequential', projectId });
    if (!currentView()) return;
    const imported = Number(result?.imported) || 0;
    const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
    await loadAssetItems();
    if (!currentView()) return;
    if (failed) showToast(`已拖入 ${imported} 项，${failed} 项未能导入`);
    else showToast(`已拖入 ${imported} 项创作资产`);
  } catch (error) {
    if (currentView()) showToast(`拖拽导入失败：${error.message}`);
  } finally {
    quickAssetMutationDepth--;
    finishQuickDeletionReload({ projectId, epoch }, currentView() && assetItemsRequestId > readBefore);
    if (currentView()) {
      el.assetDropZone.classList.remove('is-importing');
      el.assetDropZone.setAttribute('aria-busy', 'false');
    }
  }
}

function queueBoundsUpdate() {
  cancelAnimationFrame(boundsFrame);
  boundsFrame = requestAnimationFrame(() => {
    positionSplitGutter();
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
  positionSplitGutter();
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
  el.quickCancelMove.addEventListener('click', () => closeCreatorDialog(el.quickMoveDialog));
  el.quickCancelMoveTop.addEventListener('click', () => closeCreatorDialog(el.quickMoveDialog));
  el.quickMoveDialog.addEventListener('click', event => { if (event.target === el.quickMoveDialog) closeCreatorDialog(el.quickMoveDialog); });
  el.quickMoveDialog.addEventListener('cancel', event => { event.preventDefault(); closeCreatorDialog(el.quickMoveDialog); });
  // 统一跟踪预览、改名等所有对话框；关闭一个时，不能盖住另一个仍打开的对话框。
  const dialogObserver = new MutationObserver(syncCreatorDialogVisibility);
  document.querySelectorAll('dialog').forEach(dialog => {
    dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  });
  syncCreatorDialogVisibility();
  bindSplitControls();
  document.querySelectorAll('.mode-button').forEach(button => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });
  // 三个模态对话框的 Esc（cancel）改走动画关闭：拦下原生立即 close，播完退出动画再关
  [el.renameDialog, el.clearPromptDialog].forEach(dialog => {
    if (!dialog || dialog.__motionCancelWired) return;
    dialog.__motionCancelWired = true;
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeCreatorDialog(dialog);
    });
  });
  if (el.quickPreviewDialog && !el.quickPreviewDialog.__motionCancelWired) {
    el.quickPreviewDialog.__motionCancelWired = true;
    // Esc 与该对话框其余关闭路径同走 closeQuickPreview：顺带停掉预览媒体
    el.quickPreviewDialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeQuickPreview();
    });
  }
  // 开关按钮（框选、创作资产等）统一按压回弹：委托监听，动画结束由 playMotionClass 自摘
  document.addEventListener('click', event => {
    const button = event.target.closest('button[aria-pressed]');
    if (button && !button.disabled) playMotionClass(button, 'motion-tick', 400, ['motionTick']);
  });
  el.addPlatform.addEventListener('click', () => {
    closeProjectMenu();
    // 退出动画进行中（hidden 未落地）按"关"处理，否则快速关-开会吞掉重开
    const opening = el.platformPopover.classList.contains('hidden')
      || el.platformPopover.classList.contains('motion-unpop');
    if (opening) {
      // 上一场退出动画还没播完就重开：先取消退出排程，再进入弹入动画
      cancelPendingPopOut(el.platformPopover);
      el.platformPopover.classList.remove('hidden');
      playMotionClass(el.platformPopover, 'motion-pop', 400, ['motionPopIn']);
      requestAnimationFrame(() => el.platformName.focus());
    } else {
      closePlatformPopover();
    }
    el.addPlatform.setAttribute('aria-expanded', String(opening));
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
  // 「全部网页」弹层：约定 ID 缺失（creator.html 未就位）时内部自动停用
  wireAllTabs();
  // 标签条滚轮横向滚动：鼠标滚轮纵向增量转成横向滚动（触屏横向平移与 shift+滚轮走原生 deltaX，不受影响），
  // 解决网页标签超过一屏后，鼠标用户无法移动到右侧标签的问题。
  el.platformTabs.addEventListener('wheel', event => {
    if (event.deltaY === 0) return;
    if (el.platformTabs.scrollWidth <= el.platformTabs.clientWidth) return;
    event.preventDefault();
    el.platformTabs.scrollLeft += event.deltaY;
  }, { passive: false });
  // —— 指针拖拽的全局接管 ——
  // move：未超阈值前只记录位置；超过阈值激活拖拽（拖影+压暗+自动横滚）并实时更新放置计划；
  // up：激活过＝提交重排并抑制紧随其后的 click（防止拖完误切标签），没激活＝普通点击放行。
  window.addEventListener('pointermove', event => {
    if (!tabDrag) return;
    tabDrag.lastX = event.clientX;
    tabDrag.lastY = event.clientY;
    if (!tabDrag.active) {
      if (Math.hypot(event.clientX - tabDrag.startX, event.clientY - tabDrag.startY) < TAB_DRAG_THRESHOLD) return;
      if (typeof API?.reorderTabs !== 'function') {
        tabDrag = null;
        showToast('桌面程序版本过旧：请 ⌘Q 完全退出后重新打开，再使用拖动排序');
        return;
      }
      activateTabDrag();
    }
    moveTabDragGhost(event.clientX, event.clientY);
    updateTabDragPlan(event.clientX, event.clientY);
  });
  window.addEventListener('pointerup', event => {
    if (!tabDrag || event.pointerId !== tabDrag.pointerId) return;
    if (tabDrag.active) {
      endTabDrag({ commit: true });
      tabClickSuppressed = true;
    } else {
      // 未达阈值＝点击意图。激活必须放在 pointerup：标签栏重渲染（SSE 状态推送、
      // 拖拽提交后的异步刷新）若恰好落在按下与抬起之间，按下节点被替换，click
      // 事件会整个丢失，表现为点了标签却没切换。置抑制标志吞掉紧随的 click，
      // 避免按钮监听再触发一次 selectTab。
      const sourceId = tabDrag.sourceId;
      tabDrag = null;
      tabClickSuppressed = true;
      selectTab(sourceId);
    }
  });
  window.addEventListener('pointercancel', event => {
    if (tabDrag && event.pointerId === tabDrag.pointerId) endTabDrag({ commit: false });
  });
  // 分类手柄拖拽排序：window 级接管移动/松手/取消，与标签拖拽同一套接线习惯；
  // 只响应发起拖拽的那颗指针，第二触点／触控板光标不会干扰排序
  window.addEventListener('pointermove', event => {
    if (!folderGripDrag || event.pointerId !== folderGripDrag.pointerId) return;
    folderGripDrag.lastX = event.clientX;
    folderGripDrag.lastY = event.clientY;
    if (!folderGripDrag.active) {
      if (Math.hypot(event.clientX - folderGripDrag.startX, event.clientY - folderGripDrag.startY) < QUICK_FOLDER_DRAG_THRESHOLD) return;
      activateQuickFolderDrag();
    }
    event.preventDefault();
    updateQuickFolderDropPlan(event.clientY);
  });
  window.addEventListener('pointerup', event => {
    if (!folderGripDrag || event.pointerId !== folderGripDrag.pointerId) return;
    folderGripDrag.lastX = event.clientX;
    folderGripDrag.lastY = event.clientY;
    if (folderGripDrag.active) updateQuickFolderDropPlan(event.clientY);
    endQuickFolderGripDrag({ commit: folderGripDrag.active });
  });
  window.addEventListener('pointercancel', event => {
    if (folderGripDrag && event.pointerId === folderGripDrag.pointerId) endQuickFolderGripDrag({ commit: false });
  });
  window.addEventListener('keydown', event => {
    if (folderGripDrag?.active && event.key === 'Escape') {
      event.preventDefault();
      endQuickFolderGripDrag({ commit: false });
    }
  });
  // 拖拽激活后的第一颗 click 必须吞掉：拖完松手落点还在标签上，否则会误切走。
  // 每次新的 pointerdown 都重置抑制标志：若上一轮松手没产生 click（如丢到窗口外），
  // 标志不会误吞下一轮的真实点击。
  window.addEventListener('pointerdown', () => { tabClickSuppressed = false; }, true);
  el.platformTabs.addEventListener('click', event => {
    if (!tabClickSuppressed) return;
    tabClickSuppressed = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);
  el.platformForm.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closePlatformPopover();
    el.addPlatform.focus();
    queueBoundsUpdate();
  });
  // 固定提示词：支持不经过编辑器直接新建（内容完全由你自己填写，系统不提供任何预设）。
  el.templateCreate.addEventListener('click', () => {
    const opening = el.templateCreateForm.hidden;
    setTemplateCreateFormOpen(opening);
    saveWorkspace(true);
    if (opening) requestAnimationFrame(() => el.templateCreateName.focus());
  });
  el.cancelTemplateCreate.addEventListener('click', () => {
    setTemplateCreateFormOpen(false);
    el.templateCreateName.value = '';
    el.templateCreateBody.value = '';
    saveWorkspace(true);
  });
  el.templateCreateName.addEventListener('input', () => saveWorkspace());
  el.templateCreateBody.addEventListener('input', () => saveWorkspace());
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
    expandedTemplates.add(state.promptTemplates[state.mode][0].id);
    activeTemplateIds[state.mode] = state.promptTemplates[state.mode][0].id;
    setTemplateCreateFormOpen(false);
    el.templateCreateName.value = '';
    el.templateCreateBody.value = '';
    state.accordions.prompt = true;
    saveWorkspace(true);
    renderPromptTemplates();
    showToast(`已保存到当前剧本：「${title}」`);
  });
  el.promptAccordion.addEventListener('toggle', () => {
    state.accordions.prompt = el.promptAccordion.open;
    saveWorkspace();
    queueBoundsUpdate();
  });
  el.scriptAccordion.addEventListener('toggle', () => {
    state.accordions.scripts = el.scriptAccordion.open;
    saveWorkspace();
    queueBoundsUpdate();
  });
  el.addScriptGroup.addEventListener('click', addScriptGroup);
  wireScriptImportDrop();
  el.assetAccordion.addEventListener('toggle', () => {
    state.accordions.assets = el.assetAccordion.open;
    saveWorkspace();
    renderQuickFolderTree();
    queueBoundsUpdate();
  });
  el.openModeFolder.addEventListener('click', () => API.openFolder(state.mode).catch(error => showToast(error.message)));
  el.toggleAssets.addEventListener('click', toggleAssetPanel);
  el.renameForm.addEventListener('submit', saveRenamedItem);
  el.renameCancel.addEventListener('click', () => closeCreatorDialog(el.renameDialog));
  el.importLocalAssets.addEventListener('click', () => {
    el.quickFileInput.click();
  });
  el.quickFileInput.addEventListener('change', () => {
    const files = [...el.quickFileInput.files];
    el.quickFileInput.value = '';
    if (!files.length) return;
    const target = state.quickAssetFolder || '';
    importLocalFilesToFolder(files, target, { naming: 'original' });
  });
  el.openAssetLibrary.addEventListener('click', openFullAssetLibrary);
  // 右键浮出提示：仅在桌面程序具备浮出能力时注入，常驻工具行尾部，不占卡片空间。
  if (typeof API.floatVideoAsset === 'function') {
    const floatHint = document.createElement('span');
    floatHint.className = 'quick-float-hint';
    floatHint.textContent = '右键视频卡浮出小窗';
    document.querySelector('.asset-quick-actions')?.appendChild(floatHint);
  }
  el.quickMultiSelect.addEventListener('click', () => setQuickSelectMode(!state.quickSelectMode));
  el.quickSelAll.addEventListener('click', selectAllQuickAssets);
  el.quickSelClear.addEventListener('click', () => {
    if (quickAssetDeletionBusy()) return;
    state.quickSelectionOrder.length = 0;
    updateQuickSelectionUI();
  });
  el.quickSelDelete.addEventListener('click', () => deleteQuickSelectedAssets());
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
  el.currentProject.addEventListener('contextmenu', event => migrateProjectTemplates(state.config.project, event));
  el.currentProject.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      migrateProjectTemplates(state.config.project, event); return;
    }
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    openProjectMenu();
  });
  el.projectMenuManage.addEventListener('click', () => {
    closeProjectMenu();
    API.showProjectPicker(state.mode).catch(error => showToast(error.message));
  });
  document.addEventListener('pointerdown', event => {
    if (projectMenuOpen && !event.target.closest('#projectPopover, #currentProject')) closeProjectMenu();
  });
  el.projectPopover.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeProjectMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...el.projectPopover.querySelectorAll('button:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  });
  document.addEventListener('keydown', event => {
    if (projectMenuOpen && event.key === 'Escape') { event.preventDefault(); closeProjectMenu(true); }
  });
  window.addEventListener('resize', () => { if (projectMenuOpen) closeProjectMenu(); });
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
    // Alt+Enter（对标浏览器）：地址在新标签打开，不再覆盖当前网页
    if (event.key === 'Enter' && event.altKey) {
      event.preventDefault();
      openAddressInNewTab();
      return;
    }
    if (event.key !== 'Escape') return;
    const service = serviceById(state.activeService);
    el.addressInput.value = state.browser?.url || service?.url || '';
    el.addressInput.setAttribute('aria-invalid', 'false');
    el.addressInput.blur();
  });
  el.togglePrompt.addEventListener('click', toggleMaterialSidebar);
  el.collapseMaterialSidebar.addEventListener('click', toggleMaterialSidebar);
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
    // 跳转完整资产库时立即关闭预览：随后的浮层切换不等这 180ms 淡出
    closeQuickPreview({ instant: true });
    openFullAssetLibrary({ focusPath });
  });
  el.clearPrompt.addEventListener('click', () => {
    if (!el.promptEditor.value.trim()) { showToast('提示词已经是空的'); return; }
    if (state.skipClearConfirm) { clearPromptEditor(); return; }
    openCreatorDialog(el.clearPromptDialog);
  });
  el.clearPromptConfirm.addEventListener('click', () => {
    // 确认后用户会立即回到编辑器输入：模态关闭动画的 inert 窗口会吞掉紧随的输入，必须即时关
    closeCreatorDialog(el.clearPromptDialog, { instant: true });
    clearPromptEditor();
  });
  el.clearPromptNever.addEventListener('click', () => {
    state.skipClearConfirm = true;
    saveWorkspace(true);
    closeCreatorDialog(el.clearPromptDialog, { instant: true });
    clearPromptEditor();
  });
  el.clearPromptCancel.addEventListener('click', () => closeCreatorDialog(el.clearPromptDialog));
  document.querySelectorAll('[data-nav]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.action || button.dataset.nav;
      API.navigate(action).catch(error => showToast(error.message));
    });
  });
  new ResizeObserver(queueBoundsUpdate).observe(el.browserStage);
  window.addEventListener('resize', () => { syncMaterialSidebar(); queueBoundsUpdate(); });
  window.addEventListener('beforeunload', () => saveWorkspace(true));
  API.onBrowserState(applyBrowserState);
  if (typeof API.onPlatformBackdrop === 'function') API.onPlatformBackdrop(applyPlatformBackdrop);
  // 主进程发来的轻提示（撤销关闭结果等），宿主页与平台页两条快捷键路径共用
  if (typeof API.onNotice === 'function') API.onNotice(text => showToast(text));
  // 页内查找：平台页聚焦时 Cmd/Ctrl+F 由主进程转发；查找条控件与匹配计数在这里
  if (typeof API.onShowFindBar === 'function') API.onShowFindBar(() => showFindBar());
  if (typeof API.onFindResult === 'function') API.onFindResult(applyFindResult);
  if (typeof API.onFocusAddress === 'function') {
    API.onFocusAddress(() => {
      el.addressInput.focus();
      el.addressInput.select();
    });
  }
  el.findInput.addEventListener('input', () => runFind(false, false));
  el.findInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runFind(!event.shiftKey, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFindBar();
    }
  });
  el.findPrev.addEventListener('click', () => runFind(false, true));
  el.findNext.addEventListener('click', () => runFind(true, true));
  el.findClose.addEventListener('click', closeFindBar);
  // 标签右键菜单：点击菜单外或窗口失焦即关闭；Esc 仅在菜单打开时负责关闭它
  document.addEventListener('pointerdown', event => {
    if (!el.tabContextMenu.hidden && !event.target.closest('#tabContextMenu')) closeTabContextMenu();
  });
  el.tabContextMenu.addEventListener('mouseleave', scheduleTabMenuLeaveDismissal);
  el.tabContextMenu.addEventListener('mouseenter', () => cancelTabMenuLeaveDismissal());
  el.tabContextMenu.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...el.tabContextMenu.querySelectorAll('.tab-context-item:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    // 拖拽中 Esc＝取消拖动，顺序不变
    if (tabDrag?.active) {
      event.preventDefault();
      endTabDrag({ commit: false });
      showToast('已取消拖动，顺序未改变');
      return;
    }
    if (!el.tabContextMenu.hidden) {
      event.preventDefault();
      closeTabContextMenu();
    }
  });
  window.addEventListener('blur', () => closeTabContextMenu());
  API.onAssetDragResult?.(result => {
    document.querySelectorAll('.asset-card-wrap.asset-dragging').forEach(card => card.classList.remove('asset-dragging'));
    if (!result?.ok) showToast(result?.error || '文件拖拽失败，请重试');
  });
  // 视频浮出小窗关闭事件回流：撤掉「已浮出」角标并恢复原卡（路径可能以任一登记形态回传）。
  if (typeof API.onFloatVideoClosed === 'function') {
    API.onFloatVideoClosed(handleFloatVideoClosed);
  }
  API.onDownload(download => {
    state.downloads.set(download.id, download);
    renderDownloads();
    if (download.state === 'completed' && !state.archiveNotified.has(download.id)) {
      state.archiveNotified.add(download.id);
      if (quickAssetMutationDepth) scheduleQuickAssetReload();
      else loadAssetItems().catch(() => {});
      loadProduction(true).then(() => {
        renderDownloads();
      }).catch(() => {});
      showToast(`${download.filename} 已自动归档`);
    }
  });
  API.onDownloadEpisodesChanged?.(batch => applyDownloadEpisodes(batch));
  API.onSetMode(mode => setMode(mode));
  if (typeof API.onProjectChanged === 'function') {
    API.onProjectChanged(project => queueProjectChange(project).catch(error => showToast(`切换剧本失败：${error.message}`)));
  }
  if (typeof API.onAssetPanelState === 'function') API.onAssetPanelState(applyAssetPanelState);

  // 高频快捷键（标准浏览器习惯）：
  // Cmd/Ctrl+数字 切多开网页；Enter 复制并切网页；E 导入下载；R/F5 刷新；
  // L 聚焦地址栏；W 关闭当前标签；[ / ] 后退/前进；+ / - / 0 页面缩放。
  document.addEventListener('keydown', event => {
    // 模态操作中不切换其背后的网页；普通 Tab 仍用于对话框内的焦点导航。
    if (document.querySelector('dialog[open]') && (event.metaKey || event.ctrlKey)
      && (event.key === 'Tab' || /^[1-9]$/.test(event.key))) {
      event.preventDefault();
      return;
    }
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
    // 强制刷新（对标浏览器 Shift+刷新）：忽略缓存重新加载平台页
    if (lower === 'r' && event.shiftKey) {
      event.preventDefault();
      API.navigate('hard-reload').catch(error => showToast(error.message));
      return;
    }
    if (lower === 'r') {
      event.preventDefault();
      API.navigate('reload').catch(error => showToast(error.message));
      return;
    }
    // 撤销关闭标签（对标浏览器 Ctrl/⌘+Shift+T）：主进程最近关闭栈按时间恢复
    if (lower === 't' && event.shiftKey) {
      event.preventDefault();
      if (typeof API.restoreClosedTab === 'function') API.restoreClosedTab().catch(error => showToast(error.message));
      return;
    }
    // Ctrl/⌘+Tab 循环切换标签（正着走，加 Shift 反着走）
    if (event.key === 'Tab') {
      event.preventDefault();
      const ids = tabsWithIndexes(visibleTabs()).map(tab => tab.id);
      if (ids.length < 2) return;
      const index = ids.indexOf(state.browser?.tabId);
      const nextId = ids[(index + (event.shiftKey ? -1 : 1) + ids.length) % ids.length];
      selectTab(nextId);
      return;
    }
    // 页内查找（对标浏览器 Ctrl/⌘+F）；Shift 组合键留给页面自身的快捷键
    if (lower === 'f' && !event.shiftKey) {
      event.preventDefault();
      showFindBar();
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
    if (event.key === assetFolderOrderStorageKey()) {
      assetFolderOrderCache = { projectId: null, data: {} };
      renderQuickFolderTree();
    }
  });
}

async function applyPendingPrompt() {
  let payload = null;
  try { payload = JSON.parse(localStorage.getItem('vos.pendingPrompt') || 'null'); } catch {}
  if (!payload || typeof payload.body !== 'string') return;
  if (!payload.body.trim()) { localStorage.removeItem('vos.pendingPrompt'); return; }
  if (Date.now() - (payload.at || 0) > 10 * 60 * 1000) { localStorage.removeItem('vos.pendingPrompt'); return; }
  localStorage.removeItem('vos.pendingPrompt');
  if (state.config && ['image', 'video'].includes(payload.mode) && payload.mode !== state.mode) {
    if (!await setMode(payload.mode)) return;
  }
  el.templateCreateName.value = String(payload.title || '导入提示词').slice(0, 40);
  el.templateCreateBody.value = payload.body;
  setTemplateCreateFormOpen(true);
  state.accordions.prompt = true;
  el.promptAccordion.open = true;
  saveWorkspace(true);
  el.templateCreateName.focus();
  const source = 'Agent 经验库';
  showToast(`已填入来自${source}的「${payload.title || '模板'}」`);
}

async function boot() {
  // 入场动画门闸：Playwright 自动化（navigator.webdriver=true）不加，保证自动化截图与断言稳定
  if (!navigator.webdriver) document.body.classList.add('motion-boot');
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
    if (state.config.candidate) {
      document.querySelector('.creator-brand strong').textContent = '创作浏览器 · 候选版';
      document.title = `创作浏览器 · 候选版 ${state.config.candidate.version || ''}｜视频制作 OS`;
    }
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
    productionEvents.addEventListener('creative-assets', event => {
      let duplicate = false;
      try {
        const data = JSON.parse(event.data);
        const mutations = [...(data.moves || []).map(move => Date.now() - (quickRecentMoves.get(`${move.oldPath}\n${move.path}`) || 0) < 3000),
          ...(data.copies || []).map(copy => Date.now() - (quickRecentCopies.get(`${copy.sourcePath}\n${copy.path}`) || 0) < 3000),
          ...(data.deleted || []).map(path => Date.now() - (quickRecentDeletes.get(`${data.projectId}\n${path}`) || 0) < 3000)];
        duplicate = mutations.length && mutations.every(Boolean);
        applyQuickFolderRename(data.folderRename);
        applyQuickAssetMoves(data.moves, data.projectId);
        if (data.deleted?.length && !quickAssetDeletionBusy()) applyQuickAssetDeletions(data.deleted, data.projectId);
      } catch {}
      if (!duplicate) scheduleQuickAssetReload();
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
