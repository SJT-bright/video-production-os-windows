'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const {
  app,
  BrowserWindow,
  WebContentsView,
  clipboard,
  dialog,
  globalShortcut,
  Menu,
  net,
  ipcMain,
  nativeImage,
  nativeTheme,
  session,
  shell,
} = require('electron');
const { isSafeBrowserAddress, normalizeBrowserAddress } = require('./browser-address.cjs');
const { createCreatorPlatformStore } = require('./creator-platforms.cjs');
const { createBrowserSessionStore } = require('./browser-session.cjs');
const { buildCreatorContextMenuTemplate } = require('./creator-context-menu.cjs');
const { classifyDownload, resolveDownloadTarget } = require('./download-router.cjs');
const { classifyCreativeAsset, ensureCreativeAssetRoot, resolveCreativeAsset, buildCreativeAssetTree } = require('../creative-assets.cjs');
const { createCreatorAutomation, serveAutomation } = require('./creator-automation.cjs');
const { resolveMacProjectRootFromBundle, macProjectDataDir } = require('./runtime-project-path.cjs');
const { windowsReleasePaths } = require('./windows-release-path.cjs');

app.setName('视频制作 OS');
app.setAppUserModelId('VideoProductionOS.Desktop');
// 产品当前采用固定的明亮 macOS 工作台；同步原生材质，避免系统深色外观把标题栏与 vibrancy 染黑。
nativeTheme.themeSource = 'light';

const OS_DIR = path.dirname(__dirname);
const TEST_MODE = process.env.CREATOR_BROWSER_TEST === '1';
const SMOKE_TEST = process.env.VIDEO_OS_SMOKE_TEST === '1';

function readRuntimeConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(OS_DIR, 'runtime-config.json'), 'utf-8'));
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

const RUNTIME_CONFIG = readRuntimeConfig();
if (process.env.VIDEO_OS_USER_DATA) app.setPath('userData', path.resolve(process.env.VIDEO_OS_USER_DATA));
const windowsRelease = windowsReleasePaths({
  platform: process.platform, isPackaged: app.isPackaged,
  config: RUNTIME_CONFIG, userData: app.getPath('userData'),
});
const macPackagedApp = app.isPackaged && process.platform === 'darwin' && !TEST_MODE;
const explicitProjectRoot = String(process.env.VIDEO_OS_PROJECT_ROOT || '').trim();
const macProjectRootFromBundle = macPackagedApp ? resolveMacProjectRootFromBundle(OS_DIR) : '';
if (macPackagedApp && !macProjectRootFromBundle) {
  throw new Error('macOS App 必须保留在完整项目的 视频制作OS/dist 目录中；移动项目后请双击“启动OS-mac.command”重建 App。');
}
const packagedProjectRoot = typeof RUNTIME_CONFIG.projectRoot === 'string' && RUNTIME_CONFIG.projectRoot.trim()
  ? path.resolve(RUNTIME_CONFIG.projectRoot)
  : '';
const PROJECT_ROOT = path.resolve(
  (TEST_MODE && process.env.VIDEO_OS_TEST_PROJECT_ROOT)
  || macProjectRootFromBundle
  || explicitProjectRoot
  || windowsRelease?.projectRoot
  || packagedProjectRoot
  || path.dirname(OS_DIR)
);
const configuredDataDir = process.env.VIDEO_OS_DATA_DIR
  || windowsRelease?.dataDir
  || (macPackagedApp ? macProjectDataDir(PROJECT_ROOT) : '')
  || (typeof RUNTIME_CONFIG.dataDir === 'string' && RUNTIME_CONFIG.dataDir.trim() ? RUNTIME_CONFIG.dataDir : '')
  || path.join(OS_DIR, 'data');
if (!path.isAbsolute(configuredDataDir)) throw new Error('OS 数据目录必须是绝对路径');
// server.js 在 require 阶段解析项目根和数据目录，桌面发行版必须先注入真实路径。
process.env.VIDEO_OS_PROJECT_ROOT = PROJECT_ROOT;
process.env.VIDEO_OS_DATA_DIR = path.resolve(configuredDataDir);
const serverModule = require('../server.js');
const CREATIVE_ASSET_DIR = serverModule.creativeAssetDir;
const mediaSourceStore = serverModule.mediaSourceStore;
const OBSIDIAN_VAULT = TEST_MODE && process.env.VIDEO_OS_TEST_OBSIDIAN_VAULT
  ? path.resolve(process.env.VIDEO_OS_TEST_OBSIDIAN_VAULT)
  : serverModule.obsidianVault;
const productionStore = serverModule.productionStore;
const creativeProjectStore = serverModule.creativeProjectStore;
const START_PORT = Number(process.env.VIDEO_OS_PORT || 3750) || 3750;
let creatorAutomation = null;
let creatorAutomationServer = null;
const COMPATIBILITY_MODE = process.env.VIDEO_OS_ENABLE_GPU !== '1'
  && (process.env.VIDEO_OS_COMPAT_MODE === '1' || RUNTIME_CONFIG.compatibilityMode === true);
