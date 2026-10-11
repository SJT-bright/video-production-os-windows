'use strict';

// Actual Electron download events and creator IPC, using only disposable local fixtures.
// No external websites, logins, formal App/profile, or real user asset files are touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const FILE_BYTES = Buffer.from('local-download-document-fixture');
const WAV = Buffer.alloc(244);
WAV.write('RIFF', 0); WAV.writeUInt32LE(WAV.length - 8, 4); WAV.write('WAVEfmt ', 8);
WAV.writeUInt32LE(16, 16); WAV.writeUInt16LE(1, 20); WAV.writeUInt16LE(1, 22);
WAV.writeUInt32LE(8000, 24); WAV.writeUInt32LE(16000, 28); WAV.writeUInt16LE(2, 32);
WAV.writeUInt16LE(16, 34); WAV.write('data', 36); WAV.writeUInt32LE(WAV.length - 44, 40);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 18000) {
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
function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(filename));
    else if (entry.isFile()) result.push(filename);
    else throw new Error(`Unexpected fixture entry: ${filename}`);
  }
  return result;
}

async function main() {
  const executablePath = process.env.EPISODE_TEST_EXECUTABLE || '';
  if (executablePath) {
    assert.ok(executablePath.includes('/test-artifacts/'), 'Only an explicitly staged test executable is allowed');
    assert.equal(executablePath.includes('/asset-workflow-candidate-'), false, 'Do not launch an active candidate App');
  }
  const evidenceRoot = path.resolve(process.env.EPISODE_TEST_EVIDENCE || path.join(__dirname,
    'test-artifacts', `episode-workflow-${executablePath ? 'packaged' : 'source'}-${Date.now()}-${process.pid}`));
  assert.equal(fs.existsSync(evidenceRoot), false, 'Do not overwrite prior evidence');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-episodes-'));
  const projectRoot = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  const profile = path.join(temp, 'profile'), obsidian = path.join(temp, 'obsidian');
  const assetRoot = path.join(projectRoot, '创作资产库');
  const alphaName = '分集验收剧本甲', betaName = '分集验收剧本乙';
  const legacy = path.join(assetRoot, alphaName, '生成视频', '核绘', '2026-09-10', '旧素材.mp4');
  const legacyBytes = Buffer.from('legacy-asset-must-not-be-renamed-or-moved');
  const report = { status: 'running', testedAt: new Date().toISOString(), checks: {},
    scope: { isolatedProjectAndProfile: true, formalAppTouched: false, candidateAppTouched: false,
      externalPlatformLoginOrGeneration: false, physicalMouseE2E: false, oldAssetsAutomaticallyMigrated: false } };
  let application, creator, mediaServer;
  const heldResponses = new Map();
  const watchdog = setTimeout(() => {
    application?.process()?.kill('SIGKILL'); console.error('EPISODE_WORKFLOW_NATIVE_TIMEOUT'); process.exitCode = 1;
  }, 200000).unref();
  try {
    fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, legacyBytes);
    fs.mkdirSync(path.join(assetRoot, betaName), { recursive: true }); fs.mkdirSync(dataDir); fs.mkdirSync(obsidian);
    const movie = path.join(temp, 'fixture.mp4');
    const bundledFFmpeg = path.join(__dirname, 'vendor', 'media-tools', 'darwin-arm64', 'ffmpeg');
    const ffmpeg = fs.existsSync(bundledFFmpeg) ? bundledFFmpeg : '/opt/homebrew/bin/ffmpeg';
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=c=blue:s=128x72:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', movie], { timeout: 20000 });
    assert.equal(generated.status, 0, generated.stderr?.toString());
    const videoBytes = fs.readFileSync(movie);
    mediaServer = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const kind = url.pathname.endsWith('.png') ? 'image' : url.pathname.endsWith('.wav') ? 'audio'
        : url.pathname.endsWith('.zip') ? 'file' : 'video';
      const bytes = { image: PNG, video: videoBytes, audio: WAV, file: FILE_BYTES }[kind];
      response.writeHead(200, { 'Content-Type': { image: 'image/png', audio: 'audio/wav', file: 'application/zip', video: 'video/mp4' }[kind],
        'Content-Disposition': `attachment; filename="${{ image: 'frame.png', audio: 'voice.wav', file: 'document.zip', video: 'clip.mp4' }[kind]}"`,
        'Content-Length': bytes.length });
      const hold = url.searchParams.get('hold');
      if (hold) { response.write(bytes.subarray(0, 20)); heldResponses.set(hold, { response, remainder: bytes.subarray(20) }); }
      else response.end(bytes);
    });
    await new Promise((resolve, reject) => { mediaServer.once('error', reject); mediaServer.listen(0, '127.0.0.1', resolve); });
    const mediaBase = `http://127.0.0.1:${mediaServer.address().port}`;
    const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0',
      VIDEO_OS_PORT: String(await freePort()), VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: dataDir, VIDEO_OS_USER_DATA: profile, OBSIDIAN_VAULT_PATH: obsidian,
      VIDEO_OS_TEST_OBSIDIAN_VAULT: obsidian, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = async () => {
      application = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [__dirname] }), env, timeout: 30000 });
      creator = await application.firstWindow(); creator.setDefaultTimeout(10000);
      await creator.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 25000 });
      await creator.waitForLoadState('load');
      await until(() => application.evaluate(({ BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
        return host?.isVisible() && !host.webContents.isLoading() && host.contentView.children.some(view =>
          view.webContents?.getURL().includes('/creator-fixture.html?service=') && view.getVisible() && !view.webContents.isLoading());
      }), 'fully loaded local platform');
      const config = await creator.evaluate(() => window.creatorAPI.getConfig());
      const runtime = await application.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged,
        appPath: app.getAppPath(), userData: app.getPath('userData') }));
      assert.equal(config.testMode, true); assert.equal(runtime.packaged, !!executablePath);
      assert.equal(fs.realpathSync(config.paths.projectRoot), fs.realpathSync(projectRoot));
      assert.equal(fs.realpathSync(runtime.userData), fs.realpathSync(profile));
      report.runtime = runtime;
      return config;
    };
    await launch();
    const projects = await creator.evaluate(() => fetch('/api/creative-projects').then(response => response.json()));
    const alpha = projects.projects.find(project => project.name === alphaName), beta = projects.projects.find(project => project.name === betaName);
    assert.ok(alpha && beta);
    const activate = async project => {
      await creator.evaluate(async id => {
        const response = await fetch('/api/creative-projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'activate', id }) });
        const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result));
      }, project.id);
      await until(() => creator.locator('#currentProject').textContent().then(value => value.includes(project.name)), `active project ${project.name}`);
    };
    const select = async (serviceId, mode) => {
      if (await creator.locator('body').getAttribute('data-mode') !== mode) {
        await creator.locator(`.mode-button[data-mode="${mode}"]`).click();
        await creator.waitForFunction(mode => document.body.dataset.mode === mode
          && !document.querySelector(`.mode-button[data-mode="${mode}"]`).disabled, mode);
      }
      await creator.evaluate(async ({ serviceId, mode }) => { await window.creatorAPI.selectService(serviceId, mode); }, { serviceId, mode });
      await creator.waitForFunction(({ serviceId, mode }) => document.body.dataset.mode === mode
        && document.querySelector('.platform-tab.active')?.dataset.service === serviceId, { serviceId, mode });
      await until(() => application.evaluate(({ BrowserWindow }, serviceId) => {
        const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
        return host?.contentView.children.some(view => view.getVisible() && !view.webContents.isLoading()
          && new URL(view.webContents.getURL()).searchParams.get('service') === serviceId);
      }, serviceId), `loaded platform ${serviceId}`);
    };
    const state = async (project, serviceId, kind) => {
      const config = await creator.evaluate(() => window.creatorAPI.getConfig());
      assert.equal(config.project.id, project.id);
      assert.equal(config.downloadEpisodes.projectId, project.id);
      const result = config.downloadEpisodes.states.find(entry => entry.serviceId === serviceId && entry.kind === kind);
      assert.ok(result, `Missing ${serviceId}/${kind} episode state`);
      assert.match(result.label, /^第[1-9]\d*集$/); assert.equal(result.label, `第${result.episode}集`);
      return result;
    };
    const advance = async (project, serviceId, kind, expectedEpisode) => creator.evaluate(payload =>
      window.creatorAPI.advanceDownloadEpisode(payload), { projectId: project.id, serviceId, kind, expectedEpisode });
    const revealWebsiteRow = async entry => {
      if (!await creator.locator('#assetAccordion').evaluate(element => element.open)) await creator.locator('#assetAccordion > summary').click();
      const parts = entry.platformPath.split('/');
      for (let index = 1; index < parts.length; index++) {
        const folderPath = parts.slice(0, index).join('/');
        const disclosure = creator.locator(`.quick-folder-row[data-folder-path="${folderPath}"] > .quick-folder-chevron-wrap`);
        if (await disclosure.count() && await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
      }
    };
    const screenshotEpisodeButton = async (serviceId, kind, filename) => {
      const selector = `.quick-episode-advance[data-service-id="${serviceId}"][data-kind="${kind}"]`;
      await creator.locator('#creatorToast.show').waitFor({ state: 'hidden', timeout: 7000 });
      await creator.waitForFunction(() => Number(getComputedStyle(document.getElementById('creatorToast')).opacity) < .01);
      await creator.locator(selector).evaluate(button => button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
      const geometry = await until(() => creator.locator(selector).evaluate(button => {
        const panel = document.getElementById('promptPanel');
        const buttonRect = button.getBoundingClientRect(), panelRect = panel.getBoundingClientRect();
        if (buttonRect.y < panelRect.y || buttonRect.bottom > Math.min(panelRect.bottom, innerHeight)
          || buttonRect.x < panelRect.x || buttonRect.right > panelRect.right) return null;
        return { button: { x: buttonRect.x, y: buttonRect.y, width: buttonRect.width, height: buttonRect.height },
          panel: { x: panelRect.x, y: panelRect.y, width: panelRect.width, height: panelRect.height } };
      }), 'cycle button visibly inside screenshot area');
      await creator.locator('#promptPanel').screenshot({ path: path.join(evidenceRoot, filename) });
      return geometry;
    };
    const downloads = () => creator.evaluate(() => window.creatorAPI.getDownloads());
    const startDownload = async (serviceId, relative) => application.evaluate(({ BrowserWindow }, { serviceId, url }) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      const source = host?.contentView.children.find(view => view.getVisible() && view.webContents?.getURL().includes('/creator-fixture.html?service=')
        && new URL(view.webContents.getURL()).searchParams.get('service') === serviceId)?.webContents;
      if (!source) throw new Error(`No selected local platform: ${serviceId}`);
      source.downloadURL(url);
    }, { serviceId, url: mediaBase + relative });
    const chooser = () => until(async () => {
      const page = application.windows().find(page => page.url().includes('/assets/ui/download-review.html'));
      if (!page || page.isClosed()) return null;
      try { return await page.locator('[data-choice="editable"]').isVisible() ? page : null; } catch { return null; }
    }, 'video disposition chooser');
    const recordAfter = (before, predicate = () => true) => until(async () =>
      (await downloads()).find(record => !before.has(record.id) && predicate(record)), 'new matching download record');
    const ids = async () => new Set((await downloads()).map(record => record.id));
    const checkPath = (record, project, category, site, episode, disposition = '') => {
      const expected = path.join(assetRoot, project.folder, category, site, `第${episode}集`, ...(disposition ? [disposition] : []));
      assert.equal(path.dirname(record.savePath), expected, 'Frozen project/site/episode/disposition path');
      assert.ok(!/(?:^|[\\/])\d{4}-\d{2}-\d{2}(?:[\\/]|$)/.test(record.savePath), 'New downloads must not introduce date folders');
      assert.ok(record.savePath.startsWith(projectRoot + path.sep));
      assert.equal(record.projectId, project.id);
      assert.deepEqual(fs.readFileSync(record.savePath), { image: PNG, video: videoBytes, audio: WAV }[record.kind]);
      return expected;
    };

    // Run only newly added organization edges after the core download chain passed.
    if (process.env.EPISODE_TEST_TARGETED === '1') {
      report.scope.targetedOrganizationOnly = true;
      await activate(alpha); await select('hehui', 'video');
      await advance(alpha, 'hehui', 'video', 1);
      const site = await state(alpha, 'hehui', 'video');
      await revealWebsiteRow(site);
      const website = creator.locator(`.quick-folder-row[data-folder-path="${site.platformPath}"] > .quick-folder-chevron-wrap`);
      await until(() => website.count().then(count => count === 1), 'real website row rendered');
      if (await website.getAttribute('aria-expanded') === 'false') await website.click();
      const history = creator.locator(`.quick-legacy-row[data-legacy-parent="${site.platformPath}"]`);
      await until(() => history.count().then(count => count === 1), 'readonly legacy summary');
      assert.equal(await history.getAttribute('data-folder-path'), null, 'Summary must not masquerade as a writable folder');
      assert.equal(await history.locator('.quick-folder-grip').count(), 0);
      assert.equal(await history.locator('.quick-episode-advance').count(), 0);
      assert.equal(await creator.locator(`.quick-folder-row[data-folder-path="${site.platformPath}/2026-09-10"]`).count(), 0,
        'Legacy dates must not remain generated-folder rows');
      const dropTargetBefore = await creator.locator('#quickDropTarget').getAttribute('data-folder-path');
      await history.locator('.quick-folder-name').click();
      assert.equal(await creator.locator('#quickDropTarget').getAttribute('data-folder-path'), dropTargetBefore,
        'Expanding history cannot change the actual import destination');
      const legacyToken = `${site.platformPath}/2026-09-10/旧素材.mp4`;
      await until(() => history.evaluate(row => row.nextElementSibling.querySelectorAll('.asset-card-wrap').length === 1), 'actual legacy card');
      assert.equal(await history.evaluate(row => row.nextElementSibling.querySelector('.asset-card-wrap').dataset.assetPath), legacyToken,
        'Legacy drag token keeps the real physical asset path');
      const originalCount = filesUnder(assetRoot).length;
      await application.evaluate(({ Menu }) => {
        globalThis.__episodeHistoryMenuCalls = 0;
        Menu.prototype.popup = function (options) { globalThis.__episodeHistoryMenuCalls++; options?.callback?.(); };
      });
      await history.click({ button: 'right' });
      assert.equal(await application.evaluate(() => globalThis.__episodeHistoryMenuCalls), 0, 'No rename/delete folder menu on virtual summary');
      await history.evaluate(row => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(['not-an-asset'], 'must-not-import.txt', { type: 'text/plain' }));
        row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
        row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      });
      await delay(220);
      assert.equal(filesUnder(assetRoot).length, originalCount, 'Virtual summary cannot accept an import');
      assert.deepEqual(fs.readFileSync(legacy), legacyBytes);
      report.checks.historySummaryReadOnlyAndRealTokensPreserved = true;
      await creator.locator('#promptPanel').screenshot({ path: path.join(evidenceRoot, 'episode-history-readonly.png') });
      console.log('EPISODE_ORGANIZATION_STEP legacy-summary-pass');

      // Existing N+1 is a legitimate destination, not a reason to skip a number.
      const platformAbsolute = path.join(assetRoot, ...site.platformPath.split('/'));
      const third = path.join(platformAbsolute, '第3集'); fs.mkdirSync(third);
      const alreadyThere = path.join(third, '已有镜头.mp4'); fs.writeFileSync(alreadyThere, videoBytes);
      const reused = await advance(alpha, 'hehui', 'video', 2);
      assert.equal(reused.advanced, true); assert.equal(reused.state.episode, 3);
      assert.deepEqual(fs.readFileSync(alreadyThere), videoBytes);
      assert.equal(fs.existsSync(path.join(platformAbsolute, '第4集')), false);
      const blockedNext = path.join(platformAbsolute, '第4集'); fs.writeFileSync(blockedNext, 'file-not-directory');
      const deniedAdvance = () => creator.evaluate(async payload => {
        try { await window.creatorAPI.advanceDownloadEpisode(payload); return { rejected: false }; }
        catch (error) { return { rejected: true, message: error.message }; }
      }, { projectId: alpha.id, serviceId: 'hehui', kind: 'video', expectedEpisode: 3 });
      assert.equal((await deniedAdvance()).rejected, true);
      assert.equal((await state(alpha, 'hehui', 'video')).episode, 3);
      assert.equal(fs.readFileSync(blockedNext, 'utf8'), 'file-not-directory');
      fs.unlinkSync(blockedNext);
      const symlinkTarget = path.join(temp, 'symlink-target'); fs.mkdirSync(symlinkTarget);
      fs.symlinkSync(symlinkTarget, blockedNext);
      assert.equal((await deniedAdvance()).rejected, true);
      assert.equal((await state(alpha, 'hehui', 'video')).episode, 3);
      assert.deepEqual(fs.readdirSync(symlinkTarget), []);
      fs.unlinkSync(blockedNext);
      report.checks.existingNextEpisodeReusedAndFileSymlinkRejected = true;
      console.log('EPISODE_ORGANIZATION_STEP existing-next-and-invalid-leaf-pass');

      // Rename the real fixture website root and prove new downloads follow it.
      const renamedSite = '核绘_验收整理';
      await creator.evaluate(payload => window.creatorAPI.renameFolder(payload), { projectId: alpha.id, path: site.platformPath, name: renamedSite });
      const renamed = await state(alpha, 'hehui', 'video');
      assert.equal(renamed.platformFolder, renamedSite); assert.equal(renamed.episode, 3);
      assert.equal(fs.existsSync(platformAbsolute), false, 'Old website root must not be recreated');
      assert.deepEqual(fs.readFileSync(path.join(assetRoot, ...renamed.platformPath.split('/'), '第3集', '已有镜头.mp4')), videoBytes);
      assert.deepEqual(fs.readFileSync(path.join(assetRoot, ...renamed.platformPath.split('/'), '2026-09-10', '旧素材.mp4')), legacyBytes,
        'Only an explicit folder rename relocates the fixture legacy asset; bytes remain unchanged');
      const beforeRenameDownload = await ids();
      await startDownload('hehui', '/clip.mp4?renamed-site');
      await (await chooser()).locator('[data-choice="editable"]').click();
      const renamedRecord = await recordAfter(beforeRenameDownload, record => record.kind === 'video' && record.state === 'completed');
      checkPath(renamedRecord, alpha, '生成视频', renamedSite, 3, '可剪辑');
      assert.equal(fs.existsSync(platformAbsolute), false);
      await application.close(); application = null;
      await launch(); await activate(alpha);
      const persisted = await state(alpha, 'hehui', 'video');
      assert.equal(persisted.platformFolder, renamedSite); assert.equal(persisted.episode, 3);
      assert.deepEqual(fs.readFileSync(renamedRecord.savePath), videoBytes);
      report.checks.websiteFolderRenameFollowsDownloadsAndPersists = true;
      report.renamedDownload = { path: path.relative(assetRoot, renamedRecord.savePath).split(path.sep).join('/'), episode: persisted.episode };
      console.log('EPISODE_ORGANIZATION_STEP website-rename-and-restart-pass');
      await select('hehui', 'video'); await revealWebsiteRow(persisted);
      report.wideScreenshotGeometry = await screenshotEpisodeButton('hehui', 'video', 'episode-organization-wide.png');
      await application.evaluate(({ BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
        host.setMinimumSize(720, 640); host.setSize(990, 740);
      });
      await creator.waitForFunction(() => innerWidth <= 1000); await delay(220);
      report.narrowScreenshotGeometry = await screenshotEpisodeButton('hehui', 'video', 'episode-organization-narrow.png');
      report.narrowGeometry = await creator.locator('.quick-episode-advance[data-service-id="hehui"][data-kind="video"]').evaluate(button => {
        const panel = document.getElementById('promptPanel'), row = button.closest('.quick-folder-row');
        const rect = node => { const value = node.getBoundingClientRect(); return { x: value.x, right: value.right, width: value.width, height: value.height }; };
        return { panelClientWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth, button: rect(button), row: rect(row) };
      });
      assert.ok(report.narrowGeometry.panelScrollWidth <= report.narrowGeometry.panelClientWidth + 1);
      assert.ok(report.narrowGeometry.button.right <= report.narrowGeometry.row.right + 1);
      report.status = 'passed';
      console.log(`EPISODE_ORGANIZATION_NATIVE_PASS packaged=${!!executablePath} legacyReadonly=true existingNextReused=true invalidLeafRejected=true renamedSitePersists=true`);
      return;
    }

    await activate(alpha);
    // Native local TXT drag goes through the real import and persistent workspace path.
    const scriptText = ['只含第1—10集的隔离剧本', '剧本大纲', '第0集 剧情概述，不是可导入的分集正文',
      ...Array.from({ length: 10 }, (_, index) => `【第${index + 1}集】目录梗概：这一集的短小剧情概述。`), '剧本正文',
      ...Array.from({ length: 10 }, (_, index) => [`第${index + 1}集 正文标题`, `${index + 1}-1 公寓 日 内`,
        '人物：甲、乙', `甲：第${index + 1}集正文台词必须保留。`, '乙：这是正式剧本，而不是目录。', '△甲拿起桌上的杯子，转身走向窗边。'].join('\n'))].join('\n\n');
    const scriptFile = path.join(temp, '第1-10集.txt'); fs.writeFileSync(scriptFile, scriptText);
    if (!await creator.locator('#scriptAccordion').evaluate(element => element.open)) await creator.locator('#scriptAccordion > summary').click();
    await creator.locator('#scriptAccordion > summary').scrollIntoViewIfNeeded();
    const scriptBox = await creator.locator('#scriptAccordion > summary').boundingBox(); assert.ok(scriptBox);
    const cdp = await creator.context().newCDPSession(creator);
    const drag = { x: scriptBox.x + scriptBox.width / 2, y: scriptBox.y + scriptBox.height / 2,
      data: { items: [], files: [scriptFile], dragOperationsMask: 1 } };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, ...drag });
    await cdp.detach();
    await until(() => creator.locator('.script-item').count().then(count => count === 10), 'ten actual script items, excluding outline');
    const imported = await creator.evaluate(projectId => JSON.parse(localStorage.getItem('videoOS.creator.project.v2.' + projectId) || '{}')
      .scripts.groups[0].items, alpha.id);
    assert.equal(imported.length, 10);
    for (let index = 0; index < imported.length; index++) {
      assert.ok(imported[index].text.includes(`第${index + 1}集正文台词必须保留。`));
      assert.ok(!/目录梗概|第0集|剧情概述/.test(imported[index].text), 'Outline metadata cannot become an episode or leak into body');
    }
    assert.equal(fs.readFileSync(scriptFile, 'utf8'), scriptText);
    await creator.locator('#scriptAccordion > summary').click();
    report.checks.nativeScriptImportExactlyTenBodiesNoOutline = true;
    console.log('EPISODE_STEP native-script-body-import-pass');
    await select('gpt', 'image');
    assert.equal((await state(alpha, 'gpt', 'image')).episode, 1);
    let before = await ids();
    await startDownload('gpt', '/frame.png?first');
    const first = await recordAfter(before, record => record.state === 'completed' && record.kind === 'image');
    const firstDirectory = checkPath(first, alpha, '生成图片', 'GPT', 1);
    report.checks.defaultEpisodeAndRealDownload = true;
    console.log('EPISODE_STEP default-real-download-pass');

    // UI advancement creates a sibling episode folder and never moves old files.
    await until(() => creator.locator('.quick-episode-advance[data-service-id="gpt"][data-kind="image"]').count()
      .then(count => count === 1), 'image website episode button');
    const imageAdvance = () => creator.locator('.quick-episode-advance[data-service-id="gpt"][data-kind="image"]');
    await revealWebsiteRow(await state(alpha, 'gpt', 'image'));
    await imageAdvance().click();
    await until(async () => (await state(alpha, 'gpt', 'image')).episode === 2, 'image episode advanced to 2');
    assert.equal(fs.existsSync(path.join(path.dirname(firstDirectory), '第2集')), true, 'Click creates the new sibling directory immediately');
    assert.deepEqual(fs.readFileSync(first.savePath), PNG, 'The completed first episode remains in place');
    before = await ids();
    await startDownload('gpt', '/frame.png?second');
    const second = await recordAfter(before, record => record.state === 'completed' && record.kind === 'image');
    checkPath(second, alpha, '生成图片', 'GPT', 2);
    report.checks.buttonCreatesSiblingAndChangesDestination = true;
    console.log('EPISODE_STEP button-sibling-destination-pass');

    // Browser documents stay under the website only: no date or episode categorization.
    before = await ids();
    await startDownload('gpt', '/document.zip');
    const document = await recordAfter(before, record => record.state === 'completed' && record.kind === 'file');
    assert.equal(path.dirname(document.savePath), path.join(assetRoot, alpha.folder, '浏览器下载', 'GPT'));
    assert.deepEqual(fs.readFileSync(document.savePath), FILE_BYTES);
    report.checks.documentsWebsiteOnlyWithoutDates = true;

    // Same-site duplicate tabs and custom tab names must use the same episode root.
    const configBeforeDuplicate = await creator.evaluate(() => window.creatorAPI.getConfig());
    const duplicate = await creator.evaluate(({ tabId }) => window.creatorAPI.openTab('gpt', 'image', tabId), { tabId: configBeforeDuplicate.browser.tabId });
    await creator.evaluate(tabId => window.creatorAPI.renameTab(tabId, '另一个提示词窗口'), duplicate.tabId);
    await select('gpt', 'image');
    assert.equal((await creator.evaluate(() => window.creatorAPI.getConfig())).browser.displayLabel, '另一个提示词窗口');
    before = await ids();
    await startDownload('gpt', '/frame.png?duplicate');
    const duplicateRecord = await recordAfter(before, record => record.state === 'completed' && record.kind === 'image');
    checkPath(duplicateRecord, alpha, '生成图片', 'GPT', 2);
    assert.notEqual(duplicateRecord.savePath, second.savePath, 'Same-name new downloads remain distinct');
    assert.equal((await state(alpha, 'gpt', 'image')).episode, 2);
    report.checks.tabNamesDoNotSplitWebsiteAndDuplicatesDoNotOverwrite = true;

    // A shared platform still has independent image, video and audio episode counters.
    await select('gpt', 'video');
    assert.equal((await state(alpha, 'gpt', 'video')).episode, 1);
    await advance(alpha, 'gpt', 'video', 1);
    assert.equal((await state(alpha, 'gpt', 'video')).episode, 2);
    assert.equal((await state(alpha, 'gpt', 'image')).episode, 2);
    assert.equal((await state(alpha, 'gpt', 'audio')).episode, 1);
    before = await ids();
    await startDownload('gpt', '/voice.wav');
    const audio = await recordAfter(before, record => record.state === 'completed' && record.kind === 'audio');
    checkPath(audio, alpha, '音频', 'GPT', 1);
    await select('hehui', 'video');
    assert.equal((await state(alpha, 'hehui', 'video')).episode, 1);
    await advance(alpha, 'hehui', 'video', 1);
    assert.equal((await state(alpha, 'hehui', 'video')).episode, 2);
    await activate(beta);
    assert.equal((await state(beta, 'hehui', 'video')).episode, 1);
    await activate(alpha);
    assert.equal((await state(alpha, 'hehui', 'video')).episode, 2);
    report.checks.projectWebsiteAndMediaKindsIsolated = true;
    console.log('EPISODE_STEP project-website-media-isolation-pass');

    // A stale duplicate click must not skip an episode or create an unwanted folder.
    const stale = await advance(alpha, 'hehui', 'video', 1);
    assert.equal(stale.advanced, false, 'Stale expected episode coalesces rather than double advancing');
    assert.equal((await state(alpha, 'hehui', 'video')).episode, 2);
    report.checks.staleAdvanceCannotSkipEpisode = true;

    // Freeze episode 2 at download start, before completion or classification.
    before = await ids();
    await startDownload('hehui', '/clip.mp4?hold=snapshot');
    const firstChoice = await chooser();
    const pending = await recordAfter(before, record => record.kind === 'video' && record.pendingReview);
    assert.equal(pending.savePath, '', 'Unclassified video must not expose an importable asset');
    await advance(alpha, 'hehui', 'video', 2);
    await activate(beta);
    await firstChoice.locator('[data-choice="processing"]').click();
    await until(() => heldResponses.has('snapshot'), 'held video HTTP response');
    const held = heldResponses.get('snapshot'); heldResponses.delete('snapshot'); held.response.end(held.remainder);
    await activate(alpha);
    const processed = await until(async () => (await downloads()).find(record => record.id === pending.id && record.state === 'completed'), 'frozen slow video archived');
    checkPath(processed, alpha, '生成视频', '核绘', 2, '待处理');
    assert.equal(processed.videoDisposition, 'processing');
    assert.equal((await state(alpha, 'hehui', 'video')).episode, 3);
    report.checks.activeDownloadRetainsOriginalEpisodeAndProject = true;
    report.checks.processingDispositionPreserved = true;
    console.log('EPISODE_STEP frozen-slow-download-pass');

    // Concurrent completed videos awaiting classification all retain episode 3.
    await select('hehui', 'video');
    before = await ids();
    await startDownload('hehui', '/clip.mp4?parallel-a');
    await startDownload('hehui', '/clip.mp4?parallel-b');
    const concurrentChoice = await chooser();
    await advance(alpha, 'hehui', 'video', 3);
    await concurrentChoice.locator('[data-choice="editable"]').click();
    await (await chooser()).locator('[data-choice="editable"]').click();
    const concurrent = await until(async () => {
      const values = (await downloads()).filter(record => !before.has(record.id) && record.kind === 'video' && record.state === 'completed');
      return values.length === 2 ? values : null;
    }, 'two frozen concurrent videos');
    for (const record of concurrent) { checkPath(record, alpha, '生成视频', '核绘', 3, '可剪辑'); assert.equal(record.videoDisposition, 'editable'); }
    assert.notEqual(concurrent[0].savePath, concurrent[1].savePath);
    report.checks.concurrentDownloadsFreezeEpisodeAndDoNotOverwrite = true;
    console.log('EPISODE_STEP concurrent-frozen-downloads-pass');

    // Completed but undecided episode-4 video survives an isolated App restart.
    before = await ids();
    await startDownload('hehui', '/clip.mp4?restart');
    await chooser();
    const restartPending = await recordAfter(before, record => record.pendingReview);
    const journal = path.join(dataDir, 'video-download-review', 'reviews.json');
    await until(() => fs.existsSync(journal) && JSON.parse(fs.readFileSync(journal, 'utf8')).entries[restartPending.id]?.completed,
      'restart video completed in staging');
    await advance(alpha, 'hehui', 'video', 4);
    await application.close(); application = null;
    await launch();
    const recoveredChoice = await chooser();
    await recoveredChoice.locator('[data-choice="editable"]').click();
    await activate(alpha);
    assert.equal((await state(alpha, 'hehui', 'video')).episode, 5, 'Current episode persists across restart');
    const recovered = await until(async () => (await downloads()).find(record => record.id === restartPending.id && record.state === 'completed'),
      'restored download retains frozen episode');
    checkPath(recovered, alpha, '生成视频', '核绘', 4, '可剪辑');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(journal, 'utf8')).entries).length, 0, 'All review staging entries consumed exactly once');
    report.checks.restartRestoresCounterAndOriginalPendingEpisode = true;
    console.log('EPISODE_STEP restart-recovery-pass');

    assert.deepEqual(fs.readFileSync(legacy), legacyBytes);
    assert.equal(filesUnder(path.join(assetRoot, alpha.folder)).filter(filename => /(?:^|[\\/])\d{4}-\d{2}-\d{2}(?:[\\/]|$)/.test(filename)).length, 1,
      'Only the original legacy date asset remains; no new date paths are created');
    report.checks.legacyDateAssetUnchangedAndNoNewDateFolders = true;
    await select('hehui', 'video');
    await revealWebsiteRow(await state(alpha, 'hehui', 'video'));
    await creator.locator('.quick-episode-advance[data-service-id="hehui"][data-kind="video"]').scrollIntoViewIfNeeded();
    report.episodeButtonGeometry = await creator.locator('.quick-episode-advance[data-service-id="hehui"][data-kind="video"]').evaluate(button => {
      const row = button.closest('.quick-folder-row'), panel = document.getElementById('promptPanel');
      const rect = node => { const value = node.getBoundingClientRect(); return { x: value.x, y: value.y, right: value.right, bottom: value.bottom, width: value.width, height: value.height }; };
      return { button: rect(button), row: rect(row), panel: rect(panel), title: button.title,
        ariaLabel: button.getAttribute('aria-label'), panelClientWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth };
    });
    const geometry = report.episodeButtonGeometry;
    assert.ok(geometry.button.width >= 18 && geometry.button.width <= 44 && geometry.button.height >= 18 && geometry.button.height <= 44, 'Compact but usable cycle button');
    assert.ok(geometry.button.right <= geometry.row.right + 1 && geometry.button.x > geometry.row.x, 'Cycle button stays inside the website row');
    assert.ok(geometry.panelScrollWidth <= geometry.panelClientWidth + 1, 'No horizontal sidebar overflow');
    assert.ok(geometry.ariaLabel && geometry.title, 'Cycle button has a discoverable action label');
    report.wideScreenshotGeometry = await screenshotEpisodeButton('hehui', 'video', 'episode-sidebar-wide.png');
    await application.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      host.setMinimumSize(720, 640); host.setSize(990, 740);
    });
    await creator.waitForFunction(() => innerWidth <= 1000); await delay(220);
    report.narrowScreenshotGeometry = await screenshotEpisodeButton('hehui', 'video', 'episode-sidebar-narrow.png');
    report.checks.compactWebsiteRowButton = true;
    report.downloads = [first, second, duplicateRecord, audio, document, processed, ...concurrent, recovered]
      .map(record => ({ kind: record.kind, projectId: record.projectId, videoDisposition: record.videoDisposition,
        path: path.relative(assetRoot, record.savePath).split(path.sep).join('/') }));
    report.status = 'passed';
    console.log(`EPISODE_WORKFLOW_NATIVE_PASS packaged=${!!executablePath} realDownloads=true button=true isolated=true frozenEpisode=true restart=true legacyUnchanged=true`);
  } catch (error) {
    report.status = 'failed'; report.failure = String(error.stack || error);
    if (creator && !creator.isClosed()) {
      report.dom = await creator.evaluate(() => ({ ready: document.body.dataset.ready, mode: document.body.dataset.mode,
        bodyClass: document.body.className })).catch(() => null);
      try { await creator.locator('#promptPanel').screenshot({ path: path.join(evidenceRoot, 'failure-sidebar.png') }); } catch {}
    }
    throw error;
  } finally {
    clearTimeout(watchdog);
    for (const { response } of heldResponses.values()) response.destroy();
    if (application) await application.close().catch(() => application.process()?.kill('SIGKILL'));
    if (mediaServer) {
      mediaServer.closeAllConnections?.();
      await new Promise(resolve => mediaServer.close(resolve));
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    report.fixtureCleaned = true;
    fs.writeFileSync(path.join(evidenceRoot, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(`EPISODE_WORKFLOW_NATIVE_EVIDENCE ${evidenceRoot}`);
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
