'use strict';

// Real Electron main-process server and the main-sidebar asset iframe, using only
// disposable local roots. No installed App, external login or download is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 18000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  assert.ok(![3750, 3794].includes(port)); return port;
}

async function main() {
  const executablePath = process.env.ASSET_RESPONSIVENESS_EXECUTABLE || '';
  if (executablePath) {
    assert.ok(path.isAbsolute(executablePath) && executablePath.includes('/test-artifacts/'));
    assert.equal(executablePath.includes('/asset-workflow-candidate-'), false);
  }
  const evidence = path.resolve(process.env.ASSET_RESPONSIVENESS_EVIDENCE || path.join(__dirname, 'test-artifacts',
    `asset-entry-${executablePath ? 'packaged' : 'source'}-${Date.now()}-${process.pid}`));
  assert.equal(fs.existsSync(evidence), false, 'Do not overwrite prior evidence'); fs.mkdirSync(evidence, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-asset-entry-'));
  const projectRoot = path.join(temporary, 'project'), dataDir = path.join(temporary, 'data');
  const profile = path.join(temporary, 'profile'), obsidian = path.join(temporary, 'obsidian');
  const assetRoot = path.join(projectRoot, '创作资产库'), name = '入口响应测试剧本';
  const legalDocs = path.join(projectRoot, '文档集合'), originals = [];
  const report = { status: 'running', testedAt: new Date().toISOString(), checks: {}, pageErrors: [],
    scope: { isolatedProjectAndProfile: true, formalAppTouched: false, candidateAppTouched: false,
      externalPlatformLoginOrGeneration: false, realDownloadedFile: false,
      downloadCompletion: 'Local file landing plus native os:download-complete IPC and server broadcastCreativeAssets',
      syntheticIO: 'Only this spawned fixture: 15 ms asynchronous delay per legal document directory' } };
  let application, page, ownProcess;
  const watchdog = setTimeout(() => { ownProcess?.kill('SIGKILL'); process.exitCode = 1; }, 100000).unref();
  try {
    for (let i = 0; i < 60; i++) {
      const folder = path.join(legalDocs, `正文-${i}`); fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `VIDEO-${String(i).padStart(3, '0')}_正文.md`);
      fs.writeFileSync(file, `# 正文 ${i}\n有效文档\n`); originals.push(file);
    }
    for (const technical of ['node_modules', '.worktrees', 'test-artifacts', '视频制作OS', 'archive.app']) {
      const folder = path.join(projectRoot, technical, 'nested'); fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'VIDEO-999_技术目录.md'), '# 不应出现在文档索引');
    }
    const firstMedia = path.join(assetRoot, name, '人物资产', '原人物.png');
    fs.mkdirSync(path.dirname(firstMedia), { recursive: true }); fs.writeFileSync(firstMedia, PNG);
    const baselineMedia = [firstMedia];
    for (let i = 0; i < 637; i++) {
      const file = path.join(assetRoot, name, '人物资产', `分组-${i % 12}`, `人物-${i}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, PNG); baselineMedia.push(file);
    }
    report.baselineMediaCount = baselineMedia.length;
    fs.mkdirSync(dataDir); fs.mkdirSync(obsidian);
    const uiPort = await freePort(), env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0',
      VIDEO_OS_PORT: String(uiPort), VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: dataDir, VIDEO_OS_USER_DATA: profile, OBSIDIAN_VAULT_PATH: obsidian,
      VIDEO_OS_TEST_OBSIDIAN_VAULT: obsidian, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [__dirname] }), env, timeout: 30000 });
    ownProcess = application.process(); report.testPID = ownProcess.pid;
    page = await application.firstWindow(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.waitForFunction(() => document.body?.dataset.ready === 'true', null, { timeout: 25000 });
    report.runtime = await application.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged,
      appPath: app.getAppPath(), executable: process.execPath, userData: app.getPath('userData') }));
    assert.equal(report.runtime.packaged, !!executablePath);
    assert.equal(fs.realpathSync(report.runtime.userData), fs.realpathSync(profile));
    const config = await page.evaluate(() => window.creatorAPI.getConfig());
    assert.equal(config.testMode, true); assert.equal(fs.realpathSync(config.paths.projectRoot), fs.realpathSync(projectRoot));
    const catalog = await page.evaluate(() => fetch('/api/creative-projects').then(response => response.json()));
    const project = catalog.projects.find(item => item.name === name); assert.ok(project);
    if (project.id !== config.project.id) await page.evaluate(async id => {
      const response = await fetch('/api/creative-projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'activate', id }) }); if (!response.ok) throw new Error('Fixture project activation failed');
    }, project.id);
    await page.locator('#showMainWindow').click(); await page.waitForURL(url =>
      ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === String(uiPort) && url.pathname === '/');
    await page.locator('#windowsLayer .window[data-app="creator"]').waitFor({ state: 'visible' });
    await page.locator('.side-nav-item[data-app="creative-assets"]').waitFor({ state: 'visible' });
    await page.locator('.side-nav-item[data-app="creative-assets"]').click();
    const library = await until(() => page.frames().find(frame => frame.url().includes('creator-assets.html?surface=library')), 'main asset iframe');
    await library.waitForFunction(() => document.body?.dataset.ready === 'true');
    await library.locator('#assetGrid .asset-card').first().waitFor({ state: 'visible' });
    assert.ok((await library.locator('#librarySummary').textContent()).includes(name));
    report.checks.mainSidebarRealAssetIframe = true;
    await delay(1000); // Settle initial event notifications before counting explicit scan requests.
    await application.evaluate((_electron, legalDocs) => {
      const localRequire = process.mainModule.require.bind(process.mainModule);
      const io = localRequire('node:fs/promises'), original = io.opendir;
      const probe = globalThis.__assetEntryProbe = { calls: 0, byPath: {}, activeIO: 0, ticks: 0, gaps: [], last: performance.now() };
      io.opendir = async function (...args) {
        const dir = String(args[0]);
        if (dir === legalDocs || dir.startsWith(legalDocs + localRequire('node:path').sep)) {
          probe.calls++; probe.byPath[dir] = (probe.byPath[dir] || 0) + 1; probe.activeIO++;
          try { await new Promise(resolve => setTimeout(resolve, 15)); return await original.apply(this, args); }
          finally { probe.activeIO--; }
        }
        return original.apply(this, args);
      };
      probe.restore = () => { io.opendir = original; clearInterval(probe.timer); };
      probe.timer = setInterval(() => { const now = performance.now(); probe.gaps.push(now - probe.last); probe.last = now; probe.ticks++; }, 25);
    }, legalDocs);
    await page.evaluate(() => {
      // Distinct query strings avoid identical-URL cache-key serialization.
      // Two persistent SSE streams leave four HTTP/1 connections available.
      window.__entryScans = Promise.all(Array.from({ length: 4 }, (_, index) => fetch(`/api/scan?entryProbe=${index}`, { cache: 'no-store' }).then(response => {
        if (!response.ok) throw new Error(`Scan ${response.status}`); return response.json();
      })));
      return true;
    });
    await until(() => application.evaluate(() => globalThis.__assetEntryProbe.activeIO > 0), 'delayed native document I/O');
    const started = Date.now();
    await library.locator(`.folder-button[data-folder-path=${JSON.stringify(`${project.folder}/人物资产`)}]`).click();
    assert.ok((await library.locator('#currentPath').textContent()).includes('人物资产'));
    await page.locator('.side-nav-item[data-app="assets"]').click();
    await page.locator('.side-nav-item[data-app="creative-assets"]').click();
    report.navigationDuringScanMs = Date.now() - started;
    assert.ok(report.navigationDuringScanMs < 1500, 'Category and module controls must remain responsive during slow async scan');
    const concurrent = await page.evaluate(() => window.__entryScans);
    assert.equal(concurrent.length, 4);
    report.scanTimes = concurrent.map(scan => scan.scannedAt);
    assert.equal(concurrent[0].docs.length, 60); assert.ok(concurrent[0].docs.every(doc => !doc.path.includes('技术目录')));
    const probe = await application.evaluate(() => { const p = globalThis.__assetEntryProbe; return { calls: p.calls,
      perDirectoryMax: Math.max(...Object.values(p.byPath)), ticks: p.ticks, maxGapMs: Math.max(...p.gaps) }; });
    report.concurrentScan = probe;
    assert.equal(new Set(report.scanTimes).size, 1);
    assert.equal(probe.calls, 61, 'All four simultaneous HTTP readers share one scan');
    assert.equal(probe.perDirectoryMax, 1); assert.ok(probe.ticks >= 20); assert.ok(probe.maxGapMs < 500);
    report.checks.concurrentScanSharedAndNativeTickerContinues = true;
    report.checks.technicalDocsExcludedAndControlsResponsive = true;
    const landed = [];
    for (let i = 0; i < 20; i++) {
      const token = path.join(assetRoot, project.folder, '生成图片', 'GPT', '第1集', `新下载-${i}.png`);
      fs.mkdirSync(path.dirname(token), { recursive: true }); fs.writeFileSync(token, PNG); landed.push(token);
    }
    await application.evaluate(({ app, BrowserWindow }) => {
      const localRequire = process.mainModule.require.bind(process.mainModule);
      localRequire(localRequire('node:path').join(app.getAppPath(), 'server.js')).broadcastCreativeAssets();
      const host = BrowserWindow.getAllWindows().find(win => new URL(win.webContents.getURL()).pathname === '/');
      host.webContents.send('os:download-complete', { kind: 'image', filename: '本地落盘模拟.png' });
    });
    await until(() => library.locator('#librarySummary').textContent().then(text => text.includes('658 项')), 'landed media automatically appears');
    await library.locator(`.folder-button[data-folder-path=${JSON.stringify(`${project.folder}/生成图片`)}]`).click();
    assert.equal(await library.locator('#assetGrid .asset-card').count(), 20);
    await page.locator('.side-nav-item[data-app="audio"]').click();
    await page.locator('.side-nav-item[data-app="creative-assets"]').click();
    await page.evaluate(() => window.__entryPostScan = fetch('/api/scan').then(response => response.json()));
    const after = await page.evaluate(() => window.__entryPostScan);
    assert.equal(after.files.filter(file => file.sourceId === 'creative-assets').length, 658);
    const finalProbe = await application.evaluate(() => { const p = globalThis.__assetEntryProbe; return { ticks: p.ticks, maxGapMs: Math.max(...p.gaps) }; });
    assert.ok(finalProbe.maxGapMs < 500); report.nativeHeartbeat = finalProbe;
    assert.equal(report.pageErrors.length, 0);
    for (const file of baselineMedia) assert.deepEqual(fs.readFileSync(file), PNG);
    for (const file of landed) assert.deepEqual(fs.readFileSync(file), PNG);
    for (let i = 0; i < originals.length; i++) assert.equal(fs.readFileSync(originals[i], 'utf8'), `# 正文 ${i}\n有效文档\n`);
    report.checks.downloadCompletionRefreshPreservesClicksAndFiles = true;
    report.checks.noPageErrorsAndOriginalsPreserved = true;
    await page.screenshot({ path: path.join(evidence, 'main-sidebar-assets.png') });
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); report.lastURL = page?.url(); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog);
    if (application) {
      try { await application.evaluate(() => globalThis.__assetEntryProbe?.restore()); } catch {}
      try { await application.close(); } catch { ownProcess?.kill('SIGTERM'); }
      report.testProcessExited = ownProcess?.exitCode !== null || ownProcess?.signalCode !== null;
    }
    if (!application || report.testProcessExited) { fs.rmSync(temporary, { recursive: true, force: true }); report.fixtureCleaned = true; }
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, evidence, checks: report.checks, failure: report.failure }, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
