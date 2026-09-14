'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { verifyPackagedApp } = require('./verify-build-manifest.cjs');
const { windowsReleasePaths } = require('./electron/windows-release-path.cjs');

async function run() {
  const userData = path.join(os.tmpdir(), 'release-path-fixture');
  const settings = { platform: 'win32', isPackaged: true, config: { dataLocation: 'userData' }, userData };
  const expected = windowsReleasePaths(settings);
  assert.equal(expected.dataDir, path.join(userData, 'workspace', '视频制作OS', 'data'));
  assert.equal(windowsReleasePaths({ ...settings, platform: 'darwin' }), null);
  assert.equal(windowsReleasePaths({ ...settings, isPackaged: false }), null);
  assert.equal(windowsReleasePaths({ ...settings, config: {} }), null);
  console.log('WINDOWS_RELEASE_PATHS_PASS: stable user workspace; Mac and source builds unchanged');
  if (process.platform !== 'win32') {
    console.log('WINDOWS_EXE_LAUNCH_SKIPPED: requires Windows CI');
    return;
  }

  const packageRoot = path.join(__dirname, 'dist', '视频制作OS-win32-x64');
  const appRoot = path.join(packageRoot, 'resources', 'app');
  for (const required of ['视频制作OS.exe', 'ffmpeg.dll', 'icudtl.dat', 'resources.pak', 'locales/en-US.pak']) {
    assert.ok(fs.statSync(path.join(packageRoot, required)).size > 0, required);
  }
  const verified = verifyPackagedApp({ sourceRoot: __dirname, appRoot, portable: true,
    platform: 'win32', arch: 'x64', compatibilityMode: true });
  console.log(`WINDOWS_RELEASE_MANIFEST_PASS: ${verified.checkedFiles} source hashes`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-release-'));
  let application;
  try {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const profile = path.join(root, 'profile');
    const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0',
      VIDEO_OS_PORT: String(port), VIDEO_OS_USER_DATA: profile,
      VIDEO_OS_TEST_OBSIDIAN_VAULT: path.join(root, 'empty-vault'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'VIDEO_OS_DATA_DIR', 'VIDEO_OS_PROJECT_ROOT', 'VIDEO_OS_TEST_PROJECT_ROOT']) delete env[key];
    const { _electron } = require('playwright');
    const launch = async () => {
      const launched = _electron.launch({ executablePath: path.join(packageRoot, '视频制作OS.exe'),
        cwd: root, env, timeout: 45000 });
      // Packaged apps start before Playwright attaches. Its CDP initialization
      // waits for every restored WebContents, including intentionally unloaded
      // background tabs. Wake only this isolated fixture's tabs through MCP.
      launched.catch(() => {});
      const sessionFile = path.join(profile, 'creator-browser-session.json');
      const saved = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : null;
      if (saved?.tabs.length) {
        const connectionFile = path.join(profile, 'workspace', '视频制作OS', 'data', 'creator-automation-connection.json');
        const call = async (name, args = {}) => {
          const c = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
          const response = await fetch(`http://127.0.0.1:${c.port}/call`, {
            method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(3000),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error);
          return body.result;
        };
        const deadline = Date.now() + 20000;
        let state;
        while (Date.now() < deadline) {
          try { state = await call('browser_state'); if (state.tabs.length === saved.tabs.length) break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.equal(state?.tabs.length, saved.tabs.length, 'native MCP reports all restored tabs');
        for (const tab of saved.tabs) {
          await call('tab_select', { projectId: state.project.id, tabId: tab.id, expectedUrl: tab.url });
        }
      }
      application = await launched;
      const page = await application.firstWindow();
      await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 30000 });
      assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
      assert.equal(await application.evaluate(() => process.env.VIDEO_OS_DATA_DIR),
        path.join(profile, 'workspace', '视频制作OS', 'data'));
      return page;
    };
    let page = await launch();
    const before = await page.evaluate(async () => {
      await window.creatorAPI.openTab('gpt', 'image');
      return window.creatorAPI.automation('browser_state');
    });
    const tabIds = before.tabs.map(tab => tab.id).sort();
    assert.ok(tabIds.length >= 2, 'packaged browser tabs opened');
    await application.close(); application = null;
    page = await launch();
    const after = await page.evaluate(() => window.creatorAPI.automation('browser_state'));
    assert.deepEqual(after.tabs.map(tab => tab.id).sort(), tabIds);
    await page.evaluate(() => window.creatorAPI.clearTabs());
    await application.close(); application = null;
    page = await launch();
    const cleared = await page.evaluate(() => window.creatorAPI.automation('browser_state'));
    assert.equal(cleared.tabs.length, 0);
    assert.equal(fs.existsSync(path.join(appRoot, 'data')), false);
    console.log('WINDOWS_EXE_LAUNCH_PASS: packaged=true userData=true restartTabs=true clearRemembered=true');
  } finally {
    await application?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
