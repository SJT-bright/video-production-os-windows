'use strict';

// 执行 main.cjs 的实际控制器函数，仅替换 Electron 边界；不启动 App 或真实网页。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createBrowserSessionStore } = require('./electron/browser-session.cjs');
const { isSafeBrowserAddress, normalizeBrowserAddress } = require('./electron/browser-address.cjs');

const mainSource = fs.readFileSync(path.join(__dirname, 'electron/main.cjs'), 'utf-8');
const functionNames = [
  'modeOrDefault', 'safeServiceUrl', 'tabById', 'serviceTabLabel', 'publicTabs', 'browserState',
  'updateTabDisplayLabel', 'pushBrowserState', 'persistBrowserSession', 'restoreBrowserSession',
  'showEmptyBrowserMode', 'clearBrowserTabs', 'createTab', 'activateTab', 'selectServiceTab',
  'switchBrowserMode', 'destroyTab', 'closeTab', 'selectTab', 'applyCreatorLayout', 'clampBounds',
  'teardownCreatorViews', 'ensureWorkspaceWindow', 'navigateWorkspace',
];

function extractFunction(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(mainSource);
  assert.ok(start, `main.cjs 缺少实际函数 ${name}`);
  const remainder = mainSource.slice(start.index);
  const next = /\n(?:async )?function \w+\(/.exec(remainder);
  assert.ok(next, `无法确定 ${name} 的函数边界`);
  return remainder.slice(0, next.index);
}

const controllerSource = functionNames.map(extractFunction).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-browser-retention-'));
const controllers = [];

function createController(filePath) {
  const store = createBrowserSessionStore({ filePath });
  const initial = store.load();
  const writes = [];
  const diagnostics = [];
  const partitions = new Map();
  let sequence = 0;
  let failWrites = false;

  class Contents extends EventEmitter {
    constructor() {
      super();
      this.id = ++sequence;
      this.url = '';
      this.destroyed = false;
      this.loading = false;
      this.loads = [];
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    }
    isDestroyed() { return this.destroyed; }
    isLoading() { return this.loading; }
    getURL() { return this.url; }
    getTitle() { return '本地隔离测试页'; }
    setWindowOpenHandler() {}
    focus() {}
    send() {}
    loadURL(url) {
      this.loads.push(url);
      this.loading = true;
      this.emit('did-start-loading');
      this.url = url;
      this.emit('did-navigate', {}, url);
      this.loading = false;
      this.emit('did-stop-loading');
      return Promise.resolve();
    }
    navigateFromPage(url, { inPage = false, mainFrame = true } = {}) {
      if (mainFrame) this.url = url;
      if (inPage) this.emit('did-navigate-in-page', {}, url, mainFrame);
      else this.emit('did-navigate', {}, url);
    }
    close() {
      if (this.destroyed) return;
      this.emit('did-stop-loading');
      this.destroyed = true;
      this.emit('destroyed');
    }
  }

  class View {
    constructor() { this.webContents = new Contents(); }
    setBounds(bounds) { this.bounds = bounds; }
  }

  class Window extends EventEmitter {
    constructor() {
      super();
      this.id = ++sequence;
      this.destroyed = false;
      this.webContents = new Contents();
      this.contentView = {
        children: [],
        addChildView: view => {
          if (!this.contentView.children.includes(view)) this.contentView.children.push(view);
        },
        removeChildView: view => {
          this.contentView.children = this.contentView.children.filter(child => child !== view);
        },
      };
    }
    isDestroyed() { return this.destroyed; }
    getContentSize() { return [1500, 930]; }
    loadURL(url) { return this.webContents.loadURL(url); }
    show() {}
    focus() {}
    close() {
      if (this.destroyed) return;
      this.emit('close');
      this.destroyed = true;
      this.webContents.close();
      this.emit('closed');
    }
  }

  const services = {
    gpt: { id: 'gpt', label: 'GPT', url: 'https://chatgpt.com/' },
    updream: { id: 'updream', label: 'Updream', url: 'https://www.updream.cn/' },
  };
  const context = vm.createContext({
    URL, console, path, __dirname: path.join(__dirname, 'electron'),
    WebContentsView: View, BrowserWindow: Window,
    setTimeout: () => ++sequence, clearTimeout: () => {},
    TEST_MODE: false, SMOKE_TEST: true, LOAD_TIMEOUT_MS: 30000,
    localServerInfo: { url: 'http://127.0.0.1:3750' },
    mainWindow: null, creatorWindow: null, workspaceSurface: '', creatorLayoutReady: false,
    workspaceNavigation: Promise.resolve(), activeView: null, assetView: null, assetViewAttached: false,
    chromeOverlaysHidden: false, activeServiceId: null, activeMode: initial?.activeMode || 'image',
    activeTabId: null, tabSequence: 0, browserBounds: { x: 410, y: 112, width: 900, height: 700 },
    assetPanelState: { open: false, layout: 'overlay', width: 520 },
    browserTabs: new Map(), lastModeTabs: { image: null, video: null }, downloadOwners: new WeakMap(),
    activeDownloadItems: new Map(), initializedModes: { image: false, video: false, ...initial?.initializedModes },
    restoringBrowserSession: false, closingWorkspace: false, browserSessionRestored: false, lastBrowserSnapshot: '',
    browserSessionStore: {
      load: () => store.load(),
      save: snapshot => {
        if (failWrites) throw new Error('injected disk full');
        const saved = store.save(snapshot);
        writes.push(saved);
        return saved;
      },
    },
    creatorPlatformStore: { displayName: () => '' },
    serviceById: id => services[id] || null,
    serviceUrl: id => { assert.ok(services[id]); return services[id].url; },
    validServiceForMode: (mode, id) => ['image', 'video'].includes(mode) && (id === 'gpt' || (mode === 'video' && id === 'updream')),
    defaultServiceForMode: mode => mode === 'video' ? 'updream' : 'gpt',
    isSafeWebUrl: isSafeBrowserAddress, normalizeBrowserAddress,
    isLoginRejectedUrl: () => false,
    session: {
      fromPartition: name => {
        if (!partitions.has(name)) partitions.set(name, {
          name,
          clearStorageData() { throw new Error('标签操作不得清空网站登录数据'); },
        });
        return partitions.get(name);
      },
    },
    configureSession() {}, installCreatorContextMenu() {}, dismissAssetOverlay() {},
    sendCreator() {}, sendMain() {}, sendAssetPanelState() {}, protectLocalWindow() {}, enableRendererRecovery() {},
    macWindowChrome: () => ({}),
    logDiagnostic: (scope, detail) => diagnostics.push({ scope, detail: String(detail) }),
  });
  vm.runInContext(controllerSource, context, { filename: 'main.cjs:browser-retention-controller' });
  const api = {
    context, store, writes, diagnostics,
    failWrites: value => { failWrites = value; },
    async open() {
      await context.navigateWorkspace('creator', { mode: context.activeMode });
      this.readyLayout();
    },
    readyLayout() { context.creatorLayoutReady = true; context.applyCreatorLayout(); },
    state: () => plain(context.browserState()),
    tabs: () => [...context.browserTabs.values()],
    close: () => context.mainWindow?.close(),
  };
  controllers.push(api);
  return api;
}

async function run() {
  const filePath = path.join(testRoot, 'retained', 'session.json');
  let app = createController(filePath);
  await app.open();
  const c = app.context;
  const first = c.createTab('gpt', 'image', { id: 'image-first', initialUrl: 'https://chatgpt.com/c/first#reply', customName: '人物图' });
  const video = c.createTab('gpt', 'video', { id: 'video-script', initialUrl: 'https://chatgpt.com/c/script?take=2', customName: '视频脚本' });
  const second = c.createTab('gpt', 'image', { id: 'image-second', initialUrl: 'https://example.com/scene#result', customName: '场景图' });
  c.activateTab(video.id);
  video.view.webContents.unsentDraft = 'KEEP UNSENT';
  const originalTabs = app.tabs();
  const originalState = app.state();
  const originalLoads = originalTabs.map(tab => tab.view.webContents.loads.length);
  const originalWindow = c.mainWindow;
  await c.navigateWorkspace('main');
  assert.equal(c.mainWindow, originalWindow);
  assert.equal(c.mainWindow.contentView.children.some(view => originalTabs.some(tab => tab.view === view)), false, '大厅应摘下网页视图');
  await c.navigateWorkspace('creator', { mode: 'video' });
  app.readyLayout();
  assert.equal(c.mainWindow, originalWindow, '工作区往返应复用原窗口');
  assert.deepEqual(app.tabs(), originalTabs, '工作区往返不得更换标签或 WebContentsView');
  assert.deepEqual(app.state(), originalState);
  assert.deepEqual(originalTabs.map(tab => tab.view.webContents.loads.length), originalLoads, '工作区往返不能重新加载网页');
  assert.equal(video.view.webContents.unsentDraft, 'KEEP UNSENT');

  first.view.webContents.navigateFromPage('https://chatgpt.com/c/background-new');
  assert.equal(app.store.load().tabs[0].url, 'https://chatgpt.com/c/background-new', '后台标签导航必须独立保存');
  first.view.webContents.navigateFromPage('https://chatgpt.com/c/background-new#reply-4', { inPage: true });
  assert.equal(app.store.load().tabs[0].url, 'https://chatgpt.com/c/background-new#reply-4', '后台 SPA/hash 地址必须保存');
  first.view.webContents.navigateFromPage('https://iframe.example/', { inPage: true, mainFrame: false });
  assert.equal(app.store.load().tabs[0].url, 'https://chatgpt.com/c/background-new#reply-4', '子框架地址不能覆盖顶层标签');
  assert.equal(c.activeTabId, video.id, '后台导航不得抢占当前标签');

  const saved = app.store.load();
  const writesBeforeClose = app.writes.length;
  // 模拟窗口关闭时仍有原生导航回调；释放页面期间不能把正在缩短的列表写入磁盘。
  for (const tab of originalTabs) {
    tab.view.webContents.on('destroyed', () => tab.view.webContents.emit('did-navigate', {}, tab.currentUrl));
  }
  app.close();
  assert.equal(c.browserTabs.size, 0);
  assert.equal(c.browserSessionRestored, false);
  assert.deepEqual(app.store.load(), saved, '真正关闭窗口应保存会话，不能被 teardown 空列表覆盖');
  assert.ok(app.writes.slice(writesBeforeClose).every(snapshot => snapshot.tabs.length === saved.tabs.length));
  c.persistBrowserSession();
  assert.deepEqual(app.store.load(), saved, '窗口已销毁后的迟到回调也不能覆盖存储');

  app = createController(filePath);
  await app.open();
  assert.equal(app.writes.length, 0, '恢复过程中不得把部分重建的标签覆盖原会话');
  assert.deepEqual(app.store.load(), saved);
  assert.deepEqual(app.tabs().map(tab => ({ id: tab.id, mode: tab.mode, url: tab.currentUrl, customName: tab.customName })),
    saved.tabs.map(({ id, mode, url, customName }) => ({ id, mode, url, customName })), '重启恢复标签顺序、模式、地址和名称');
  assert.equal(app.state().mode, 'video');
  assert.equal(app.state().tabId, video.id);
  assert.deepEqual(app.tabs().map(tab => tab.view.webContents.loads.length), [0, 1, 0], '重启仅加载当前标签，后台标签延迟加载');
  const restored = app.context;
  restored.switchBrowserMode('image', 'gpt');
  assert.equal(restored.activeTabId, second.id, '每种模式应恢复上次选中的标签');
  assert.deepEqual(app.tabs().map(tab => tab.view.webContents.loads.length), [0, 1, 1]);
  restored.switchBrowserMode('video', 'gpt');
  restored.switchBrowserMode('image', 'gpt');
  assert.deepEqual(app.tabs().map(tab => tab.view.webContents.loads.length), [0, 1, 1], '已加载网页再次切换不得重载');
  restored.closeTab(second.id);
  assert.equal(restored.activeTabId, first.id);
  restored.closeTab(first.id);
  assert.equal(restored.activeMode, 'image');
  assert.equal(restored.activeTabId, null);
  assert.equal(restored.activeServiceId, null);
  assert.deepEqual(app.tabs().map(tab => tab.id), [video.id], '关闭图片最后标签不能补默认网页或关闭视频标签');
  restored.switchBrowserMode('video', 'gpt');
  restored.switchBrowserMode('image', 'gpt');
  assert.equal(restored.activeTabId, null, '再次回到已清空模式仍须为空');
  app.close();

  app = createController(filePath);
  await app.open();
  assert.equal(app.state().mode, 'image');
  assert.equal(app.state().tabId, null, '重启保留某模式最后标签关闭后的空状态');
  assert.deepEqual(app.tabs().map(tab => tab.id), [video.id]);
  assert.equal(app.tabs()[0].view.webContents.loads.length, 0, '空模式启动不加载另一模式网页');
  app.context.switchBrowserMode('video', 'gpt');
  const beforeFailedClear = app.state();
  const beforeFailedClearDisk = app.store.load();
  const retainedView = app.tabs()[0].view;
  app.failWrites(true);
  assert.throws(() => app.context.clearBrowserTabs(), /injected disk full/);
  assert.deepEqual(app.state(), beforeFailedClear, '清空写盘失败必须保留全部标签状态');
  assert.equal(retainedView.webContents.isDestroyed(), false);
  assert.deepEqual(app.store.load(), beforeFailedClearDisk);
  app.failWrites(false);
  app.context.clearBrowserTabs();
  assert.equal(app.tabs().length, 0);
  assert.equal(retainedView.webContents.isDestroyed(), true);
  assert.deepEqual(app.store.load().initializedModes, { image: true, video: true });
  assert.deepEqual(app.store.load().tabs, []);
  app.close();

  app = createController(filePath);
  await app.open();
  for (const mode of ['image', 'video', 'image']) {
    app.context.switchBrowserMode(mode, mode === 'image' ? 'gpt' : 'updream');
    assert.equal(app.state().mode, mode);
    assert.equal(app.state().tabId, null);
    assert.equal(app.state().serviceId, null);
    assert.equal(app.tabs().length, 0, '主动清空全部后重启、切模式均不得打开默认网页');
  }
  app.context.selectServiceTab('gpt', 'image');
  assert.equal(app.tabs().length, 1, '主动清空后仍应允许用户明确打开新网页');
  assert.equal(app.diagnostics.length, 0);
  console.log('BROWSER_RETENTION_PASS sameWindow=true restartRestore=true lazyLoading=true emptyModes=true clearFailurePreservesTabs=true backgroundNavigationSaved=true closeDoesNotOverwrite=true');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const controller of controllers) controller.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
});
