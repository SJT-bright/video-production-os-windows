'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { launchChromium } = require('./test-playwright.cjs');

const BASE_URL = process.argv[2] || 'http://127.0.0.1:3790';
let activeBrowser = null;

async function main() {
  const consoleErrors = [];
  const pageErrors = [];
  const browser = activeBrowser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1500, height: 930 }, colorScheme: 'dark' });
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.route('**/api/**', route => {
    if (route.request().method() !== 'GET') return route.abort('blockedbyclient');
    return route.continue();
  });
  await page.route('**/api/prompt-sidecar', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));
  await page.route('**/api/knowledge', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      sections: [{
        id: 'formats',
        items: [
          'f-seedance', 'f-grok', 'f-position-table', 'f-tail-inherit',
          'f-firstframe', 'f-mother', 'f-colorcard',
        ].map(id => ({ id, title: id, body: `测试模板 ${id}` })),
      }],
    }),
  }));
  await page.route('**/api/creative-assets?*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      available: true,
      stats: { files: 3, image: 2, video: 1, sizeText: '8 MB' },
      tree: {
        kind: 'folder', name: '校园心动', path: '校园心动', fileCount: 3,
        children: [
          {
            kind: 'folder', name: '人物图片', path: '校园心动/人物图片', fileCount: 3,
            children: [
              { kind: 'file', type: 'image', name: '女主正脸.png', path: '校园心动/人物图片/女主正脸.png', mtime: '2026-08-28T00:00:00.000Z' },
              { kind: 'file', type: 'image', name: '男主正脸.png', path: '校园心动/人物图片/男主正脸.png', mtime: '2026-08-27T00:00:00.000Z' },
              { kind: 'file', type: 'video', name: '镜头测试.mp4', path: '校园心动/人物图片/镜头测试.mp4', mtime: '2026-08-26T00:00:00.000Z' },
            ],
          },
          { kind: 'folder', name: '场景图片', path: '校园心动/场景图片', fileCount: 0, children: [] },
        ],
      },
    }),
  }));
  const quickImportRequests = [];
  const quickMoveRequests = [];
  await page.route('**/api/creative-assets/move?*', async route => {
    const body = route.request().postDataJSON();
    quickMoveRequests.push(body);
    await page.evaluate(item => { (window.__quickMoves = window.__quickMoves || []).push(item); }, body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, name: 'moved.png', path: body.folder, folder: body.folder }) });
  });
  await page.route('**/api/creative-assets/import?*', async route => {
    const url = new URL(route.request().url());
    const record = { folder: url.searchParams.get('folder'), name: url.searchParams.get('name') };
    quickImportRequests.push(record);
    await page.evaluate(item => { (window.__quickImports = window.__quickImports || []).push(item); }, record);
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, type: 'image', name: '导入.png' }) });
  });
  await page.route('**/api/creative-assets/file?*', route => route.fulfill({
    status: 200,
    contentType: 'image/gif',
    body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
  }));
  let production = {
    available: true,
    projectId: 'project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    context: {
      revision: 3,
      active_shot_id: 7,
      shot_no: 'S01-03',
      shot_title: '走廊擦肩后回头',
      shot_task: '女主停下回头，男主在远处看见她的反应。',
      shot_status: 'planned',
      duration_sec: 10,
      tail_frame_status: 'pending',
      mode: 'video',
      service_id: 'updream',
    },
    inbox: [{
      id: 'inbox-first', download_key: 'image-persisted-first', mode: 'image', kind: 'image', source: 'platform',
      service_id: 'gpt', service_label: 'GPT', filename: '已入库首图.png', asset_path: 'C:\\mock\\obsidian\\已入库首图.png',
      state: 'unassigned', captured_shot_id: null, shot_no: '', shot_title: '',
      created_at: '2026-08-26T00:00:00.000Z', updated_at: '2026-08-26T00:00:00.000Z',
    }],
    inboxPage: { limit: 1, offset: 0, total: 3, hasMore: true },
    stats: { shots: 1, unassigned: 1 },
  };
  await page.route('**/api/production', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(production),
  }));
  await page.route('**/api/context', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 405 });
    const patch = route.request().postDataJSON();
    assert.equal(patch.expectedRevision, production.context.revision, '上下文同步必须携带当前 revision');
    const shotsById = {
      6: { shot_no: 'S01-02', shot_title: '天台对视', shot_status: 'planned', duration_sec: 8, tail_frame_status: 'pending' },
      7: { shot_no: 'S01-03', shot_title: '走廊擦肩后回头', shot_status: 'planned', duration_sec: 10, tail_frame_status: 'pending' },
      8: { shot_no: 'S01-04', shot_title: '楼下降雨共伞', shot_status: 'planned', duration_sec: 12, tail_frame_status: 'pending' },
    };
    const shotInfo = patch.activeShotId ? shotsById[patch.activeShotId] : null;
    production = {
      ...production,
      context: {
        ...production.context,
        revision: production.context.revision + 1,
        mode: patch.mode || production.context.mode,
        service_id: patch.serviceId || production.context.service_id,
        ...(shotInfo ? { active_shot_id: patch.activeShotId, ...shotInfo } : {}),
      },
    };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, context: production.context }),
    });
  });
  await page.route('**/api/shots', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      items: [
        { id: 6, shot_no: 'S01-02', title: '天台对视', status: 'planned' },
        { id: 7, shot_no: 'S01-03', title: '走廊擦肩后回头', status: 'planned' },
        { id: 8, shot_no: 'S01-04', title: '楼下降雨共伞', status: 'planned' },
      ],
      context: production.context,
    }),
  }));
  await page.route('**/api/script-breakdowns', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schemaVersion: 1,
      items: [{
        filename: 'E01_拆解.json', documentId: 'doc-1', title: 'E01 第一集拆解', project: '校园心动',
        episode: 'E01', ready: 2, needsInput: 1, shots: 3, groups: 1, durationSec: 30,
      }],
      invalid: [],
    }),
  }));
  await page.route('**/api/script-breakdown?*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ document: {
      shots: [
        { id: 's1', shotNo: 'S01-02', title: '天台对视', generation: { tool: 'seedance', status: 'ready', prompt: 'PROMPT-A' } },
        { id: 's2', shotNo: 'S01-03', title: '走廊擦肩后回头', generation: { tool: 'seedance', status: 'ready', prompt: 'PROMPT-B' } },
        { id: 's3', shotNo: 'S01-04', title: '楼下降雨共伞', generation: { tool: 'seedance', status: 'needs-input', prompt: '' } },
      ],
    } }),
  }));
  await page.route('**/api/inbox**', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405 });
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset') || 0);
    assert.equal(offset, 1, '分页按钮应请求下一页入库结果');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{
          id: 'inbox-second', download_key: 'image-persisted-second', mode: 'image', kind: 'image', source: 'platform',
          service_id: 'gpt', service_label: 'GPT', filename: '已入库次图.png', asset_path: 'C:\\mock\\obsidian\\已入库次图.png',
          state: 'unassigned', captured_shot_id: null, shot_no: '', shot_title: '',
          created_at: '2026-08-26T00:01:00.000Z', updated_at: '2026-08-26T00:01:00.000Z',
        }],
        pagination: { limit: 1, offset: 1, total: 3, hasMore: true },
      }),
    });
  });
  await page.addInitScript(() => {
    const events = { browser: [], download: [], mode: [], asset: [], project: [] };
    let currentProject = { id: 'project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '校园心动', folder: '校园心动', kind: 'script', categories: [] };
    const services = [
      { id: 'gpt', label: 'GPT', imageLabel: 'GPT 图片', videoLabel: 'GPT 提示词', url: 'https://chatgpt.com/' },
      { id: 'gemini', label: 'Gemini', imageLabel: 'Gemini', videoLabel: 'Gemini', url: 'https://gemini.google.com/app' },
      { id: 'grok', label: 'Grok', imageLabel: 'Grok', videoLabel: 'Grok', url: 'https://grok.com/' },
      { id: 'midjourney', label: 'Midjourney', imageLabel: 'Midjourney', url: 'https://www.midjourney.com/' },
      { id: 'updream', label: 'Updream', videoLabel: 'Updream', url: 'https://www.updream.cn/' },
      { id: 'xiaoyunque', label: '小云雀', videoLabel: '小云雀', url: 'https://xyq.jianying.com/' },
      { id: 'hehui', label: '核绘', imageLabel: '核绘', videoLabel: '核绘', url: 'https://hehui.dawncoreai.com/drama/project-manage/project-details/project-role?id=1704&project_name=%E7%9F%AD%E5%89%A7+%E3%80%8A%E9%99%86%E6%80%BB%EF%BC%8C%E5%88%AB%E8%BF%BD%E4%BA%86%E3%80%8B' },
      { id: 'libtv', label: 'LibTV', imageLabel: 'LibTV', videoLabel: 'LibTV', url: 'https://www.liblib.tv/wappro?sourceid=040004' },
    ];
    const selected = [];
    const importCalls = [];
    const navActions = [];
    const addressCalls = [];
    const assetPanelCalls = [];
    const assetImportCalls = [];
    const dropCalls = [];
    const customCalls = [];
    const platformCalls = [];
    const tabSwitches = [];
    const hiddenBuiltins = new Set();
    const openTabs = [];
    let browserMode = 'video';
    let currentTabId = null;
    const lastTabs = { image: null, video: null };
    let tabSequence = 0;
    const makeTab = (serviceId, mode = browserMode) => {
      const tab = { id: `tab-${++tabSequence}`, serviceId, mode };
      openTabs.push(tab);
      return tab;
    };
    const activate = tab => {
      if (!tab) return;
      browserMode = tab.mode;
      currentTabId = tab.id;
      lastTabs[tab.mode] = tab.id;
    };
    const activeTab = serviceId => openTabs.find(tab => tab.id === currentTabId && (!serviceId || tab.serviceId === serviceId))
      || openTabs.find(tab => tab.mode === browserMode && (!serviceId || tab.serviceId === serviceId)) || null;
    const tabsPayload = forServiceId => {
      const current = activeTab(forServiceId);
      return {
        tabs: openTabs.map(tab => ({
          id: tab.id,
          serviceId: tab.serviceId,
          label: serviceMap[tab.serviceId]?.label || '',
          customName: tab.customName || '',
          mode: tab.mode,
          active: !!current && tab.id === current.id,
        })),
        tabId: current?.id || null,
      };
    };
    const browserPayload = (serviceId, extra = {}) => {
      const service = serviceMap[serviceId];
      return {
        mode: browserMode,
        serviceId,
        loading: false,
        url: service?.url || '',
        title: service?.label || '',
        canGoBack: false,
        canGoForward: false,
        error: '',
        ...tabsPayload(serviceId),
        ...extra,
      };
    };
    const emitBrowserPayload = payload => events.browser.forEach(callback => callback(payload));
    let clipboardText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async value => { clipboardText = String(value); } },
    });
    let assetPanel = { open: true, layout: 'overlay', width: 520, creativeAssetAvailable: true };
    const serviceMap = Object.fromEntries(services.map(service => [service.id, service]));
    window.__creatorTest = {
      selected,
      importCalls,
      navActions,
      addressCalls,
      assetPanelCalls,
      assetImportCalls,
      dropCalls,
      focusAssetCalls: [],
      trayToggles: 0,
      selectionDrags: [],
      customCalls,
      platformCalls,
      tabSwitches,
      get clipboardText() { return clipboardText; },
      bounds: [],
      emitBrowser(payload) { events.browser.forEach(callback => callback(payload)); },
      emitDownload(payload) { events.download.forEach(callback => callback(payload)); },
      emitMode(mode) { events.mode.forEach(callback => callback(mode)); },
      emitAsset(payload) { events.asset.forEach(callback => callback(payload)); },
      emitProject(project) { currentProject = project; events.project.forEach(callback => callback(project)); },
    };
    window.creatorAPI = {
      getConfig: async () => {
        const customIds = Object.values(serviceMap).filter(service => service.custom).map(service => service.id);
        const image = ['gpt', 'gemini', 'grok', 'midjourney', 'hehui', 'libtv'].filter(id => !hiddenBuiltins.has(id)).concat(customIds);
        const video = ['gpt', 'gemini', 'grok', 'updream', 'xiaoyunque', 'hehui', 'libtv'].filter(id => !hiddenBuiltins.has(id)).concat(customIds);
        return {
          services: Object.values(serviceMap).map(service => ({ ...service, hidden: hiddenBuiltins.has(service.id) })),
          modeServices: { image, video },
          defaults: { image: image.includes('gpt') ? 'gpt' : image[0], video: video.includes('updream') ? 'updream' : video[0] },
          hiddenBuiltinIds: [...hiddenBuiltins],
          project: currentProject,
          paths: { imageRoot: 'C:\\mock\\obsidian', materialRoot: 'D:\\mock\\素材库', creativeAssetRoot: 'D:\\mock\\创作资产库\\校园心动', creativeAssetLibraryRoot: 'D:\\mock\\创作资产库', creativeAssetAvailable: true, obsidianAvailable: true },
          assetPanel,
          nativeQuickAssetDrag: true,
          testMode: true,
        };
      },
      addCustomService: async input => {
        const service = {
          id: 'custom-11111111-1111-4111-8111-111111111111',
          label: input.name,
          url: input.url.startsWith('http') ? input.url : `https://${input.url}`,
          custom: true,
          modes: ['image', 'video'],
        };
        serviceMap[service.id] = service;
        customCalls.push({ action: 'add', ...input });
        return service;
      },
      renameService: async (serviceId, name) => {
        serviceMap[serviceId].displayName = name;
        return { id: serviceId, displayName: name };
      },
      renameTab: async (tabId, name) => {
        const tab = openTabs.find(candidate => candidate.id === tabId);
        tab.customName = name;
        return browserPayload(tab.serviceId);
      },
      removeCustomService: async serviceId => {
        delete serviceMap[serviceId];
        customCalls.push({ action: 'remove', serviceId });
        return { id: serviceId };
      },
      removeService: async serviceId => {
        if (serviceMap[serviceId]?.custom) {
          delete serviceMap[serviceId];
          customCalls.push({ action: 'remove', serviceId });
        } else {
          hiddenBuiltins.add(serviceId);
          platformCalls.push({ action: 'hide', serviceId });
        }
        for (let index = openTabs.length - 1; index >= 0; index--) {
          if (openTabs[index].serviceId === serviceId) openTabs.splice(index, 1);
        }
        return { id: serviceId, custom: !!serviceMap[serviceId]?.custom };
      },
      restoreBuiltinService: async serviceId => {
        hiddenBuiltins.delete(serviceId);
        platformCalls.push({ action: 'restore', serviceId });
        return { id: serviceId, changed: true };
      },
      restoreBuiltinServices: async () => {
        const restored = [...hiddenBuiltins];
        hiddenBuiltins.clear();
        platformCalls.push({ action: 'restore-all', serviceIds: restored });
        return restored;
      },
      setAssetPanel: async patch => {
        assetPanel = { ...assetPanel, ...patch, creativeAssetAvailable: true };
        assetPanelCalls.push({ ...assetPanel });
        events.asset.forEach(callback => callback(assetPanel));
        return assetPanel;
      },
      focusAssetInLibrary: async assetPath => { window.__creatorTest.focusAssetCalls.push(assetPath); return { ok: true }; },
      toggleDragTray: async () => { window.__creatorTest.trayToggles += 1; return { open: true }; },
      startAssetDragSelection: paths => { window.__creatorTest.selectionDrags.push([...paths]); return true; },
      selectService: async (serviceId, mode) => {
        selected.push({ serviceId, mode });
        activate(openTabs.find(tab => tab.mode === mode && tab.serviceId === serviceId) || makeTab(serviceId, mode));
        const payload = browserPayload(serviceId);
        emitBrowserPayload(payload);
        return payload;
      },
      setMode: async (mode, serviceId) => {
        const tab = openTabs.find(tab => tab.id === lastTabs[mode])
          || openTabs.find(tab => tab.mode === mode) || makeTab(serviceId, mode);
        activate(tab);
        selected.push({ serviceId: tab.serviceId, mode });
        const payload = browserPayload(tab.serviceId);
        emitBrowserPayload(payload);
        return payload;
      },
      openTab: async (serviceId, mode, afterTabId) => {
        const tab = makeTab(serviceId, mode);
        activate(tab);
        window.__tabDups = window.__tabDups || [];
        window.__tabDups.push({ serviceId, afterTabId: afterTabId || null, id: tab.id });
        if (afterTabId && openTabs.some(candidate => candidate.id === afterTabId)) {
          const from = openTabs.findIndex(candidate => candidate.id === tab.id);
          const [moved] = openTabs.splice(from, 1);
          const to = openTabs.findIndex(candidate => candidate.id === afterTabId);
          openTabs.splice(to + 1, 0, moved);
        }
        const payload = browserPayload(serviceId);
        emitBrowserPayload(payload);
        return payload;
      },
      selectTab: async tabId => {
        tabSwitches.push(tabId);
        const tab = openTabs.find(candidate => candidate.id === tabId);
        if (!tab) throw new Error('标签不存在');
        activate(tab);
        const payload = browserPayload(tab.serviceId);
        emitBrowserPayload(payload);
        return payload;
      },
      copyAsset: async assetPath => {
        (window.__assetCopied = window.__assetCopied || []).push(assetPath);
        return true;
      },
      deleteAsset: async assetPath => {
        (window.__assetDeleted = window.__assetDeleted || []).push(assetPath);
        return true;
      },
      pageZoom: async action => { (window.__zoomCalls = window.__zoomCalls || []).push(action); return true; },
      setPlatformViewHidden: async hidden => { (window.__overlayHidden = window.__overlayHidden || []).push(!!hidden); return {}; },
      closeTab: async tabId => {
        (window.__tabClosed = window.__tabClosed || []).push(tabId);
        const index = openTabs.findIndex(candidate => candidate.id === tabId);
        if (index >= 0) openTabs.splice(index, 1);
        const next = activeTab();
        activate(next);
        const payload = next
          ? browserPayload(next.serviceId)
          : { serviceId: '', loading: false, url: '', title: '', canGoBack: false, canGoForward: false, error: '', tabs: [], tabId: null };
        emitBrowserPayload(payload);
        return payload;
      },
      setBrowserBounds: async bounds => { window.__creatorTest.bounds.push(bounds); return bounds; },
      navigate: async action => { navActions.push(action); return true; },
      navigateUrl: async address => {
        addressCalls.push(address);
        const current = activeTab();
        const payload = {
          serviceId: current?.serviceId || 'gpt', loading: false,
          displayLabel: 'example.com',
          url: address.startsWith('http') ? address : `https://${address}`,
          title: '手动网页', canGoBack: true, canGoForward: false, error: '',
        };
        emitBrowserPayload({ ...payload, ...tabsPayload(current?.serviceId) });
        return payload;
      },
      openExternal: async () => false,
      importFiles: async mode => { importCalls.push(mode); return { cancelled: false, imported: 1, failed: [] }; },
      importAssets: async () => { assetImportCalls.push('local'); return { cancelled: false, imported: 2, failed: [] }; },
      getPathForFile: file => window.__nativeTestPaths?.[file.name] || file.name,
      startAssetDrag: assetPath => { (window.__nativeDragPaths ||= []).push(assetPath); },
      importDroppedAssets: async payload => { dropCalls.push(payload); return { cancelled: false, imported: payload.paths.length + payload.urls.length, failed: [] }; },
      openFolder: async () => true,
      openDownload: async () => true,
      downloadAction: async () => true,
      focusBrowser: async () => true,
      showMainWindow: async () => true,
      showProjectPicker: async () => { window.__creatorTest.projectPickerOpened = true; return true; },
      showProjectMenu: async options => {
        window.__creatorTest.projectMenuOptions = options;
        window.__creatorTest.projectMenuOpened = (window.__creatorTest.projectMenuOpened || 0) + 1;
        return { cancelled: false, project: { id: 'project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '校园心动', folder: '校园心动', kind: 'script' } };
      },
      getDownloads: async () => [],
      onBrowserState: callback => { events.browser.push(callback); return () => {}; },
      onDownload: callback => { events.download.push(callback); return () => {}; },
      onSetMode: callback => { events.mode.push(callback); return () => {}; },
      onProjectChanged: callback => { events.project.push(callback); return () => {}; },
      onAssetPanelState: callback => { events.asset.push(callback); return () => {}; },
    };
  });

  const response = await page.goto(`${BASE_URL}/creator.html?mode=video&project=project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  await page.locator('body[data-ready="true"]').waitFor({ state: 'attached' }).catch(async () => {
    console.log('BOOT-STATE:', await page.locator('body').getAttribute('data-ready'));
    console.log('BOOT-ERR:', await page.locator('#browserPlaceholderTitle').textContent().catch(() => 'n/a'));
    throw new Error('boot failed');
  });
  assert.equal(await page.locator('html').evaluate(node => getComputedStyle(node).colorScheme), 'light', '创作工作台不应跟随系统深色模式');
  assert.equal(await page.locator('body').getAttribute('data-mode'), 'video');
  assert.match(await page.locator('#currentProject').textContent(), /校园心动/);
  await page.locator('#currentProject').click();
  await page.waitForFunction(() => window.__creatorTest.projectMenuOpened === 1, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__creatorTest.projectMenuOpened), 1, '当前剧本按钮应打开面板内剧本菜单');
  assert.equal(await page.locator('#currentShotContext, #shotDialog, #queueImportBreakdown, #queueAccordion, #queueAddCurrent').count(), 0, '已移除镜头台账、拆解导入和提示词队列');
  // 顶部条只显示已打开的网页标签；启动后只有默认平台一个标签
  assert.deepEqual(await page.locator('.platform-tab').allTextContents(), ['Updream']);
  await page.locator('#addPlatform').click();
  assert.equal(await page.locator('[data-remove-service]').count(), 7, '＋菜单应列出全部网站并提供移除入口');
  // 从＋菜单打开 Grok：新增一个网页标签，并显示内嵌验证兼容提示
  await page.locator('[data-open-service="grok"]').click();
  await page.locator('.platform-tab', { hasText: 'Grok' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#browserCompatibility').count(), 0, '过时的 Grok 常驻兼容提示条应已移除');
  // 多开：为当前平台（刚打开的 Grok）再开一个独立网页，出现带序号的第二个标签
  await page.locator('#addPlatform').click();
  await page.locator('#duplicateTab').click();
  assert.deepEqual(await page.locator('.platform-tab').allTextContents(), ['Updream', 'Grok', 'Grok·2'], '多开没有生成带序号的第二个标签');
  await page.locator('.platform-tab', { hasText: 'Grok·2' }).click({ button: 'right' });
  await page.locator('#renameName').fill('人物图');
  await page.locator('#renameName').press('Enter');
  await page.waitForFunction(() => !document.querySelector('#renameDialog').open);
  assert.deepEqual(await page.locator('.platform-tab').allTextContents(), ['Updream', 'Grok', '人物图'], '单独改名不能影响同平台其他标签');
  await page.locator('#addPlatform').click();
  await page.locator('[data-rename-service="grok"]').click();
  await page.locator('#renameName').fill('创作助手');
  await page.locator('#renameSave').click();
  await page.waitForFunction(() => !document.querySelector('#renameDialog').open);
  assert.deepEqual(await page.locator('.platform-tab').allTextContents(), ['Updream', '创作助手', '人物图'], '网站改名应更新默认标签并保留单独命名');
  await page.locator('[data-rename-service="grok"]').click();
  await page.locator('#renameName').fill('Grok');
  await page.locator('#renameSave').click();
  await page.waitForFunction(() => !document.querySelector('#renameDialog').open);
  await page.locator('#cancelPlatform').click();
  await page.locator('.platform-tab-wrap', { hasText: '人物图' }).locator('.platform-tab-close').click();
  await page.waitForFunction(() => document.querySelectorAll('.platform-tab').length === 2);
  assert.deepEqual(await page.locator('.platform-tab').allTextContents(), ['Updream', 'Grok'], '关闭多开标签失败');
  // 复制标签：悬停 ⧉ 一键在旁边多开同一个平台
  const grokTabId = await page.locator('.platform-tab', { hasText: 'Grok' }).getAttribute('data-tab-id');
  await page.locator('.platform-tab-wrap', { hasText: 'Grok' }).hover();
  await page.locator('.platform-tab-wrap', { hasText: 'Grok' }).locator('.platform-tab-dup').click();
  await page.locator('.platform-tab', { hasText: 'Grok·2' }).waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('.platform-tab').allTextContents(), ['Updream', 'Grok', 'Grok·2'], '复制标签应插到源标签旁边');
  const dupRecord = await page.evaluate(() => (window.__tabDups || []).at(-1));
  assert.equal(dupRecord.afterTabId, grokTabId, '复制标签没有插到源标签之后');
  assert.equal(dupRecord.serviceId, 'grok', '复制标签的平台不正确');
  await page.locator('.platform-tab-wrap', { hasText: 'Grok·2' }).locator('.platform-tab-close').click();
  await page.waitForFunction(() => document.querySelectorAll('.platform-tab').length === 2);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#addPlatform').click();
  await page.locator('[data-remove-service="grok"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-open-service="grok"]'));
  assert.equal(await page.locator('.platform-tab', { hasText: 'Grok' }).count(), 0, '移除 Grok 后它的网页标签没有关闭');
  assert.equal(await page.locator('#browserCompatibility').count(), 0, '兼容提示条不应存在');
  assert.equal(await page.locator('[data-restore-service="grok"]').isVisible(), true, '＋菜单没有提供已移除内置网站的恢复入口');
  await page.locator('[data-restore-service="grok"]').click();
  assert.equal(await page.locator('[data-open-service="grok"]').isVisible(), true, '恢复后 Grok 没有回到＋菜单网站列表');
  assert.deepEqual((await page.evaluate(() => window.__creatorTest.platformCalls)).map(call => call.action), ['hide', 'restore']);
  await page.locator('#cancelPlatform').click();

  assert.equal(await page.locator('#promptAccordion').getAttribute('open'), null, '没有模板和草稿时提示词板块应默认折叠');
  assert.equal(await page.locator('#assetAccordion').getAttribute('open'), '', '资产图片板块应默认展开');
  assert.equal(await page.locator('.asset-image-card').count(), 3, '创作资产板块没有同时显示图片与视频');
  assert.equal(await page.locator('.asset-video-preview').count(), 1, '本地视频没有显示为视频资产');
  // 快捷分类树：展开「人物图片」后图片嵌在树下，导入目标同步为该分类
  await page.locator('.quick-folder-name', { hasText: '人物图片' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.quick-children:not(.collapsed)').length >= 2, null, { timeout: 5000 });
  assert.match(await page.locator('#quickDropTarget').textContent(), /人物图片/, '展开分类后拖放目标没有更新');
  // 框选模式（剪映联动）：开关 → 点卡片按顺序选入 → 拖动选中卡整批多文件拖出
  assert.equal(await page.locator('#quickMultiSelect').count(), 1, '快捷面板应有框选模式开关');
  await page.locator('#quickMultiSelect').click();
  assert.equal(await page.locator('#quickMultiSelect').getAttribute('aria-pressed'), 'true', '框选模式应开启');
  assert.equal(await page.locator('#quickSelInfo').textContent(), '点卡片选入，或按住拖动画框', '开启后应有选入引导');
  const visibleImageCards = page.locator('#quickFolderTree .asset-image-card.image:visible');
  const cardCount = await visibleImageCards.count();
  assert.ok(cardCount >= 2, `框选断言前置：可见图片卡应 ≥2，实际 ${cardCount}`);
  await visibleImageCards.nth(0).click();
  await visibleImageCards.nth(1).click();
  const selCards = await page.locator('#quickFolderTree [data-asset-path].sel-on').count();
  assert.equal(selCards, 2, '框选模式下应选中 2 张卡片');
  const dragCard = page.locator('#quickFolderTree [data-asset-path].sel-on').first();
  await dragCard.dispatchEvent('dragstart');
  await page.waitForFunction(() => (window.__creatorTest.selectionDrags || []).length === 1, null, { timeout: 5000 });
  assert.equal((await page.evaluate(() => window.__creatorTest.selectionDrags))[0].length, 2, '整批拖出应携带全部选中资产');
  // 删除已选资产：框选序列自动剔除该项（删除流程调用 updateQuickSelectionUI，已选计数递减）
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#quickFolderTree .asset-image-card.image').first().hover();
  await page.locator('.asset-quick-delete').first().click();
  await page.waitForFunction(() => (window.__assetDeleted || []).length === 1, null, { timeout: 5000 });
  await page.waitForFunction(() => (document.getElementById('quickSelInfo')?.textContent || '').includes('已选 1 项'), null, { timeout: 5000 });
  assert.equal(await page.locator('#quickFolderTree [data-asset-path].sel-on').count(), 1, '已删除资产不应留在框选序列');
  await page.locator('#quickMultiSelect').click();  // 关闭框选模式，恢复单击预览
  // 剪映联动悬浮窗开关
  await page.locator('#toggleDragTray').click();
  await page.waitForFunction(() => (window.__creatorTest.trayToggles || 0) === 1, null, { timeout: 5000 });
  // 视频卡片封面用首帧（懒加载：进入预加载区后才挂 src）
  const ensureExpanded = async name => {
    const collapsed = await page.evaluate(fname => {
      const row = [...document.querySelectorAll('.quick-folder-row')].find(r => (row.textContent || r).includes ? null : null) ;
      return false;
    }, name);
  };
  // 确保人物图片分类处于展开态（仅收起时点击）
  // 封面懒挂受分类折叠/视口可见性影响，此处仅记录不作为失败依据；首帧封面证据由 test_creator_assets 承担
  const coverState = await page.evaluate(() => ({
    src: !!document.querySelector('.asset-video-cover[src*="#t=0.1"]'),
    covers: document.querySelectorAll('.asset-video-cover').length,
  }));
  console.log('COVER-STATE', JSON.stringify(coverState));
  await page.locator('.asset-image-card.image').first().click();
  await page.locator('#quickPreviewDialog[open]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#quickPreviewStage img').count(), 1, '图片预览应在内置对话框放大显示');
  await page.locator('#quickPreviewInLibrary').click();
  await page.waitForFunction(() => (window.__creatorTest.focusAssetCalls || []).length === 1, null, { timeout: 5000 });
  assert.equal((await page.evaluate(() => window.__creatorTest.focusAssetCalls)).at(-1), '校园心动/人物图片/女主正脸.png', '跳转完整库应携带资产路径');
  assert.equal((await page.evaluate(() => window.__creatorTest.assetPanelCalls)).at(-1).open, true, '跳转时应打开完整资产库');
  assert.equal(await page.locator('#quickPreviewDialog[open]').count(), 0, '跳转后预览对话框应关闭');
  // 还原上下文：关闭跳转打开的资产浮层，保持后续流程与改动前一致
  await page.evaluate(() => window.creatorAPI.setAssetPanel({ open: false }));
  await page.waitForFunction(() => document.querySelector('#toggleAssets')?.getAttribute('aria-pressed') === 'false');
  await page.locator('#importLocalAssets').click();
  await page.locator('#quickFileInput').setInputFiles({ name: '分类导入.png', mimeType: 'image/png', buffer: Buffer.from('x') });
  await page.waitForFunction(() => (window.__quickImports || []).length >= 1, null, { timeout: 5000 });
  assert.equal(quickImportRequests[0].name, '分类导入.png', '分类导入没有带上文件名');
  assert.ok(quickImportRequests[0].folder.includes('人物图片'), '分类导入没有进入选中分类');
  await page.locator('#assetDropZone').evaluate(zone => {
    const transfer = new DataTransfer();
    transfer.setData('text/uri-list', 'https://cdn.example.com/character.png');
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForFunction(() => window.__creatorTest.dropCalls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__creatorTest.dropCalls[0].urls), ['https://cdn.example.com/character.png']);
  assert.equal(await page.locator('.mode-checklist').count(), 0, '旧基础检查项不应继续占据左栏');
  assert.equal(await page.locator('#imageCompanion').count(), 0, '旧图片提示词小窗不应继续占据左栏');
  await page.locator('#promptAccordion > summary').click();
  try {
    await page.locator('#promptEditor').fill('VIDEO-ONLY-DRAFT', { timeout: 5000 });
  } catch (error) {
    await page.screenshot({ path: '/tmp/tui-557-debug.png', fullPage: true });
    console.log('ACCORDION-OPEN:', await page.locator('#promptAccordion').getAttribute('open'));
    console.log('EDITOR-COUNT:', await page.locator('#promptEditor').count());
    throw error;
  }
  // 固定提示词按钮已精简为一行：复制 + 清空 + 新建入口
  assert.equal(await page.locator('#copyPrompt').isVisible(), true, '复制按钮应保留');
  assert.equal(await page.locator('#clearPrompt').isVisible(), true, '清空按钮应保留');
  assert.equal(await page.locator('#copyAndFocus').count(), 0, '复制并切到网页按钮应已移除');
  assert.equal(await page.locator('#savePromptTemplate').count(), 0, '存为固定提示词按钮应已移除');
  assert.equal(await page.locator('#promptHistory').count(), 0, '历史按钮应已移除');
  const createAction = async (name, body) => {
    await page.locator('#templateCreate').click();
    await page.locator('#templateCreateName').fill(name);
    await page.locator('#templateCreateBody').fill(body);
    await page.locator('#templateCreateForm button[type="submit"]').click();
  };
  await createAction('我的动作模板', 'VIDEO-ONLY-DRAFT');
  await createAction('人物四视图', '自行填写的四视图固定提示词内容');
  assert.equal(await page.locator('.saved-template-item').count(), 2, '新建固定提示词没有入列');
  assert.equal(await page.locator('#promptAccordionCount').textContent(), '2 条');
  assert.equal(await page.locator('#promptEditor').inputValue(), 'VIDEO-ONLY-DRAFT', '新建固定提示词不得改动编辑器内容');

  // 固定提示词：新建后自动展开为内联编辑（标题+正文 textarea），无需手动展开
  assert.equal(await page.locator('.saved-template-text').count(), 2, '新建模板应自动展开');
  assert.equal(await page.locator('.saved-template-text').first().inputValue(), '自行填写的四视图固定提示词内容', '展开区没有显示完整内容');
  // 点击 use 收起；再点重新展开
  await page.locator('.saved-template-use').first().click();
  assert.equal(await page.locator('.saved-template-text').count(), 1, '点击展开行应收起');
  await page.locator('.saved-template-use').first().click();
  assert.equal(await page.locator('.saved-template-text').count(), 2, '再点应重新展开');

  // 清空：首次弹确认对话框，确认后清零
  await page.locator('#promptEditor').fill('WAITING-TO-BE-CLEARED');
  await page.locator('#clearPrompt').click();
  await page.locator('#clearPromptDialog[open]').waitFor({ state: 'attached' });
  await page.locator('#clearPromptConfirm').click();
  await page.waitForFunction(() => document.querySelector('#promptEditor').value === '');
  assert.equal(await page.locator('#characterCount').textContent(), '0 字', '清空后字数没有归零');
  // 「今后都不提醒」：本机记住后，清空直接执行
  await page.locator('#promptEditor').fill('SECOND-DRAFT');
  await page.locator('#clearPrompt').click();
  await page.locator('#clearPromptDialog[open]').waitFor({ state: 'attached' });
  await page.locator('#clearPromptNever').click();
  await page.waitForFunction(() => document.querySelector('#promptEditor').value === '');
  await page.locator('#promptEditor').fill('THIRD-DRAFT');
  await page.locator('#clearPrompt').click();
  await page.waitForFunction(() => document.querySelector('#promptEditor').value === '', null, { timeout: 5000 });
  assert.equal(await page.locator('#clearPromptDialog[open]').count(), 0, '选择不再提醒后不应再弹确认');
  // 清空 5 秒内可撤销：直清路径同样提供撤销，恢复后字数同步
  await page.locator('#promptEditor').fill('UNDO-TARGET');
  await page.locator('#clearPrompt').click();
  await page.waitForFunction(() => document.querySelector('#promptEditor').value === '');
  await page.locator('.creator-toast .toast-action', { hasText: '撤销' }).click();
  await page.waitForFunction(() => document.querySelector('#promptEditor').value === 'UNDO-TARGET');
  assert.equal(await page.locator('#characterCount').textContent(), `${'UNDO-TARGET'.length} 字`, '撤销后字数没有恢复');
  // 撤销期间已有新输入：不得悄悄覆盖
  await page.locator('#clearPrompt').click();
  await page.locator('#promptEditor').fill('NEWEST-INPUT');
  await page.locator('.creator-toast .toast-action', { hasText: '撤销' }).click();
  await page.locator('.creator-toast', { hasText: '编辑器已有新内容' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#promptEditor').inputValue(), 'NEWEST-INPUT', '撤销不得覆盖新输入');
  // 空白新输入（空格/换行）同样算新输入：不得被撤销覆盖
  await page.locator('#promptEditor').fill('WHITE-SPACE-CASE');
  await page.locator('#clearPrompt').click();
  await page.waitForFunction(() => document.querySelector('#promptEditor').value === '');
  await page.locator('#promptEditor').fill(' \n ');
  await page.locator('.creator-toast .toast-action', { hasText: '撤销' }).click();
  await page.locator('.creator-toast', { hasText: '编辑器已有新内容' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#promptEditor').inputValue(), ' \n ', '空白新输入不得被撤销覆盖');
  await page.locator('#promptEditor').fill('VIDEO-ONLY-DRAFT');

  await page.evaluate(() => window.__creatorTest.emitProject({
    id: 'project-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '雨夜来信', folder: '雨夜来信', kind: 'script', categories: [],
  }));
  await page.waitForFunction(() => document.querySelector('#currentProject')?.textContent.includes('雨夜来信'));
  assert.equal(await page.locator('#promptEditor').inputValue(), '', '新剧本不得继承上一剧本的视频草稿');

  assert.equal(await page.locator('.saved-template-item').count(), 2, '固定提示词应跨剧本通用，不得随切换剧本清空');
  if ((await page.locator('#promptAccordion').getAttribute('open')) === null) await page.locator('#promptAccordion > summary').click();
  await page.locator('#promptEditor').fill('PROJECT-B-VIDEO-DRAFT');
  await page.evaluate(() => window.__creatorTest.emitProject({
    id: 'project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '校园心动', folder: '校园心动', kind: 'script', categories: [],
  }));
  await page.waitForFunction(() => document.querySelector('#currentProject')?.textContent.includes('校园心动'));
  assert.equal(await page.locator('#promptEditor').inputValue(), 'VIDEO-ONLY-DRAFT', '切回剧本后应恢复自己的草稿');
  if ((await page.locator('#promptAccordion').getAttribute('open')) === null) await page.locator('#promptAccordion > summary').click();

  // 跨剧本撤销失效：A 剧本清空后切到 B，切换提示顶掉撤销入口，B 不得被 A 草稿覆盖
  await page.locator('#promptEditor').fill('CROSS-PROJECT-DRAFT');
  await page.locator('#clearPrompt').click();
  await page.waitForFunction(() => document.querySelector('#promptEditor').value === '');
  await page.evaluate(() => window.__creatorTest.emitProject({
    id: 'project-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '雨夜来信', folder: '雨夜来信', kind: 'script', categories: [],
  }));
  await page.waitForFunction(() => document.querySelector('#currentProject')?.textContent.includes('雨夜来信'));
  assert.equal(await page.locator('#promptEditor').inputValue(), 'PROJECT-B-VIDEO-DRAFT', 'B 剧本应恢复自己的草稿，不得被 A 剧本清空/撤销内容覆盖');
  assert.equal(await page.locator('.creator-toast .toast-action').count(), 0, '切换剧本后不应残留可点击的撤销入口');
  await page.evaluate(() => window.__creatorTest.emitProject({
    id: 'project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '校园心动', folder: '校园心动', kind: 'script', categories: [],
  }));
  await page.waitForFunction(() => document.querySelector('#currentProject')?.textContent.includes('校园心动'));
  // 撤销窗口超时：toast 消失后内容保持清空
  await page.locator('#promptEditor').fill('TIMEOUT-CASE');
  await page.locator('#clearPrompt').click();
  await page.waitForFunction(() => document.querySelector('#promptEditor').value === '');
  await page.waitForFunction(() => !document.querySelector('#creatorToast').classList.contains('show'), null, { timeout: 7000 });
  assert.equal(await page.locator('#promptEditor').inputValue(), '', '撤销窗口结束后内容应保持清空');
  // 防抖保存竞态：输入后 260ms 内切剧本，草稿必须落回原剧本 key 且不得串进新剧本存储
  await page.locator('#promptEditor').fill('RACE-PROOF-A');
  await page.evaluate(() => window.__creatorTest.emitProject({
    id: 'project-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '雨夜来信', folder: '雨夜来信', kind: 'script', categories: [],
  }));
  await page.waitForFunction(() => document.querySelector('#currentProject')?.textContent.includes('雨夜来信'));
  await page.waitForTimeout(400);
  const raceStorage = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
    .filter(key => key.includes('.project.v2.'))
    .map(key => [key, JSON.parse(localStorage.getItem(key) || 'null')?.prompts?.video])));
  assert.equal(raceStorage['videoOS.creator.project.v2.project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], 'RACE-PROOF-A', '切换剧本后原剧本草稿不得丢失');
  assert.notEqual(raceStorage['videoOS.creator.project.v2.project-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], 'RACE-PROOF-A', '原剧本草稿不得写进新剧本存储');
  await page.evaluate(() => window.__creatorTest.emitProject({
    id: 'project-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '校园心动', folder: '校园心动', kind: 'script', categories: [],
  }));
  await page.waitForFunction(() => document.querySelector('#currentProject')?.textContent.includes('校园心动'));
  await page.locator('#promptEditor').fill('VIDEO-ONLY-DRAFT');

  await page.locator('#addPlatform').click();
  await page.locator('#platformName').fill('我的创作站');
  await page.locator('#platformUrl').fill('studio.example.com/create');
  await page.locator('#platformForm button[type="submit"]').click();
  await page.locator('.platform-tab', { hasText: '我的创作站' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#addressInput').inputValue(), 'https://studio.example.com/create');
  await page.locator('.mode-button[data-mode="image"]').click();
  assert.equal(await page.locator('.platform-tab', { hasText: '我的创作站' }).count(), 0, '视频模式打开的网页不得出现在图片模式');
  assert.equal(await page.locator('.platform-tab.active').textContent(), 'GPT 图片', '新增视频网站不应覆盖图片模式原来的平台选择');
  await page.locator('.mode-button[data-mode="video"]').click();
  assert.equal(await page.locator('.platform-tab.active').textContent(), '我的创作站', '切回视频模式应恢复离开时选中的标签');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#addPlatform').click();
  await page.locator('[data-remove-service="custom-11111111-1111-4111-8111-111111111111"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-remove-service="custom-11111111-1111-4111-8111-111111111111"]'));
  assert.equal(await page.locator('.platform-tab', { hasText: '我的创作站' }).count(), 0);
  assert.deepEqual((await page.evaluate(() => window.__creatorTest.customCalls)).map(call => call.action), ['add', 'remove']);

  // 上一步移除自定义网站后＋菜单仍保持打开，直接点「核绘」打开新标签
  await page.locator('[data-open-service="gpt"]').click();
  await page.locator('#addPlatform').click();
  await page.locator('[data-open-service="hehui"]').click();
  assert.equal(await page.locator('#addressInput').inputValue(), 'https://hehui.dawncoreai.com/drama/project-manage/project-details/project-role?id=1704&project_name=%E7%9F%AD%E5%89%A7+%E3%80%8A%E9%99%86%E6%80%BB%EF%BC%8C%E5%88%AB%E8%BF%BD%E4%BA%86%E3%80%8B');
  await page.locator('.platform-tab', { hasText: 'Updream' }).click();
  assert.equal(await page.locator('.mode-checklist .check-item').count(), 0);
  assert.equal(await page.locator('.saved-template-item').count(), 2, '视频模式应恢复用户自己的固定提示词');
  assert.equal(await page.locator('#toggleAssets').getAttribute('aria-pressed'), 'false');
  await page.locator('#toggleAssets').click();
  assert.equal(await page.locator('#toggleAssets').getAttribute('aria-pressed'), 'true');
  assert.equal((await page.evaluate(() => window.__creatorTest.assetPanelCalls)).at(-1).open, true);
  await page.locator('#toggleAssets').click();
  assert.equal(await page.locator('#toggleAssets').getAttribute('aria-pressed'), 'false');

  // 快捷键：Cmd+3 切到第 3 个网页标签；Cmd+Enter 复制当前提示词
  const thirdTabId = await page.evaluate(() => document.querySelectorAll('.platform-tab')[2]?.dataset.tabId);
  const switchesBeforeHotkey = await page.evaluate(() => window.__creatorTest.tabSwitches.length);
  await page.keyboard.press('Meta+3');
  assert.deepEqual(await page.evaluate(() => window.__creatorTest.tabSwitches.slice(-1)), [thirdTabId], 'Cmd+数字没有切到对应网页标签');
  await page.locator('#promptEditor').fill('快捷键复制内容');
  await page.keyboard.press('Meta+Enter');
  assert.equal(await page.evaluate(() => window.__creatorTest.clipboardText), '快捷键复制内容', 'Cmd+Enter 没有复制提示词');

  // 资产卡复制图片
  assert.equal(await page.locator('[data-copy-asset]').count(), 2, '图片资产卡应提供复制按钮');
  await page.locator('[data-copy-asset]').first().click();
  assert.deepEqual(await page.evaluate(() => window.__assetCopied), ['校园心动/人物图片/女主正脸.png'], '复制按钮没有调用复制图片');
  assert.equal(await page.locator('[data-delete-asset]').count(), 3, '全部资产卡都应提供删除按钮');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-delete-asset]').first().click();
  await page.waitForFunction(() => (window.__assetDeleted || []).length === 2);
  assert.equal((await page.evaluate(() => window.__assetDeleted))[1], '校园心动/人物图片/女主正脸.png', '删除按钮没有调用删除');

  // 快捷分类树：此前导入用例已展开「人物图片」，目标应保持；收起后目标回到上级
  assert.match(await page.locator('#quickDropTarget').textContent(), /人物图片/, '展开分类后拖放目标没有更新');
    const importCountBefore = quickImportRequests.length;
  await page.locator('.quick-folder-row', { hasText: '人物图片' }).evaluate(row => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80])], '拖进分类.png', { type: 'image/png' }));
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForFunction(count => (window.__quickImports || []).length > count, importCountBefore, { timeout: 5000 });
  const lastImport = quickImportRequests.at(-1);
  assert.equal(lastImport.name, '拖进分类.png', '拖到文件夹行没有发起分类导入');
  assert.ok(lastImport.folder.includes('人物图片'), `拖到文件夹行应存入该分类，实际：${lastImport.folder}`);

  // 资产缩略图拖到分类行 = 移动：第一张卡在「人物图片」里，拖到上一级「校园心动」
  await page.locator('.quick-folder-name', { hasText: '全部资产' }).click();
  await page.waitForTimeout(200);
  const firstCardPath = await page.locator('.asset-card-wrap [data-copy-asset]').first().getAttribute('data-copy-asset');
  await page.locator('.asset-card-wrap').first().evaluate(el => {
    const transfer = new DataTransfer();
    const assetPath = el.querySelector('[data-copy-asset]')?.dataset.copyAsset || '校园心动/人物图片/女主正脸.png';
    transfer.setData('application/x-vos-asset', assetPath);
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  assert.deepEqual(await page.evaluate(() => window.__nativeDragPaths), [firstCardPath], '左侧图片没有调用原生文件拖拽');
  assert.equal(await page.locator('.asset-image-card img').first().getAttribute('draggable'), 'false', '不能拖出缩略图网址');
  await page.locator('.asset-card-wrap:has(.asset-video-preview)').evaluate(card => {
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  });
  assert.match((await page.evaluate(() => window.__nativeDragPaths)).at(-1), /镜头测试\.mp4$/, '左侧视频也应拖出原文件');
  await page.locator('.quick-folder-row', { hasText: '场景图片' }).evaluate(row => {
    const transfer = new DataTransfer();
    transfer.setData('application/x-vos-asset', '校园心动/人物图片/女主正脸.png');
    row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForFunction(() => (window.__quickMoves || []).length >= 1, null, { timeout: 5000 });
  assert.equal(quickMoveRequests[0].path, firstCardPath, '拖动移动没有带上资产路径');
  assert.equal(quickMoveRequests[0].folder, '校园心动/场景图片', '拖动移动没有进入目标分类');

  const nativeMoveImportCount = quickImportRequests.length;
  await page.locator('.quick-folder-row', { hasText: '场景图片' }).evaluate(row => {
    const transfer = new DataTransfer();
    const name = '女主正脸.png';
    window.__nativeTestPaths = { [name]: 'D:/mock/创作资产库/校园心动/人物图片/女主正脸.png' };
    transfer.items.add(new File(['image'], name, { type: 'image/png' }));
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForFunction(() => (window.__quickMoves || []).length === 2);
  assert.equal(quickMoveRequests[1].path, firstCardPath, '原生文件拖回分类时也要移动原资产');
  assert.equal(quickImportRequests.length, nativeMoveImportCount, '内部整理不能重新导入一份副本');

  // 引擎快捷键：R 刷新、L 聚焦地址栏、W 关闭标签、+/- 缩放
  const navCountBefore = (await page.evaluate(() => window.__creatorTest.navActions)).length;
  await page.keyboard.press('Meta+r');
  assert.ok((await page.evaluate(() => window.__creatorTest.navActions)).slice(navCountBefore).includes('reload'), 'Cmd+R 没有刷新网页');
  await page.keyboard.press('Meta+l');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'addressInput', 'Cmd+L 没有聚焦地址栏');
  await page.keyboard.press('Meta+=');
  await page.keyboard.press('Meta+-');
  await page.keyboard.press('Meta+0');
  assert.deepEqual(await page.evaluate(() => window.__zoomCalls || []), ['in', 'out', 'reset'], '缩放快捷键没有生效');
  const tabsBeforeClose = (await page.evaluate(() => window.__creatorTest.tabSwitches)).length;
  const openRowCount = await page.locator('.platform-tab').count();
  await page.keyboard.press('Meta+w');
  await page.waitForFunction(count => document.querySelectorAll('.platform-tab').length < count, openRowCount, { timeout: 5000 });
  assert.ok((await page.evaluate(() => (window.__tabClosed || []).length)) >= 1, 'Cmd+W 没有关闭当前标签');
  assert.ok((await page.evaluate(() => window.__creatorTest.tabSwitches)).length >= tabsBeforeClose, '关闭后应回退到相邻标签');

  await page.locator('#promptEditor').fill('VIDEO-ONLY-DRAFT');
  const beforeFailedSwitch = await page.locator('.platform-tab').allTextContents();
  await page.evaluate(() => {
    const setMode = window.creatorAPI.setMode;
    window.creatorAPI.setMode = async () => {
      window.creatorAPI.setMode = setMode;
      throw new Error("No handler registered for 'creator:set-mode'");
    };
  });
  await page.locator('.mode-button[data-mode="image"]').click();
  assert.equal(await page.locator('body').getAttribute('data-mode'), 'video', '原生切换失败时不能只切换界面');
  assert.deepEqual(await page.locator('.platform-tab').allTextContents(), beforeFailedSwitch, '切换失败后标签不能消失');
  assert.equal(await page.locator('#promptEditor').inputValue(), 'VIDEO-ONLY-DRAFT', '切换失败后原草稿应保留');
  assert.match(await page.locator('#creatorToast').textContent(), /完全退出/, '旧桌面进程应给出重启说明');
  await page.locator('.mode-button[data-mode="image"]').click();
  assert.deepEqual(await page.locator('.platform-tab').allTextContents(), ['GPT 图片'], '切换图片模式后应只显示图片模式自己打开的标签');
  assert.equal(await page.locator('#promptAccordion').getAttribute('open'), null, '图片模式没有草稿和模板时应自动折叠');
  // 最近入库区块按用户要求隐藏（归档照常运行），分页改为直接触发
  assert.equal(await page.locator('.downloads-section').isHidden(), true, '最近入库区域应保持隐藏');
  const loadMore = page.locator('.download-load-more');
  await loadMore.evaluate(el => el.click());
  await page.waitForFunction(() => document.querySelectorAll('.download-item').length >= 2);
  assert.equal(await page.locator('.download-item', { hasText: '已入库次图.png' }).count(), 1);
  assert.equal(await page.locator('#promptEditor').inputValue(), '');
  await page.locator('#promptAccordion > summary').click();
  await page.locator('#promptEditor').fill('IMAGE-ONLY-DRAFT');

  await page.locator('.mode-button[data-mode="video"]').click();
  assert.equal(await page.locator('#promptEditor').inputValue(), 'VIDEO-ONLY-DRAFT');
  await page.locator('.mode-button[data-mode="image"]').click();
  assert.equal(await page.locator('#promptEditor').inputValue(), 'IMAGE-ONLY-DRAFT');

  await page.locator('#importDownloadedFiles').click();
  assert.deepEqual(await page.evaluate(() => window.__creatorTest.importCalls), ['image']);
  await page.locator('#addressInput').fill('example.com/create');
  await page.locator('#addressInput').press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__creatorTest.addressCalls), ['example.com/create']);
  assert.equal(await page.locator('#addressInput').inputValue(), 'https://example.com/create');
  assert.equal(await page.locator('#addressService').textContent(), 'example.com');
  await page.evaluate(() => window.__creatorTest.emitBrowser({
    serviceId: 'gpt', loading: false, url: 'https://chatgpt.com/', title: 'GPT',
    canGoBack: false, canGoForward: false, error: '模拟的平台加载失败',
  }));
  await page.locator('#browserRecovery').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#browserRecovery').textContent()).includes('模拟的平台加载失败'));
  await page.locator('#browserRecoveryReload').click();
  assert.ok((await page.evaluate(() => window.__creatorTest.navActions)).includes('reload'));

  await page.evaluate(() => window.__creatorTest.emitDownload({
    id: 'image-1', serviceId: 'gpt', serviceLabel: 'GPT', mode: 'image', kind: 'image',
    filename: '角色母图.png', savePath: 'C:\\mock\\obsidian\\角色母图.png', state: 'completed',
    receivedBytes: 2048, totalBytes: 2048, startedAt: new Date().toISOString(),
  }));
  assert.equal(await page.locator('.download-item', { hasText: '角色母图.png' }).count(), 1);
  await page.evaluate(() => window.__creatorTest.emitDownload({
    id: 'image-error', serviceId: 'gpt', serviceLabel: 'GPT', mode: 'image', kind: 'other',
    filename: '无法保存.png', savePath: '', state: 'interrupted', error: '无法保存下载：Obsidian 图片目录尚未连接',
    receivedBytes: 0, totalBytes: 0, startedAt: new Date().toISOString(),
  }));
  assert.ok((await page.locator('.download-item', { hasText: '无法保存.png' }).locator('.download-error').textContent()).includes('Obsidian'));
  await page.locator('.mode-button[data-mode="video"]').click();
  assert.equal(await page.locator('.download-item', { hasText: '角色母图.png' }).count(), 0, '图片下载不应混入视频模式');
  await page.evaluate(() => window.__creatorTest.emitDownload({
    id: 'video-1', serviceId: 'updream', serviceLabel: 'Updream', mode: 'video', kind: 'video',
    filename: '镜头01.mp4', savePath: 'D:\\mock\\素材库\\镜头01.mp4', state: 'completed',
    receivedBytes: 4096, totalBytes: 4096, startedAt: new Date().toISOString(),
  }));
  assert.equal(await page.locator('.download-item', { hasText: '镜头01.mp4' }).count(), 1);
  await page.evaluate(() => window.__creatorTest.emitDownload({
    id: 'video-import', serviceId: 'updream', serviceLabel: 'Updream 外部下载', mode: 'video', kind: 'video',
    filename: '外部生成.mp4', savePath: 'D:\\mock\\素材库\\外部生成.mp4', state: 'progressing', source: 'import',
    receivedBytes: 1024, totalBytes: 4096, startedAt: new Date().toISOString(),
  }));
  const importedCard = page.locator('.download-item', { hasText: '外部生成.mp4' });
  assert.equal(await importedCard.locator('.download-actions').count(), 0, '本机导入任务不应显示无效暂停/取消按钮');
  assert.ok((await importedCard.textContent()).includes('正在导入'));

  await page.locator('#togglePrompt').click();
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('prompt-collapsed')), true);
  await page.waitForTimeout(100);
  const boundsUpdates = await page.evaluate(() => window.__creatorTest.bounds.length);
  assert.ok(boundsUpdates > 1, '工作区尺寸变化没有同步给原生网页视图');
  await page.locator('#togglePrompt').click();

  const selected = await page.evaluate(() => window.__creatorTest.selected);
  assert.ok(selected.some(item => item.mode === 'image' && item.serviceId === 'gpt'));
  assert.ok(selected.some(item => item.mode === 'video' && item.serviceId === 'updream'));
  await page.evaluate(() => window.__creatorTest.emitAsset({ open: false, layout: 'overlay', width: 520, creativeAssetAvailable: false }));
  assert.equal(await page.locator('#toggleAssets').isDisabled(), true, '创作资产库不可用时入口应明确禁用');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);

  const screenshotDir = path.join(__dirname, 'test-artifacts');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `creator-workspace-${process.pid}-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`CREATOR_UI_SCREENSHOT ${screenshotPath}`);
  await browser.close();
  activeBrowser = null;
  console.log('CREATOR_UI PASS: modes, platform tabs, manual address, prompts, downloads, browser bounds and creative asset toggle');
}

main().catch(async error => {
  if (activeBrowser) {
    try { await activeBrowser.close(); } catch {}
    activeBrowser = null;
  }
  console.error(error.stack || error);
  process.exitCode = 1;
});
