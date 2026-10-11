'use strict';

// Isolated native Electron windows. Pointer actions use Playwright's Chromium
// input channel, never element.click() or fabricated DOM pointer events.
// Does not connect to third-party sites or write to an installed App/profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  assert.ok(port !== 3750 && port !== 3794, 'Never use a user App port');
  return port;
}

async function main() {
  const executablePath = process.env.TAB_MENU_TEST_EXECUTABLE || '';
  const evidenceRoot = path.resolve(process.env.TAB_MENU_TEST_EVIDENCE || path.join(
    __dirname, 'test-artifacts', `tab-menu-native-${executablePath ? 'packaged' : 'source'}-${Date.now()}-${process.pid}`));
  assert.equal(fs.existsSync(evidenceRoot), false, 'Do not overwrite previous evidence');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-tab-menu-native-'));
  const projectRoot = path.join(temp, 'project');
  const dataDir = path.join(temp, 'data');
  const profile = path.join(temp, 'profile');
  const obsidian = path.join(temp, 'obsidian');
  const report = { status: 'running', testedAt: new Date().toISOString(), checks: {},
    scope: { isolatedSourceOrPackagedApp: true, formalAppChanged: false,
      realUserTabsClosed: false, assetsDeleted: false, physicalMouseE2E: false,
      inputMethod: 'Playwright Chromium mouse input into native Electron windows' } };
  let application, creator, latestMenu;
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    application?.process()?.kill('SIGKILL');
    console.error('TAB_MENU_NATIVE_TIMEOUT');
  }, 100000).unref();
  try {
    fs.mkdirSync(path.join(projectRoot, '创作资产库', '菜单测试剧本'), { recursive: true });
    fs.mkdirSync(dataDir); fs.mkdirSync(obsidian);
    const env = { ...process.env,
      CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0',
      VIDEO_OS_PORT: String(await freePort()), VIDEO_OS_PROJECT_ROOT: projectRoot,
      VIDEO_OS_TEST_PROJECT_ROOT: projectRoot, VIDEO_OS_DATA_DIR: dataDir,
      VIDEO_OS_USER_DATA: profile, OBSIDIAN_VAULT_PATH: obsidian,
      VIDEO_OS_TEST_OBSIDIAN_VAULT: obsidian, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: [__dirname] }),
      timeout: 30000, env,
    });
    creator = await application.firstWindow();
    creator.setDefaultTimeout(10000);
    await creator.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 25000 });
    // navigateWorkspace focuses the host after its complete load; do not open
    // a popup early and mislabel that final startup focus as a pointer failure.
    await creator.waitForLoadState('load');
    // A native local fixture is the readiness boundary; the creator owns SSE.
    // Its perpetual stream must not be mistaken for failure to reach networkidle.
    await until(() => application.evaluate(({ webContents }) => webContents.getAllWebContents()
      .some(wc => wc.getURL().includes('/creator-fixture.html?service=') && !wc.isLoading())), 'local platform ready');
    const config = await creator.evaluate(() => window.creatorAPI.getConfig());
    report.runtime = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged, version: app.getVersion(), userData: app.getPath('userData'), appPath: app.getAppPath(),
    }));
    assert.equal(report.runtime.packaged, !!executablePath);
    assert.equal(fs.realpathSync(report.runtime.userData), fs.realpathSync(profile));
    assert.equal(fs.realpathSync(config.paths.projectRoot), fs.realpathSync(projectRoot));
    assert.equal(config.testMode, true);
    const sourceId = config.browser.tabId;
    assert.ok(sourceId, 'An isolated source tab is required');
    const originalTabs = config.browser.tabs.map(tab => tab.id);
    await until(() => application.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      return host?.isVisible() && !host.webContents.isLoading() && host.contentView.children.some(view => view.webContents?.getURL().includes('/creator-fixture.html?service=')
        && view.getVisible());
    }), 'visible fully loaded host and attached native platform');
    await application.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      const platform = host.contentView.children.find(view => view.webContents?.getURL().includes('/creator-fixture.html?service='));
      if (!platform) throw new Error('Native platform is not attached');
      globalThis.__tabMenuNativeProbe = { host, contents: platform.webContents, navigations: 0, loads: 0 };
      platform.webContents.on('did-navigate', () => globalThis.__tabMenuNativeProbe.navigations++);
      platform.webContents.on('did-finish-load', () => globalThis.__tabMenuNativeProbe.loads++);
    });
    await application.evaluate(({ app, BrowserWindow }) => {
      globalThis.__tabMenuWindowEvents = [];
      app.on('activate', () => globalThis.__tabMenuWindowEvents.push({ kind: 'app-activate', at: Date.now() }));
      app.on('browser-window-focus', (_event, win) => globalThis.__tabMenuWindowEvents.push({ kind: 'app-window-focus', at: Date.now(), id: win.id }));
      app.on('browser-window-blur', (_event, win) => globalThis.__tabMenuWindowEvents.push({ kind: 'app-window-blur', at: Date.now(), id: win.id,
        focusedId: BrowserWindow.getFocusedWindow()?.id || null }));
      app.on('browser-window-created', (_event, win) => {
        for (const kind of ['focus', 'blur', 'closed']) win.on(kind, () => {
          globalThis.__tabMenuWindowEvents.push({ kind, at: Date.now(), id: win.id });
        });
        win.webContents.on('ipc-message', (_event, channel, payload) => {
          if (channel.startsWith('tab-menu:')) globalThis.__tabMenuWindowEvents.push({
            kind: channel, at: Date.now(), id: win.id, payload,
          });
        });
      });
    });
    const platformState = () => application.evaluate(() => {
      const probe = globalThis.__tabMenuNativeProbe;
      const view = probe.host.contentView.children.find(view => view.webContents === probe.contents);
      return { id: probe.contents.id, destroyed: probe.contents.isDestroyed(),
        attached: !!view, visible: !!view && view.getVisible(), url: probe.contents.getURL(),
        navigations: probe.navigations, loads: probe.loads };
    });
    const baseline = await platformState();
    report.platformBefore = baseline;
    const unchanged = async label => assert.deepEqual(await platformState(), baseline, label);
    const tab = id => creator.locator(`.platform-tab[data-tab-id="${id}"]`);
    const browser = () => creator.evaluate(async () => (await window.creatorAPI.getConfig()).browser);
    const open = async (id, enterImmediately = true) => {
      await until(async () => !application.windows().some(page => page.url().includes('/tab-menu.html') && !page.isClosed()), 'previous menu gone');
      await tab(id).click({ button: 'right' });
      const menu = await until(() => application.windows().find(page => page.url().includes('/tab-menu.html') && !page.isClosed()), 'native menu window');
      latestMenu = menu;
      menu.setDefaultTimeout(10000);
      await menu.locator('[data-action="close"]').waitFor({ state: 'visible' });
      await menu.evaluate(() => {
        window.__nativePointerEvents = [];
        for (const kind of ['pointerenter', 'pointerleave']) document.documentElement.addEventListener(kind, event => {
          window.__nativePointerEvents.push({ kind, at: Date.now(), trusted: event.isTrusted,
            x: event.clientX, y: event.clientY });
        });
      });
      if (enterImmediately) {
        const box = await menu.locator('[data-action="duplicate"]').boundingBox();
        assert.ok(box);
        await menu.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        // Move into the popup before networkidle's 500ms wait, because the user
        // request deliberately dismisses an untouched outside popup in 500ms.
        await menu.waitForLoadState('networkidle');
      }
      return menu;
    };
    const menuGeometry = menu => menu.evaluate(() => ({
      width: innerWidth, height: innerHeight, contentHeight: document.getElementById('menuRoot').scrollHeight,
      rootHeight: document.getElementById('menuRoot').clientHeight,
      overflowY: getComputedStyle(document.getElementById('menuRoot')).overflowY,
      items: [...document.querySelectorAll('[data-action]')].map(item => {
        const rect = item.getBoundingClientRect();
        return { action: item.dataset.action, label: item.querySelector('.tab-context-label').textContent,
          top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
          fullyInsideViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth };
      }),
    }));
    const moveInside = async menu => {
      const box = await menu.locator('[data-action="duplicate"]').boundingBox();
      assert.ok(box);
      await menu.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    };
    const leave = async menu => {
      const size = await menu.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const before = await menu.evaluate(() => window.__nativePointerEvents.length);
      const start = Date.now();
      await menu.mouse.move(size.width + 30, size.height + 30);
      const event = await until(() => menu.evaluate(before => window.__nativePointerEvents.slice(before)
        .find(event => event.kind === 'pointerleave'), before), 'trusted Chromium pointerleave', 250);
      assert.equal(event.trusted, true, 'Use browser mouse input, not dispatched DOM events');
      return { start, event };
    };

    let menu = await open(sourceId);
    await unchanged('Opening a menu must preserve the native platform');
    const geometry = await menuGeometry(menu);
    report.menuGeometry = geometry;
    assert.deepEqual(geometry.items.map(item => item.action), ['rename', 'duplicate', 'close']);
    assert.deepEqual(geometry.items.map(item => item.label), ['改名…', '复制标签', '删除标签']);
    assert.ok(geometry.items.every(item => item.fullyInsideViewport), 'All three actions must be reachable by the mouse');
    assert.ok(geometry.height > 64, 'The native window must grow beyond its old 64px cap');
    await menu.screenshot({ path: path.join(evidenceRoot, 'three-visible-actions.png') });
    report.checks.threeActionsFullyVisible = true;
    for (const action of ['rename', 'duplicate', 'close', 'rename']) {
      await menu.locator(`[data-action="${action}"]`).hover();
      await delay(150);
    }
    await delay(600);
    assert.equal(menu.isClosed(), false, 'Moving between children must not dismiss');
    report.checks.childHoverRetainsMenu = true;
    await moveInside(menu);
    const firstLeave = await leave(menu);
    await delay(200);
    assert.equal(menu.isClosed(), false, 'Menu must remain open before 500ms expires');
    await until(() => menu.isClosed(), 'leave closes after 500ms', 1800);
    const firstCloseElapsed = Date.now() - firstLeave.event.at;
    assert.ok(firstCloseElapsed >= 440 && firstCloseElapsed < 1600, `Unexpected leave delay: ${firstCloseElapsed}`);
    report.pointerLeave = { ...firstLeave, closeElapsedMs: firstCloseElapsed };
    report.checks.pointerLeaveClosesAfter500ms = true;
    await unchanged('Auto-dismiss must not rebuild or detach the platform');

    menu = await open(sourceId);
    await moveInside(menu);
    await leave(menu);
    await delay(100);
    await moveInside(menu);
    const pointerEvents = await menu.evaluate(() => window.__nativePointerEvents);
    assert.ok(pointerEvents.some(event => event.kind === 'pointerenter' && event.trusted), 'Re-enter must reach the window');
    await delay(720);
    assert.equal(menu.isClosed(), false, 'Re-enter before 500ms must cancel dismissal');
    const secondLeave = await leave(menu);
    await until(() => menu.isClosed(), 'second leave closes normally', 1800);
    report.pointerReturn = { events: pointerEvents, secondCloseElapsedMs: Date.now() - secondLeave.event.at };
    report.checks.quickReturnCancelsDismissal = true;
    await unchanged('Leave/return/cancel preserves native view identity');

    menu = await open(sourceId, false);
    const initiallyOutside = await application.evaluate(({ BrowserWindow, screen }) => {
      const popup = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/tab-menu.html'));
      const bounds = popup.getBounds(), cursor = screen.getCursorScreenPoint();
      return { cursor, bounds, outside: cursor.x < bounds.x || cursor.y < bounds.y
        || cursor.x >= bounds.x + bounds.width || cursor.y >= bounds.y + bounds.height };
    });
    if (initiallyOutside.outside) {
      const openedAt = Date.now();
      await delay(180);
      assert.equal(menu.isClosed(), false, 'Initially outside popup must also dwell, not close instantly');
      await until(() => menu.isClosed(), 'never-entered popup closes', 1800);
      report.checks.initiallyOutsideWithoutEnterCloses = true;
      report.initiallyOutside = { ...initiallyOutside, elapsedFromReadyMs: Date.now() - openedAt };
    } else {
      report.checks.initiallyOutsideWithoutEnterCloses = 'not-tested: physical cursor happened to be inside';
      await menu.keyboard.press('Escape');
      await until(() => menu.isClosed(), 'inside popup escape');
    }
    await unchanged('Never-entered menu cancellation preserves platform');

    menu = await open(sourceId);
    await menu.locator('[data-action="duplicate"]').click();
    await until(() => menu.isClosed(), 'picked duplicate closes menu');
    const afterDuplicate = await until(async () => {
      const state = await browser();
      return state.tabs.length === originalTabs.length + 1 && state.tabId !== sourceId ? state : null;
    }, 'duplicate adds exactly one new tab');
    const duplicateId = afterDuplicate.tabs.find(candidate => !originalTabs.includes(candidate.id))?.id;
    assert.ok(duplicateId, 'Copy must create a tab, not just copy the URL');
    assert.ok(afterDuplicate.tabs.some(candidate => candidate.id === sourceId));
    await tab(sourceId).click();
    await until(async () => (await browser()).tabId === sourceId, 'source tab reactivated');
    await unchanged('Duplicate must retain the source WebContents');
    menu = await open(duplicateId);
    await menu.locator('[data-action="close"]').click();
    await until(() => menu.isClosed(), 'picked delete closes menu');
    const afterClose = await until(async () => {
      const state = await browser();
      return !state.tabs.some(candidate => candidate.id === duplicateId) ? state : null;
    }, 'close removes only the context target');
    assert.deepEqual(afterClose.tabs.map(candidate => candidate.id), originalTabs);
    assert.equal(afterClose.tabId, sourceId, 'Deleting another tab must not change the active source');
    await unchanged('Deleting another tab preserves the source platform');
    report.checks.realDuplicateAndTargetedDelete = true;

    menu = await open(sourceId);
    await menu.locator('[data-action="rename"]').click();
    await until(() => menu.isClosed(), 'picked rename closes menu');
    await creator.locator('#renameDialog[open]').waitFor({ state: 'visible' });
    await creator.locator('#renameName').fill('原生菜单改名测试');
    await creator.locator('#renameSave').click();
    await until(async () => (await browser()).tabs.find(candidate => candidate.id === sourceId)?.customName === '原生菜单改名测试', 'rename saved');
    await creator.locator('#renameDialog[open]').waitFor({ state: 'detached' });
    await until(async () => (await platformState()).attached, 'platform restored after rename modal');
    await unchanged('Rename retains the source view after the dialog closes');
    report.checks.realRename = true;

    // An isolated display-workArea override checks clamping and scrollability.
    // It is not evidence of a physical small monitor or a production App update.
    await application.evaluate(({ screen }) => {
      globalThis.__tabMenuOriginalNearestDisplay = screen.getDisplayNearestPoint;
      screen.getDisplayNearestPoint = point => {
        const display = globalThis.__tabMenuOriginalNearestDisplay.call(screen, point);
        return { ...display, workArea: { ...display.workArea, height: 96 } };
      };
    });
    menu = await open(sourceId);
    const clamped = await menuGeometry(menu);
    assert.ok(clamped.height <= 80, `Menu must fit workArea: ${clamped.height}`);
    assert.equal(clamped.overflowY, 'auto');
    assert.ok(clamped.contentHeight > clamped.rootHeight, 'Overflow content must be scrollable');
    await moveInside(menu);
    await menu.mouse.wheel(0, 200);
    await delay(180);
    const scrolled = await menuGeometry(menu);
    assert.equal(scrolled.items.find(item => item.action === 'close').fullyInsideViewport, true, 'Scrolled delete must be reachable');
    await menu.screenshot({ path: path.join(evidenceRoot, 'small-workarea-scroll.png') });
    await menu.keyboard.press('Escape');
    await until(() => menu.isClosed(), 'clamped menu escaped');
    await unchanged('Small-workArea menu preserves platform');
    report.checks.smallWorkareaClampsAndScrolls = true;
    report.smallWorkarea = { beforeScroll: clamped, afterScroll: scrolled };
    await application.evaluate(({ screen }) => {
      screen.getDisplayNearestPoint = globalThis.__tabMenuOriginalNearestDisplay;
      delete globalThis.__tabMenuOriginalNearestDisplay;
    });
    report.platformAfter = await platformState();
    assert.equal(timedOut, false);
    report.status = 'passed';
    console.log(`TAB_MENU_NATIVE_PASS packaged=${!!executablePath} threeVisible=true leave500ms=true quickReturn=true targetedDelete=true platformRetained=true`);
  } catch (error) {
    report.status = 'failed';
    report.failure = String(error.stack || error);
    if (latestMenu && !latestMenu.isClosed()) {
      try { await latestMenu.screenshot({ path: path.join(evidenceRoot, 'failure-menu.png') }); } catch {}
    }
    if (creator && !creator.isClosed()) {
      try { await creator.screenshot({ path: path.join(evidenceRoot, 'failure-host-html-only.png') }); } catch {}
    }
    throw error;
  } finally {
    clearTimeout(watchdog);
    if (application) {
      report.windowEvents = await application.evaluate(() => globalThis.__tabMenuWindowEvents || []).catch(() => []);
      await application.evaluate(({ screen }) => {
        if (globalThis.__tabMenuOriginalNearestDisplay) screen.getDisplayNearestPoint = globalThis.__tabMenuOriginalNearestDisplay;
      }).catch(() => {});
      await application.close().catch(() => application.process()?.kill('SIGKILL'));
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    report.fixtureCleaned = true;
    fs.writeFileSync(path.join(evidenceRoot, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(`TAB_MENU_NATIVE_EVIDENCE ${evidenceRoot}`);
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