if (process.env.VIDEO_OS_DISABLE_GPU === '1' || COMPATIBILITY_MODE) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-rasterization');
}
if (COMPATIBILITY_MODE) {
  // 本机 Chromium 沙箱子进程无法稳定启动；仅发行版/显式兼容模式使用此降级。
  // Node 集成、权限、协议过滤、上下文隔离与 webSecurity 仍保持收紧。
  app.commandLine.appendSwitch('no-sandbox');
}
// 避免 Chromium 子进程崩溃时留下阻塞式系统弹窗；错误仍会写入 video-os.log。
app.commandLine.appendSwitch('disable-error-dialogs');
app.commandLine.appendSwitch('noerrdialogs');
// 网站兼容性：内嵌浏览器按标准 Chrome 对待。
// 1) 关闭自动化标记，Cloudflare/Turnstile 不再把它当自动化环境反复验证；
// 2) 全局 UA 伪装成正式 Chrome（Electron 默认 UA 里的 “Electron/x” 会导致
//    Google 登录报“不支持 JavaScript/浏览器不安全”并被部分站点降级）。
app.commandLine.appendSwitch('disable-features', 'AutomationControlled');
const { isLoginRejectedUrl } = require('./login-reject-url.cjs');
const CREATOR_BROWSER_UA = `Mozilla/5.0 (${process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
// 页面加载超时阈值：默认 30 秒；隔离测试可用环境变量调短，避免真实等待。
const LOAD_TIMEOUT_MS = Number(process.env.VIDEO_OS_LOAD_TIMEOUT_MS) || 30000;
app.userAgentFallback = CREATOR_BROWSER_UA;
const SERVICES = Object.freeze({
  gpt: { id: 'gpt', label: 'GPT', imageLabel: 'GPT 图片', videoLabel: 'GPT 提示词', url: 'https://chatgpt.com/' },
  gemini: { id: 'gemini', label: 'Gemini', imageLabel: 'Gemini', videoLabel: 'Gemini', url: 'https://gemini.google.com/app' },
  grok: { id: 'grok', label: 'Grok', imageLabel: 'Grok', videoLabel: 'Grok', url: 'https://grok.com/' },
  midjourney: { id: 'midjourney', label: 'Midjourney', imageLabel: 'Midjourney', url: 'https://www.midjourney.com/' },
  updream: { id: 'updream', label: 'Updream', videoLabel: 'Updream', url: 'https://www.updream.cn/' },
  xiaoyunque: { id: 'xiaoyunque', label: '小云雀', videoLabel: '小云雀', url: 'https://xyq.jianying.com/' },
  hehui: { id: 'hehui', label: '核绘', imageLabel: '核绘', videoLabel: '核绘', url: 'https://hehui.dawncoreai.com/' },
  libtv: { id: 'libtv', label: 'LibTV', imageLabel: 'LibTV', videoLabel: 'LibTV', url: 'https://www.liblib.tv/wappro?sourceid=040004' },
});
const MODE_SERVICES = Object.freeze({
  image: ['gpt', 'gemini', 'grok', 'midjourney', 'hehui', 'libtv'],
  video: ['gpt', 'gemini', 'grok', 'updream', 'xiaoyunque', 'hehui', 'libtv'],
});
const MODE_DEFAULTS = Object.freeze({ image: 'gpt', video: 'updream' });
const creatorPlatformStore = createCreatorPlatformStore({
  filePath: path.join(app.getPath('userData'), 'creator-platforms.json'),
  builtinIds: Object.keys(SERVICES),
  onWarning: message => console.warn(`[creator-platforms] ${message}`),
});
const ALLOWED_DOWNLOAD_ACTIONS = new Set(['pause', 'resume', 'cancel']);
const browserSessionStore = createBrowserSessionStore({
  filePath: path.join(app.getPath('userData'), 'creator-browser-session.json'),
  onWarning: message => console.warn(`[browser-session] ${message}`),
});
const initialBrowserSession = browserSessionStore.load();
let initializedModes = { image: false, video: false, ...initialBrowserSession?.initializedModes };
let restoringBrowserSession = false;
let closingWorkspace = false;
let browserSessionRestored = false;
let lastBrowserSnapshot = '';
const ALLOWED_NAV_ACTIONS = new Set(['back', 'forward', 'reload', 'stop', 'home']);
const ASSET_PANEL_MIN_WIDTH = 360;
const ASSET_PANEL_MAX_WIDTH = 760;
// 拖拽幻影兜底：视频等无法解码为图片的文件，用可见的深底+播放角标占位（1x1 透明图不可见，已弃用）
const DRAG_FALLBACK_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAX0lEQVRogO3PsQ0AMAgEQXCf7o1jOIagqPZ2M7AzVdM3wBewYcCGET/BhgE7RvwEGwbsGPH/XxcuXMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCA4d4E9wB3D7TGtAAAAABJRU5ErkJggg==';

let localServerInfo = null;
let mainWindow = null;
let creatorWindow = null;
let workspaceSurface = '';
let creatorLayoutReady = false;
let workspaceNavigation = Promise.resolve();
let activeView = null;
let assetView = null;
let assetViewAttached = false;
// 面板页世代号：页面创建或重载时递增，用于识别 focus 推送落在过期文档上的情况。
let assetViewGeneration = 0;
let chromeOverlaysHidden = false;
let activeServiceId = null;
let activeMode = initialBrowserSession?.activeMode || 'image';
let activeTabId = null;
let tabSequence = 0;
let browserBounds = { x: 410, y: 112, width: 900, height: 700 };
let assetPanelState = { open: false, layout: 'overlay', width: 520 };
let downloadSequence = 0;

// 多开标签：同一平台可以同时开多个网页（例如多个 GPT 窗口批量出图），
// 会话分区仍按平台共享，保证同平台多窗口共用一次登录。
const browserTabs = new Map();
const lastModeTabs = { image: null, video: null };
const downloadOwners = new WeakMap();
const configuredSessions = new Set();
const recentDownloads = [];
const activeDownloadItems = new Map();
let diagnosticLog = '';

function initDiagnostics() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    diagnosticLog = path.join(dir, 'video-os.log');
  } catch {}
}

function logDiagnostic(scope, detail) {
  const message = detail instanceof Error ? (detail.stack || detail.message) : String(detail || '');
  const line = `${new Date().toISOString()} [${scope}] ${message}\n`;
  try { if (diagnosticLog) fs.appendFileSync(diagnosticLog, line, 'utf-8'); } catch {}
  console.error(line.trim());
}

function isSafeWebUrl(value) {
  return isSafeBrowserAddress(value);
}

function isLocalAppUrl(value) {
  if (!localServerInfo) return false;
  try {
    return new URL(value).origin === new URL(localServerInfo.url).origin;
  } catch {
    return false;
  }
}

function isTrustedMainSender(event) {
  return workspaceSurface === 'main' && !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

function isTrustedCreatorSender(event) {
  return workspaceSurface === 'creator' && !!creatorWindow && !creatorWindow.isDestroyed() && event.sender === creatorWindow.webContents;
}

function isTrustedAssetSender(event) {
  return !!assetView && !assetView.webContents.isDestroyed() && event.sender === assetView.webContents;
}

function isTrustedDragTraySender(event) {
  return !!dragTrayWindow && !dragTrayWindow.isDestroyed() && event.sender === dragTrayWindow.webContents;
}

function isTrustedMediaSender(event) {
  // 剪贴板等共享能力：创作窗口 HTML 层、完整资产库、剪映悬浮窗三者皆可
  return isTrustedCreatorSender(event) || isTrustedAssetSender(event) || isTrustedDragTraySender(event);
}

function requireTrusted(event, kind) {
  const trusted = kind === 'main'
    ? isTrustedMainSender(event)
    : kind === 'asset'
      ? isTrustedAssetSender(event)
      : kind === 'tray'
        ? isTrustedDragTraySender(event)
        : kind === 'media'
          ? isTrustedMediaSender(event)
          : isTrustedCreatorSender(event);
  if (!trusted) throw new Error('拒绝未经授权的桌面操作');
}

function modeOrDefault(value) {
  return value === 'video' ? 'video' : 'image';
}

function customServices() {
  return creatorPlatformStore.list();
}

function serviceById(serviceId) {
  return SERVICES[serviceId] || customServices().find(service => service.id === serviceId) || null;
}

function modeServices(mode) {
  const hiddenBuiltinIds = new Set(creatorPlatformStore.hiddenBuiltinIds());
  const builtins = MODE_SERVICES[modeOrDefault(mode)].filter(serviceId => !hiddenBuiltinIds.has(serviceId));
  return [...builtins, ...customServices().map(service => service.id)];
}

function validServiceForMode(mode, serviceId) {
  return modeServices(mode).includes(serviceId);
}

function defaultServiceForMode(mode) {
  const safeMode = modeOrDefault(mode);
  const available = modeServices(safeMode);
  return available.includes(MODE_DEFAULTS[safeMode]) ? MODE_DEFAULTS[safeMode] : (available[0] || null);
}

function publicDefaults() {
  return { image: defaultServiceForMode('image'), video: defaultServiceForMode('video') };
}

function serviceUrl(serviceId) {
  const service = serviceById(serviceId);
  if (!service) throw new Error('未知创作平台');
  if (!TEST_MODE) return service.url;
  return `${localServerInfo.url}/creator-fixture.html?service=${encodeURIComponent(serviceId)}`;
}

function publicServices() {
  const hiddenBuiltinIds = new Set(creatorPlatformStore.hiddenBuiltinIds());
  const builtins = Object.values(SERVICES).map(({ id, label, imageLabel, videoLabel, url }) => ({
    id, label, imageLabel, videoLabel, url, custom: false, hidden: hiddenBuiltinIds.has(id),
  }));
  return [...builtins, ...customServices()].map(service => ({
    ...service, displayName: creatorPlatformStore.displayName(service.id),
  }));
}

function publicModeServices() {
  return { image: modeServices('image'), video: modeServices('video') };
}

function creatorPaths() {
  const vault = OBSIDIAN_VAULT || '';
  ensureCreativeAssetRoot(CREATIVE_ASSET_DIR);
  const activeProject = creativeProjectStore?.active() || null;
  const activeProjectRoot = activeProject ? creativeProjectStore.resolveRoot(activeProject.id) : CREATIVE_ASSET_DIR;
  const category = categoryId => {
    try { return activeProject ? creativeProjectStore.category(activeProject.id, categoryId).absolutePath : ''; }
    catch { return ''; }
  };
  return {
    projectRoot: PROJECT_ROOT,
    activeProject,
    activeProjectRoot,
    materialRoot: category('generated-videos'),
    audioRoot: category('audio'),
    frameRoot: category('frames'),
    creativeAssetRoot: activeProjectRoot,
    creativeAssetLibraryRoot: CREATIVE_ASSET_DIR,
    creativeAssetAvailable: true,
    imageRoot: category('generated-images'),
    legacyImageRoot: vault ? path.join(vault, 'ai创作短剧', '韩剧制作', '浏览器生成') : '',
    obsidianAvailable: !!vault,
    diagnosticLog,
  };
}

function activeProjectDirectories() {
  const paths = creatorPaths();
  if (!paths.activeProject) throw new Error('请先选择一个剧本或灵感工作区');
  return { image: paths.imageRoot, video: paths.materialRoot, audio: paths.audioRoot };
}

function publicAssetPanelState() {
  return {
    open: !!assetPanelState.open,
    layout: assetPanelState.layout === 'push' ? 'push' : 'overlay',
    width: assetPanelState.width,
    creativeAssetAvailable: true,
    obsidianAvailable: !!OBSIDIAN_VAULT,
  };
}

function normalizeAssetPanelState(patch = {}) {
  const requestedWidth = Number(patch.width);
  const width = Number.isFinite(requestedWidth)
    ? Math.max(ASSET_PANEL_MIN_WIDTH, Math.min(ASSET_PANEL_MAX_WIDTH, Math.round(requestedWidth)))
    : assetPanelState.width;
  return {
    open: patch.open === undefined ? assetPanelState.open : !!patch.open,
    layout: patch.layout === undefined
      ? assetPanelState.layout
      : patch.layout === 'push' ? 'push' : 'overlay',
    width,
  };
}

function sendAssetPanelState() {
  const panel = publicAssetPanelState();
  sendCreator('creator:asset-panel-state', panel);
  if (assetView && !assetView.webContents.isDestroyed()) assetView.webContents.send('asset:panel-state', panel);
  return panel;
}

function sendCreator(channel, payload) {
  if (workspaceSurface === 'creator' && creatorWindow && !creatorWindow.isDestroyed()) creatorWindow.webContents.send(channel, payload);
}

function sendMain(channel, payload) {
  if (workspaceSurface === 'main' && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function safeServiceUrl(serviceId) {
  try { return serviceUrl(serviceId); } catch { return ''; }
}

function tabById(tabId) {
  return browserTabs.get(String(tabId || '')) || null;
}

function serviceTabLabel(tab) {
  const service = serviceById(tab.serviceId);
  return tab.customName || tab.displayLabel || creatorPlatformStore.displayName(tab.serviceId) || service?.label || '创作网页';
}

function publicTabs() {
  return [...browserTabs.values()].map(tab => ({
    id: tab.id,
    serviceId: tab.serviceId,
    label: serviceTabLabel(tab),
    customName: tab.customName || '',
    url: tab.currentUrl || safeServiceUrl(tab.serviceId),
    mode: tab.mode,
    active: tab.id === activeTabId,
  }));
}

function browserState() {
  const tab = tabById(activeTabId);
  if (!tab || tab.view.webContents.isDestroyed()) {
    const service = serviceById(activeServiceId);
    return {
      mode: activeMode,
      tabId: activeTabId,
      serviceId: activeServiceId,
      displayLabel: service?.label || '',
      loading: false, url: '', title: '',
      canGoBack: false, canGoForward: false, error: '',
      loadTimedOut: false, loginRejected: false,
      tabs: publicTabs(),
    };
  }
  const contents = tab.view.webContents;
  return {
    mode: tab.mode,
    tabId: tab.id,
    serviceId: tab.serviceId,
    displayLabel: serviceTabLabel(tab),
    loading: contents.isLoading(),
    url: tab.currentUrl || contents.getURL() || safeServiceUrl(tab.serviceId),
    title: contents.getTitle(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    error: tab.error || '',
    loadTimedOut: !!tab.loadTimedOut,
    loginRejected: !!tab.loginRejected,
    tabs: publicTabs(),
  };
}

function updateTabDisplayLabel(tab, value) {
  if (TEST_MODE) return;
  try {
    const service = serviceById(tab.serviceId);
    if (!service) return;
    const currentHost = new URL(value).hostname.replace(/^www\./i, '');
    const homeHost = new URL(service.url).hostname.replace(/^www\./i, '');
    if (currentHost && currentHost !== homeHost) tab.displayLabel = currentHost;
    else tab.displayLabel = '';
  } catch {
    tab.displayLabel = '';
  }
}

function pushBrowserState() {
  persistBrowserSession();
  sendCreator('creator:browser-state', browserState());
}

function persistBrowserSession() {
  if (restoringBrowserSession || closingWorkspace || !browserSessionRestored) return;
  const snapshot = {
    schemaVersion: 1,
    activeMode,
    lastModeTabs: { ...lastModeTabs },
    initializedModes: { ...initializedModes },
    tabs: [...browserTabs.values()].map(tab => ({
      id: tab.id, serviceId: tab.serviceId, mode: tab.mode,
      url: tab.currentUrl || safeServiceUrl(tab.serviceId), customName: tab.customName || '',
    })),
  };
  const serialized = JSON.stringify(snapshot);
  if (serialized === lastBrowserSnapshot) return;
  try { browserSessionStore.save(snapshot); lastBrowserSnapshot = serialized; }
  catch (error) { logDiagnostic('browser-session-save', error); }
}

function restoreBrowserSession() {
  if (browserSessionRestored) return;
  const saved = browserSessionStore.load();
  restoringBrowserSession = true;
  try {
    if (saved) {
      initializedModes = { ...saved.initializedModes };
      activeMode = saved.activeMode;
      for (const item of saved.tabs) {
        if (!validServiceForMode(item.mode, item.serviceId)) continue;
        createTab(item.serviceId, item.mode, {
          activate: false, id: item.id, initialUrl: item.url, customName: item.customName, deferLoad: true,
        });
      }
      for (const mode of ['image', 'video']) {
        const previous = tabById(saved.lastModeTabs[mode]);
        lastModeTabs[mode] = previous?.mode === mode ? previous.id
          : [...browserTabs.values()].find(tab => tab.mode === mode)?.id || null;
      }
      if (lastModeTabs[activeMode]) activateTab(lastModeTabs[activeMode]);
    }
  } finally {
    restoringBrowserSession = false;
    browserSessionRestored = true;
  }
}

function showEmptyBrowserMode(mode) {
  if (activeView) {
    try { creatorWindow?.contentView.removeChildView(activeView); } catch {}
  }
  activeMode = modeOrDefault(mode);
  activeView = null;
  activeTabId = null;
  activeServiceId = null;
  lastModeTabs[activeMode] = null;
  applyCreatorLayout();
  pushBrowserState();
  return browserState();
}

function clearBrowserTabs() {
  if ([...activeDownloadItems.values()].some(item => ['progressing', 'paused'].includes(item.record?.state))) {
    throw new Error('还有下载任务，请完成或取消下载后再清空网页');
  }
  const emptySnapshot = {
    schemaVersion: 1, activeMode, tabs: [],
    lastModeTabs: { image: null, video: null },
    initializedModes: { image: true, video: true },
  };
  // 先落盘，再关闭网页；写入失败时保留所有标签，并把错误交给界面。
  browserSessionStore.save(emptySnapshot);
  lastBrowserSnapshot = JSON.stringify(emptySnapshot);
  initializedModes = { image: true, video: true };
  restoringBrowserSession = true;
  try { for (const tab of [...browserTabs.values()]) destroyTab(tab); }
  finally { restoringBrowserSession = false; }
  return showEmptyBrowserMode(activeMode);
}

function publicDownload(record) {
  return {
    id: record.id,
    serviceId: record.serviceId,
    serviceLabel: record.serviceLabel,
    mode: record.mode,
    kind: record.kind,
    filename: record.filename,
    savePath: record.savePath,
    state: record.state,
    receivedBytes: record.receivedBytes,
    totalBytes: record.totalBytes,
    startedAt: record.startedAt,
    endedAt: record.endedAt || null,
    error: record.error || '',
    source: record.source || 'platform',
    shotId: record.productionSnapshot && record.productionSnapshot.shotId || null,
    shotNo: record.productionSnapshot && record.productionSnapshot.shotNo || '',
    shotTitle: record.productionSnapshot && record.productionSnapshot.shotTitle || '',
    contextRevision: Number(record.productionSnapshot && record.productionSnapshot.contextRevision || 0),
    projectId: record.productionSnapshot && record.productionSnapshot.projectId || '',
    inboxId: record.inboxId || null,
    ingestState: record.ingestState || (record.state === 'completed' ? 'pending' : ''),
    ingestError: record.ingestError || '',
  };
}

function captureProductionContext(serviceId, mode) {
  // 新结果只归属剧本，不再继承旧版本中可能残留的当前镜头。
  const projectId = creativeProjectStore?.active()?.id || '';
  return { shotId: null, shotNo: '', shotTitle: '', contextRevision: 0, projectId, serviceId, mode };
}

function archiveDownloadInProduction(record) {
  if (!productionStore || record.state !== 'completed') return;
  try {
    const item = productionStore.recordDownload({
      downloadKey: record.id,
      assetPath: record.savePath,
      filename: record.filename,
      kind: record.kind,
      mode: record.mode,
      serviceId: record.serviceId,
      serviceLabel: record.serviceLabel,
      source: record.source || 'platform',
      sizeBytes: record.totalBytes || record.receivedBytes || 0,
    }, record.productionSnapshot || {});
    record.inboxId = item.id;
    record.ingestState = item.state;
    record.ingestError = item.error || '';
    if (typeof serverModule.broadcastProduction === 'function') serverModule.broadcastProduction();
  } catch (error) {
    record.ingestState = 'error';
    record.ingestError = `文件已归档，但制作台账写入失败：${error.message}`;
    appendLog(record.ingestError);
  }
}

function broadcastDownload(record) {
  sendCreator('creator:download', publicDownload(record));
}

function configureSession(serviceId, ses) {
  if (configuredSessions.has(serviceId)) return;
  configuredSessions.add(serviceId);

  // 标准 Chrome 级权限：AI 站点常见的剪贴板、麦克风/摄像头、通知、存储等直接放行，
  // 避免登录/使用过程中被静默拒绝导致页面功能异常或反复验证。
  const allowedPermissions = new Set([
    'clipboard-sanitized-write', 'clipboard-read', 'fullscreen',
    'media', 'audioCapture', 'videoCapture', 'display-capture',
    'notifications', 'pointerLock', 'persistent-storage', 'geolocation',
    'storage-access', 'top-level-storage-access', 'midi', 'midiSysex',
  ]);
  const allowPermission = permission => allowedPermissions.has(permission);
  ses.setUserAgent(CREATOR_BROWSER_UA);
  // Client-Hints 头一致性：UA 伪装成 Chrome 后，Sec-CH-UA 系列请求头若仍是 Chromium，
  // Google 服务端会因“UA 与 Client-Hints 矛盾”直接拒绝登录（signin/rejected）。
  const chromeMajor = String(process.versions.chrome).split('.')[0];
  const secChUA = `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", ";Not A Brand";v="99"`;
  const secChUAFull = `"Chromium";v="${chromeMajor}.0.0.0", "Google Chrome";v="${chromeMajor}.0.0.0", ";Not A Brand";v="99.0.0.0"`;
  const secChUAPlatform = process.platform === 'darwin' ? '"macOS"' : '"Windows"';
  // 注意：必须使用 callback 异步形式；同步返回形式在当前 Electron 版本会挂起请求。
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'sec-ch-ua') headers[key] = secChUA;
      else if (lower === 'sec-ch-ua-full-version-list') headers[key] = secChUAFull;
      else if (lower === 'sec-ch-ua-mobile') headers[key] = '?0';
      else if (lower === 'sec-ch-ua-platform') headers[key] = secChUAPlatform;
    }
    callback({ requestHeaders: headers });
  });
  // 页面环境补丁：让 Google 登录等站点把内嵌浏览器当作标准 Chrome（plugins/chrome/webdriver 指纹）。
  const pagePatchPreload = path.join(__dirname, 'creator-page-patch-preload.cjs');
  try {
    if (typeof ses.registerPreloadScript === 'function') {
      ses.registerPreloadScript({ id: `vos-page-patch-${serviceId}`, type: 'frame', filePath: pagePatchPreload });
    } else {
      ses.setPreloads([pagePatchPreload]);
    }
  } catch (error) {
    logDiagnostic(`creator-page-patch:${serviceId}`, error.message || String(error));
  }
  ses.setPermissionCheckHandler((_webContents, permission) => allowPermission(permission));
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowPermission(permission));
  });

  ses.on('will-download', (event, item, sourceContents) => {
    const service = serviceById(serviceId);
    if (!service) { event.preventDefault(); return; }
    const downloadingTab = sourceContents ? downloadOwners.get(sourceContents) : tabById(activeTabId);
    const displayLabel = downloadingTab && downloadingTab.serviceId === serviceId
      ? serviceTabLabel(downloadingTab)
      : service.label;
    const mode = downloadingTab?.mode || activeMode;
    const productionSnapshot = captureProductionContext(serviceId, mode);
    const originalName = item.getFilename() || `download-${Date.now()}`;
    const id = `dl-${Date.now()}-${++downloadSequence}`;
    let target;
    let savePath;
    try {
      target = resolveDownloadTarget({
        projectRoot: PROJECT_ROOT,
        obsidianVault: OBSIDIAN_VAULT,
        serviceId,
        serviceLabel: displayLabel,
        mode,
        filename: originalName,
        mimeType: item.getMimeType(),
        projectDirectories: activeProjectDirectories(),
      });
      fs.mkdirSync(target.directory, { recursive: true });
      // 图片/视频统一按“分类-序号”落盘（平台内点击下载也一样），UUID 乱名不再进入素材库；
      // 提示词血缘 sidecar 使用最终 savePath，跟随新文件名。
      savePath = (target.kind === 'image' || target.kind === 'video')
        ? sequentialImportTarget(target.directory, target.kind, originalName)
        : target.targetPath;
      item.setSavePath(savePath);
    } catch (error) {
      event.preventDefault();
      const failedRecord = {
        id,
        serviceId,
        serviceLabel: displayLabel,
        mode,
        kind: 'other',
        filename: originalName,
        savePath: '',
        state: 'interrupted',
        receivedBytes: 0,
        totalBytes: Math.max(0, item.getTotalBytes()),
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        error: `无法保存下载：${error.message}`,
      };
      recentDownloads.unshift(failedRecord);
      if (recentDownloads.length > 50) recentDownloads.length = 50;
      broadcastDownload(failedRecord);
      return;
    }

    const record = {
      id,
      serviceId,
      serviceLabel: displayLabel,
      mode,
      kind: target.kind,
      filename: path.basename(savePath),
      savePath,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: Math.max(0, item.getTotalBytes()),
      startedAt: new Date().toISOString(),
      productionSnapshot,
    };
    recentDownloads.unshift(record);
    if (recentDownloads.length > 50) recentDownloads.length = 50;
    activeDownloadItems.set(id, { item, record });
    broadcastDownload(record);

    item.on('updated', (_downloadEvent, state) => {
      record.state = state === 'interrupted' ? 'interrupted' : (item.isPaused() ? 'paused' : 'progressing');
      record.receivedBytes = Math.max(0, item.getReceivedBytes());
      record.totalBytes = Math.max(0, item.getTotalBytes());
      broadcastDownload(record);
    });

    item.once('done', (_downloadEvent, state) => {
      activeDownloadItems.delete(id);
      record.state = state;
      record.receivedBytes = Math.max(0, item.getReceivedBytes());
      record.totalBytes = Math.max(0, item.getTotalBytes());
      record.endedAt = new Date().toISOString();
      if (state !== 'completed') record.error = state === 'cancelled' ? '下载已取消' : '下载中断，可返回平台重试';
      if (state === 'completed') archiveDownloadInProduction(record);
      broadcastDownload(record);
      if (state === 'completed') {
        sendMain('os:download-complete', publicDownload(record));
      }
    });
  });
}

async function copyFileWithProgress(sourcePath, targetPath, onProgress) {
  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isFile()) throw new Error('选择的路径不是文件');
  let copied = 0;
  let lastUpdate = 0;
  const input = fs.createReadStream(sourcePath);
  const output = fs.createWriteStream(targetPath, { flags: 'wx' });
  input.on('data', chunk => {
    copied += chunk.length;
    const now = Date.now();
    if (now - lastUpdate >= 120 || copied === stat.size) {
      lastUpdate = now;
      onProgress(copied, stat.size);
    }
  });
  try {
    await pipeline(input, output);
    return stat.size;
  } catch (error) {
    try { await fs.promises.unlink(targetPath); } catch {}
    throw error;
  }
}

// 导入资产自动按“类别-序号”重命名（例如 生成图片-007.png），序号在落盘目录内递增；
// 平台点击下载保持原文件名，只有拖拽/手动导入走这条规则。
const IMPORT_SEQUENCE_LABELS = Object.freeze({ image: '生成图片', video: '生成视频', audio: '音频' });

function sequentialImportTarget(directory, kind, originalName) {
  const label = IMPORT_SEQUENCE_LABELS[kind];
  const extension = path.extname(originalName).toLowerCase();
  if (!label || !extension) return path.join(directory, path.basename(originalName));
  let max = 0;
  try {
    const pattern = new RegExp(`^${label}-(\\d+)\\.`);
    for (const entry of fs.readdirSync(directory)) {
      const match = entry.match(pattern);
      if (match) max = Math.max(max, Number.parseInt(match[1], 10) || 0);
    }
  } catch {}
  let candidate = '';
  do {
    max += 1;
    candidate = path.join(directory, `${label}-${String(max).padStart(3, '0')}${extension}`);
  } while (fs.existsSync(candidate));
  return candidate;
}

