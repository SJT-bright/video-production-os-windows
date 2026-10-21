'use strict';

// Real staged App/preload/IPC with disposable project, data and profile only.
// Native confirmation is intercepted. Most Trash calls use an owned recovery
// directory; one uniquely named generated PNG exercises the actual macOS Trash.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedElectron } = require('./test-isolated-electron-cdp.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function until(read, label) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(60); }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(![3750, 3794].includes(port));
  return port;
}

async function main() {
  assert.equal(process.platform, 'darwin', 'The real Trash case requires macOS');
  const executablePath = process.env.BULK_NATIVE_EXECUTABLE || '';
  assert.ok(executablePath.includes('/test-artifacts/') && fs.existsSync(executablePath));
  const evidenceRoot = path.resolve(process.env.BULK_NATIVE_EVIDENCE ||
    path.join(__dirname, 'test-artifacts', 'bulk-delete-native-20261014', `run-${Date.now()}`));
  assert.equal(fs.existsSync(evidenceRoot), false); fs.mkdirSync(evidenceRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-episodes-bulk-'));
  const projectRoot = path.join(temp, 'project'), assetRoot = path.join(projectRoot, '创作资产库');
  const name = '批删原生验收', realName = `video-os-bulk-fixture-${crypto.randomUUID()}.png`;
  const token = file => `${name}/人物资产/${file}`;
  const absolute = relative => path.join(assetRoot, ...relative.split('/'));
  const tokens = ['成功.png', '失败.png', '未选.png', realName].map(token);
  const receipt = { status: 'running', testedAt: new Date().toISOString(), checks: {},
    scope: { isolatedProjectDataProfile: true, formalAppModified: false,
      nativePreloadIPC: true, nativeConfirmationIntercepted: true,
      partialFailureTrashInjected: true, realSystemTrashTested: false,
      physicalMouseE2E: false, installed: false, published: false } };
  let application, realTrashTarget;
  const watchdog = setTimeout(() => {
    application?.process()?.kill('SIGKILL'); process.exitCode = 1;
    console.error('BULK_NATIVE_TIMEOUT');
  }, 160000).unref();
  try {
    for (const relative of tokens) {
      fs.mkdirSync(path.dirname(absolute(relative)), { recursive: true });
      fs.writeFileSync(absolute(relative), PNG, { flag: 'wx' });
    }
    for (const directory of ['data', 'profile', 'obsidian', 'recovery']) fs.mkdirSync(path.join(temp, directory));
    const port = await freePort();
    const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0',
      VIDEO_OS_PORT: String(port), VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: path.join(temp, 'data'), VIDEO_OS_USER_DATA: path.join(temp, 'profile'),
      OBSIDIAN_VAULT_PATH: path.join(temp, 'obsidian'), VIDEO_OS_TEST_OBSIDIAN_VAULT: path.join(temp, 'obsidian') };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await launchIsolatedElectron({ executablePath, env });
    receipt.runtime = await application.evaluate(({ app }) => ({ pid: process.pid, version: app.getVersion(),
      packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData') }));
    assert.equal(receipt.runtime.packaged, true); assert.equal(receipt.runtime.version, require('./package.json').version);
    const projects = await application.renderer(() => fetch('/api/creative-projects').then(response => response.json()));
    const project = projects.projects.find(project => project.name === name); assert.ok(project);
    await application.renderer(async id => {
      const response = await fetch('/api/creative-projects', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'activate', id }) });
      if (!response.ok) throw new Error(await response.text()); return response.json();
    }, project.id);
    await until(() => application.renderer(id => state.projectId === id && state.assetItems.length === 4, project.id), 'own project and four PNGs');
    const config = await application.renderer(() => window.creatorAPI.getConfig());
    assert.equal(config.testMode, true); assert.equal(fs.realpathSync(config.paths.projectRoot), fs.realpathSync(projectRoot));
    await application.renderer(() => window.creatorAPI.setAssetPanel({ open: true, width: 720, layout: 'overlay' }));
    const library = (fn, value) => application.renderer(fn, value, '/creator-assets.html');
    await until(() => library(() => document.body.dataset.ready === 'true').catch(() => false), 'owned native library');
    assert.equal(await library(() => typeof window.assetAPI.deleteItems), 'function');
    assert.equal(await application.renderer(() => typeof window.creatorAPI.deleteAssets), 'function');
    receipt.checks.packagedRuntimeAndBothRealPreloads = true;
    await library(() => { document.getElementById('assetCollapse').click(); return true; });
    await until(() => library(() => {
      const pane = document.querySelector('.library-pane'), heading = document.querySelector('.library-heading');
      return pane.classList.contains('grid-collapsed')
        && getComputedStyle(document.getElementById('selectionBar')).display === 'none'
        && Math.abs(pane.getBoundingClientRect().bottom - heading.getBoundingClientRect().bottom) <= 2;
    }), 'collapsed library keeps only its bottom heading');
    await library(() => { document.getElementById('assetCollapse').click(); return true; });
    await until(() => library(() => getComputedStyle(document.getElementById('selectionBar')).display !== 'none'), 'batch bar restored after expanding');
    receipt.checks.collapsedLibraryHeadingAndBatchBarRestoration = true;

    await application.evaluate(({ dialog, shell }, recovery) => {
      // Capture modules while the inspector's command-line require is in scope.
      const fixtureFS = require('node:fs'), fixturePath = require('node:path');
      globalThis.__bulkNative = { prompts: [], trash: [], response: 0, checkboxChecked: true, failName: '失败.png', defer: false, recovery };
      globalThis.__bulkOriginalTrash = shell.trashItem.bind(shell);
      dialog.showMessageBox = async (_owner, options) => {
        __bulkNative.prompts.push(options);
        if (__bulkNative.defer) return new Promise(resolve => { __bulkNative.resolve = resolve; });
        return { response: __bulkNative.response, checkboxChecked: __bulkNative.checkboxChecked };
      };
      shell.trashItem = async file => {
        __bulkNative.trash.push(file);
        if (fixturePath.basename(file) === __bulkNative.failName) throw new Error('隔离模拟废纸篓失败');
        await fixtureFS.promises.rename(file, fixturePath.join(__bulkNative.recovery, fixturePath.basename(file)));
      };
      return true;
    }, path.join(temp, 'recovery'));

    // Invoke real card click listeners and the real left-hand batch button.
    await application.renderer(paths => {
      // Lazy folders must be opened through their real disclosure controls.
      for (const folder of [state.config.project.folder, `${state.config.project.folder}/人物资产`]) {
        const row = document.querySelector(`.quick-folder-row[data-folder-path="${CSS.escape(folder)}"]`);
        const disclosure = row?.querySelector('.quick-folder-chevron-wrap');
        if (!disclosure) throw new Error('Own test folder missing');
        if (disclosure.getAttribute('aria-expanded') === 'false') disclosure.click();
      }
      document.getElementById('quickMultiSelect').click();
      for (const relative of paths) {
        const card = document.querySelector(`[data-asset-path="${CSS.escape(relative)}"] .asset-image-card`);
        if (!card) throw new Error('Own test card missing'); card.click();
      }
      document.getElementById('quickSelDelete').click(); return true;
    }, tokens.slice(0, 2));
    await until(() => application.evaluate(() => __bulkNative.prompts.length === 1), 'one native cancellation prompt');
    await until(() => application.renderer(() => !quickAssetDeletionBusy()), 'cancel completed');
    assert.deepEqual(await application.renderer(() => [...state.quickSelectionOrder]), tokens.slice(0, 2));
    assert.equal((await application.evaluate(() => __bulkNative.trash)).length, 0);
    assert.equal(await application.renderer(() => state.assetItems.length), 4);
    for (const relative of tokens) assert.deepEqual(fs.readFileSync(absolute(relative)), PNG);
    const prompt = await application.evaluate(() => __bulkNative.prompts[0]);
    assert.equal(prompt.defaultId, 0); assert.equal(prompt.cancelId, 0); assert.equal(prompt.buttons.length, 2);
    assert.match(prompt.message, /2/); assert.match(prompt.detail, /废纸篓/);
    assert.match(prompt.checkboxLabel, /5 分钟内不再询问/); assert.equal(prompt.checkboxChecked, false);
    receipt.checks.sidebarCancelAndSingleDefaultCancelNativePrompt = true;

    await application.evaluate(() => { __bulkNative.response = 1; __bulkNative.checkboxChecked = false; return true; });
    await application.renderer(() => { document.getElementById('quickSelDelete').click(); return true; });
    await until(() => application.evaluate(() => __bulkNative.prompts.length === 2), 'one prompt on retry');
    await until(() => application.renderer(() => !quickAssetDeletionBusy()), 'partial batch completed');
    assert.equal(fs.existsSync(absolute(tokens[0])), false);
    assert.deepEqual(fs.readFileSync(path.join(temp, 'recovery', '成功.png')), PNG);
    assert.deepEqual(fs.readFileSync(absolute(tokens[1])), PNG);
    assert.deepEqual(fs.readFileSync(absolute(tokens[2])), PNG);
    assert.deepEqual(await application.renderer(() => [...state.quickSelectionOrder]), [tokens[1]]);
    assert.equal(await application.renderer(() => state.assetItems.length), 3);
    await until(() => library(relative => !state.assets.some(item => item.path === relative), tokens[0]), 'library receives final real SSE');
    receipt.partial = await application.renderer(() => ({ count: state.assetItems.length,
      selected: [...state.quickSelectionOrder], toast: document.getElementById('creatorToast').textContent }));
    assert.match(receipt.partial.toast, /1 项/);
    receipt.checks.sidebarPartialFailureAndBothCounts = true;

    // The two real IPC handlers share one lock even while confirmation is open.
    await application.evaluate(() => { __bulkNative.defer = true; return true; });
    await application.renderer(payload => {
      window.__bulkPending = window.creatorAPI.deleteAssets(payload).then(result => { window.__bulkPendingResult = result; });
      return true;
    }, { projectId: project.id, paths: [tokens[1]] });
    await until(() => application.evaluate(() => __bulkNative.prompts.length === 3), 'held native prompt');
    const concurrent = await library(async payload => {
      try { await window.assetAPI.deleteItems(payload); return { rejected: false }; }
      catch (error) { return { rejected: true, error: String(error.message) }; }
    }, { projectId: project.id, paths: [tokens[1]] });
    assert.equal(concurrent.rejected, true); assert.match(concurrent.error, /已有批量删除/);
    assert.equal(await application.evaluate(() => __bulkNative.prompts.length), 3);
    await application.evaluate(() => { __bulkNative.resolve({ response: 0 }); __bulkNative.defer = false; return true; });
    const cancelled = await until(() => application.renderer(() => window.__bulkPendingResult), 'shared lock cancelled');
    assert.equal(cancelled.cancelled, true); assert.equal(cancelled.deleted.length, 0);
    receipt.checks.sharedNativeLockAcrossBothSurfaces = true;

    // Real full-library button, real preload, successful deletion on retry.
    await application.evaluate(() => { __bulkNative.failName = ''; __bulkNative.checkboxChecked = true; return true; });
    await library(relative => {
      const checkbox = document.querySelector(`[data-check-path="${CSS.escape(relative)}"]`);
      if (!checkbox) throw new Error('Own library checkbox missing'); checkbox.click();
      document.getElementById('batchDelete').click(); return true;
    }, tokens[1]);
    await until(() => application.evaluate(() => __bulkNative.prompts.length === 4), 'one full-library prompt');
    await until(() => library(() => !state.batchDeleteBusy && state.selectedPaths.size === 0), 'library batch completed');
    assert.equal(fs.existsSync(absolute(tokens[1])), false);
    assert.deepEqual(fs.readFileSync(path.join(temp, 'recovery', '失败.png')), PNG);
    assert.equal(await library(() => state.assets.length), 2);
    await until(() => application.renderer(() => state.assetItems.length === 2), 'sidebar receives library deletion');
    assert.deepEqual(fs.readFileSync(absolute(tokens[2])), PNG);
    receipt.checks.libraryRetryUsesNativeIPCAndSynchronizesSidebar = true;

    // Restore original shell API for one generated unique file, never a user file.
    await application.evaluate(({ shell }) => { shell.trashItem = __bulkOriginalTrash; return true; });
    const realHash = hash(absolute(tokens[3]));
    const realResult = await application.renderer(payload => window.creatorAPI.deleteAssets(payload),
      { projectId: project.id, paths: [tokens[3]] });
    assert.deepEqual(realResult.deleted, [tokens[3]]); assert.equal(realResult.failed.length, 0);
    assert.equal(fs.existsSync(absolute(tokens[3])), false);
    realTrashTarget = path.join(os.homedir(), '.Trash', realName);
    assert.equal(hash(realTrashTarget), realHash, 'Only the exact generated unique PNG may be restored');
    fs.renameSync(realTrashTarget, absolute(tokens[3])); realTrashTarget = null;
    assert.equal(hash(absolute(tokens[3])), realHash);
    receipt.scope.realSystemTrashTested = true;
    receipt.checks.realSystemTrashAndExactGeneratedFileRecovery = true;
    receipt.trash = { result: realResult, fixtureSha256: realHash, recoveredBeforeCleanup: true };
    assert.deepEqual(fs.readFileSync(absolute(tokens[2])), PNG);
    assert.equal(fs.statSync(path.dirname(absolute(tokens[2]))).isDirectory(), true);
    receipt.checks.unselectedBytesAndParentDirectoryPreserved = true;
    receipt.nativePromptCount = await application.evaluate(() => __bulkNative.prompts.length);
    assert.equal(receipt.nativePromptCount, 4, 'Library opt-in must cover the next sidebar deletion, while checked cancellation must not');
    receipt.checks.nativeCheckboxContractCancelDoesNotOptInAndSharedFiveMinuteSkip = true;
    receipt.status = 'passed';
    console.log('BULK_NATIVE_PASS actualApp=true preloadIPC=true cancel=true partial=true sharedLock=true bothPanels=true realTrash=true unselected=true');
  } catch (error) {
    receipt.status = 'failed'; receipt.failure = String(error.stack || error);
    if (application) {
      receipt.failureNativeState = await application.evaluate(() => globalThis.__bulkNative
        ? { prompts: __bulkNative.prompts, trash: __bulkNative.trash } : null).catch(error => ({ error: String(error.message) }));
      receipt.failureSidebarState = await application.renderer(() => ({ busy: quickAssetDeletionBusy(),
        selected: [...state.quickSelectionOrder], toast: document.getElementById('creatorToast').textContent })).catch(error => ({ error: String(error.message) }));
    }
    throw error;
  } finally {
    clearTimeout(watchdog);
    if (application) await application.close();
    // If the real Trash probe failed after delivery, only its exact owned file
    // is eligible for cleanup; never enumerate or clear the user's Trash.
    if (realTrashTarget) {
      try {
        if (hash(realTrashTarget) === crypto.createHash('sha256').update(PNG).digest('hex')) {
          fs.renameSync(realTrashTarget, path.join(temp, realName)); receipt.trashFixtureRecoveredOnFailure = true;
        }
      } catch (error) { receipt.trashFixtureCleanupError = String(error.message); }
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    receipt.fixtureCleaned = !fs.existsSync(temp);
    fs.writeFileSync(path.join(evidenceRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    console.log(`BULK_NATIVE_EVIDENCE ${evidenceRoot}`);
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
