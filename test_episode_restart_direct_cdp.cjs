'use strict';

// Recovery-only continuation of the isolated packaged checks. This deliberately
// does not call Playwright's all-target initializer, which times out on restored windows.
// Only the spawned fixture process and its exact localhost creator target are attached.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 22000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(60); }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  assert.ok(![3750, 3794].includes(port)); return port;
}
class DirectCDP {
  constructor(url, role) {
    const endpoint = new URL(url);
    assert.ok(endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
    this.role = role; this.socket = new WebSocket(url); this.sequence = 0; this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('Fixture CDP failed')), { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Fixture CDP closed')); }
      this.pending.clear();
    });
  }
  async send(method, params = {}, sessionId) {
    if (this.role === 'main') assert.equal(method, 'Runtime.evaluate');
    else {
      assert.ok(['Target.getTargets', 'Target.attachToTarget', 'Runtime.enable', 'Runtime.evaluate', 'Page.captureScreenshot'].includes(method));
      if (method === 'Target.attachToTarget') assert.equal(params.targetId, this.creatorTargetId);
      if (method.startsWith('Runtime.') || method.startsWith('Page.')) assert.equal(sessionId, this.creatorSession);
    }
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Fixture CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true,
      includeCommandLineAPI: !sessionId }, sessionId);
    if (result.exceptionDetails) throw new Error(`Fixture CDP evaluation: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

async function main() {
  const executable = process.env.EPISODE_TEST_EXECUTABLE, output = process.env.EPISODE_TEST_EVIDENCE;
  const priorFile = process.env.EPISODE_TEST_PRIOR, organization = process.env.EPISODE_TEST_TARGETED === '1';
  assert.ok(executable && path.isAbsolute(executable) && executable.includes('/test-artifacts/'));
  assert.equal(executable.includes('/asset-workflow-candidate-'), false);
  assert.ok(output && path.isAbsolute(output) && output.includes('/test-artifacts/'));
  assert.equal(fs.existsSync(output), false, 'Do not overwrite prior evidence');
  assert.ok(priorFile && path.isAbsolute(priorFile) && priorFile.includes('/test-artifacts/'));
  const priorBytes = fs.readFileSync(priorFile), prior = JSON.parse(priorBytes);
  assert.equal(prior.status, 'failed'); assert.equal(prior.runtime.packaged, true);
  assert.match(prior.failure, /electron\.launch: Timeout/);
  const requiredChecks = organization ? ['historySummaryReadOnlyAndRealTokensPreserved', 'existingNextEpisodeReusedAndFileSymlinkRejected']
    : ['nativeScriptImportExactlyTenBodiesNoOutline', 'defaultEpisodeAndRealDownload', 'buttonCreatesSiblingAndChangesDestination',
      'documentsWebsiteOnlyWithoutDates', 'tabNamesDoNotSplitWebsiteAndDuplicatesDoNotOverwrite', 'projectWebsiteAndMediaKindsIsolated',
      'staleAdvanceCannotSkipEpisode', 'activeDownloadRetainsOriginalEpisodeAndProject', 'processingDispositionPreserved',
      'concurrentDownloadsFreezeEpisodeAndDoNotOverwrite'];
  for (const check of requiredChecks) assert.equal(prior.checks[check], true, `Prior business evidence required: ${check}`);
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-episode-cdp-'));
  const projectRoot = path.join(temp, 'project'), dataDir = path.join(temp, 'data'), profile = path.join(temp, 'profile');
  const assetRoot = path.join(projectRoot, '创作资产库'), projectName = '包内恢复验收剧本';
  const report = { status: 'running', testedAt: new Date().toISOString(), checks: {},
    priorPartialReceipt: { path: priorFile, sha256: crypto.createHash('sha256').update(priorBytes).digest('hex'),
      statusUnchanged: 'failed', completedBusinessChecks: requiredChecks },
    scope: { isolatedProjectAndProfile: true, formalAppTouched: false, candidateAppTouched: false,
      externalTargetsAttached: 0, externalPlatformLoginOrGeneration: false, physicalMouseE2E: false,
      connection: 'direct CDP: exact fixture creator target and spawned main Node inspector', recoveryOnly: true,
      oldAssetsAutomaticallyMigrated: false }, testProcesses: [] };
  let child, exited, nodeCDP, browserCDP, creatorSession, native, renderer, mediaServer;
  const closeOwnApp = async () => {
    if (!child) return;
    try { if (native) await native(({ app }) => { setTimeout(() => app.quit(), 40); return true; }); }
    catch { child.kill('SIGTERM'); }
    browserCDP?.close(); nodeCDP?.close();
    if (!await Promise.race([exited.then(() => true), delay(12000).then(() => false)])) {
      child.kill('SIGTERM'); await Promise.race([exited, delay(3000)]);
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Only the spawned fixture process must exit before reuse/cleanup');
    report.testProcesses.at(-1).exited = true;
    child = nodeCDP = browserCDP = native = renderer = null;
  };
  const watchdog = setTimeout(() => {
    child?.kill('SIGKILL'); console.error('EPISODE_RECOVERY_CDP_TIMEOUT'); process.exitCode = 1;
  }, 150000).unref();
  try {
    fs.mkdirSync(path.join(assetRoot, projectName, '生成视频', '核绘', '2026-09-10'), { recursive: true });
    fs.mkdirSync(dataDir); fs.mkdirSync(path.join(temp, 'obsidian'));
    const movie = path.join(temp, 'fixture.mp4'), bundled = path.join(__dirname, 'vendor', 'media-tools', 'darwin-arm64', 'ffmpeg');
    const ffmpeg = fs.existsSync(bundled) ? bundled : '/opt/homebrew/bin/ffmpeg';
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x72:d=0.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', movie], { timeout: 20000 });
    assert.equal(generated.status, 0, generated.stderr?.toString());
    const bytes = fs.readFileSync(movie), legacy = path.join(assetRoot, projectName, '生成视频', '核绘', '2026-09-10', '旧素材.mp4');
    fs.writeFileSync(legacy, bytes);
    mediaServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="clip.mp4"', 'Content-Length': bytes.length });
      response.end(bytes);
    });
    await new Promise(resolve => mediaServer.listen(0, '127.0.0.1', resolve));
    const mediaURL = `http://127.0.0.1:${mediaServer.address().port}/clip.mp4`;
    const uiPort = await freePort();
    const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0',
      VIDEO_OS_PORT: String(uiPort), VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: dataDir, VIDEO_OS_USER_DATA: profile, OBSIDIAN_VAULT_PATH: path.join(temp, 'obsidian'),
      VIDEO_OS_TEST_OBSIDIAN_VAULT: path.join(temp, 'obsidian'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = async () => {
      let nodeUrl, browserUrl, partial = '', spawnError;
      child = spawn(executable, ['--inspect=0', '--remote-debugging-port=0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      report.testProcesses.push({ pid: child.pid, exited: false });
      exited = new Promise(resolve => child.once('exit', resolve));
      child.once('error', error => { spawnError = error; });
      child.stderr.on('data', data => {
        partial += data.toString(); const lines = partial.split('\n'); partial = lines.pop();
        for (const line of lines) {
          const nodeMatch = line.match(/^Debugger listening on (ws:\/\/[^\s]+)/), browserMatch = line.match(/^DevTools listening on (ws:\/\/[^\s]+)/);
          if (nodeMatch) nodeUrl = nodeMatch[1]; if (browserMatch) browserUrl = browserMatch[1];
        }
      });
      await until(() => { if (spawnError) throw spawnError; return nodeUrl && browserUrl; }, 'spawned fixture debug endpoints');
      nodeCDP = new DirectCDP(nodeUrl, 'main'); browserCDP = new DirectCDP(browserUrl, 'browser');
      await Promise.all([nodeCDP.ready, browserCDP.ready]);
      native = (fn, argument) => nodeCDP.evaluate(`(${fn.toString()})(require('electron'),${JSON.stringify(argument ?? null)})`);
      const target = await until(async () => (await browserCDP.send('Target.getTargets')).targetInfos.find(target => {
        if (target.type !== 'page') return false;
        try { const url = new URL(target.url); return ['127.0.0.1', 'localhost'].includes(url.hostname)
          && url.port === String(uiPort) && url.pathname === '/creator.html'; } catch { return false; }
      }), 'exact fixture creator target');
      browserCDP.creatorTargetId = target.targetId;
      ({ sessionId: creatorSession } = await browserCDP.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
      browserCDP.creatorSession = creatorSession;
      await browserCDP.send('Runtime.enable', {}, creatorSession);
      renderer = (fn, argument) => browserCDP.evaluate(`(${fn.toString()})(${JSON.stringify(argument ?? null)})`, creatorSession);
      await until(() => renderer(() => document.body?.dataset.ready === 'true'), 'fixture creator ready');
      const runtime = await native(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged,
        appPath: app.getAppPath(), userData: app.getPath('userData'), executable: process.execPath }));
      assert.equal(runtime.version, prior.runtime.version); assert.equal(runtime.packaged, true);
      assert.equal(fs.realpathSync(runtime.executable), fs.realpathSync(executable));
      assert.equal(fs.realpathSync(runtime.userData), fs.realpathSync(profile));
      const config = await renderer(() => window.creatorAPI.getConfig());
      assert.equal(config.testMode, true); assert.equal(fs.realpathSync(config.paths.projectRoot), fs.realpathSync(projectRoot));
      report.runtime = runtime; return config;
    };
    const config = await launch(), projectId = config.project.id, projectFolder = config.project.folder;
    const state = async () => (await renderer(() => window.creatorAPI.getConfig())).downloadEpisodes.states
      .find(entry => entry.serviceId === 'hehui' && entry.kind === 'video');
    const advance = expectedEpisode => renderer(payload => window.creatorAPI.advanceDownloadEpisode(payload),
      { projectId, serviceId: 'hehui', kind: 'video', expectedEpisode });
    const select = async () => {
      await renderer(async () => { await window.creatorAPI.setMode('video'); await window.creatorAPI.selectService('hehui', 'video'); });
      await until(() => native(({ BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
        return host?.contentView.children.some(view => view.getVisible() && !view.webContents.isLoading()
          && new URL(view.webContents.getURL()).searchParams.get('service') === 'hehui');
      }), 'local hehui fixture loaded');
    };
    const download = () => native(({ BrowserWindow }, url) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      const contents = host.contentView.children.find(view => view.getVisible()
        && view.webContents.getURL().includes('/creator-fixture.html?service=hehui'))?.webContents;
      if (!contents) throw new Error('Missing local fixture download source'); contents.downloadURL(url); return true;
    }, mediaURL);
    const choose = async () => {
      await until(() => native(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win =>
        win.webContents.getURL().includes('/assets/ui/download-review.html') && !win.webContents.isLoading())), 'local review UI');
      await native(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win =>
        win.webContents.getURL().includes('/assets/ui/download-review.html')).webContents.executeJavaScript(
        'document.querySelector("[data-choice=editable]").click(); true', true));
    };
    const downloads = () => renderer(() => window.creatorAPI.getDownloads());
    await select();
    let record, expectedPath, savedLegacy = legacy;
    if (organization) {
      await advance(1); await advance(2);
      const original = await state(), renamedSite = '核绘_包内恢复整理';
      await renderer(payload => window.creatorAPI.renameFolder(payload), { projectId, path: original.platformPath, name: renamedSite });
      assert.equal((await state()).platformFolder, renamedSite);
      savedLegacy = path.join(assetRoot, projectFolder, '生成视频', renamedSite, '2026-09-10', '旧素材.mp4');
      await download(); await choose();
      record = await until(async () => (await downloads()).find(record => record.state === 'completed'), 'renamed-root actual download');
      expectedPath = path.join(assetRoot, projectFolder, '生成视频', renamedSite, '第3集', '可剪辑');
      assert.equal(path.dirname(record.savePath), expectedPath); assert.deepEqual(fs.readFileSync(record.savePath), bytes);
      await closeOwnApp(); await launch();
      const restored = await state(); assert.equal(restored.platformFolder, renamedSite); assert.equal(restored.episode, 3);
      assert.equal(fs.existsSync(path.join(assetRoot, projectFolder, '生成视频', original.platformFolder)), false);
      assert.deepEqual(fs.readFileSync(record.savePath), bytes); assert.deepEqual(fs.readFileSync(savedLegacy), bytes);
      report.checks.websiteFolderRenameFollowsDownloadsAndPersists = true;
      console.log('EPISODE_RECOVERY_STEP renamed-root-restart-pass');
    } else {
      await download();
      const journal = path.join(dataDir, 'video-download-review', 'reviews.json');
      const pending = await until(async () => {
        const record = (await downloads()).find(record => record.pendingReview);
        return record && fs.existsSync(journal) && JSON.parse(fs.readFileSync(journal, 'utf8')).entries[record.id]?.completed ? record : null;
      }, 'actual downloaded undecided video completed in journal');
      assert.equal(pending.savePath, ''); await advance(1);
      await closeOwnApp(); await launch();
      assert.equal((await state()).episode, 2, 'Episode cursor persisted across normal fixture restart');
      await choose();
      record = await until(async () => (await downloads()).find(record => record.id === pending.id && record.state === 'completed'), 'recovered pending video archived');
      expectedPath = path.join(assetRoot, projectFolder, '生成视频', '核绘', '第1集', '可剪辑');
      assert.equal(path.dirname(record.savePath), expectedPath); assert.deepEqual(fs.readFileSync(record.savePath), bytes);
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(journal, 'utf8')).entries).length, 0);
      report.checks.restartRestoresCounterAndOriginalPendingEpisode = true;
      console.log('EPISODE_RECOVERY_STEP original-pending-episode-restart-pass');
    }
    assert.deepEqual(fs.readFileSync(savedLegacy), bytes);
    const dateDirectories = [];
    const scanDirectories = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const absolute = path.join(directory, entry.name);
        if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) dateDirectories.push(absolute);
        scanDirectories(absolute);
      }
    };
    scanDirectories(assetRoot);
    assert.deepEqual(dateDirectories, [path.dirname(savedLegacy)], 'Only the fixture legacy date directory remains');
    report.checks.legacyDateAssetUnchangedAndNoNewDateFolders = true;
    await select();
    const current = await state();
    await renderer(platformPath => {
      const accordion = document.getElementById('assetAccordion'); if (!accordion.open) accordion.querySelector('summary').click();
      const parts = platformPath.split('/');
      for (let index = 1; index <= parts.length; index++) {
        const row = document.querySelector('.quick-folder-row[data-folder-path="' + CSS.escape(parts.slice(0, index).join('/')) + '"]');
        const disclosure = row?.querySelector('.quick-folder-chevron-wrap');
        if (disclosure?.getAttribute('aria-expanded') === 'false') disclosure.click();
      }
    }, current.platformPath);
    await until(() => renderer(() => Number(getComputedStyle(document.getElementById('creatorToast')).opacity) < .01), 'creator toast fully faded');
    const screenshot = async filename => {
      await renderer(() => document.querySelector('.quick-episode-advance[data-service-id="hehui"][data-kind="video"]')
        .scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
      const geometry = await renderer(() => {
        const button = document.querySelector('.quick-episode-advance[data-service-id="hehui"][data-kind="video"]');
        const panel = document.getElementById('promptPanel'), row = button.closest('.quick-folder-row');
        const rect = node => { const value = node.getBoundingClientRect(); return { x: value.x, y: value.y, right: value.right,
          bottom: value.bottom, width: value.width, height: value.height }; };
        return { button: rect(button), row: rect(row), panel: rect(panel), viewportHeight: innerHeight,
          panelClientWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth,
          title: button.title, ariaLabel: button.getAttribute('aria-label') };
      });
      assert.ok(geometry.button.width >= 18 && geometry.button.width <= 44 && geometry.button.height >= 18 && geometry.button.height <= 44);
      assert.ok(geometry.panelScrollWidth <= geometry.panelClientWidth + 1);
      assert.ok(geometry.button.x >= geometry.row.x && geometry.button.right <= geometry.row.right + 1);
      assert.ok(geometry.button.y >= geometry.panel.y && geometry.button.bottom <= Math.min(geometry.panel.bottom, geometry.viewportHeight));
      assert.ok(geometry.title && geometry.ariaLabel);
      const shot = await browserCDP.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false,
        clip: { x: geometry.panel.x, y: geometry.panel.y, width: geometry.panel.width,
          height: Math.min(geometry.panel.height, geometry.viewportHeight - geometry.panel.y), scale: 1 } }, creatorSession);
      fs.writeFileSync(path.join(output, filename), Buffer.from(shot.data, 'base64')); return geometry;
    };
    report.wideGeometry = await screenshot('episode-sidebar-wide.png');
    await native(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      host.setMinimumSize(720, 640); host.setSize(990, 740);
    });
    await until(() => renderer(() => innerWidth <= 1000), 'narrow fixture viewport'); await delay(220);
    report.narrowGeometry = await screenshot('episode-sidebar-narrow.png');
    report.checks.compactWebsiteRowButton = true;
    // Readonly historical group screenshot, after selecting a real current episode root.
    await renderer(platformPath => {
      const row = document.querySelector('.quick-legacy-row[data-legacy-parent="' + CSS.escape(platformPath) + '"]');
      if (!row) throw new Error('Missing local readonly history summary');
      if (row.querySelector('.quick-folder-chevron-wrap')?.getAttribute('aria-expanded') === 'false') row.querySelector('.quick-folder-name').click();
      row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }, current.platformPath);
    await delay(180);
    const historyGeometry = await renderer(platformPath => {
      const row = document.querySelector('.quick-legacy-row[data-legacy-parent="' + CSS.escape(platformPath) + '"]');
      const panel = document.getElementById('promptPanel').getBoundingClientRect();
      return { virtualFolderPath: row.dataset.folderPath || '', cards: row.nextElementSibling.querySelectorAll('[data-asset-path]').length,
        clip: { x: panel.x, y: panel.y, width: panel.width, height: Math.min(panel.height, innerHeight - panel.y), scale: 1 } };
    }, current.platformPath);
    assert.equal(historyGeometry.virtualFolderPath, ''); assert.ok(historyGeometry.cards >= 1);
    const historyShot = await browserCDP.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: historyGeometry.clip }, creatorSession);
    fs.writeFileSync(path.join(output, 'episode-history-readonly.png'), Buffer.from(historyShot.data, 'base64'));
    report.historyGeometry = historyGeometry;
    report.completedDownload = { path: path.relative(assetRoot, record.savePath).split(path.sep).join('/'), currentEpisode: current.episode };
    report.combinedCoverage = { complementaryEvidence: true, priorReceiptRemainsFailed: true,
      completedChecks: [...new Set([...requiredChecks, ...Object.keys(report.checks)])], untouchedFormalApp: true };
    report.status = 'passed';
    console.log(`EPISODE_RECOVERY_DIRECT_CDP_PASS organization=${organization} packaged=true restarted=true narrowButtonVisible=true sourceChanged=false externalTargetsAttached=0`);
  } catch (error) {
    report.status = 'failed'; report.failure = String(error.stack || error); throw error;
  } finally {
    clearTimeout(watchdog);
    await closeOwnApp();
    if (mediaServer) { mediaServer.closeAllConnections?.(); await new Promise(resolve => mediaServer.close(resolve)); }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    report.fixtureCleaned = true;
    fs.writeFileSync(path.join(output, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(`EPISODE_RECOVERY_DIRECT_CDP_EVIDENCE ${output}`);
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