async function archiveExternalPaths(filePaths, allowedKinds) {
  const failed = [];
  let imported = 0;
  for (const sourcePath of filePaths) {
    const filename = path.basename(sourcePath);
    const kind = classifyDownload({ filename, mode: 'video', serviceId: activeServiceId || '' });
    if (!allowedKinds.has(kind)) { failed.push(`${filename}：仅支持所选类型的素材`); continue; }
    const safeMode = kind === 'image' ? 'image' : 'video';
    const serviceId = validServiceForMode(safeMode, activeServiceId) ? activeServiceId : defaultServiceForMode(safeMode);
    if (!serviceId) { failed.push(`${filename}：当前模式没有可用创作平台`); continue; }
    const service = serviceById(serviceId);
    const id = `import-${Date.now()}-${++downloadSequence}`;
    const productionSnapshot = captureProductionContext(serviceId, safeMode);
    let record;
    try {
      const target = resolveDownloadTarget({
        projectRoot: PROJECT_ROOT,
        obsidianVault: OBSIDIAN_VAULT,
        serviceId,
        serviceLabel: `${service.label} 外部下载`,
        mode: safeMode,
        filename,
        mimeType: '',
        projectDirectories: activeProjectDirectories(),
      });
      fs.mkdirSync(target.directory, { recursive: true });
      const targetPath = sequentialImportTarget(target.directory, kind, filename);
      const totalBytes = fs.statSync(sourcePath).size;
      record = {
        id, serviceId, serviceLabel: `${service.label} 外部下载`, mode: safeMode, kind,
        filename: path.basename(targetPath), savePath: targetPath,
        state: 'progressing', receivedBytes: 0, totalBytes, startedAt: new Date().toISOString(),
        source: 'import',
        productionSnapshot,
      };
      recentDownloads.unshift(record);
      if (recentDownloads.length > 50) recentDownloads.length = 50;
      activeDownloadItems.set(id, { item: null, record });
      broadcastDownload(record);
      await copyFileWithProgress(sourcePath, targetPath, (receivedBytes, total) => {
        record.receivedBytes = receivedBytes;
        record.totalBytes = total;
        broadcastDownload(record);
      });
      record.state = 'completed';
      record.receivedBytes = totalBytes;
      record.endedAt = new Date().toISOString();
      archiveDownloadInProduction(record);
      imported++;
      broadcastDownload(record);
      sendMain('os:download-complete', publicDownload(record));
    } catch (error) {
      if (record) {
        record.state = 'interrupted';
        record.endedAt = new Date().toISOString();
        record.error = `导入失败：${error.message}`;
        broadcastDownload(record);
      }
      failed.push(`${filename}：${error.message}`);
    } finally {
      activeDownloadItems.delete(id);
    }
  }
  if (imported) serverModule.broadcastCreativeAssets?.();
  return { cancelled: false, imported, failed };
}

async function importExternalDownloads(mode) {
  const safeMode = modeOrDefault(mode);
  if (!creatorWindow || creatorWindow.isDestroyed()) throw new Error('创作浏览器尚未打开');
  const filters = safeMode === 'image'
    ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'] }]
    : [{ name: '视频与音频', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'amr', 'ape'] }];
  const selection = await dialog.showOpenDialog(creatorWindow, {
    title: safeMode === 'image' ? '导入系统浏览器下载的图片' : '导入系统浏览器下载的视频或音频',
    buttonLabel: '导入并归档',
    properties: ['openFile', 'multiSelections'],
    filters,
  });
  if (selection.canceled || !selection.filePaths.length) return { cancelled: true, imported: 0, failed: [] };
  const allowedKinds = safeMode === 'image' ? new Set(['image']) : new Set(['video', 'audio']);
  return archiveExternalPaths(selection.filePaths, allowedKinds);
}

async function importLocalCreativeAssets() {
  if (!creatorWindow || creatorWindow.isDestroyed()) throw new Error('创作浏览器尚未打开');
  const selection = await dialog.showOpenDialog(creatorWindow, {
    title: '添加图片、视频或音频到当前剧本',
    buttonLabel: '添加到创作资产',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片、视频与音频', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'amr', 'ape'] }],
  });
  if (selection.canceled || !selection.filePaths.length) return { cancelled: true, imported: 0, failed: [] };
  return archiveExternalPaths(selection.filePaths, new Set(['image', 'video', 'audio']));
}

function isPrivateRemoteHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}

const REMOTE_IMAGE_EXTENSIONS = Object.freeze({
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/bmp': '.bmp', 'image/avif': '.avif',
});

function remoteImageName(url, mimeType) {
  if (String(url || '').startsWith('data:')) return `网页图片-${Date.now()}${REMOTE_IMAGE_EXTENSIONS[mimeType] || '.png'}`;
  let name = '';
  try { name = decodeURIComponent(path.posix.basename(new URL(url).pathname)); } catch {}
  const extension = REMOTE_IMAGE_EXTENSIONS[mimeType] || '';
  const acceptedExtensions = new Set(Object.values(REMOTE_IMAGE_EXTENSIONS));
  if (!acceptedExtensions.has(path.extname(name).toLowerCase())) {
    name = `网页图片-${Date.now()}${extension || '.png'}`;
  }
  return name;
}

async function importRemoteImage(urlValue) {
  const value = String(urlValue || '').trim();
  if (value.startsWith('data:image/')) {
    const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
    if (!match || !REMOTE_IMAGE_EXTENSIONS[match[1].toLowerCase()]) throw new Error('网页图片数据格式不受支持');
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length || buffer.length > 100 * 1024 * 1024) throw new Error('网页图片为空或超过 100 MB');
    return saveRemoteImageBuffer(buffer, value, match[1].toLowerCase());
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || isPrivateRemoteHost(url.hostname)) throw new Error('网页图片地址不受支持');
  const requestSession = activeView && !activeView.webContents.isDestroyed() ? activeView.webContents.session : null;
  const response = requestSession
    ? await requestSession.fetch(url.href, { credentials: 'include' })
    : await net.fetch(url.href, { credentials: 'include' });
  if (!response.ok) throw new Error(`网页图片下载失败（HTTP ${response.status}）`);
  const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!REMOTE_IMAGE_EXTENSIONS[mimeType]) throw new Error('拖入的网址不是受支持的图片');
  const announcedSize = Number(response.headers.get('content-length') || 0);
  if (announcedSize > 100 * 1024 * 1024) throw new Error('网页图片超过 100 MB');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 100 * 1024 * 1024) throw new Error('网页图片为空或超过 100 MB');
  return saveRemoteImageBuffer(buffer, url.href, mimeType);
}

async function saveRemoteImageBuffer(buffer, sourceUrl, mimeType) {
  const safeMode = 'image';
  const serviceId = validServiceForMode(safeMode, activeServiceId) ? activeServiceId : defaultServiceForMode(safeMode);
  if (!serviceId) throw new Error('图片模式没有可用创作平台');
  const service = serviceById(serviceId);
  const filename = remoteImageName(sourceUrl, mimeType);
  const target = resolveDownloadTarget({
    projectRoot: PROJECT_ROOT, obsidianVault: OBSIDIAN_VAULT, serviceId,
    serviceLabel: `${service.label} 网页拖入`, mode: safeMode, filename, mimeType,
    projectDirectories: activeProjectDirectories(),
  });
  fs.mkdirSync(target.directory, { recursive: true });
  const targetPath = sequentialImportTarget(target.directory, 'image', filename);
  await fs.promises.writeFile(targetPath, buffer, { flag: 'wx' });
  const id = `drop-${Date.now()}-${++downloadSequence}`;
  const record = {
    id, serviceId, serviceLabel: `${service.label} 网页拖入`, mode: safeMode, kind: 'image',
    filename: path.basename(targetPath), savePath: targetPath, state: 'completed',
    receivedBytes: buffer.length, totalBytes: buffer.length, startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(), source: 'import',
    productionSnapshot: captureProductionContext(serviceId, safeMode),
  };
  recentDownloads.unshift(record);
  if (recentDownloads.length > 50) recentDownloads.length = 50;
  archiveDownloadInProduction(record);
  broadcastDownload(record);
  sendMain('os:download-complete', publicDownload(record));
  return record;
}

async function importDroppedCreativeAssets(payload = {}) {
  const paths = Array.isArray(payload.paths) ? payload.paths.map(value => String(value || '')).filter(Boolean).slice(0, 100) : [];
  const urls = Array.isArray(payload.urls) ? payload.urls.map(value => String(value || '')).filter(Boolean).slice(0, 20) : [];
  const local = await archiveExternalPaths(paths, new Set(['image', 'video', 'audio']));
  const failed = [...local.failed];
  let imported = local.imported;
  for (const url of urls) {
    try { await importRemoteImage(url); imported++; }
    catch (error) { failed.push(`网页图片：${error.message}`); }
  }
  if (imported) serverModule.broadcastCreativeAssets?.();
  return { cancelled: false, imported, failed };
}

function securePopupOptions(ses) {
  return {
    parent: creatorWindow,
    width: 980,
    height: 760,
    autoHideMenuBar: true,
    backgroundColor: '#10162a',
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  };
}

function installCreatorContextMenu(contents, ownerWindow = creatorWindow) {
  if (!contents || contents.isDestroyed()) return;
  contents.on('context-menu', (_event, params) => {
    if (!ownerWindow || ownerWindow.isDestroyed() || contents.isDestroyed()) return;
    const template = buildCreatorContextMenuTemplate({
      contents,
      params,
      clipboard,
      onError: error => appendLog(`浏览器右键菜单操作失败：${error.message}`),
    });
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: ownerWindow });
  });
}

function createTab(serviceId, mode, { activate = true, id, initialUrl, customName = '', deferLoad = false } = {}) {
  if (!creatorWindow || creatorWindow.isDestroyed()) throw new Error('创作浏览器尚未打开');
  const safeMode = modeOrDefault(mode);
  if (!validServiceForMode(safeMode, serviceId)) throw new Error('该平台不属于当前创作模式');
  const service = serviceById(serviceId);
  if (!service) throw new Error('未知创作平台');
  const ses = session.fromPartition(`persist:video-os-creator-${serviceId}`);
  configureSession(serviceId, ses);

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  const contents = view.webContents;
  installCreatorContextMenu(contents);
  // 用户点击网页时收起覆盖式资产库；不拦截原点击，网页按钮和输入框仍可直接操作。
  contents.on('before-mouse-event', (_event, input) => {
    if (input.type === 'mouseDown' && contents === activeView?.webContents) dismissAssetOverlay();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const safeLoginBootstrap = /^(about:blank|about:srcdoc)$/i.test(url);
    if (!safeLoginBootstrap && !isSafeWebUrl(url)) {
      if (/^(mailto|tel):/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: securePopupOptions(ses) };
  });
  contents.on('did-create-window', childWindow => {
    downloadOwners.set(childWindow.webContents, tab);
    installCreatorContextMenu(childWindow.webContents, childWindow);
  });
  contents.on('will-navigate', (event, url) => {
    if (!isSafeWebUrl(url)) event.preventDefault();
  });
  const tab = {
    id: id || `tab-${Date.now().toString(36)}-${++tabSequence}`,
    serviceId,
    mode: safeMode,
    currentUrl: isSafeWebUrl(initialUrl) ? initialUrl : serviceUrl(serviceId),
    customName,
    needsLoad: deferLoad,
    view,
    session: ses,
    displayLabel: '',
    error: '',
    loadTimedOut: false,
    loginRejected: false,
    stoppedAfterTimeout: false,
    loadTimer: null,
    loadSeq: 0,
  };
  // 统一的标签内加载入口：带导航序号，失败回调只在“这次加载仍是最新一次”时写状态，
  // 避免换页替换旧请求产生的 ERR_ABORTED 污染新页面的正常状态。
  const loadInTab = (url, { manual = false } = {}) => {
    tab.currentUrl = url;
    tab.needsLoad = false;
    persistBrowserSession();
    const seq = ++tab.loadSeq;
    return contents.loadURL(url).catch(error => {
      if (seq !== tab.loadSeq) return;
      const aborted = String(error.message).includes('ERR_ABORTED');
      if (aborted) {
        tab.error = tab.stoppedAfterTimeout
          ? '已停止加载：站点长时间无响应。可重试，或改用系统浏览器打开。'
          : '已停止加载。可重试，或改用系统浏览器打开。';
      } else {
        tab.error = `平台加载失败：${error.message}`;
      }
      if (tab.id === activeTabId) pushBrowserState();
    });
  };
  const clearLoadTimer = () => {
    if (tab.loadTimer) { clearTimeout(tab.loadTimer); tab.loadTimer = null; }
  };
  contents.on('did-start-loading', () => {
    tab.error = '';
    tab.loadTimedOut = false;
    // 每轮导航独立计时：完成/失败/停止/新导航都会重置，避免旧计时器污染新页面。
    clearLoadTimer();
    tab.loadTimer = setTimeout(() => {
      if (contents.isDestroyed() || !contents.isLoading()) return;
      tab.loadTimer = null;
      tab.loadTimedOut = true;
      logDiagnostic(`tab-timeout:${serviceId}`, `加载超过 ${LOAD_TIMEOUT_MS}ms 未完成`);
      if (tab.id === activeTabId) pushBrowserState();
    }, LOAD_TIMEOUT_MS);
    if (tab.id === activeTabId) pushBrowserState();
  });
  contents.on('did-stop-loading', () => {
    clearLoadTimer();
    tab.loadTimedOut = false;
    if (tab.id === activeTabId) pushBrowserState();
  });
  contents.on('did-navigate', (_event, url) => {
    if (isSafeWebUrl(url)) tab.currentUrl = url;
    persistBrowserSession();
    updateTabDisplayLabel(tab, url);
    // Google 账号“拒绝内嵌登录”落地页：按精确主机+路径识别，普通页面自动清除。
    tab.loginRejected = isLoginRejectedUrl(url);
    if (tab.id === activeTabId) pushBrowserState();
  });
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    // 同页导航按当前主框架 URL 重算拒绝状态：
    // - 仅子框架的跳转不得覆盖顶层拒绝状态；
    // - 拒绝路径只变 hash 时 URL 主体不变，仍保持拒绝提示。
    if (isMainFrame) {
      if (isSafeWebUrl(url)) tab.currentUrl = url;
      persistBrowserSession();
      tab.loginRejected = isLoginRejectedUrl(url || contents.getURL());
    }
    if (tab.id === activeTabId) pushBrowserState();
  });
  contents.on('page-title-updated', () => { if (tab.id === activeTabId) pushBrowserState(); });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (!isMainFrame) { logDiagnostic(`tab-frame-fail:${serviceId}`, `subframe ${errorCode} ${errorDescription}`); return; }
    if (errorCode === -3) { logDiagnostic(`tab-frame-fail:${serviceId}`, 'aborted(-3)'); return; }
    logDiagnostic(`tab-fail:${serviceId}`, `${errorCode} ${errorDescription}`);
    tab.error = `平台加载失败（${errorCode}）：${errorDescription}`;
    if (tab.id === activeTabId) pushBrowserState();
  });
  contents.on('render-process-gone', (_event, details) => {
    tab.error = `平台页面异常退出：${details.reason}`;
    logDiagnostic(`platform:${serviceId}`, JSON.stringify(details));
    if (tab.id === activeTabId) pushBrowserState();
  });
  browserTabs.set(tab.id, tab);
  initializedModes[safeMode] = true;
  tab.load = (url = tab.currentUrl) => loadInTab(url);
  downloadOwners.set(contents, tab);
  // 首次加载走统一入口：错误按“平台加载失败”归类，且被后续导航替换时不污染状态。
  if (!deferLoad) tab.load().catch(error => {
    logDiagnostic(`boot-load:${serviceId}`, error.message || String(error));
  });
  if (activate) activateTab(tab.id);
  else persistBrowserSession();
  return tab;
}

function activateTab(tabId) {
  const tab = tabById(tabId);
  if (!tab) throw new Error('创作标签不存在');
  if (!creatorWindow || creatorWindow.isDestroyed()) throw new Error('创作浏览器尚未打开');
  if (activeTabId) dismissAssetOverlay();
  if (activeView && activeView !== tab.view) {
    try { creatorWindow.contentView.removeChildView(activeView); } catch {}
  }
  activeView = tab.view;
  activeTabId = tab.id;
  activeServiceId = tab.serviceId;
  activeMode = tab.mode;
  lastModeTabs[tab.mode] = tab.id;
  if (tab.needsLoad) tab.load();
  applyCreatorLayout({ reorder: true });
  if (!chromeOverlaysHidden) tab.view.webContents.focus();
  pushBrowserState();
  return browserState();
}

function selectServiceTab(serviceId, mode) {
  const safeMode = modeOrDefault(mode);
  if (!validServiceForMode(safeMode, serviceId)) throw new Error('该平台不属于当前创作模式');
  const last = tabById(lastModeTabs[safeMode]);
  const existing = last?.serviceId === serviceId ? last
    : [...browserTabs.values()].find(tab => tab.serviceId === serviceId && tab.mode === safeMode);
  if (existing) return activateTab(existing.id);
  createTab(serviceId, safeMode);
  return browserState();
}

