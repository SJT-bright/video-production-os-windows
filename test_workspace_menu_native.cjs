'use strict';
// 隔离 Electron + 本地平台页：证明菜单窗口不卸下／重载平台，绝不使用真实登录或正式素材。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 16000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(60); }
  throw new Error(`超时：${label}`);
}
async function pressEscape(menu) {
  try { await menu.keyboard.press('Escape'); }
  catch (error) { if (!String(error.message).includes('has been closed')) throw error; await until(() => menu.isClosed(), 'Esc关闭'); }
}
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-workspace-menu-'));
  let application;
  const report = {};
  const watchdog = setTimeout(() => { application?.process()?.kill('SIGKILL'); console.error('WORKSPACE_MENU_WATCHDOG'); process.exit(1); }, 100000).unref();
  try {
    const projectRoot = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
    fs.mkdirSync(path.join(projectRoot, '创作资产库', '菜单测试甲'), { recursive: true }); fs.mkdirSync(dataDir);
    application = await _electron.launch({ args: [__dirname], timeout: 30000, env: { ...process.env,
      CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_PORT: String(4500 + process.pid % 400),
      VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot, VIDEO_OS_DATA_DIR: dataDir,
      VIDEO_OS_USER_DATA: path.join(temp, 'profile'), OBSIDIAN_VAULT_PATH: path.join(temp, 'obsidian'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const creator = await application.firstWindow();
    await creator.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 22000 });
    await until(() => application.evaluate(({ webContents }) => webContents.getAllWebContents().some(wc => wc.getURL().includes('/creator-fixture.html?service=') && !wc.isLoading())), '本地平台页完成');
    const postProject = (body) => creator.evaluate(async body => {
      const response = await fetch('/api/creative-projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
    }, body);
    const config = await creator.evaluate(() => window.creatorAPI.getConfig());
    assert.equal(fs.realpathSync(config.paths.projectRoot), fs.realpathSync(projectRoot), '必须先确认隔离目录，再写测试数据');
    const { project: beta } = await postProject({ action: 'create', name: '菜单测试乙' });
    const projectBeforeMenu = (await creator.evaluate(() => window.creatorAPI.getConfig())).project.id;
    const tabId = config.browser.tabId;
    await creator.evaluate(id => window.creatorAPI.renameTab(id, '可搜索的专用网页'), tabId);
    await application.evaluate(({ app, webContents, BrowserWindow }, id) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      const platform = host.contentView.children.find(view => view.webContents?.getURL().includes('/creator-fixture.html?service='));
      if (!platform) throw new Error('原生平台未附着');
      globalThis.__menuNativeProbe = { host, contents: platform.webContents, navigation: 0, reload: 0 };
      platform.webContents.on('did-navigate', () => globalThis.__menuNativeProbe.navigation++);
      platform.webContents.on('did-finish-load', () => globalThis.__menuNativeProbe.reload++);
      app.on('web-contents-created', (_event, wc) => {
        wc.on('ipc-message', (_event, channel, payload) => {
          if (channel === 'workspace-menu:report-size') wc.__workspaceToken = payload.token;
        });
      });
      return platform.webContents.executeJavaScript(`document.body.style.minHeight='2200px'; window.scrollTo(0,240); window.__persistentMenuMarker=${JSON.stringify(id)}; document.body.insertAdjacentHTML('afterbegin','<input id="menuRetentionInput" value="菜单期间保留输入">'); true`);
    }, `marker-${Date.now()}`);
    const snapshot = () => application.evaluate(async () => {
      const p = globalThis.__menuNativeProbe;
      const children = p.host.contentView.children;
      const view = children.find(view => view.webContents === p.contents);
      return { attached: !!view, visible: !!view && view.getVisible() && p.host.isVisible(), id: p.contents.id,
        url: p.contents.getURL(), navigation: p.navigation, reload: p.reload,
        state: await p.contents.executeJavaScript('({marker:window.__persistentMenuMarker,scroll:window.scrollY,input:document.getElementById("menuRetentionInput")?.value})'),
        childIds: children.filter(view => view.webContents).map(view => view.webContents.id) };
    });
    const baseline = await snapshot();
    console.log('WORKSPACE_MENU_STEP platform-ready');
    const unchanged = async label => {
      const value = await snapshot(); assert.equal(value.attached, true, label);
      assert.equal(value.visible, true, `${label}: 原生view和宿主均可见`);
      for (const key of ['id', 'url', 'navigation', 'reload', 'state']) assert.deepEqual(value[key], baseline[key], `${label}: ${key}`);
    };
    const open = async (kind, coordinates = { x: 200, y: 95 }) => {
      const previous = new Set(application.windows());
      await creator.evaluate(({ kind, coordinates }) => {
        window.__workspaceReceipt = null;
        window.creatorAPI.showWorkspaceMenu({ kind, ...coordinates }).then(result => { window.__workspaceReceipt = result; }, error => { window.__workspaceReceipt = { error: error.message }; });
      }, { kind, coordinates });
      const menu = await until(() => application.windows().find(page => !previous.has(page) && page.url().includes('/workspace-menu.html') && !page.isClosed()), '独立菜单窗口');
      console.log('WORKSPACE_MENU_STEP opened', kind, await menu.title(), menu.url());
      await menu.waitForLoadState('networkidle');
      await until(() => menu.locator('.menu-item').count(), '菜单内容');
      await unchanged(`${kind}菜单打开`); return menu;
    };
    const receipt = () => until(() => creator.evaluate(() => window.__workspaceReceipt), '菜单回执');
    let menu = await open('projects');
    assert.ok(await menu.locator('.menu-item').count() >= 3);
    // 主进程权威目录；未知动作／ID／过期token／其他页面的消息不能决定菜单动作。
    await application.evaluate(({ ipcMain, BrowserWindow }) => {
      const popup = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/workspace-menu.html'));
      const p = globalThis.__menuNativeProbe;
      const token = popup.webContents.__workspaceToken;
      if (!token) throw new Error('未捕获实际菜单token');
      ipcMain.emit('workspace-menu:pick', { sender: p.contents }, { token, action: 'manage' });
      ipcMain.emit('workspace-menu:pick', { sender: popup.webContents }, { token: 'old-session', action: 'manage' });
      ipcMain.emit('workspace-menu:pick', { sender: popup.webContents }, { token, action: 'delete' });
      ipcMain.emit('workspace-menu:pick', { sender: popup.webContents }, { token, action: 'select', id: 'foreign-project' });
    });
    await delay(100); assert.equal(await creator.evaluate(() => window.__workspaceReceipt), null);
    await menu.locator(`.menu-item[data-id="${beta.id}"]`).click({ button: 'right' });
    await menu.locator('#migrate').waitFor({ state: 'visible' });
    const evidence = path.join(__dirname, 'test-artifacts', 'workspace-menu-native-20261010');
    fs.mkdirSync(evidence, { recursive: true });
    await menu.screenshot({ path: path.join(evidence, 'project-menu.png') });
    const platformImage = await application.evaluate(() => globalThis.__menuNativeProbe.contents.capturePage().then(image => image.toDataURL()));
    fs.writeFileSync(path.join(evidence, 'platform-view-content.png'), Buffer.from(platformImage.split(',')[1], 'base64'));
    const hostOnly = path.join(evidence, 'live-platform-during-menu.png');
    if (fs.existsSync(hostOnly)) fs.unlinkSync(hostOnly); // 旧host-only截图不能充当原生平台屏幕可见证据。
    await menu.locator('#migrate').click();
    const migration = await receipt(); assert.equal(migration.action, 'migrate'); assert.equal(migration.id, beta.id);
    assert.ok(Number.isFinite(migration.x) && Number.isFinite(migration.y));
    assert.equal((await creator.evaluate(() => window.creatorAPI.getConfig())).project.id, projectBeforeMenu, '菜单只返回动作，不擅自激活项目');
    report.authoritativeActionsAndMigration = true;
    console.log('WORKSPACE_MENU_STEP migration-pass');
    await unchanged('迁移菜单选中');
    menu = await open('tabs');
    await menu.locator('#menuSearch').fill('不存在的网页');
    assert.equal(await menu.locator('.menu-item').count(), 0);
    await menu.locator('#menuSearch').fill('专用网页');
    assert.equal(await menu.locator('.menu-item').count(), 1);
    await menu.locator('.menu-item').click();
    assert.deepEqual((await receipt()).action, 'select'); assert.equal((await creator.evaluate(() => window.__workspaceReceipt)).id, tabId);
    await unchanged('网页搜索选中'); report.tabSearch = true;
    console.log('WORKSPACE_MENU_STEP search-pass');
    menu = await open('projects'); await pressEscape(menu);
    assert.equal((await receipt()).cancelled, true); await unchanged('Esc取消');
    menu = await open('projects'); await creator.evaluate(() => window.creatorAPI.closeWorkspaceMenu());
    assert.equal((await receipt()).cancelled, true); report.explicitCancel = true;
    menu = await open('projects');
    await application.evaluate(() => globalThis.__menuNativeProbe.host.focus());
    assert.equal((await receipt()).cancelled, true); await unchanged('失焦取消'); report.blurCancel = true;
    await creator.evaluate(() => window.creatorAPI.setAssetPanel({ open: true, layout: 'overlay', width: 360 }));
    await until(() => application.evaluate(() => globalThis.__menuNativeProbe.host.contentView.children.length >= 2), '完整资产浮层附着');
    const withAsset = (await snapshot()).childIds;
    menu = await open('projects', { x: 1500, y: 800 });
    assert.deepEqual((await snapshot()).childIds, withAsset, '菜单不能卸下平台或资产库');
    await application.evaluate(() => globalThis.__menuNativeProbe.host.setSize(750, 640));
    await delay(160);
    const position = await application.evaluate(({ BrowserWindow, screen }) => {
      const popup = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/workspace-menu.html'));
      const bounds = popup.getBounds(), area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
      return { bounds, area };
    });
    assert.ok(position.bounds.x >= position.area.x && position.bounds.y >= position.area.y);
    assert.ok(position.bounds.x + position.bounds.width <= position.area.x + position.area.width + 1);
    assert.ok(position.bounds.y + position.bounds.height <= position.area.y + position.area.height + 1);
    await unchanged('窄窗菜单resize');
    await menu.locator('#dismiss').click(); assert.equal((await receipt()).cancelled, true);
    report.assetOverlayAndNarrowResize = true;
    await creator.evaluate(() => window.creatorAPI.setAssetPanel({ open: false }));
    // 实际功能按钮通路：打开菜单仍保留平台，取消后视图不需重建。
    await creator.locator('#currentProject').click();
    menu = await until(() => application.windows().find(page => page.url().includes('/workspace-menu.html') && !page.isClosed()), '实际剧本按钮');
    await menu.waitForLoadState('networkidle'); await unchanged('实际剧本按钮打开');
    await pressEscape(menu); await until(() => menu.isClosed(), '实际剧本按钮取消');
    await creator.locator('#allTabsButton').click();
    menu = await until(() => application.windows().find(page => page.url().includes('/workspace-menu.html') && !page.isClosed()), '实际全部网页按钮');
    await menu.waitForLoadState('networkidle'); await unchanged('实际全部网页按钮打开');
    await menu.locator('#menuSearch').fill('专用网页'); await menu.locator('.menu-item').click();
    await until(() => menu.isClosed(), '实际网页选择');
    await unchanged('实际网页选中'); report.actualButtons = true;
    console.log('WORKSPACE_MENU_STEP buttons-pass');
    // 真正HTML模态仍需让出原生视图，但显示内存截图，而不是“平台已连接”占位。
    await creator.evaluate(() => document.getElementById('renameDialog').showModal());
    await until(async () => !(await snapshot()).attached, '模态原生保护');
    assert.equal(await creator.locator('#platformBackdrop').isVisible(), true);
    assert.equal(await creator.locator('#platformBackdrop').evaluate(image => image.complete && image.naturalWidth > 0 && image.src.startsWith('data:image/')), true);
    await creator.evaluate(() => document.getElementById('renameDialog').close());
    await until(async () => (await snapshot()).attached, '模态取消恢复');
    assert.equal(await creator.locator('#platformBackdrop').isVisible(), false);
    await unchanged('模态取消'); report.modalBackdropAndRestore = true;
    // 故意延缓捕获，旧true请求不能在false回执之后再次隐藏平台。
    await application.evaluate(() => {
      const wc = globalThis.__menuNativeProbe.contents;
      wc.__originalCapturePage = wc.capturePage.bind(wc);
      wc.capturePage = (...args) => wc.__originalCapturePage(...args).then(image => new Promise(resolve => setTimeout(() => resolve(image), 90)));
    });
    await creator.evaluate(async () => {
      const opening = window.creatorAPI.setPlatformViewHidden(true);
      const closing = window.creatorAPI.setPlatformViewHidden(false);
      await Promise.all([opening, closing]);
    });
    await unchanged('快速模态开关旧截图守卫');
    assert.equal(await creator.locator('#platformBackdrop').isVisible(), false);
    await application.evaluate(() => {
      const wc = globalThis.__menuNativeProbe.contents; wc.capturePage = wc.__originalCapturePage; delete wc.__originalCapturePage;
    });
    report.captureRaceGuard = true;
    console.log('WORKSPACE_MENU_STEP modal-pass');
    // UI快捷键与主进程API都不能在模态保护期间让另一页盖住对话框。
    const secondState = await creator.evaluate(() => window.creatorAPI.openTab('gpt', 'image'));
    const secondId = secondState.tabId;
    assert.ok(secondId && secondId !== tabId);
    await until(() => application.evaluate(() => globalThis.__menuNativeProbe.host.contentView.children.some(view =>
      view.webContents?.getURL().includes('/creator-fixture.html?service=') && view.webContents.id !== globalThis.__menuNativeProbe.contents.id
        && !view.webContents.isLoading())), '第二个本地平台页');
    await application.evaluate(() => {
      const p = globalThis.__menuNativeProbe;
      const view = p.host.contentView.children.find(view => view.webContents?.getURL().includes('/creator-fixture.html?service=') && view.webContents !== p.contents);
      p.secondContents = view.webContents;
    });
    await creator.evaluate(id => window.creatorAPI.selectTab(id), tabId);
    await creator.evaluate(() => document.getElementById('renameDialog').showModal());
    await until(async () => !(await snapshot()).attached, '快捷键测试模态保护');
    await creator.keyboard.press(process.platform === 'darwin' ? 'Meta+Tab' : 'Control+Tab');
    assert.equal((await creator.evaluate(() => window.creatorAPI.getConfig())).browser.tabId, tabId);
    await creator.keyboard.press(process.platform === 'darwin' ? 'Meta+2' : 'Control+2');
    assert.equal((await creator.evaluate(() => window.creatorAPI.getConfig())).browser.tabId, tabId);
    await creator.evaluate(() => document.getElementById('renameDialog').close());
    await until(async () => (await snapshot()).attached, '快捷键测试结束');
    await application.evaluate(() => {
      const wc = globalThis.__menuNativeProbe.contents;
      wc.__originalCapturePage = wc.capturePage.bind(wc);
      wc.capturePage = (...args) => wc.__originalCapturePage(...args).then(image => new Promise(resolve => setTimeout(() => resolve(image), 130)));
    });
    await creator.evaluate(() => {
      window.__modalCaptureReceipts = [];
      window.creatorAPI.onPlatformBackdrop(payload => window.__modalCaptureReceipts.push({ sequence: payload.sequence, hasImage: !!payload.image }));
      document.getElementById('renameDialog').showModal();
    });
    await creator.evaluate(id => window.creatorAPI.selectTab(id), secondId);
    await until(() => application.evaluate(() => {
      const p = globalThis.__menuNativeProbe;
      return p.host.contentView.children.every(view => view.webContents !== p.contents && view.webContents !== p.secondContents);
    }), '捕获期间换页仍受保护');
    await delay(260);
    const images = await creator.evaluate(() => window.__modalCaptureReceipts.filter(entry => entry.hasImage));
    assert.equal(images.length, 1, '只能发送最新平台底图，旧capture不能回流');
    assert.equal((await creator.evaluate(() => window.creatorAPI.getConfig())).browser.tabId, secondId);
    await creator.evaluate(() => document.getElementById('renameDialog').close());
    await until(() => application.evaluate(() => {
      const p = globalThis.__menuNativeProbe; return p.host.contentView.children.some(view => view.webContents === p.secondContents);
    }), '关闭模态后恢复新平台');
    assert.equal(await creator.locator('#platformBackdrop').isVisible(), false);
    await application.evaluate(() => {
      const wc = globalThis.__menuNativeProbe.contents; wc.capturePage = wc.__originalCapturePage; delete wc.__originalCapturePage;
    });
    await creator.evaluate(id => window.creatorAPI.selectTab(id), tabId);
    await unchanged('换页模态关闭后原页内容仍保留');
    report.modalShortcutsAndTabCaptureRace = true;
    menu = await open('projects');
    await application.evaluate(() => globalThis.__menuNativeProbe.host.destroy());
    await until(() => menu.isClosed(), 'owner关闭取消'); report.ownerClose = true;
    report.noDetachReloadOrStateLoss = true;
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log('WORKSPACE_MENU_NATIVE_PASS', JSON.stringify(report));
  } finally {
    clearTimeout(watchdog);
    if (application) await application.close().catch(() => application.process()?.kill('SIGKILL'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
