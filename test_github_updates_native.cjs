'use strict';
// Real packaged App, preloads and UI; GitHub response, native confirmation and
// browser opening are intercepted. Never star a repository or open user sessions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedElectron } = require('./test-isolated-electron-cdp.cjs');
const { releaseTarget } = require('./electron/github-updates.cjs');
const version = require('./package.json').version;
const defaultExecutable = process.platform === 'darwin'
  ? path.join(__dirname, 'dist/public-release/视频制作 OS-darwin-universal/视频制作 OS.app/Contents/MacOS/VideoProductionOS')
  : path.join(__dirname, 'dist/视频制作OS-win32-x64/视频制作OS.exe');
const executablePath = process.env.UPDATE_TEST_EXECUTABLE || defaultExecutable;
const target = releaseTarget(process.platform, process.arch);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const result = await read(); if (result) return result; await delay(80); }
  throw new Error('Update native timeout: ' + message);
}
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); assert.notEqual(port, 3750); return port;
}
function release(next) {
  const name = process.platform === 'darwin' ? `VideoProductionOS-Mac-v${next}-Universal.zip` : `VideoProductionOS-Windows-v${next}-x64.zip`;
  return { tag_name: 'v' + next, draft: false, prerelease: false, published_at: '2026-10-19T01:00:00Z', name: '隔离更新验收', body: '仅测试回执，不是真实发布。',
    assets: [name, 'SHA256SUMS.txt'].map(name => ({ name, size: 123, state: 'uploaded', browser_download_url: `${target.starUrl}/releases/download/v${next}/${name}` })) };
}
async function main() {
  assert.ok(fs.existsSync(executablePath), 'Build the actual App first');
  const evidence = path.resolve(process.env.UPDATE_TEST_EVIDENCE || path.join(__dirname, 'test-artifacts/latest-release-native/github-updates'));
  assert.equal(fs.existsSync(evidence), false, 'Never overwrite earlier evidence'); fs.mkdirSync(evidence, { recursive: true });
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-episodes-update-'));
  for (const name of ['project', 'profile', 'data', 'obsidian']) fs.mkdirSync(path.join(temp, name));
  const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0',
    VIDEO_OS_PROJECT_ROOT: path.join(temp, 'project'), VIDEO_OS_TEST_PROJECT_ROOT: path.join(temp, 'project'),
    VIDEO_OS_USER_DATA: path.join(temp, 'profile'), VIDEO_OS_DATA_DIR: path.join(temp, 'data'),
    OBSIDIAN_VAULT_PATH: path.join(temp, 'obsidian'), VIDEO_OS_TEST_OBSIDIAN_VAULT: path.join(temp, 'obsidian') };
  delete env.ELECTRON_RUN_AS_NODE;
  const receipt = { status: 'running', testedAt: new Date().toISOString(), platform: process.platform, version,
    checks: {}, scope: { actualPackagedApp: true, nativeIPC: true, githubResponseInjected: true,
      browserOpenIntercepted: true, nativeDialogIntercepted: true, realGitHubStarPerformed: false,
      realGitHubReleasePublishedByTest: false, formalAppTouched: false, installed: false } };
  let application;
  try {
    const next = version.split('.').map(Number); next[2]++; const nextVersion = next.join('.');
    env.VIDEO_OS_PORT = String(await freePort());
    application = await launchIsolatedElectron({ executablePath, env });
    receipt.runtime = await application.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData') }));
    assert.equal(receipt.runtime.packaged, true); assert.equal(receipt.runtime.version, version);
    const initial = await application.renderer(() => window.desktopOS.getAppReleaseState());
    assert.equal(initial.starUrl, target.starUrl); assert.equal(initial.currentVersion, version); assert.equal(initial.available, false);
    await application.evaluate(({ net, shell, dialog }, raw) => {
      const ResponseClass = Response;
      global.__updateProbe = { raw, requests: [], opens: [], prompts: [], status: 200 };
      net.fetch = async (url, options) => {
        if (!String(url).startsWith('https://api.github.com/repos/SJT-bright/video-production-os')) throw Error('Unexpected update network URL');
        global.__updateProbe.requests.push({ url, credentials: options.credentials });
        return new ResponseClass(JSON.stringify(global.__updateProbe.raw), { status: global.__updateProbe.status });
      };
      shell.openExternal = async url => { global.__updateProbe.opens.push(url); };
      dialog.showMessageBox = async (...args) => { global.__updateProbe.prompts.push(args.at(-1)); return { response: 0 }; };
      return true;
    }, release(nextVersion));
    await application.renderer(() => document.querySelector('[data-app-star]').click());
    await until(() => application.evaluate(() => global.__updateProbe.opens.length === 1), 'Star host IPC');
    assert.equal(await application.evaluate(() => global.__updateProbe.opens[0]), target.starUrl);
    receipt.checks.creatorStarUsesCorrectPlatformRepository = true;
    await application.renderer(() => document.querySelector('[data-app-update]').click());
    await until(() => application.renderer(() => document.querySelector('[data-app-update]').dataset.updateAvailable === 'true'
      && !document.querySelector('[data-app-update]').disabled), 'manual result and update event');
    const probe = await application.evaluate(() => global.__updateProbe);
    assert.equal(probe.requests.length, 1); assert.equal(probe.requests[0].url, target.apiUrl); assert.equal(probe.requests[0].credentials, 'omit');
    assert.equal(probe.prompts.length, 1); assert.equal(probe.prompts[0].defaultId, 0); assert.equal(probe.prompts[0].cancelId, 0);
    assert.deepEqual(probe.prompts[0].buttons, ['稍后', '查看更新']);
    assert.match(probe.prompts[0].message, new RegExp(nextVersion.replaceAll('.', '\\.')));
    receipt.checks.manualCheckAndNativePromptAndStateEvent = true;
    await application.renderer(() => document.querySelector('[data-app-update]').click());
    await until(() => application.evaluate(() => global.__updateProbe.opens.length === 2), 'known update opens');
    assert.equal(await application.evaluate(() => global.__updateProbe.opens[1]), target.starUrl + '/releases/tag/v' + nextVersion);
    receipt.checks.updateOpensPinnedReleaseWithoutRestart = true;
    await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed()); win.setSize(1100, 780); return true; });
    await delay(300);
    const geometry = await application.renderer(() => {
      const buttons = [...document.querySelectorAll('.header-actions button,.header-actions a')].filter(node => node.getBoundingClientRect().width > 0);
      return { width: innerWidth, right: Math.max(...buttons.map(node => node.getBoundingClientRect().right)),
        star: document.querySelector('[data-app-star]').getBoundingClientRect().toJSON(), update: document.querySelector('[data-app-update]').getBoundingClientRect().toJSON() };
    });
    assert.ok(geometry.right <= geometry.width + 1, 'Support controls must not push actions outside the toolbar'); receipt.geometry = geometry;
    receipt.checks.creatorControlsFit1100px = true;

    await application.renderer(() => window.creatorAPI.showMainWindow()).catch(() => {});
    const mainPage = (fn, value) => application.evaluate(async ({ webContents }, request) => {
      const wc = webContents.getAllWebContents().find(wc => {
        if (wc.isDestroyed()) return false;
        try { const url = new URL(wc.getURL()); return ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === request.port && ['/', '/index.html'].includes(url.pathname); } catch { return false; }
      });
      if (!wc) return null;
      return wc.executeJavaScript('(' + request.fn + ')(' + JSON.stringify(request.value ?? null) + ')');
    }, { fn: fn.toString(), value, port: env.VIDEO_OS_PORT });
    await until(() => mainPage(() => window.desktopOS && !!document.querySelector('[data-app-star]')).catch(() => false), 'same owned main surface');
    assert.equal((await mainPage(() => window.desktopOS.getAppReleaseState())).release.version, nextVersion);
    await mainPage(() => document.querySelector('[data-app-star]').click());
    await until(() => application.evaluate(() => global.__updateProbe.opens.length === 3), 'main Star IPC');
    assert.equal(await application.evaluate(() => global.__updateProbe.opens[2]), target.starUrl);
    receipt.checks.mainSurfaceStarAndUpdateState = true;
    await application.close(); application = null;
    env.VIDEO_OS_PORT = String(await freePort());
    application = await launchIsolatedElectron({ executablePath, env });
    const restored = await application.renderer(() => window.desktopOS.getAppReleaseState());
    assert.equal(restored.release.version, nextVersion); assert.equal(restored.promptedVersion, nextVersion); assert.equal(restored.available, true);
    receipt.checks.restartRetainsReleaseAndDoesNotForgetPromptedVersion = true;
    assert.equal(restored.automaticInstall, false);
    receipt.status = 'passed'; console.log('GITHUB_UPDATES_NATIVE_PASS platform=' + process.platform + ' version=' + version + ' bothSurfaces=true nativeIPC=true stateEvent=true restart=true realStar=false');
  } catch (error) { receipt.status = 'failed'; receipt.failure = String(error.stack || error); throw error; }
  finally {
    if (application) await application.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); receipt.fixtureCleaned = !fs.existsSync(temp);
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log('GITHUB_UPDATES_NATIVE_EVIDENCE ' + evidence);
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