function switchBrowserMode(mode, preferredServiceId) {
  const safeMode = modeOrDefault(mode);
  const last = tabById(lastModeTabs[safeMode]);
  if (last && validServiceForMode(safeMode, last.serviceId)) return activateTab(last.id);
  const existing = [...browserTabs.values()].find(tab => tab.mode === safeMode && validServiceForMode(safeMode, tab.serviceId));
  if (existing) return activateTab(existing.id);
  if (initializedModes[safeMode]) return showEmptyBrowserMode(safeMode);
  const serviceId = validServiceForMode(safeMode, preferredServiceId) ? preferredServiceId : defaultServiceForMode(safeMode);
  return selectServiceTab(serviceId, safeMode);
}

function destroyTab(tab) {
  if (tab.loadTimer) { clearTimeout(tab.loadTimer); tab.loadTimer = null; }
  if (lastModeTabs[tab.mode] === tab.id) lastModeTabs[tab.mode] = null;
  if (tab.id === activeTabId) {
    activeView = null;
    activeTabId = null;
  }
  if (!tab.view.webContents.isDestroyed()) {
    try { creatorWindow?.contentView.removeChildView(tab.view); } catch {}
    try { tab.view.webContents.close(); } catch {}
  }
  browserTabs.delete(tab.id);
}

function closeTab(tabId) {
  const tab = tabById(tabId);
  if (!tab) return browserState();
  const ids = [...browserTabs.values()].filter(candidate => candidate.mode === tab.mode).map(candidate => candidate.id);
  const index = ids.indexOf(tab.id);
  const wasActive = tab.id === activeTabId;
  destroyTab(tab);
  if (wasActive) {
    const nextId = ids[index + 1] || ids[index - 1] || null;
    if (nextId && browserTabs.has(nextId)) {
      activateTab(nextId);
      return browserState();
    }
    return showEmptyBrowserMode(activeMode);
  } else {
    pushBrowserState();
  }
  return browserState();
}

function selectTab(tabId) {
  if (tabById(tabId)?.mode !== activeMode) throw new Error('请先切换到这个标签所属的创作模式');
  return activateTab(tabId);
}

function createAssetView() {
  if (assetView && !assetView.webContents.isDestroyed()) return assetView;
  if (!creatorWindow || creatorWindow.isDestroyed()) throw new Error('创作浏览器尚未打开');

  assetView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'asset-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  const contents = assetView.webContents;
  assetViewGeneration += 1;
  contents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('did-finish-load', () => sendAssetPanelState());
  contents.on('preload-error', (_event, preloadPath, error) => logDiagnostic(`asset-preload:${preloadPath}`, error));
  contents.on('render-process-gone', (_event, details) => {
    logDiagnostic('asset-view', JSON.stringify(details));
    const failedView = assetView;
    assetPanelState.open = false;
    if (failedView && assetViewAttached && creatorWindow && !creatorWindow.isDestroyed()) {
      try { creatorWindow.contentView.removeChildView(failedView); } catch {}
    }
    assetViewAttached = false;
    assetView = null;
    sendAssetPanelState();
    applyCreatorLayout();
  });
  contents.loadURL(`${localServerInfo.url}/creator-assets.html`).catch(error => {
    logDiagnostic('asset-view-load', error);
  });
  return assetView;
}

function attachAssetViewOnTop() {
  if (!creatorWindow || creatorWindow.isDestroyed() || !assetView) return;
  if (assetViewAttached) {
    try { creatorWindow.contentView.removeChildView(assetView); } catch {}
    assetViewAttached = false;
  }
  creatorWindow.contentView.addChildView(assetView);
  assetViewAttached = true;
}

function applyCreatorLayout(options = {}) {
  if (!creatorWindow || creatorWindow.isDestroyed()) return;
  // 只保留当前网页；所有入口共用同一份层级，避免切换标签或关闭弹窗时叠加旧视图。
  for (const tab of browserTabs.values()) {
    if ((workspaceSurface !== 'creator' || !creatorLayoutReady || chromeOverlaysHidden || tab.view !== activeView) && creatorWindow.contentView.children.includes(tab.view)) {
      creatorWindow.contentView.removeChildView(tab.view);
    }
  }
  assetViewAttached = !!assetView && creatorWindow.contentView.children.includes(assetView);
  if (workspaceSurface !== 'creator' || !creatorLayoutReady || chromeOverlaysHidden) {
    if (assetViewAttached) creatorWindow.contentView.removeChildView(assetView);
    assetViewAttached = false;
    return;
  }
  browserBounds = clampBounds(browserBounds);
  let reattachedPlatform = false;
  const children = creatorWindow.contentView.children || [];
  if (activeView && !children.includes(activeView)) {
    creatorWindow.contentView.addChildView(activeView);
    reattachedPlatform = true;
  }
  const panelOpen = !!assetPanelState.open;
  const minimumBrowserWidth = Math.min(420, Math.floor(browserBounds.width / 2));
  const panelWidth = Math.max(1, Math.min(assetPanelState.width, browserBounds.width - minimumBrowserWidth));
  const platformBounds = { ...browserBounds };

  if (panelOpen && assetPanelState.layout === 'push') {
    platformBounds.width = browserBounds.width - panelWidth;
  }
  if (activeView) activeView.setBounds(platformBounds);

  if (!panelOpen) {
    if (assetView && assetViewAttached) {
      try { creatorWindow.contentView.removeChildView(assetView); } catch {}
      assetViewAttached = false;
    }
    sendAssetPanelState();
    return;
  }

  const panel = createAssetView();
  if (!assetViewAttached || options.reorder || reattachedPlatform) attachAssetViewOnTop();
  panel.setBounds({
    x: browserBounds.x + browserBounds.width - panelWidth,
    y: browserBounds.y,
    width: panelWidth,
    height: browserBounds.height,
  });
  sendAssetPanelState();
}

function updateAssetPanel(patch = {}) {
  const wasOpen = !!assetPanelState.open;
  assetPanelState = normalizeAssetPanelState(patch);
  applyCreatorLayout({ reorder: !!assetPanelState.open && !wasOpen });
  return publicAssetPanelState();
}

function dismissAssetOverlay() {
  if (chromeOverlaysHidden || !assetPanelState.open || assetPanelState.layout !== 'overlay') return;
  // 只卸下原生视图，不销毁页面，重新打开时保留目录、筛选与滚动位置。
  updateAssetPanel({ open: false });
}

function clampBounds(bounds) {
  if (!creatorWindow || creatorWindow.isDestroyed()) return browserBounds;
  const [contentWidth, contentHeight] = creatorWindow.getContentSize();
  const number = value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  const x = Math.max(0, Math.min(number(bounds.x), Math.max(0, contentWidth - 120)));
  const y = Math.max(0, Math.min(number(bounds.y), Math.max(0, contentHeight - 120)));
  const width = Math.max(120, Math.min(number(bounds.width), contentWidth - x));
  const height = Math.max(120, Math.min(number(bounds.height), contentHeight - y));
  return { x, y, width, height };
}

function teardownCreatorViews() {
  activeView = null;
  activeTabId = null;
  assetView = null;
  assetViewAttached = false;
  chromeOverlaysHidden = false;
  activeServiceId = null;
  // BrowserWindow 销毁时会统一销毁其 ContentView 子树；此处再 close() 会在
  // Windows 调试连接退出阶段形成重复销毁并触发 0x80000003 断点异常。
  browserTabs.clear();
  lastModeTabs.image = null;
  lastModeTabs.video = null;
}

function hasActiveServiceDownload(serviceId) {
  return [...activeDownloadItems.values()].some(transfer => transfer.record?.serviceId === serviceId
    && ['progressing', 'paused'].includes(transfer.record?.state));
}

function closeServiceTabs(serviceId) {
  for (const tab of [...browserTabs.values()].filter(candidate => candidate.serviceId === serviceId)) {
    destroyTab(tab);
  }
  persistBrowserSession();
}

function removeCreatorService(serviceId, customOnly = false) {
  const service = serviceById(serviceId);
  if (!service) throw new Error('创作网站不存在或已被移除');
  if (customOnly && !service.custom) throw new Error('只能删除已添加的自定义网站');
  if (hasActiveServiceDownload(serviceId)) throw new Error('该网站仍有下载任务，请完成或取消后再删除');
  for (const mode of ['image', 'video']) {
    if (validServiceForMode(mode, serviceId) && modeServices(mode).length <= 1) {
      throw new Error(`${mode === 'image' ? '图片' : '视频'}模式至少需要保留一个网站`);
    }
  }
  const result = service.custom
    ? creatorPlatformStore.remove(serviceId)
    : creatorPlatformStore.hideBuiltin(serviceId);
  if (activeServiceId === serviceId) {
    try {
      const fallback = defaultServiceForMode(activeMode);
      if (!fallback) throw new Error('当前模式没有可用网站');
      selectServiceTab(fallback, activeMode);
    }
    catch (error) { logDiagnostic('creator-platform-remove-fallback', error); }
  }
  closeServiceTabs(serviceId);
  return { id: serviceId, custom: !!service.custom, changed: result?.changed !== false };
}

function removeCustomService(serviceId) {
  return removeCreatorService(serviceId, true);
}

function protectLocalWindow(win) {
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault();
      if (isSafeWebUrl(url)) shell.openExternal(url).catch(() => {});
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeWebUrl(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
}

function enableRendererRecovery(win, scope) {
  let recoveryUsed = false;
  win.webContents.on('render-process-gone', (_event, details) => {
    logDiagnostic(`${scope}-renderer`, JSON.stringify(details));
    if (details.reason === 'clean-exit') return;
    if (SMOKE_TEST) {
      app.exit(1);
      return;
    }
    if (!recoveryUsed) {
      recoveryUsed = true;
      logDiagnostic(`${scope}-renderer`, '首次异常，500ms 后自动重新加载');
      setTimeout(() => {
        if (!win.isDestroyed()) win.reload();
      }, 500);
      return;
    }
    logDiagnostic(`${scope}-renderer`, '自动恢复后再次异常，退出桌面版以触发网页兼容版');
    app.exit(1);
  });
}

function configureApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

function macWindowChrome(trafficLightY = 18) {
  if (process.platform !== 'darwin') return {};
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: trafficLightY },
    vibrancy: 'under-window',
    visualEffectState: 'active',
  };
}

function ensureWorkspaceWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const win = new BrowserWindow({
    width: 1500, height: 930, minWidth: 980, minHeight: 680,
    show: false, autoHideMenuBar: true,
    backgroundColor: '#f5f5f7', title: '视频制作 OS',
    ...macWindowChrome(18),
    webPreferences: {
      preload: path.join(__dirname, 'creator-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    },
  });
  // 两个工作页面共用同一个宿主窗口；第三方网页独立于宿主页面，切页不销毁标签。
  mainWindow = creatorWindow = win;
  protectLocalWindow(win);
  win.webContents.on('preload-error', (_event, preloadPath, error) => logDiagnostic('workspace-preload:' + preloadPath, error));
  enableRendererRecovery(win, 'workspace');
  win.on('unresponsive', () => logDiagnostic('workspace-window', '窗口无响应'));
  win.on('resize', () => applyCreatorLayout());
  win.once('ready-to-show', () => { if (!SMOKE_TEST && !win.isDestroyed()) win.show(); });
  win.on('close', () => {
    persistBrowserSession();
    closingWorkspace = true;
    // 摘下后保留的网页不在窗口子树中，真正关闭窗口时也要释放它们。
    for (const tab of [...browserTabs.values()]) destroyTab(tab);
    if (assetView && !assetView.webContents.isDestroyed()) {
      try { win.contentView.removeChildView(assetView); } catch {}
      assetView.webContents.close();
    }
    teardownCreatorViews();
  });
  win.on('closed', () => {
    mainWindow = creatorWindow = null;
    workspaceSurface = '';
    creatorLayoutReady = false;
    browserSessionRestored = false;
    closingWorkspace = false;
  });
  restoreBrowserSession();
  return win;
}

function navigateWorkspace(surface, params = {}) {
  const navigate = async () => {
    const win = ensureWorkspaceWindow();
    const reused = workspaceSurface === surface && !win.webContents.isLoading();
    if (!reused) {
      workspaceSurface = surface;
      creatorLayoutReady = false;
      chromeOverlaysHidden = false;
      applyCreatorLayout();
      const address = new URL(surface === 'creator' ? '/creator.html' : '/', localServerInfo.url);
      for (const [key, value] of Object.entries(params)) address.searchParams.set(key, value);
      await win.loadURL(address.href);
    }
    if (!SMOKE_TEST) { win.show(); win.focus(); }
    if (reused && surface === 'main' && params.projectPicker) {
      sendMain('os:open-project-picker', { mode: params.projectPicker });
    }
    return { win, reused };
  };
  const result = workspaceNavigation.then(navigate);
  workspaceNavigation = result.catch(() => {});
  return result;
}

async function createMainWindow(pickerMode = '') {
  return navigateWorkspace('main', pickerMode ? { projectPicker: modeOrDefault(pickerMode) } : {});
}

async function createCreatorWindow(initialRequest = 'image') {
  const request = initialRequest && typeof initialRequest === 'object' ? initialRequest : { mode: initialRequest };
  const mode = modeOrDefault(request.mode);
  const requestedProjectId = String(request.projectId || '').trim();
  const project = requestedProjectId ? creativeProjectStore.activate(requestedProjectId) : creativeProjectStore.active();
  if (!project) throw new Error('请先选择一个剧本或灵感工作区');
  productionStore?.activateProject(project.id);
  serverModule.broadcastCreativeProjects?.();
  serverModule.broadcastCreativeAssets?.();
  serverModule.broadcastProduction?.();
  activeMode = mode;
  const { reused } = await navigateWorkspace('creator', { mode, project: project.id });
  if (reused) {
    sendCreator('creator:project-changed', project);
    sendCreator('creator:set-mode', mode);
  }
  if (assetView && !assetView.webContents.isDestroyed()) { assetViewGeneration += 1; assetView.webContents.reloadIgnoringCache(); }
  return { ok: true, reused, project };
}

function requireCreativeAsset(relativePath, expectedType = '') {
  const requested = String(relativePath || '').replace(/\\/g, '/');
  const activeProject = creativeProjectStore.active();
  if (!activeProject || (requested !== activeProject.folder && !requested.startsWith(`${activeProject.folder}/`))) {
    throw new Error('资产不属于当前剧本');
  }
  const entry = resolveCreativeAsset(CREATIVE_ASSET_DIR, requested, 'file');
  const type = entry && classifyCreativeAsset(entry.rel);
  if (!entry || !type || (expectedType && type !== expectedType)) {
    throw new Error(expectedType === 'image' ? '图片不存在或不在创作资产库内' : '资产不存在或不在创作资产库内');
  }
  return { absolutePath: entry.abs, type };
}

function dragIconFor(absolutePath) {
  const image = nativeImage.createFromPath(absolutePath);
  if (image.isEmpty()) return nativeImage.createFromDataURL(DRAG_FALLBACK_ICON).resize({ width: 48, height: 48 });
  const size = image.getSize();
  const scale = Math.min(1, 72 / Math.max(size.width || 1, size.height || 1));
  return scale < 1
    ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' })
    : image;
}

// —— 剪映联动 · 迷你悬浮拖拽窗 ——
// 置顶小窗（不抢焦点 showInactive），只占屏幕一角：拖资产卡片到剪映时间线/素材池即可导入；
// 也可点卡片把文件复制到系统剪贴板，去剪映 ⌘V 粘贴。位置/尺寸记忆在数据目录。
let dragTrayWindow = null;

function dragTrayBoundsFile() {
  return path.join(process.env.VIDEO_OS_DATA_DIR || app.getPath('temp'), 'drag-tray-bounds.json');
}

function createDragTrayWindow() {
  if (dragTrayWindow && !dragTrayWindow.isDestroyed()) {
    dragTrayWindow.showInactive();
    return dragTrayWindow;
  }
  if (!localServerInfo) throw new Error('本地服务尚未就绪');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(dragTrayBoundsFile(), 'utf-8')); } catch {}
  const options = {
    width: 240, height: 400, minWidth: 180, minHeight: 240, maxWidth: 520, maxHeight: 800,
    frame: false, alwaysOnTop: true, show: false, fullscreenable: false, minimizable: false,
    backgroundColor: '#1c1c20', title: '剪映拖拽助手',
    webPreferences: {
      preload: path.join(__dirname, 'drag-tray-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    },
  };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) { options.x = saved.x; options.y = saved.y; }
  if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) { options.width = saved.width; options.height = saved.height; }
  dragTrayWindow = new BrowserWindow(options);
  dragTrayWindow.setAlwaysOnTop(true, 'floating');
  const saveBounds = () => {
    try { fs.writeFileSync(dragTrayBoundsFile(), JSON.stringify(dragTrayWindow.getBounds())); } catch {}
  };
  dragTrayWindow.on('moved', saveBounds);
  dragTrayWindow.on('resize', saveBounds);
  dragTrayWindow.on('closed', () => { dragTrayWindow = null; });
  dragTrayWindow.once('ready-to-show', () => { if (dragTrayWindow && !dragTrayWindow.isDestroyed()) dragTrayWindow.showInactive(); });
  dragTrayWindow.loadURL(`${localServerInfo.url}/drag-tray.html`).catch(error => logDiagnostic('drag-tray-load', error));
  return dragTrayWindow;
}

