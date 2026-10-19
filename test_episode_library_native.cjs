'use strict';

// Native asset preload and the real library WebContentsView. All roots are disposable.
// Native drag payload is intercepted inside this fixture; no external application receives a file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 16000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(50); }
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
  const executablePath = process.env.EPISODE_TEST_EXECUTABLE || '';
  if (executablePath) {
    assert.ok(executablePath.includes('/test-artifacts/'), 'Only an explicitly staged test executable is allowed');
    assert.equal(executablePath.includes('/asset-workflow-candidate-'), false, 'Never launch the current candidate');
  }
  const evidenceRoot = path.resolve(process.env.EPISODE_TEST_EVIDENCE || path.join(__dirname, 'test-artifacts',
    `episode-library-${executablePath ? 'packaged' : 'source'}-${Date.now()}-${process.pid}`));
  assert.equal(fs.existsSync(evidenceRoot), false); fs.mkdirSync(evidenceRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-episode-library-'));
  const projectRoot = path.join(temp, 'project'), dataDir = path.join(temp, 'data'), profile = path.join(temp, 'profile');
  const assetRoot = path.join(projectRoot, '创作资产库');
  const alphaName = '资产库分集验收甲', betaName = '资产库分集验收乙';
  const oldToken = `${alphaName}/生成图片/GPT/2026-09-10/旧图片.png`;
  const originalEpisodeToken = `${alphaName}/生成图片/GPT/第1集/原第1集.png`;
  const customDateToken = `${alphaName}/场景资产/2026-09-10/自建场景.png`;
  const betaToken = `${betaName}/生成图片/GPT/2026-09-10/乙剧本图片.png`;
  const absolute = token => path.join(assetRoot, ...token.split('/'));
  const report = { status: 'running', testedAt: new Date().toISOString(), checks: {},
    scope: { isolatedProjectAndProfile: true, formalAppTouched: false, candidateAppTouched: false,
      externalPlatformLoginOrGeneration: false, physicalMouseE2E: false, nativeDragTargetDelivery: false,
      oldAssetsAutomaticallyMigrated: false } };
  let application, creator;
  const watchdog = setTimeout(() => {
    application?.process()?.kill('SIGKILL'); console.error('EPISODE_LIBRARY_NATIVE_TIMEOUT'); process.exitCode = 1;
  }, 140000).unref();
  try {
    for (const token of [oldToken, originalEpisodeToken, customDateToken, betaToken]) {
      fs.mkdirSync(path.dirname(absolute(token)), { recursive: true }); fs.writeFileSync(absolute(token), PNG);
    }
    fs.mkdirSync(dataDir); fs.mkdirSync(path.join(temp, 'obsidian'));
    const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0',
      VIDEO_OS_PORT: String(await freePort()), VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: dataDir, VIDEO_OS_USER_DATA: profile, OBSIDIAN_VAULT_PATH: path.join(temp, 'obsidian'),
      VIDEO_OS_TEST_OBSIDIAN_VAULT: path.join(temp, 'obsidian'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [__dirname] }), env, timeout: 30000 });
    creator = await application.firstWindow();
    await creator.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 25000 });
    report.runtime = await application.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged,
      appPath: app.getAppPath(), userData: app.getPath('userData') }));
    assert.equal(report.runtime.packaged, !!executablePath);
    assert.equal(fs.realpathSync(report.runtime.userData), fs.realpathSync(profile));
    const projects = await creator.evaluate(() => fetch('/api/creative-projects').then(response => response.json()));
    const alpha = projects.projects.find(project => project.name === alphaName), beta = projects.projects.find(project => project.name === betaName);
    assert.ok(alpha && beta);
    const activate = async project => {
      await creator.evaluate(async id => {
        const response = await fetch('/api/creative-projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'activate', id }) });
        const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result));
      }, project.id);
      await until(() => creator.locator('#currentProject').textContent().then(value => value.includes(project.name)), 'creator project updated');
    };
    await activate(alpha);
    const config = await creator.evaluate(() => window.creatorAPI.getConfig());
    assert.equal(config.testMode, true);
    assert.equal(fs.realpathSync(config.paths.projectRoot), fs.realpathSync(projectRoot));
    await creator.evaluate(() => window.creatorAPI.setAssetPanel({ open: true, width: 720, layout: 'overlay' }));
    const assetEval = code => application.evaluate(({ webContents }, code) => {
      const contents = webContents.getAllWebContents().find(contents => contents.getURL().includes('/creator-assets.html'));
      if (!contents || contents.isDestroyed()) return null;
      return contents.executeJavaScript(code, true);
    }, code);
    await until(() => assetEval('document.body.dataset.ready === "true"'), 'native library ready');
    const libraryConfig = await assetEval('window.assetAPI.getConfig()');
    assert.equal(libraryConfig.project.id, alpha.id);
    assert.equal(libraryConfig.downloadEpisodes.projectId, alpha.id);
    assert.deepEqual(libraryConfig.downloadEpisodes, config.downloadEpisodes, 'Asset native preload carries the same scoped episode contract');
    await assetEval('window.__episodeEvents=[]; window.assetAPI.onDownloadEpisodesChanged(batch => window.__episodeEvents.push(batch)); true');
    const platformPath = `${alpha.folder}/生成图片/GPT`;
    const historyPath = 'videoOS-history://' + encodeURIComponent(platformPath);
    const selectFolder = token => assetEval(`(() => {
      const button = document.querySelector('.folder-button[data-folder-path="' + CSS.escape(${JSON.stringify(token)}) + '"]');
      if (!button) return false; button.click(); return true;
    })()`);
    for (const token of [alpha.folder, `${alpha.folder}/生成图片`, platformPath]) assert.equal(await selectFolder(token), true);
    assert.equal(await selectFolder(historyPath), true);
    const history = await assetEval(`(() => {
      const row=document.querySelector('.folder-row[data-folder-path="' + CSS.escape(${JSON.stringify(historyPath)}) + '"]');
      return { name:row?.dataset.folderName, grip:row?.querySelectorAll('.folder-order-grip').length,
        disabled:['importAssets','newSubfolder','normalizeNames'].map(id=>document.getElementById(id).disabled),
        paths:[...document.querySelectorAll('#assetGrid .asset-card')].map(card=>card.dataset.path),
        dateRows:[...document.querySelectorAll('.folder-row')].map(row=>row.dataset.folderPath).filter(token=>token.endsWith('/2026-09-10')) };
    })()`);
    assert.equal(history.name, '未分集素材'); assert.equal(history.grip, 0);
    assert.deepEqual(history.disabled, [true, true, true]); assert.deepEqual(history.paths, [oldToken]);
    assert.ok(!history.dateRows.includes(`${platformPath}/2026-09-10`));
    assert.ok(history.dateRows.includes(`${alpha.folder}/场景资产/2026-09-10`), 'Ordinary custom date folders stay real folders');
    await application.evaluate(({ Menu, webContents }) => {
      globalThis.__episodeLibraryMenus = 0; globalThis.__episodeLibraryDrags = [];
      Menu.prototype.popup = function(options) { globalThis.__episodeLibraryMenus++; options?.callback?.(); };
      webContents.getAllWebContents().find(contents => contents.getURL().includes('/creator-assets.html')).startDrag = payload => {
        globalThis.__episodeLibraryDrags.push(payload.file || payload.files);
      };
    });
    await assetEval(`document.querySelector('.folder-row[data-folder-path="' + CSS.escape(${JSON.stringify(historyPath)}) + '"]')
      .dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2})); true`);
    assert.equal(await application.evaluate(() => globalThis.__episodeLibraryMenus), 0);
    await until(() => assetEval('Number(getComputedStyle(document.getElementById("assetToast")).opacity)<.01'), 'history notice fades');
    await assetEval(`document.querySelector('.folder-row[data-folder-path="' + CSS.escape(${JSON.stringify(historyPath)}) + '"]')
      .scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}); true`);
    const historyScreenshot = await application.evaluate(async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find(contents => contents.getURL().includes('/creator-assets.html'));
      return (await contents.capturePage()).toPNG().toString('base64');
    });
    fs.writeFileSync(path.join(evidenceRoot, 'native-library-history.png'), Buffer.from(historyScreenshot, 'base64'));
    report.checks.nativeLibraryMetadataAndHistoryReadonly = true;
    report.history = history;
    assert.deepEqual(fs.readFileSync(absolute(oldToken)), PNG);
    console.log('EPISODE_LIBRARY_STEP native-metadata-readonly-pass');

    const advanced = await creator.evaluate(payload => window.creatorAPI.advanceDownloadEpisode(payload),
      { projectId: alpha.id, serviceId: 'gpt', kind: 'image', expectedEpisode: 1 });
    assert.equal(advanced.state.episode, 2);
    await until(() => assetEval(`window.__episodeEvents.some(batch => batch.projectId===${JSON.stringify(alpha.id)}
      && batch.states.some(entry=>entry.serviceId==='gpt'&&entry.kind==='image'&&entry.episode===2))`), 'asset native episode event');
    const nextPath = `${platformPath}/第2集`;
    await until(() => assetEval(`!!document.querySelector('.folder-row[data-folder-path="' + CSS.escape(${JSON.stringify(nextPath)}) + '"]')`), 'new episode row through asset SSE');
    assert.deepEqual(fs.readFileSync(absolute(originalEpisodeToken)), PNG);
    assert.deepEqual(fs.readFileSync(absolute(oldToken)), PNG);
    report.checks.episodePushUpdatesLibraryWithoutMigratingOldAssets = true;
    console.log('EPISODE_LIBRARY_STEP episode-event-pass');

    // The actual history card menu moves a real asset to the new real episode folder.
    assert.equal(await selectFolder(historyPath), true);
    await assetEval(`document.querySelector('#assetGrid .asset-card[data-path="' + CSS.escape(${JSON.stringify(oldToken)}) + '"]')
      .dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:250,clientY:250})); true`);
    await until(() => assetEval(`(() => { const menu = [...document.querySelectorAll('.asset-context-menu button')]
      .find(button => button.textContent==='移动到…'); if (!menu) return false; menu.click(); return true; })()`), 'real history card move action');
    assert.equal(await assetEval(`!!document.querySelector('#moveFolderList .move-folder-row[data-folder-path="' + CSS.escape(${JSON.stringify(historyPath)}) + '"]')`), false,
      'Virtual history is never a writable move target');
    assert.equal(await assetEval(`(() => { const target=document.querySelector('#moveFolderList .move-folder-row[data-folder-path="'
      + CSS.escape(${JSON.stringify(nextPath)}) + '"]'); if(!target) return false; target.click(); return true; })()`), true);
    const movedToken = `${nextPath}/旧图片.png`;
    await until(() => fs.existsSync(absolute(movedToken)), 'real history file moved once');
    assert.equal(fs.existsSync(absolute(oldToken)), false);
    assert.deepEqual(fs.readFileSync(absolute(movedToken)), PNG);
    await until(() => assetEval(`!!document.querySelector('#assetGrid .asset-card[data-path="' + CSS.escape(${JSON.stringify(movedToken)}) + '"]')`), 'moved asset still indexed');
    await assetEval(`document.querySelector('#assetGrid .asset-card[data-path="' + CSS.escape(${JSON.stringify(movedToken)}) + '"] .asset-preview-button').click(); true`);
    await until(() => assetEval(`(() => {const image=document.querySelector('#previewMedia img');
      return document.getElementById('previewDialog').open && image?.complete && image.naturalWidth===1;})()`), 'moved history image decodes in actual preview');
    const preview = await assetEval(`(() => {const image=document.querySelector('#previewMedia img');
      return {name:document.getElementById('previewName').textContent,src:image.src,width:image.naturalWidth};})()`);
    assert.equal(preview.name, '旧图片.png');
    await assetEval(`document.getElementById('closePreview').click(); document.querySelector('#assetGrid .asset-card[data-path="'
      + CSS.escape(${JSON.stringify(movedToken)}) + '"]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true})); true`);
    const dragged = await until(() => application.evaluate(() => globalThis.__episodeLibraryDrags.at(-1)), 'native moved-file drag IPC');
    assert.equal(fs.realpathSync(dragged), fs.realpathSync(absolute(movedToken)));
    assert.deepEqual(fs.readFileSync(dragged), PNG);
    report.checks.historyAssetMovesPreviewsAndUsesRealNativeDragPath = true;
    report.preview = preview;
    console.log('EPISODE_LIBRARY_STEP history-move-preview-native-drag-pass');

    // A live project switch cannot carry another script's virtual group or selected files across.
    await activate(beta);
    await until(() => assetEval(`window.assetAPI.getConfig().then(config => config.project.id===${JSON.stringify(beta.id)})`), 'native library project beta');
    const betaHistory = 'videoOS-history://' + encodeURIComponent(`${beta.folder}/生成图片/GPT`);
    await until(() => assetEval(`!!document.querySelector('.folder-row[data-folder-path="' + CSS.escape(${JSON.stringify(betaHistory)}) + '"]')`), 'beta scoped history tree');
    assert.equal(await assetEval(`!!document.querySelector('.folder-row[data-folder-path="' + CSS.escape(${JSON.stringify(historyPath)}) + '"]')`), false);
    assert.equal(await selectFolder(betaHistory), true);
    const betaCards = await assetEval('[...document.querySelectorAll("#assetGrid .asset-card")].map(card=>card.dataset.path)');
    assert.deepEqual(betaCards, [betaToken]);
    assert.deepEqual(fs.readFileSync(absolute(betaToken)), PNG);
    assert.deepEqual(fs.readFileSync(absolute(customDateToken)), PNG);
    assert.deepEqual(fs.readFileSync(absolute(originalEpisodeToken)), PNG);
    report.checks.libraryProjectSwitchKeepsHistoryScoped = true;
    report.status = 'passed';
    console.log(`EPISODE_LIBRARY_NATIVE_PASS packaged=${!!executablePath} metadata=true historyReadonly=true originalPaths=true event=true movedPreview=true nativeDragPayload=true projectIsolation=true`);
  } catch (error) {
    report.status = 'failed'; report.failure = String(error.stack || error); throw error;
  } finally {
    clearTimeout(watchdog);
    if (application) await application.close().catch(() => application.process()?.kill('SIGKILL'));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    report.fixtureCleaned = true;
    fs.writeFileSync(path.join(evidenceRoot, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(`EPISODE_LIBRARY_NATIVE_EVIDENCE ${evidenceRoot}`);
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