function toggleDragTrayWindow() {
  if (dragTrayWindow && !dragTrayWindow.isDestroyed()) {
    dragTrayWindow.close();
    return { open: false };
  }
  createDragTrayWindow();
  return { open: true };
}

function registerIpc() {
  ipcMain.handle('creator:automation', (event, request = {}) => {
    requireTrusted(event, 'media');
    if (!creatorAutomation) throw new Error('自动化接口正在启动');
    return creatorAutomation.call(request.name, request.arguments || {});
  });
  ipcMain.handle('os:open-creator', async (event, request) => {
    requireTrusted(event, 'main');
    return createCreatorWindow(request);
  });

  ipcMain.handle('os:add-media-source', async (event, kind) => {
    requireTrusted(event, 'main');
    if (!mediaSourceStore) throw new Error('媒体索引服务尚未就绪');
    const requestedKind = kind === 'downloads' ? 'downloads' : 'folder';
    let rootPath = '';
    if (requestedKind === 'downloads') {
      rootPath = app.getPath('downloads');
    } else {
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: '选择要关联的图片、音频或视频文件夹',
        buttonLabel: '添加到媒体索引',
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
      rootPath = selection.filePaths[0];
    }
    const baseLabel = requestedKind === 'downloads' ? 'Downloads' : (path.basename(rootPath) || '媒体目录');
    const existingLabels = new Set(mediaSourceStore.list({ downloadsPath: app.getPath('downloads') })
      .map(source => source.label.toLocaleLowerCase('zh-CN')));
    let label = baseLabel;
    for (let suffix = 2; existingLabels.has(label.toLocaleLowerCase('zh-CN')); suffix++) {
      label = `${baseLabel} ${suffix}`;
    }
    const source = mediaSourceStore.addDirectory({ label, rootPath, kind: requestedKind });
    serverModule.mediaSourceWatcher?.refresh();
    serverModule.broadcastRescan?.();
    return source;
  });

  ipcMain.handle('os:remove-media-source', (event, sourceId) => {
    requireTrusted(event, 'main');
    if (!mediaSourceStore) throw new Error('媒体索引服务尚未就绪');
    serverModule.prepareMediaSourceRemoval?.();
    const source = mediaSourceStore.remove(String(sourceId || ''));
    serverModule.mediaSourceWatcher?.refresh();
    serverModule.broadcastRescan?.();
    return source;
  });

  ipcMain.handle('creator:get-config', event => {
    requireTrusted(event, 'creator');
    return {
      services: publicServices(),
      modeServices: publicModeServices(),
      defaults: publicDefaults(),
      hiddenBuiltinIds: creatorPlatformStore.hiddenBuiltinIds(),
      paths: creatorPaths(),
      project: creativeProjectStore.active(),
      assetPanel: publicAssetPanelState(),
      nativeQuickAssetDrag: true,
      browser: browserState(),
      testMode: TEST_MODE,
    };
  });

  ipcMain.handle('creator:add-custom-service', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('网站信息格式无效');
    const requestedName = String(payload.name || '').normalize('NFC').trim().toLowerCase();
    const requestedUrl = normalizeBrowserAddress(payload.url);
    if (Object.values(SERVICES).some(service => service.label.toLowerCase() === requestedName
      || service.imageLabel?.toLowerCase() === requestedName || service.videoLabel?.toLowerCase() === requestedName)) {
      throw new Error('该名称已被内置平台使用');
    }
    if (Object.values(SERVICES).some(service => normalizeBrowserAddress(service.url) === requestedUrl)) {
      throw new Error('该网址已是内置平台');
    }
    return creatorPlatformStore.add({ name: payload.name, url: requestedUrl });
  });

  ipcMain.handle('creator:remove-custom-service', (event, serviceId) => {
    requireTrusted(event, 'creator');
    return removeCustomService(String(serviceId || ''));
  });

  ipcMain.handle('creator:rename-service', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    const result = creatorPlatformStore.rename(String(payload.serviceId || ''), payload.name);
    pushBrowserState();
    return result;
  });

  ipcMain.handle('creator:rename-tab', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    const tab = tabById(payload.tabId);
    if (!tab) throw new Error('这个网页已关闭');
    const { normalizePlatformName } = require('./creator-platforms.cjs');
    tab.customName = normalizePlatformName(payload.name);
    pushBrowserState();
    return browserState();
  });

  ipcMain.handle('creator:remove-service', (event, serviceId) => {
    requireTrusted(event, 'creator');
    return removeCreatorService(String(serviceId || ''));
  });

  ipcMain.handle('creator:restore-builtin-service', (event, serviceId) => {
    requireTrusted(event, 'creator');
    return creatorPlatformStore.restoreBuiltin(String(serviceId || ''));
  });

  ipcMain.handle('creator:restore-builtin-services', event => {
    requireTrusted(event, 'creator');
    return creatorPlatformStore.restoreBuiltins();
  });

  ipcMain.handle('creator:set-asset-panel', (event, patch = {}) => {
    requireTrusted(event, 'creator');
    return updateAssetPanel(patch);
  });

  ipcMain.handle('creator:select-service', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    return selectServiceTab(String(payload.serviceId || ''), payload.mode);
  });

  ipcMain.handle('creator:set-mode', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    return switchBrowserMode(payload.mode, payload.serviceId);
  });

  ipcMain.handle('creator:open-tab', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    // 多开：同一平台再开一个独立网页（类似浏览器的“复制标签页”），
    // 指定 afterTabId 时新标签插到源标签旁边，可无限多开并行对话。
    const sourceTabId = String(payload.afterTabId || '');
    const newTab = createTab(String(payload.serviceId || ''), payload.mode);
    if (sourceTabId && browserTabs.has(sourceTabId) && newTab.id !== sourceTabId) {
      const reordered = new Map();
      for (const [id, tab] of browserTabs) {
        reordered.set(id, tab);
        if (id === sourceTabId) reordered.set(newTab.id, newTab);
      }
      browserTabs.clear();
      for (const [id, tab] of reordered) browserTabs.set(id, tab);
    }
    pushBrowserState();
    return browserState();
  });

  ipcMain.handle('creator:select-tab', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    return selectTab(String(payload.tabId || ''));
  });

  ipcMain.handle('creator:close-tab', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    return closeTab(String(payload.tabId || ''));
  });

  ipcMain.handle('creator:clear-tabs', event => {
    requireTrusted(event, 'creator');
    return clearBrowserTabs();
  });

  ipcMain.handle('creator:set-browser-bounds', (event, bounds = {}) => {
    requireTrusted(event, 'creator');
    browserBounds = clampBounds(bounds);
    creatorLayoutReady = true;
    applyCreatorLayout();
    return browserBounds;
  });

  ipcMain.handle('creator:navigate', (event, action) => {
    requireTrusted(event, 'creator');
    if (!activeView || !ALLOWED_NAV_ACTIONS.has(action)) return false;
    dismissAssetOverlay();
    const contents = activeView.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') {
      // 只对“原加载已经超时”的停止给出后续说明；普通页面的停止不误报超时。
      const stoppedTab = tabById(activeTabId);
      if (stoppedTab && stoppedTab.loadTimedOut) stoppedTab.pendingStopNotice = true;
      contents.stop();
    }
    else if (action === 'home' && activeServiceId) {
      const tab = tabById(activeTabId);
      if (tab) tab.displayLabel = '';
      tab?.load(serviceUrl(activeServiceId));
    }
    else return false;
    return true;
  });

  ipcMain.handle('creator:navigate-url', (event, address) => {
    requireTrusted(event, 'creator');
    if (!activeView || !activeServiceId) throw new Error('请先选择一个创作平台');
    const url = normalizeBrowserAddress(address);
    const activeTab = tabById(activeTabId);
    if (!activeTab) throw new Error('当前标签不存在');
    dismissAssetOverlay();
    const seq = ++activeTab.loadSeq;
    activeTab.currentUrl = url;
    persistBrowserSession();
    // 新导航会让旧加载以 ERR_ABORTED 失败：旧回调按序号识别为“已被替换”，不污染新页面状态。
    activeTab.pendingStopNotice = false;
    updateTabDisplayLabel(activeTab, url);
    activeTab.error = '';
    activeView.webContents.loadURL(url).catch(rejectError => {
      if (seq !== activeTab.loadSeq) return;
      // pendingStopNotice：用户对“已超时”的加载点了停止。
      // 停止挂起型请求的拒绝码可能是 ERR_FAILED 而非 ERR_ABORTED，
      // 因此按状态而非错误码判断。
      if (activeTab.pendingStopNotice) {
        activeTab.pendingStopNotice = false;
        activeTab.error = '已停止加载：站点长时间无响应。可重试，或改用系统浏览器打开。';
      } else if (String(rejectError.message).includes('ERR_ABORTED')) {
        activeTab.error = '已停止加载。可重试，或改用系统浏览器打开。';
      } else {
        activeTab.error = `网页打开失败：${rejectError.message}`;
      }
      pushBrowserState();
    });
    return browserState();
  });

  ipcMain.handle('creator:open-external', event => {
    requireTrusted(event, 'creator');
    const url = tabById(activeTabId)?.currentUrl || (activeView && activeView.webContents.getURL())
      || (activeServiceId && serviceById(activeServiceId)?.url)
      || '';
    if (!url || !isSafeWebUrl(url) || TEST_MODE) return false;
    shell.openExternal(url).catch(() => {});
    return true;
  });

  ipcMain.handle('creator:open-folder', async (event, kind) => {
    requireTrusted(event, 'creator');
    const paths = creatorPaths();
    const target = kind === 'image' ? paths.imageRoot : paths.materialRoot;
    if (!target) throw new Error('对应文件夹尚未连接');
    fs.mkdirSync(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('creator:import-files', async (event, mode) => {
    requireTrusted(event, 'creator');
    return importExternalDownloads(mode);
  });

  ipcMain.handle('creator:import-assets', async event => {
    requireTrusted(event, 'creator');
    return importLocalCreativeAssets();
  });

  ipcMain.handle('creator:import-dropped-assets', async (event, payload = {}) => {
    requireTrusted(event, 'creator');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('拖拽素材信息无效');
    return importDroppedCreativeAssets(payload);
  });

  ipcMain.handle('creator:copy-creative-asset', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    // 复制当前剧本的参考图到剪贴板，便于直接粘贴到 GPT 等平台上传。
    const { absolutePath } = requireCreativeAsset(String(payload.path || ''), 'image');
    if (fs.statSync(absolutePath).size > 100 * 1024 * 1024) throw new Error('图片超过 100 MB，无法复制到剪贴板');
    const image = nativeImage.createFromPath(absolutePath);
    if (image.isEmpty()) throw new Error('当前图片格式无法复制');
    clipboard.writeImage(image);
    return true;
  });

  ipcMain.handle('creator:delete-creative-asset', async (event, payload = {}) => {
    requireTrusted(event, 'creator');
    // 创作浏览器左栏快格删除：与资产库一致，移入系统废纸篓可随时恢复。
    const { absolutePath } = requireCreativeAsset(String(payload.path || ''));
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile()) throw new Error('只能删除文件资产');
    await shell.trashItem(absolutePath);
    serverModule.broadcastCreativeAssets?.();
    return true;
  });

  ipcMain.handle('creator:page-zoom', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    // 当前网页缩放：in / out / reset，与标准浏览器一致（步进 0.5，范围 ±3）。
    if (!activeView || activeView.webContents.isDestroyed()) return false;
    const contents = activeView.webContents;
    const action = String(payload.action || '');
    if (action === 'in') contents.setZoomLevel(Math.min(3, contents.getZoomLevel() + 0.5));
    else if (action === 'out') contents.setZoomLevel(Math.max(-3, contents.getZoomLevel() - 0.5));
    else if (action === 'reset') contents.setZoomLevel(0);
    else return false;
    return true;
  });

  ipcMain.handle('creator:set-platform-view-hidden', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    // 模态对话框是 HTML 层，而平台网页/资产浮层是原生视图（永远在 HTML 之上）：
    // 对话框打开期间临时隐藏原生视图，关闭后恢复，否则对话框会被盖住无法操作。
    const hidden = !!payload.hidden;
    if (hidden === chromeOverlaysHidden) return browserState();
    chromeOverlaysHidden = hidden;
    applyCreatorLayout({ reorder: true });
    return browserState();
  });

  ipcMain.handle('creator:open-download', async (event, downloadId) => {
    requireTrusted(event, 'creator');
    const record = recentDownloads.find(item => item.id === downloadId);
    if (!record || !fs.existsSync(record.savePath)) return false;
    shell.showItemInFolder(record.savePath);
    return true;
  });

  ipcMain.handle('creator:download-action', (event, payload = {}) => {
    requireTrusted(event, 'creator');
    const action = String(payload.action || '');
    const transfer = activeDownloadItems.get(String(payload.downloadId || ''));
    const item = transfer?.item;
    if (!item || !ALLOWED_DOWNLOAD_ACTIONS.has(action)) return false;
    if (action === 'pause' && !item.isPaused()) item.pause();
    else if (action === 'resume' && item.canResume()) item.resume();
    else if (action === 'cancel') item.cancel();
    else return false;
    return true;
  });

  ipcMain.handle('creator:focus-browser', event => {
    requireTrusted(event, 'creator');
    if (!activeView) return false;
    dismissAssetOverlay();
    activeView.webContents.focus();
    return true;
  });

  ipcMain.handle('creator:show-main-window', async event => {
    requireTrusted(event, 'creator');
    await createMainWindow();
    return true;
  });

  ipcMain.handle('creator:show-project-menu', async (event, payload = {}) => {
    requireTrusted(event, 'creator');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('剧本菜单参数无效');
    const owner = creatorWindow;
    if (!owner || owner.isDestroyed()) return { cancelled: true };
    const projects = creativeProjectStore.list();
    const activeProjectId = creativeProjectStore.active()?.id;
    const mode = modeOrDefault(payload.mode);
    const zoom = event.sender.getZoomFactor();
    const [width, height] = owner.getContentSize();
    const x = Number.isFinite(payload.x) ? Math.max(0, Math.min(width - 1, Math.round(payload.x * zoom))) : 0;
    const y = Number.isFinite(payload.y) ? Math.max(0, Math.min(height - 1, Math.round(payload.y * zoom))) : 74;
    const selection = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        owner.removeListener('closed', onClosed);
        resolve(value);
      };
      const onClosed = () => finish(null);
      owner.once('closed', onClosed);
      try {
        const menu = Menu.buildFromTemplate([
          { label: '快速切换剧本', enabled: false },
          { type: 'separator' },
          ...projects.map(project => ({
            label: project.name + (project.available === false ? '（目录不可用）' : ''),
            type: 'radio',
            checked: project.id === activeProjectId,
            enabled: project.available !== false,
            click: () => finish({ projectId: project.id }),
          })),
          { type: 'separator' },
          { label: '新建或管理剧本…', click: () => finish({ manage: true }) },
        ]);
        menu.popup({
          window: owner, x, y,
          // Let the selected item's click arrive before treating dismissal as cancel.
          callback: () => setImmediate(() => finish(null)),
        });
      } catch (error) {
        owner.removeListener('closed', onClosed);
        reject(error);
      }
    });
    if (!selection || owner.isDestroyed()) return { cancelled: true };
    if (selection.manage) {
      await createMainWindow(mode);
      return { manage: true };
    }
    if (selection.projectId === creativeProjectStore.active()?.id) {
      return { ok: true, unchanged: true, project: creativeProjectStore.active() };
    }
    // Reuse the existing project transition; keep browser tabs and login sessions alive.
    return createCreatorWindow({ mode, projectId: selection.projectId });
  });

  ipcMain.handle('creator:show-project-picker', async (event, mode) => {
    requireTrusted(event, 'creator');
    await createMainWindow(mode);
    return true;
  });

  ipcMain.handle('creator:get-downloads', event => {
    requireTrusted(event, 'creator');
    const activeProjectId = creativeProjectStore.active()?.id || '';
    return recentDownloads
      .map(publicDownload)
      .filter(download => !download.projectId || download.projectId === activeProjectId);
  });

  ipcMain.handle('asset:get-config', event => {
    requireTrusted(event, 'asset');
    ensureCreativeAssetRoot(CREATIVE_ASSET_DIR);
    return {
      panel: publicAssetPanelState(),
      project: creativeProjectStore.active(),
      rootName: creativeProjectStore.active()?.name || path.basename(CREATIVE_ASSET_DIR),
      rootPath: creatorPaths().activeProjectRoot,
      creativeAssetAvailable: true,
      obsidianAvailable: !!OBSIDIAN_VAULT,
    };
  });

  ipcMain.handle('asset:pick-source-folder', async event => {
    requireTrusted(event, 'asset');
    const result = await dialog.showOpenDialog(creatorWindow || mainWindow, {
      title: '选择外部素材文件夹', properties: ['openDirectory', 'dontAddToRecent'],
    });
    return result.canceled ? { cancelled: true } : { path: result.filePaths[0] };
  });

  ipcMain.handle('asset:set-panel-state', (event, patch = {}) => {
    requireTrusted(event, 'asset');
    return updateAssetPanel(patch);
  });

  const startAssetDrag = (kind, resultChannel) => (event, payload = {}) => {
    try {
      requireTrusted(event, kind);
      // 单文件 {path} 或多文件 {paths:[...按序]}（悬浮窗多选拖拽：Electron files 数组）
      const requested = Array.isArray(payload?.paths) && payload.paths.length
        ? payload.paths.map(p => String(p || '').replace(/\\/g, '/'))
        : [String(payload?.path || '').replace(/\\/g, '/')].filter(Boolean);
      if (!requested.length) throw new Error('缺少资产路径');
      if (requested.length > 100) throw new Error('一次最多拖拽 100 个文件');
      const absolutePaths = requested.map(rel => {
        const { absolutePath } = requireCreativeAsset(rel);
        if (fs.statSync(absolutePath).size > 20 * 1024 * 1024 * 1024) throw new Error(`${rel} 超过 20 GB，拒绝直接拖拽`);
        return absolutePath;
      });
      const dragItem = absolutePaths.length > 1
        ? { files: absolutePaths, icon: dragIconFor(absolutePaths[0]) }
        : { file: absolutePaths[0], icon: dragIconFor(absolutePaths[0]) };
      event.sender.startDrag(dragItem);
      if (!event.sender.isDestroyed()) event.sender.send(resultChannel, { ok: true, path: requested[0], count: absolutePaths.length });
    } catch (error) {
      if (!event.sender.isDestroyed()) event.sender.send(resultChannel, { ok: false, error: error.message });
    }
  };
  ipcMain.on('asset:start-drag', startAssetDrag('asset', 'asset:drag-result'));
  ipcMain.on('creator:start-asset-drag', startAssetDrag('creator', 'creator:asset-drag-result'));
  ipcMain.on('tray:start-asset-drag', startAssetDrag('tray', 'tray:drag-result'));

  // 剪映导入走原生多文件拖拽（startAssetDrag {paths}），剪贴板复制路线已按用户反馈移除。

  ipcMain.handle('creator:toggle-drag-tray', event => {
    requireTrusted(event, 'creator');
    return toggleDragTrayWindow();
  });
  ipcMain.on('tray:close', event => {
    requireTrusted(event, 'tray');
    if (dragTrayWindow && !dragTrayWindow.isDestroyed()) dragTrayWindow.close();
  });

  ipcMain.handle('asset:copy-image', (event, payload = {}) => {
    requireTrusted(event, 'asset');
    const { absolutePath } = requireCreativeAsset(payload.path, 'image');
    if (fs.statSync(absolutePath).size > 100 * 1024 * 1024) throw new Error('图片超过 100 MB，无法复制到剪贴板');
    const image = nativeImage.createFromPath(absolutePath);
    if (image.isEmpty()) throw new Error('当前图片格式无法复制');
    clipboard.writeImage(image);
    return true;
  });

  ipcMain.handle('asset:show-item', (event, payload = {}) => {
    requireTrusted(event, 'asset');
    const { absolutePath } = requireCreativeAsset(payload.path);
    shell.showItemInFolder(absolutePath);
    return true;
  });

  // 创作浏览器快捷面板“在完整库中查看”：打开面板并把目标资产送达面板定位。
  // 送达决策（await 检测就绪期间可能并发导航/重建/换项目/更新目标）：
  // - 就绪、视图世代未变、项目未变、pending 仍是本请求 → 推送并清空；
  // - 面板页被 reload/重建（世代变化）或尚未就绪 → 保留 pending，由新文档 boot 的 consume 取走；
  // - 项目已切换 → 旧目标作废（清空），不得误投新项目；
  // - pending 为其他值 → superseded；pending 已空 → consume（boot 恰好取走本请求）。
  // pending 以 {path, projectId, at} 整体记录/比较/清空：path 与发起时项目身份不拆散，
  // consume 返回完整对象，面板端须再次核对自己就是该 projectId（过期对象带 expired:true，面板实际提示取消），
  // 旧项目请求不得借相同路径误投。发送异常时保留 pending，等待下次推送或 consume，不静默丢失。
  // 有界取消：pending 只在 focus/consume 时惰性检查 TTL（无后台定时器）——过期在“下次交互”时
  // 被丢弃并回执 expired/warn 留痕；面板加载失败期间 pending 保持滞留，属于该边界下的既定行为。
  // TTL 与检测前的测试门闩均可经环境变量注入，便于隔离测试用确定性时序覆盖过期边界。
  const FOCUS_TTL_MS = Number.isFinite(Number(process.env.VIDEO_OS_FOCUS_TTL_MS)) && Number(process.env.VIDEO_OS_FOCUS_TTL_MS) > 0
    ? Number(process.env.VIDEO_OS_FOCUS_TTL_MS) : 30000;
  const FOCUS_GATE_MS = Number.isFinite(Number(process.env.VIDEO_OS_FOCUS_GATE_MS)) && Number(process.env.VIDEO_OS_FOCUS_GATE_MS) > 0
    ? Number(process.env.VIDEO_OS_FOCUS_GATE_MS) : 0;
  const focusExpired = pending => pending && Date.now() - pending.at > FOCUS_TTL_MS;
  let pendingFocus = null;
  ipcMain.handle('asset:focus-asset', async (event, payload = {}) => {
    requireTrusted(event, 'creator');
    const relativePath = String(payload?.path || '').replace(/\\/g, '/');
    const requestProjectId = String(payload?.projectId || '');
    if (!relativePath) return { ok: false, error: '缺少资产路径' };
    const myGeneration = assetViewGeneration;
    pendingFocus = { path: relativePath, projectId: requestProjectId, at: Date.now() };
    // 测试门闩：确定性地让 pending 滞留越过 TTL 边界（生产默认 0 = 无延迟）。
    try { updateAssetPanel({ open: true }); } catch {}
    if (FOCUS_GATE_MS > 0) await new Promise(resolve => setTimeout(resolve, FOCUS_GATE_MS));
    const view = assetView && !assetView.webContents.isDestroyed() ? assetView : null;
    let ready = false;
    if (view) {
      try { ready = await view.webContents.executeJavaScript("document.body?.dataset?.ready === 'true'"); } catch { ready = false; }
    }
    const generationStale = assetViewGeneration !== myGeneration;
    const projectStale = requestProjectId && creativeProjectStore.active()?.id !== requestProjectId;
    const isSameRequest = pendingFocus && pendingFocus.path === relativePath && pendingFocus.projectId === requestProjectId;
    if (ready && !generationStale && !projectStale && isSameRequest) {
      if (focusExpired(pendingFocus)) {
        pendingFocus = null;
        console.warn(`[focus] expired dropped before push: ${relativePath}`);
        return { ok: true, delivered: 'expired' };
      }
      pendingFocus = null;
      try {
        view.webContents.send('asset:focus-asset', { path: relativePath, projectId: requestProjectId });
        return { ok: true, delivered: 'push' };
      } catch (sendError) {
        pendingFocus = { path: relativePath, projectId: requestProjectId, at: Date.now() };
        return { ok: false, delivered: 'pending', error: sendError.message };
      }
    }
    if (projectStale && isSameRequest) pendingFocus = null;
    const delivered = projectStale ? 'stale-project'
      : !pendingFocus ? 'consume'
        : isSameRequest ? 'pending' : 'superseded';
    return { ok: true, delivered };
  });
  ipcMain.handle('asset:consume-pending-focus', event => {
    requireTrusted(event, 'asset');
    const pending = pendingFocus;
    pendingFocus = null;
    if (focusExpired(pending)) {
      console.warn(`[focus] expired dropped at consume: ${pending.path}`);
      return { path: pending.path, projectId: pending.projectId, expired: true };
    }
    return { path: pending.path, projectId: pending.projectId };
  });

  ipcMain.handle('asset:delete-item', async (event, payload = {}) => {
    requireTrusted(event, 'asset');
    // 删除 = 移入系统废纸篓，可随时恢复；只允许删除当前剧本内的文件资产。
    const { absolutePath, type } = requireCreativeAsset(payload.path);
    if (!type || type === 'folder') throw new Error('只能删除文件资产');
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile()) throw new Error('只能删除文件资产');
    await shell.trashItem(absolutePath);
    serverModule.broadcastCreativeAssets?.();
    return true;
  });

  ipcMain.handle('asset:open-library', async event => {
    requireTrusted(event, 'asset');
    ensureCreativeAssetRoot(CREATIVE_ASSET_DIR);
    const error = await shell.openPath(creatorPaths().activeProjectRoot);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('asset:show-project-picker', async event => {
    requireTrusted(event, 'asset');
    await createMainWindow(activeMode);
    return true;
  });
}

async function readSmokeRenderer(webContents, expression, closedValue = 'closed') {
  if (!webContents || webContents.isDestroyed()) return closedValue;
  return webContents.executeJavaScript(expression).catch(error => ({ ready: 'unreadable', error: String(error.message || error) }));
}

async function creatorSmokeSnapshot() {
  const fixtureViews = [...browserTabs.values()]
    .map(entry => entry.view.webContents.getURL())
    .filter(url => url.includes('/creator-fixture.html?service='));
  const creator = await readSmokeRenderer(creatorWindow?.webContents, `({
    ready: document.body.dataset.ready || '',
    mode: document.body.dataset.mode || '',
    error: document.querySelector('#browserRecoveryMessage')?.textContent?.trim().slice(0, 240) || ''
  })`);
  const asset = await readSmokeRenderer(assetView?.webContents, `({
    ready: document.body.dataset.ready || '',
    state: document.querySelector('.asset-state')?.textContent?.trim().slice(0, 240) || ''
  })`);
  return {
    creatorWindow: !!creatorWindow && !creatorWindow.isDestroyed(),
    creator,
    activeServiceId,
    activeView: activeView && !activeView.webContents.isDestroyed() ? activeView.webContents.getURL() : 'closed',
    fixtureCount: fixtureViews.length,
    fixtureViews,
    asset,
  };
}

async function waitForCreatorSmokeReady(timeoutMs = 18000) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    if (!creatorWindow || creatorWindow.isDestroyed()) throw new Error('创作浏览器窗口已关闭');
    lastSnapshot = await creatorSmokeSnapshot();
    if (lastSnapshot.creator.ready === 'error') {
      throw new Error(`创作浏览器前端初始化失败：${JSON.stringify(lastSnapshot)}`);
    }
    if (lastSnapshot.asset.ready === 'error') {
      throw new Error(`创作资产库初始化失败：${JSON.stringify(lastSnapshot)}`);
    }
    if (lastSnapshot.creator.ready === 'true' && lastSnapshot.fixtureCount > 0 && lastSnapshot.asset.ready === 'true') return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`创作浏览器前端或内嵌平台页面初始化超时：${JSON.stringify(lastSnapshot || await creatorSmokeSnapshot())}`);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const target = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow
      : (creatorWindow && !creatorWindow.isDestroyed()) ? creatorWindow : null;
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  });

  app.whenReady().then(async () => {
    initDiagnostics();
    app.on('child-process-gone', (_event, details) => logDiagnostic('child-process', JSON.stringify(details)));
    configureApplicationMenu();
    registerIpc();
    localServerInfo = await serverModule.startServer(START_PORT, 8, { open: false });
    creatorAutomation = createCreatorAutomation({
      directory: process.env.VIDEO_OS_DATA_DIR,
      allowLocal: TEST_MODE,
      getState: () => ({ project: creativeProjectStore.active(), ...browserState() }),
      getProject: () => creativeProjectStore.active(),
      getTab: tabById,
      selectTab,
      resolveAsset: requireCreativeAsset,
      listAssets: search => {
        const active = creativeProjectStore.active();
        if (!active) throw new Error('请先选择项目');
        const listing = buildCreativeAssetTree(CREATIVE_ASSET_DIR, { scopePath: active.folder });
        const items = [];
        const walk = node => { if (node.kind === 'file' && node.path.toLowerCase().includes(search.toLowerCase())) items.push(node); for (const child of node.children || []) walk(child); };
        walk(listing.tree);
        return { projectId: active.id, items: items.slice(0, 1000), truncated: listing.truncated || items.length > 1000 };
      },
    });
    creatorAutomationServer = await serveAutomation(creatorAutomation, path.join(process.env.VIDEO_OS_DATA_DIR, 'creator-automation-connection.json'));
    if (SMOKE_TEST) {
      await createMainWindow();
      await createCreatorWindow('video');
    } else {
      // 创作优先：直接进入创作页面，资产管理与创作共用同一窗口。
      await createCreatorWindow({ mode: activeMode });
    }
    // 剪映联动：全局快捷键 Alt+Shift+D 开关悬浮拖拽窗（剪映在前台时也能呼出/收起，不抢焦点）
    try {
      globalShortcut.register('Alt+Shift+D', () => { try { toggleDragTrayWindow(); } catch {} });
    } catch (error) { logDiagnostic('global-shortcut', error); }
    app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
    if (SMOKE_TEST) {
      setTimeout(async () => {
        try {
          const initialAssetPanel = await creatorWindow.webContents.executeJavaScript(
            'window.creatorAPI.setAssetPanel({ open: true, layout: "overlay", width: 360 })'
          );
          await waitForCreatorSmokeReady();
          const pushPanel = await creatorWindow.webContents.executeJavaScript(
            'window.creatorAPI.setAssetPanel({ open: true, layout: "push", width: 360 })'
          );
          const pushBrowserBounds = activeView.getBounds();
          const overlayPanel = await creatorWindow.webContents.executeJavaScript(
            'window.creatorAPI.setAssetPanel({ open: true, layout: "overlay", width: 360 })'
          );
          const overlayBrowserBounds = activeView.getBounds();
          // —— 遮挡盾（结构证据）：打开清空确认框时，原生 child view 必须整体摘除。
          //    本段读取 main 进程 contentView 真实视图树与 renderer 对话框状态，不依赖窗口焦点。 ——
          const overlayShieldHealth = {};
          await creatorWindow.webContents.executeJavaScript(`
            document.getElementById('promptEditor').value = 'SHIELD-CASE';
            document.getElementById('clearPrompt').click();
          `);
          for (let i = 0; i < 40 && !await creatorWindow.webContents.executeJavaScript("document.getElementById('clearPromptDialog')?.open === true"); i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          for (let i = 0; i < 40 && chromeOverlaysHidden !== true; i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          const childViewsDuringDialog = creatorWindow.contentView.children;
          overlayShieldHealth.rendererDialogOpen = await creatorWindow.webContents.executeJavaScript("document.getElementById('clearPromptDialog')?.open === true");
          overlayShieldHealth.hiddenFlagSet = chromeOverlaysHidden === true;
          overlayShieldHealth.assetViewDetached = !childViewsDuringDialog.includes(assetView);
          overlayShieldHealth.platformViewsDetached = [...browserTabs.values()].every(tab => !childViewsDuringDialog.includes(tab.view));
          await creatorWindow.webContents.executeJavaScript("document.getElementById('clearPromptConfirm')?.click()");
          for (let i = 0; i < 40 && await creatorWindow.webContents.executeJavaScript("document.getElementById('clearPromptDialog')?.open === true"); i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          for (let i = 0; i < 40 && chromeOverlaysHidden !== false; i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          overlayShieldHealth.rendererDialogClosed = await creatorWindow.webContents.executeJavaScript("document.getElementById('clearPromptDialog')?.open === false");
          overlayShieldHealth.hiddenFlagCleared = chromeOverlaysHidden === false;
          overlayShieldHealth.promptCleared = await creatorWindow.webContents.executeJavaScript("document.getElementById('promptEditor')?.value === ''");
          overlayShieldHealth.activeViewRestored = creatorWindow.contentView.children.includes(activeView);
          if (Object.values(overlayShieldHealth).some(value => value !== true)) {
            throw new Error(`对话框原生遮挡盾失败：${JSON.stringify({ overlayShieldHealth, childCountDuringDialog: childViewsDuringDialog.length })}`);
          }
          console.log(`OVERLAY_SHIELD_PASS ${JSON.stringify(overlayShieldHealth)}`);
          // —— 像素探针。证据层级声明：capturePage 只捕获测试窗口 HTML webContents 合成层，
          //    不包含 WebContentsView 原生子视图，不能单独用于遮挡判定；遮挡判定以 OVERLAY_SHIELD 结构断言为准。 ——
          const smokeVerification = { structure: 'pass', ipc: 'pass', pixels: 'not-captured', pointer: 'not-verified-this-batch' };
          try {
            const captured = await creatorWindow.webContents.capturePage();
            const size = captured.getSize();
            if (size.width > 0 && size.height > 0) {
              const pngPath = path.join(process.env.VIDEO_OS_DATA_DIR || app.getPath('temp'), `smoke-window-${Date.now()}.png`);
              fs.writeFileSync(pngPath, captured.toPNG());
              smokeVerification.pixels = `pass ${size.width}x${size.height} -> ${pngPath}`;
              console.log(`SMOKE_WINDOW_CAPTURE ${smokeVerification.pixels}`);
            } else {
              smokeVerification.pixels = `unavailable: empty capture ${JSON.stringify(size)}`;
              console.log(`SMOKE_WINDOW_CAPTURE_UNAVAILABLE ${smokeVerification.pixels}`);
            }
          } catch (captureError) {
            smokeVerification.pixels = `unavailable: ${captureError.message}`;
            console.log(`SMOKE_WINDOW_CAPTURE_UNAVAILABLE ${smokeVerification.pixels}`);
          }
          // —— IPC 项目切换：HTTP activate → fixture server 广播（creative-projects SSE）→ creator.js 既有串行链 → renderer 应用。
          //     同时核对四项：store id、renderer 标题、renderer 草稿、store 归属；重复同项目不得重置草稿；快速 A/B 收敛后必须一致。 ——
          const projectSwitchIpc = {};
          const projectApiBase = `http://127.0.0.1:${localServerInfo.port}/api/creative-projects`;
          const postProjectAction = async body => (await fetch(projectApiBase, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
          const readRenderer = async () => creatorWindow.webContents.executeJavaScript(`({
            title: document.getElementById('currentProject')?.textContent || '',
            draft: document.getElementById('promptEditor')?.value ?? null,
          })`);
          const waitForRendererProject = async (namePart, timeoutRounds = 60) => {
            for (let i = 0; i < timeoutRounds; i++) {
              await new Promise(resolve => setTimeout(resolve, 50));
              const view = await readRenderer();
              if (view.title.includes(namePart)) return view;
            }
            return readRenderer();
          };
          const originalProjectId = creativeProjectStore.active()?.id;
          const originalProjectName = creativeProjectStore.active()?.name || '';
          // 预置原剧本草稿并等待防抖落盘，供切回后核对 renderer 恢复
          await creatorWindow.webContents.executeJavaScript(`
            (() => {
              const editor = document.getElementById('promptEditor');
              editor.value = 'A-KEEP';
              editor.dispatchEvent(new Event('input', { bubbles: true }));
            })();
          `);
          await new Promise(resolve => setTimeout(resolve, 450));
          const createdProject = await postProjectAction({ action: 'create', name: '烟测剧本B' });
          projectSwitchIpc.createAccepted = createdProject?.project?.id != null;
          const targetProjectId = createdProject?.project?.id || '';
          if (targetProjectId) await postProjectAction({ action: 'activate', id: targetProjectId });
          const viewB = await waitForRendererProject('烟测剧本B');
          projectSwitchIpc.storeActivated = creativeProjectStore.active()?.id === targetProjectId;
          projectSwitchIpc.rendererApplied = viewB.title.includes('烟测剧本B');
          projectSwitchIpc.rendererDraftIsolated = viewB.draft === '';
          // 给 B 写入自己的草稿并落盘，供“切回也验证 renderer”使用
          await creatorWindow.webContents.executeJavaScript(`
            (() => {
              const editor = document.getElementById('promptEditor');
              editor.value = 'B-DRAFT';
              editor.dispatchEvent(new Event('input', { bubbles: true }));
            })();
          `);
          await new Promise(resolve => setTimeout(resolve, 450));
          if (originalProjectId) await postProjectAction({ action: 'activate', id: originalProjectId });
          const viewBackA = await waitForRendererProject(originalProjectName);
          projectSwitchIpc.switchedBack = creativeProjectStore.active()?.id === originalProjectId
            && viewBackA.title.includes(originalProjectName);
          projectSwitchIpc.rendererDraftRestored = viewBackA.draft === 'A-KEEP';
          // 重复同项目 activate：同 id 守卫不得重置草稿
          await postProjectAction({ action: 'activate', id: originalProjectId });
          await new Promise(resolve => setTimeout(resolve, 600));
          projectSwitchIpc.duplicateKeepsDraft = (await readRenderer()).draft === 'A-KEEP';
          // 快速 A/B 连发（不等待上一轮完成）：收敛后四项必须一致
          await postProjectAction({ action: 'activate', id: targetProjectId });
          await postProjectAction({ action: 'activate', id: originalProjectId });
          const viewRace = await waitForRendererProject(originalProjectName);
          projectSwitchIpc.raceStoreId = creativeProjectStore.active()?.id === originalProjectId;
          projectSwitchIpc.raceTitleConsistent = viewRace.title.includes(originalProjectName);
          projectSwitchIpc.raceDraftConsistent = viewRace.draft === 'A-KEEP';
          if (!projectSwitchIpc.createAccepted || !projectSwitchIpc.storeActivated || !projectSwitchIpc.rendererApplied
            || !projectSwitchIpc.rendererDraftIsolated || !projectSwitchIpc.switchedBack
            || !projectSwitchIpc.rendererDraftRestored || !projectSwitchIpc.duplicateKeepsDraft
            || !projectSwitchIpc.raceStoreId || !projectSwitchIpc.raceTitleConsistent || !projectSwitchIpc.raceDraftConsistent) {
            throw new Error(`IPC 项目切换验证失败：${JSON.stringify({ projectSwitchIpc })}`);
          }
          await creatorWindow.webContents.executeJavaScript("document.getElementById('promptEditor').value = ''");
          console.log(`PROJECT_SWITCH_IPC_PASS ${JSON.stringify(projectSwitchIpc)}`);
          // —— 跳转定位三路径：真实 handler → 面板（未就绪 boot consume / 就绪推送 / 关闭重开推送）。 ——
          const focusLinkHealth = {};
          const focusReadPanel = () => assetView.webContents.executeJavaScript(`({
            ready: document.body?.dataset?.ready === 'true',
            previewOpen: document.getElementById('previewDialog')?.open === true,
            previewName: document.getElementById('previewName')?.textContent || '',
          })`);
          const panelPreviewOpen = async () => {
            for (let i = 0; i < 80; i++) {
              try { if ((await focusReadPanel()).previewOpen) return true; } catch {}
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            return false;
          };
          // 路径 2：面板重载未就绪时跳转 → 登记 pending → boot consume 后定位
          await assetView.webContents.reloadIgnoringCache();
          const consumeResult = await creatorWindow.webContents.executeJavaScript(
            `window.creatorAPI.focusAssetInLibrary(${JSON.stringify('测试剧本/测试角色.png')})`
          );
          focusLinkHealth.unreadyHandled = ['pending', 'push', 'consume'].includes(consumeResult.delivered);
          // 注：烟测重载窗口较短，面板常在就绪检测前完成加载而走 push；未就绪→pending 分支由
          // test_creator_assets 的 boot-consume 用例覆盖（localStorage 登记 → 重载 → 定位断言）。
          focusLinkHealth.consumeLocated = await panelPreviewOpen()
            && (await focusReadPanel().catch(() => ({ previewName: '' }))).previewName.includes('测试角色.png');
          // 路径 1：面板已就绪 → push 推送（第二次跳转不丢失）
          const pushResult = await creatorWindow.webContents.executeJavaScript(
            `window.creatorAPI.focusAssetInLibrary(${JSON.stringify('测试剧本/测试角色.png')})`
          );
          focusLinkHealth.readyPush = pushResult.delivered === 'push';
          await new Promise(resolve => setTimeout(resolve, 250));
          focusLinkHealth.pushLocated = await panelPreviewOpen();
          // 路径 3：关闭面板后重开 → 页面未销毁，仍走推送并可定位
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.setAssetPanel({ open: false })');
          await new Promise(resolve => setTimeout(resolve, 120));
          const reopenResult = await creatorWindow.webContents.executeJavaScript(
            `window.creatorAPI.focusAssetInLibrary(${JSON.stringify('测试剧本/测试角色.png')})`
          );
          focusLinkHealth.reopenPush = reopenResult.delivered === 'push';
          await new Promise(resolve => setTimeout(resolve, 250));
          focusLinkHealth.reopenLocated = await panelPreviewOpen();
          if (Object.values(focusLinkHealth).some(value => value !== true)) {
            throw new Error(`跳转定位三路径失败：${JSON.stringify(focusLinkHealth)}`);
          }
          console.log(`FOCUS_LINK_PASS ${JSON.stringify(focusLinkHealth)}`);
          const ui = await creatorWindow.webContents.executeJavaScript(`({
            mode: document.body.dataset.mode,
            tabs: Array.from(document.querySelectorAll('.platform-tab')).map(node => node.textContent),
            promptLength: document.querySelector('#promptEditor')?.value.length || 0,
            promptAccordionOpen: document.querySelector('#promptAccordion')?.open,
            assetAccordionOpen: document.querySelector('#assetAccordion')?.open,
            quickAssetCount: document.querySelectorAll('.asset-image-card').length,
            assetTogglePressed: document.querySelector('#toggleAssets')?.getAttribute('aria-pressed'),
            addressEnabled: !document.querySelector('#addressInput')?.disabled
          })`);
          const assetUi = await assetView.webContents.executeJavaScript(`({
            ready: document.body.dataset.ready,
            layout: document.body.dataset.layout,
            imageCount: document.querySelectorAll('.image-card').length,
            folderCount: document.querySelectorAll('.folder-button').length
          })`);
          const fixtureViews = [...browserTabs.values()]
            .map(entry => entry.view.webContents.getURL())
            .filter(url => url.includes('/creator-fixture.html?service='));
          // 发出真实鼠标事件：收起浮层的同一次点击仍须到达网页。
          const preservedAssetView = assetView;
          await assetView.webContents.executeJavaScript(`
            document.getElementById('assetSearch').value = '测试角色';
          `);
          await activeView.webContents.executeJavaScript(`
            window.__assetOverlayClicks = 0;
            window.__assetOverlayEvents = [];
            for (const type of ['mousedown', 'mouseup', 'click']) document.addEventListener(type, event => {
              window.__assetOverlayEvents.push([type, event.clientX, event.clientY, event.target.tagName]);
            }, true);
            const target = document.createElement('button');
            target.textContent = '点击继续网页';
            target.style.cssText = 'position:fixed;left:10px;top:10px;width:160px;height:50px;z-index:9999';
            target.onclick = () => window.__assetOverlayClicks++;
            document.body.appendChild(target);
          `);
          creatorWindow.show();
          creatorWindow.focus();
          activeView.webContents.focus();
          await new Promise(resolve => setTimeout(resolve, 150));
          const clickFixture = async () => {
            activeView.webContents.sendInputEvent({ type: 'mouseMove', x: 30, y: 30 });
            activeView.webContents.sendInputEvent({ type: 'mouseDown', x: 30, y: 30, button: 'left', clickCount: 1 });
            await new Promise(resolve => setTimeout(resolve, 40));
            activeView.webContents.sendInputEvent({ type: 'mouseUp', x: 30, y: 30, button: 'left', clickCount: 1 });
          };
          // —— POINTER_DIAG（D1/D2，只读采集，不改任何成功门槛）：
          //    记录输入事件前后的焦点、几何、缩放与点击计数，并用 HTML 层探针与 WebContentsView 通道对照。 ——
          const collectPointerDiag = async tag => ({
            tag,
            windowFocused: creatorWindow.isFocused(),
            activeViewWebFocused: activeView.webContents.isFocused(),
            creatorWebFocused: creatorWindow.webContents.isFocused(),
            renderer: await activeView.webContents.executeJavaScript('({ hasFocus: document.hasFocus(), visibility: document.visibilityState })'),
            zoom: activeView.webContents.getZoomFactor(),
            activeViewBounds: activeView.getBounds(),
            buttonRect: await activeView.webContents.executeJavaScript('(() => { const r = document.querySelector("button")?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null; })()'),
            clicks: await activeView.webContents.executeJavaScript('window.__assetOverlayClicks || 0'),
          });
          const dualChannelProbe = {};
          try {
            await creatorWindow.webContents.executeJavaScript(`
              (() => {
                const probe = document.createElement('button');
                probe.id = 'smokeInputProbe';
                probe.textContent = 'probe';
                probe.style.cssText = 'position:fixed;left:8px;top:8px;width:60px;height:30px;z-index:99999';
                probe.addEventListener('click', () => { window.__smokeProbeHits = (window.__smokeProbeHits || 0) + 1; });
                document.body.appendChild(probe);
              })()
            `);
            creatorWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 30, y: 20 });
            creatorWindow.webContents.sendInputEvent({ type: 'mouseDown', x: 30, y: 20, button: 'left', clickCount: 1 });
            creatorWindow.webContents.sendInputEvent({ type: 'mouseUp', x: 30, y: 20, button: 'left', clickCount: 1 });
            await new Promise(resolve => setTimeout(resolve, 150));
            dualChannelProbe.htmlLayerHit = await creatorWindow.webContents.executeJavaScript('window.__smokeProbeHits === 1');
          } catch (probeError) {
            dualChannelProbe.htmlLayerHit = `probe-error: ${probeError.message}`;
          }
          const pointerDiagPre = await collectPointerDiag('pre-click1');
          await clickFixture();
          for (let i = 0; i < 60 && await activeView.webContents.executeJavaScript('window.__assetOverlayClicks') < 1; i++) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          const pointerDiagPost1 = await collectPointerDiag('post-click1');
          const overlayFocusHealth = {
            clickDismissed: !assetPanelState.open && !assetViewAttached,
            clickReachedPage: await activeView.webContents.executeJavaScript('window.__assetOverlayClicks') === 1,
          };
          applyCreatorLayout({ reorder: true });
          overlayFocusHealth.staysBehind = !creatorWindow.contentView.children.includes(assetView);
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.setAssetPanel({ open: true })');
          overlayFocusHealth.reopenedWithState = assetView === preservedAssetView && assetViewAttached
            && await assetView.webContents.executeJavaScript('document.getElementById("assetSearch").value') === '测试角色';
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.focusBrowser()');
          overlayFocusHealth.focusDismissed = !assetPanelState.open;
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.setAssetPanel({ open: true, layout: "push" })');
          await clickFixture();
          for (let i = 0; i < 60 && await activeView.webContents.executeJavaScript('window.__assetOverlayClicks') < 2; i++) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          const pointerDiagPost2 = await collectPointerDiag('post-click2');
          const pointerDiag = { dualChannelProbe, pre: pointerDiagPre, post1: pointerDiagPost1, post2: pointerDiagPost2 };
          console.log(`POINTER_DIAG ${JSON.stringify(pointerDiag)}`);
          const occludedHidden = pointerDiag.pre.renderer.visibility === 'hidden' || pointerDiag.post2.renderer.visibility === 'hidden';
          const pointerVerdict = occludedHidden && dualChannelProbe.htmlLayerHit === true && pointerDiagPre.zoom === 1
            ? 'environment-input-gated: occluded WebContentsView renderer visibility=hidden so Chromium drops mouse input before product code; HTML layer probe reachable; coordinates/zoom normal'
            : 'inconclusive: see POINTER_DIAG for focus/geometry evidence';
          console.log(`POINTER_VERDICT ${pointerVerdict}`);
          overlayFocusHealth.splitViewKept = assetPanelState.open && assetViewAttached
            && await activeView.webContents.executeJavaScript('window.__assetOverlayClicks') === 2;
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.setAssetPanel({ open: true, layout: "overlay" })');
          if (Object.values(overlayFocusHealth).some(value => value !== true)) {
            const inputDetails = await activeView.webContents.executeJavaScript('({events: window.__assetOverlayEvents, target: document.elementFromPoint(30, 30)?.outerHTML, width: innerWidth, height: innerHeight})');
            throw new Error(`资产浮层切换失败：${JSON.stringify({ overlayFocusHealth, inputDetails, pointerDiag })}`);
          }
          console.log(`ASSET_OVERLAY_FOCUS_PASS ${JSON.stringify(overlayFocusHealth)}`);
          smokeVerification.pointer = 'pass';
          // 多开检查：同一平台连开两个网页，再关闭当前标签应回退到相邻标签。
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.selectService("gpt", "video")');
          const firstTabId = [...browserTabs.keys()][0];
          await creatorWindow.webContents.executeJavaScript(
            `window.creatorAPI.openTab("gpt", "video", ${JSON.stringify(firstTabId)})`
          );
          const multiTabHealth = { afterOpen: browserTabs.size, activeBeforeClose: activeTabId };
          // 复制标签：新标签应紧邻源标签插入
          multiTabHealth.adjacent = [...browserTabs.keys()][1] === activeTabId;
          multiTabHealth.patchApplied = await activeView.webContents
            .executeJavaScript('!!window.__vosChromePatched && navigator.plugins.length > 0 && navigator.webdriver === false')
            .catch(() => false);
          // 加载超时：挂起端点应在阈值后标记 loadTimedOut；正常导航后清除
          await creatorWindow.webContents.executeJavaScript(
            `window.creatorAPI.navigateUrl(${JSON.stringify(localServerInfo.url + '/__test__/hang')})`
          );
          for (let i = 0; i < 60 && !(tabById(activeTabId) && tabById(activeTabId).loadTimedOut); i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          multiTabHealth.loadTimeoutMarked = !!(tabById(activeTabId) && tabById(activeTabId).loadTimedOut);
          await creatorWindow.webContents.executeJavaScript(
            `window.creatorAPI.navigateUrl(${JSON.stringify(localServerInfo.url + '/creator-fixture.html?service=updream')})`
          );
          for (let i = 0; i < 60 && (tabById(activeTabId) && tabById(activeTabId).loadTimedOut); i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          multiTabHealth.loadTimeoutCleared = !(tabById(activeTabId) && tabById(activeTabId).loadTimedOut);
          // 停止已超时的加载：did-stop-loading 应给出中性后续说明
          await creatorWindow.webContents.executeJavaScript(`window.creatorAPI.navigateUrl(${JSON.stringify(localServerInfo.url + '/__test__/hang')})`);
          for (let i = 0; i < 60 && !(tabById(activeTabId) && tabById(activeTabId).loadTimedOut); i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          await creatorWindow.webContents.executeJavaScript(`window.creatorAPI.navigate('stop')`);
          for (let i = 0; i < 60 && !((tabById(activeTabId) && tabById(activeTabId).error || '').includes('已停止加载')); i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          multiTabHealth.stopAfterTimeoutGuided = (tabById(activeTabId) && tabById(activeTabId).error || '').includes('已停止加载');
          await creatorWindow.webContents.executeJavaScript(
            `window.creatorAPI.navigateUrl(${JSON.stringify(localServerInfo.url + '/creator-fixture.html?service=updream')})`
          );
          for (let i = 0; i < 60 && ((tabById(activeTabId) && tabById(activeTabId).error || '') !== ''); i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          multiTabHealth.stoppedNoteCleared = (tabById(activeTabId) && tabById(activeTabId).error || '') === '';
          // 同页导航状态：主框架 URL 重算拒绝状态；仅 hash 变化保持；子框架不覆盖顶层
          const rejTab = tabById(activeTabId);
          if (rejTab) {
            rejTab.view.webContents.emit('did-navigate-in-page', { preventDefault() {} }, 'https://accounts.google.com/v3/signin/rejected?x=1', true);
            multiTabHealth.loginRejectedWired = rejTab.loginRejected === true;
            rejTab.view.webContents.emit('did-navigate-in-page', { preventDefault() {} }, 'https://accounts.google.com/v3/signin/rejected#anchor', true);
            multiTabHealth.loginRejectedHashKept = rejTab.loginRejected === true;
            rejTab.view.webContents.emit('did-navigate-in-page', { preventDefault() {} }, 'https://chatgpt.com/', false);
            multiTabHealth.loginRejectedMainFrameOnly = rejTab.loginRejected === true;
            rejTab.view.webContents.emit('did-navigate', { preventDefault() {} }, 'https://chatgpt.com/');
            multiTabHealth.loginRejectedClearedOnNavigate = rejTab.loginRejected === false;
          }
          await creatorWindow.webContents.executeJavaScript(
            `window.creatorAPI.closeTab(${JSON.stringify(activeTabId)})`
          );
          multiTabHealth.afterClose = browserTabs.size;
          multiTabHealth.activeAfterClose = activeServiceId;
          // 使用真实网页实例验证双模式隔离，不能只检查标签文字。
          const videoTab = tabById(activeTabId);
          for (let i = 0; i < 80 && videoTab.view.webContents.isLoading(); i++) await new Promise(resolve => setTimeout(resolve, 25));
          await videoTab.view.webContents.executeJavaScript(`
            history.replaceState(null, '', '#video-draft');
            const draft = document.createElement('textarea'); draft.id = 'modeDraft'; draft.value = '视频对白草稿';
            document.body.appendChild(draft);
          `);
          const videoUrl = videoTab.view.webContents.getURL();
          await creatorWindow.webContents.executeJavaScript(`window.creatorAPI.renameTab(${JSON.stringify(videoTab.id)}, '视频脚本')`);
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.setMode("image", "gpt")');
          const imageTab = tabById(activeTabId);
          const modeIsolationHealth = {
            separatePages: imageTab.id !== videoTab.id && imageTab.view !== videoTab.view,
            sharedLogin: imageTab.session === videoTab.session,
            fixedOwnership: imageTab.mode === 'image' && videoTab.mode === 'video',
          };
          const downloadsBefore = recentDownloads.length;
          await videoTab.view.webContents.executeJavaScript('document.getElementById("testVideoDownload").click()', true);
          for (let i = 0; i < 80 && (recentDownloads.length === downloadsBefore || recentDownloads[0].state === 'progressing'); i++) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          modeIsolationHealth.backgroundDownload = recentDownloads.length > downloadsBefore
            && recentDownloads[0].mode === 'video' && recentDownloads[0].state === 'completed';
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.openTab("gpt", "image")');
          const secondImageId = activeTabId;
          await creatorWindow.webContents.executeJavaScript(`window.creatorAPI.renameTab(${JSON.stringify(secondImageId)}, '人物图')`);
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.setMode("video", "gpt")');
          modeIsolationHealth.videoRestored = activeTabId === videoTab.id && videoTab.customName === '视频脚本'
            && videoTab.view.webContents.getURL() === videoUrl
            && await videoTab.view.webContents.executeJavaScript('document.getElementById("modeDraft").value') === '视频对白草稿';
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.setMode("image", "gpt")');
          modeIsolationHealth.lastMultiTabRestored = activeTabId === secondImageId && tabById(activeTabId).customName === '人物图';
          await creatorWindow.webContents.executeJavaScript(`window.creatorAPI.closeTab(${JSON.stringify(secondImageId)})`);
          modeIsolationHealth.closeStaysInMode = activeMode === 'image' && activeTabId === imageTab.id;
          await creatorWindow.webContents.executeJavaScript(`window.creatorAPI.closeTab(${JSON.stringify(imageTab.id)})`);
          modeIsolationHealth.lastCloseStaysInMode = activeMode === 'image' && activeTabId === null && browserTabs.has(videoTab.id);
          for (const tab of [...browserTabs.values()].filter(tab => tab.mode === 'image')) destroyTab(tab);
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.setMode("video", "gpt")');
          if (Object.values(modeIsolationHealth).some(value => value !== true)) {
            throw new Error(`图片／视频网页隔离失败：${JSON.stringify(modeIsolationHealth)}`);
          }
          console.log(`MODE_ISOLATION_PASS ${JSON.stringify(modeIsolationHealth)}`);
          const customPlatform = await creatorWindow.webContents.executeJavaScript(
            'window.creatorAPI.addCustomService({ name: "烟测创作站", url: "https://example.test/studio" })'
          );
          const customConfig = await creatorWindow.webContents.executeJavaScript('window.creatorAPI.getConfig()');
          await creatorWindow.webContents.executeJavaScript(
            `window.creatorAPI.selectService(${JSON.stringify(customPlatform.id)}, "video")`
          );
          for (let attempt = 0; attempt < 60 && !(activeView?.webContents.getURL() || '').includes('creator-fixture.html'); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          const customFixtureUrl = activeView?.webContents.getURL() || '';
          await creatorWindow.webContents.executeJavaScript(
            `window.creatorAPI.removeCustomService(${JSON.stringify(customPlatform.id)})`
          );
          const configAfterCustomRemove = await creatorWindow.webContents.executeJavaScript('window.creatorAPI.getConfig()');
          const customPlatformHealth = {
            addedToImage: customConfig.modeServices.image.includes(customPlatform.id),
            addedToVideo: customConfig.modeServices.video.includes(customPlatform.id),
            fixtureUrl: customFixtureUrl,
            removed: !configAfterCustomRemove.services.some(service => service.id === customPlatform.id),
            fallbackService: activeServiceId,
          };
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.removeService("grok")');
          const configAfterBuiltinHide = await creatorWindow.webContents.executeJavaScript('window.creatorAPI.getConfig()');
          await creatorWindow.webContents.executeJavaScript('window.creatorAPI.restoreBuiltinService("grok")');
          const configAfterBuiltinRestore = await creatorWindow.webContents.executeJavaScript('window.creatorAPI.getConfig()');
          const builtinPlatformHealth = {
            hidden: configAfterBuiltinHide.hiddenBuiltinIds.includes('grok')
              && !configAfterBuiltinHide.modeServices.image.includes('grok')
              && !configAfterBuiltinHide.modeServices.video.includes('grok'),
            restored: !configAfterBuiltinRestore.hiddenBuiltinIds.includes('grok')
              && configAfterBuiltinRestore.modeServices.image.includes('grok')
              && configAfterBuiltinRestore.modeServices.video.includes('grok'),
          };
          // 同窗往返：触发真实按钮，平台 renderer 与未提交内容必须保留。
          const workspaceId = creatorWindow.id;
          const tabSnapshot = () => [...browserTabs.values()].map(tab => ({
            id: tab.id, contentsId: tab.view.webContents.id, url: tab.view.webContents.getURL(),
          }));
          const beforeNavigation = tabSnapshot();
          const previousActiveId = activeTabId;
          await activeView.webContents.executeJavaScript("window.__navigationDraft = 'UNSENT-KEEP'");
          await creatorWindow.webContents.executeJavaScript("document.getElementById('showMainWindow').click(); true");
          for (let i = 0; i < 100; i++) {
            const ready = await readSmokeRenderer(mainWindow?.webContents, "location.pathname === '/' && typeof WM !== 'undefined' && !!WM.activeId");
            if (ready === true) break;
            await new Promise(resolve => setTimeout(resolve, 60));
          }
          const mainPage = await mainWindow.webContents.executeJavaScript(`({
            route: location.pathname,
            retiredNav: document.querySelectorAll('[data-app="scripts"], [data-app="projects"]').length,
            ready: typeof WM !== 'undefined' && !!WM.activeId,
          })`);
          const detached = [...browserTabs.values()].every(tab => !mainWindow.contentView.children.includes(tab.view))
            && (!assetView || !mainWindow.contentView.children.includes(assetView));
          await mainWindow.webContents.executeJavaScript("WM.open('assets'); true");
          await mainWindow.webContents.executeJavaScript("document.querySelector('.library-advanced-toggle').click()");
          const filters = await mainWindow.webContents.executeJavaScript(`({
            expanded: document.querySelector('.library-advanced-toggle').getAttribute('aria-expanded'),
            toolbarHeight: document.querySelector('.assets-toolbar').getBoundingClientRect().height,
            controlsVisible: !document.querySelector('.library-advanced-controls').hidden,
          })`);
          await mainWindow.webContents.executeJavaScript("window.desktopOS.openCreatorBrowser({mode:'video'}); true");
          await waitForCreatorSmokeReady();
          const sameWindowHealth = {
            oneWindow: BrowserWindow.getAllWindows().length === 1 && creatorWindow.id === workspaceId && creatorWindow === mainWindow,
            mainPage, detached, filters,
            tabsPreserved: JSON.stringify(beforeNavigation) === JSON.stringify(tabSnapshot()) && previousActiveId === activeTabId,
            draftPreserved: await activeView.webContents.executeJavaScript("window.__navigationDraft === 'UNSENT-KEEP'"),
          };
          if (!sameWindowHealth.oneWindow || !mainPage.ready || mainPage.retiredNav || !detached
            || !sameWindowHealth.tabsPreserved || !sameWindowHealth.draftPreserved
            || filters.expanded !== 'true' || !filters.controlsVisible || filters.toolbarHeight > 100) {
            throw new Error('同窗切换失败：' + JSON.stringify(sameWindowHealth));
          }
          console.log('SAME_WINDOW_NAVIGATION_PASS ' + JSON.stringify(sameWindowHealth));
          const productionHealth = productionStore && productionStore.health();
          const smokeShot = productionStore && productionStore.createShot({
            shotNo: `SMOKE-${Date.now()}`,
            title: '桌面发行版制作台账验证',
            status: 'planned',
          });
          const priorSmokeContext = productionStore && productionStore.getContext();
          const smokeContext = smokeShot && productionStore.setContext({
            activeShotId: smokeShot.id,
            mode: 'video',
            serviceId: 'updream',
            expectedRevision: priorSmokeContext && priorSmokeContext.revision,
          });
          if (ui.mode !== 'video' || ui.tabs.length !== 1 || ui.tabs[0] !== 'Updream'
            || !ui.addressEnabled || ui.promptLength !== 0
            || ui.promptAccordionOpen !== false || ui.assetAccordionOpen !== true || ui.quickAssetCount !== 1
            || ui.assetTogglePressed !== 'true' || assetUi.ready !== 'true' || assetUi.imageCount !== 1
            || !assetUi.folderCount || pushPanel.layout !== 'push' || overlayPanel.layout !== 'overlay'
            || pushBrowserBounds.width >= overlayBrowserBounds.width || !fixtureViews.length
            || multiTabHealth.afterOpen !== 3 || multiTabHealth.afterClose !== 2 || multiTabHealth.activeAfterClose !== 'gpt'
            || !multiTabHealth.adjacent || !multiTabHealth.patchApplied
            || !multiTabHealth.loadTimeoutMarked || !multiTabHealth.loadTimeoutCleared
            || !multiTabHealth.stopAfterTimeoutGuided || !multiTabHealth.stoppedNoteCleared
            || !multiTabHealth.loginRejectedWired || !multiTabHealth.loginRejectedHashKept
            || !multiTabHealth.loginRejectedMainFrameOnly || !multiTabHealth.loginRejectedClearedOnNavigate
            || configAfterCustomRemove.modeServices.video.length !== 7
            || !customPlatformHealth.addedToImage || !customPlatformHealth.addedToVideo
            || !customPlatformHealth.fixtureUrl.includes(`service=${encodeURIComponent(customPlatform.id)}`)
            || !customPlatformHealth.removed || customPlatformHealth.fallbackService !== 'updream'
            || !builtinPlatformHealth.hidden || !builtinPlatformHealth.restored
            || !initialAssetPanel.open || !productionHealth?.ok || !smokeContext || smokeContext.active_shot_id !== smokeShot.id) {
            throw new Error(`桌面烟雾检查不完整：${JSON.stringify({ ui, assetUi, initialAssetPanel, pushPanel, overlayPanel, pushBrowserBounds, overlayBrowserBounds, fixtureViews, multiTabHealth, customPlatformHealth, builtinPlatformHealth, productionHealth, smokeContext })}`);
          }
          console.log(`ELECTRON_SMOKE_PASS ${JSON.stringify({ packaged: app.isPackaged, mainUrl: mainWindow?.webContents.getURL(), creatorUrl: creatorWindow?.webContents.getURL(), ui, assetUi, assetPanel: publicAssetPanelState(), pushBrowserBounds, overlayBrowserBounds, fixtureViews, multiTabHealth, customPlatformHealth, builtinPlatformHealth, production: { health: productionHealth.ok, activeShot: smokeContext.shot_no }, smokeVerification })}`);
          app.exit(0);
        } catch (error) {
          console.error(`ELECTRON_SMOKE_FAIL ${error.stack || error}`);
          app.exit(1);
        }
      }, 150);
    }
  }).catch(error => {
    logDiagnostic('startup', error);
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (process.platform !== 'darwin' || !localServerInfo) return;
  if (creatorWindow && !creatorWindow.isDestroyed()) {
    creatorWindow.show();
    creatorWindow.focus();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createCreatorWindow({ mode: activeMode }).catch(error => logDiagnostic('activate', error));
    return;
  }
  mainWindow.show();
});

app.on('before-quit', () => {
  persistBrowserSession();
  creatorAutomationServer?.close();
  if (serverModule.server.listening) serverModule.server.close();
  try { if (productionStore) productionStore.close(); } catch {}
});
