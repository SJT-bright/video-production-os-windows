'use strict';

// 实际打包 App 正常启动；仅连接本地 creator target，绝不 attach 外部网页 target。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { assertCandidateBundle } = require('./verify-candidate-build.cjs');
const { readArg } = require('./candidate-contract.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const flatten = node => node.kind === 'file' ? [node] : (node.children || []).flatMap(flatten);
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(90); }
  throw new Error(`独立候选检查超时：${label}`);
}

class DirectCDP {
  constructor(url) {
    this.socket = new WebSocket(url); this.sequence = 0; this.pending = new Map(); this.creatorExceptions = 0;
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('本机 CDP 连接失败')), { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown' && message.sessionId === this.creatorSession) this.creatorExceptions++;
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
  }
  async send(method, params = {}, sessionId) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 命令超时：${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression, sessionId) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true,
      includeCommandLineAPI: !sessionId }, sessionId);
    if (response.exceptionDetails) throw new Error(`CDP 执行失败：${response.exceptionDetails.text}`);
    return response.result?.value;
  }
  close() { this.socket.close(); }
}

async function run() {
  const argv = process.argv.slice(2), appBundle = readArg(argv, '--app'), profile = readArg(argv, '--candidate-user-data');
  const evidenceOut = readArg(argv, '--evidence-out');
  assert.ok(evidenceOut && path.isAbsolute(evidenceOut), '需要新的绝对路径回执');
  assert.equal(fs.existsSync(evidenceOut), false, '不覆盖已有验收回执');
  const formalPid = Number(readArg(argv, '--formal-pid'));
  const verified = assertCandidateBundle({ appBundle, candidateUserData: profile, arch: readArg(argv, '--arch') || process.arch });
  const buildManifestSha256 = hash(path.join(appBundle, 'Contents/Resources/app/build-manifest.json'));
  const seed = JSON.parse(fs.readFileSync(path.join(profile, 'candidate-seed.json'), 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vos-candidate-direct-'));
  const assetRoot = path.join(verified.candidateWorkspace, '创作资产库'), data = path.join(verified.candidateWorkspace, '视频制作OS/data');
  let child, nodeCDP, browserCDP, creatorSession, scratchAbsolute, scratchRelative, scratchCreated = false;
  let initialProjectId, initialMode, originalSelection, renderer, native, exited;
  const testAssets = [];
  const evidence = { status: 'running', version: verified.candidateVersion, buildManifestSha256, formalPid,
    connection: 'direct CDP: local creator target plus main Node inspector', externalTargetsAttached: 0,
    externalPageContentRead: false, playwrightLaunchTimeouts: [30000, 90000], candidateProfileReseeded: false,
    originalAppStopped: false, sourceFilesChanged: false, externalEditorReceived: false };
  try {
    if (formalPid) process.kill(formalPid, 0);
    const overrides = ['profile', 'project', 'data'].map(name => path.join(root, `override-${name}`));
    for (const dir of overrides) fs.mkdirSync(dir);
    const env = { ...process.env, VIDEO_OS_USER_DATA: overrides[0], VIDEO_OS_PROJECT_ROOT: overrides[1],
      VIDEO_OS_DATA_DIR: overrides[2], VIDEO_OS_PORT: '3750', OBSIDIAN_VAULT_PATH: path.join(root, 'empty-obsidian') };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'CREATOR_BROWSER_TEST', 'VIDEO_OS_SMOKE_TEST', 'VIDEO_OS_TEST_PROJECT_ROOT']) delete env[key];
    child = spawn(verified.executable, ['--inspect=0', '--remote-debugging-port=0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    exited = new Promise(resolve => child.once('exit', resolve));
    let nodeUrl, browserUrl, partial = '';
    child.stderr.on('data', bytes => {
      partial += bytes.toString(); const lines = partial.split('\n'); partial = lines.pop();
      for (const line of lines) {
        const nodeMatch = line.match(/^Debugger listening on (ws:\/\/[^\s]+)/), browserMatch = line.match(/^DevTools listening on (ws:\/\/[^\s]+)/);
        if (nodeMatch) nodeUrl = nodeMatch[1]; if (browserMatch) browserUrl = browserMatch[1];
      }
    });
    await until(() => nodeUrl && browserUrl, '本机调试端点');
    nodeCDP = new DirectCDP(nodeUrl); browserCDP = new DirectCDP(browserUrl);
    await Promise.all([nodeCDP.ready, browserCDP.ready]);
    native = (fn, argument) => nodeCDP.evaluate(`(${fn.toString()})(require('electron'), ${JSON.stringify(argument ?? null)})`);
    const target = await until(async () => (await browserCDP.send('Target.getTargets')).targetInfos
      .find(item => item.type === 'page' && /^http:\/\/(localhost|127\.0\.0\.1):\d+\/creator\.html/.test(item.url)), '候选工作台 target');
    const origin = new URL(target.url).origin, uiPort = Number(new URL(origin).port);
    const ports = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'n'], { encoding: 'utf8' })
      .split('\n').filter(line => line.startsWith('n')).map(line => Number(line.match(/:(\d+)$/)?.[1]));
    assert.ok(ports.includes(uiPort)); if (formalPid) assert.notEqual(uiPort, 3750);
    ({ sessionId: creatorSession } = await browserCDP.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
    browserCDP.creatorSession = creatorSession;
    await browserCDP.send('Runtime.enable', {}, creatorSession);
    renderer = (fn, argument) => browserCDP.evaluate(`(${fn.toString()})(${JSON.stringify(argument ?? null)})`, creatorSession);
    await until(() => renderer(() => document.body.dataset.ready === 'true'), '工作台渲染就绪');
    const nativeConfig = await native(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData'), packaged: app.isPackaged }));
    assert.equal(nativeConfig.version, verified.candidateVersion); assert.equal(nativeConfig.userData, profile); assert.equal(nativeConfig.packaged, true);
    const config = await renderer(() => window.creatorAPI.getConfig());
    assert.equal(config.paths.projectRoot, verified.candidateWorkspace); assert.equal(config.paths.creativeAssetLibraryRoot, assetRoot);
    assert.equal(config.candidate.version, verified.candidateVersion);
    const ui = await renderer(() => ({ badge: /候选版/.test(document.querySelector('.creator-brand strong')?.textContent || ''),
      title: document.title, removedTrayEntryAndAPI: !document.querySelector('#toggleDragTray') && typeof window.creatorAPI.toggleDragTray === 'undefined' }));
    assert.ok(ui.badge && ui.title.includes(verified.candidateVersion) && ui.removedTrayEntryAndAPI);
    for (const dir of overrides) assert.equal(fs.readdirSync(dir).length, 0);
    evidence.runtime = { ...nativeConfig, candidatePid: child.pid, projectRoot: config.paths.projectRoot, dataDir: data,
      origin, uiPort, candidateListenerConfirmed: true, ready: 'true', envOverrideIgnored: true, badgeVisible: true };
    evidence.localState = await renderer(() => {
      const rows = Object.keys(localStorage).filter(key => key.startsWith('videoOS.creator.project.v2.')).map(key => {
        try { return JSON.parse(localStorage.getItem(key)); } catch { return {}; }
      });
      return { projects: rows.length, imageTemplates: rows.reduce((n, row) => n + (row.promptTemplates?.image?.length || 0), 0),
        videoTemplates: rows.reduce((n, row) => n + (row.promptTemplates?.video?.length || 0), 0), scriptGroups: rows.reduce((n, row) => n + (row.scripts?.groups?.length || 0), 0),
        scriptSegments: rows.reduce((n, row) => n + (row.scripts?.groups || []).reduce((sum, group) => sum + (group.items?.length || 0), 0), 0) };
    });
    const platformSnapshot = () => native(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      const views = host.contentView.children.filter(view => view.webContents && /^https?:/.test(view.webContents.getURL())
        && !/^http:\/\/(localhost|127\.0\.0\.1):/.test(view.webContents.getURL()) && view.getVisible());
      return { hostVisible: host.isVisible(), views: views.map(view => ({ id: view.webContents.id, attached: true, visible: view.getVisible(),
        origin: new URL(view.webContents.getURL()).origin, urlSha256: require('node:crypto').createHash('sha256').update(view.webContents.getURL()).digest('hex') })) };
    });
    const baseline = await until(async () => { const value = await platformSnapshot(); return value.hostVisible && value.views.length ? value : null; }, '既有平台 View 可见');
    for (const selector of ['#currentProject', '#allTabsButton']) {
      await renderer(selector => { const button = document.querySelector(selector); if (!button) throw new Error('菜单按钮缺失'); button.click(); }, selector);
      await until(() => native(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('/workspace-menu.html') && win.isVisible())), '真实菜单可见');
      assert.deepEqual(await platformSnapshot(), baseline, '菜单打开须保留同一平台 WC/URL/附着与可见状态');
      await native(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/workspace-menu.html'))?.close());
      await until(() => renderer(selector => document.querySelector(selector)?.getAttribute('aria-expanded') === 'false', selector), '菜单取消回执');
      assert.deepEqual(await platformSnapshot(), baseline, '菜单取消后须保留平台');
    }
    evidence.workspaceMenus = { projectsAndAllTabs: true, samePlatformWcUrlAttachedVisible: true, cancelled: true,
      platformOrigins: baseline.views.map(view => view.origin), externalPageContentRead: false, inputAndScrollRead: false };
    const api = (endpoint, body, projectId) => renderer(async ({ endpoint, body, projectId }) => {
      const response = await fetch(endpoint + (projectId ? `?project=${encodeURIComponent(projectId)}` : ''), body ? { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
    }, { endpoint, body, projectId });
    const projects = await api('/api/creative-projects'); initialProjectId = projects.activeProjectId;
    initialMode = await renderer(() => state.mode); originalSelection = await renderer(() => [...state.quickSelectionOrder]);
    let selectedProject, selectedAsset;
    for (const project of [...projects.projects].sort((a, b) => Number(b.id === initialProjectId) - Number(a.id === initialProjectId))) {
      if (!project.available) continue;
      if ((await renderer(() => window.creatorAPI.getConfig())).project.id !== project.id) {
        await renderer(id => window.creatorAPI.selectProject({ projectId: id, mode: 'video' }), project.id);
        await until(() => renderer(id => state.projectId === id, project.id), '素材项目切换');
      }
      const tree = await api('/api/creative-assets', null, project.id);
      const media = flatten(tree.tree).filter(item => ['audio', 'video'].includes(item.type) && item.assetRole !== 'finals'
        && (item.type !== 'video' || item.videoDisposition !== 'processing')
        && fs.existsSync(path.join(seed.sourceProject, '创作资产库', item.path))).sort((a, b) => (a.size || 0) - (b.size || 0));
      selectedAsset = media.find(item => hash(path.join(assetRoot, item.path)) === hash(path.join(seed.sourceProject, '创作资产库', item.path)));
      if (selectedAsset) { selectedProject = project; break; }
    }
    assert.ok(selectedProject && selectedAsset, '需要未改动的既有素材副本作隔离操作验收');
    const originalAsset = path.join(seed.sourceProject, '创作资产库', selectedAsset.path), clonedAsset = path.join(assetRoot, selectedAsset.path);
    const originalHash = hash(originalAsset), cloneHash = hash(clonedAsset);
    const scratchName = `候选验收-${process.pid}`; scratchRelative = `${selectedProject.folder}/${scratchName}`; scratchAbsolute = path.join(assetRoot, scratchRelative);
    assert.equal(fs.existsSync(scratchAbsolute), false);
    await api('/api/creative-assets/folder', { parent: selectedProject.folder, name: scratchName }, selectedProject.id); scratchCreated = true;
    await api('/api/creative-assets/folder', { parent: scratchRelative, name: '已移动' }, selectedProject.id);
    const copied = await api('/api/creative-assets/copy', { path: selectedAsset.path, folder: scratchRelative }, selectedProject.id); testAssets.push(copied.assetId);
    assert.notEqual(copied.assetId, selectedAsset.assetId); assert.equal(copied.sourceAssetId, selectedAsset.assetId);
    assert.equal(hash(path.join(assetRoot, copied.path)), originalHash);
    await renderer(async assetPath => { await loadAssetItems(); state.quickSelectionOrder = [assetPath]; updateQuickSelectionUI(); }, copied.path);
    const moved = await api('/api/creative-assets/move', { path: copied.path, folder: `${scratchRelative}/已移动` }, selectedProject.id);
    assert.equal(moved.assetId, copied.assetId); assert.equal(fs.existsSync(path.join(assetRoot, copied.path)), false);
    assert.equal(hash(path.join(assetRoot, moved.path)), originalHash);
    await until(() => renderer(assetPath => state.quickSelectionOrder.includes(assetPath), moved.path), '侧栏选择随移动更新');
    await native(({ webContents }) => {
      globalThis.__candidateDirectDrag = null;
      webContents.getAllWebContents().find(wc => wc.getURL().includes('/creator.html')).startDrag = payload => {
        globalThis.__candidateDirectDrag = { file: payload.file, files: payload.files };
      };
    });
    await renderer(assetPath => window.creatorAPI.startAssetDrag(assetPath), moved.path);
    const drag = await until(() => native(() => globalThis.__candidateDirectDrag), '素材原生拖拽路径');
    assert.equal(drag.file, path.join(assetRoot, moved.path)); assert.equal(hash(originalAsset), originalHash); assert.equal(hash(clonedAsset), cloneHash);
    evidence.assetLinkage = { copyCreatesNewId: true, copySourceIdPreserved: true, moveKeepsId: true, sidebarSelectionFollowsMove: true,
      nativeDragResolvesCandidatePath: true, removedTrayEntryAndAPI: true, cloneSourceUnchanged: true, formalSourceUnchanged: true, externalEditorReceived: false };
    assert.equal(browserCDP.creatorExceptions, 0);
    if (formalPid) process.kill(formalPid, 0);
    evidence.status = 'passed';
    console.log(`CANDIDATE_DIRECT_CDP_PASS version=${verified.candidateVersion} candidatePid=${child.pid} origin=${origin} templates=${evidence.localState.imageTemplates + evidence.localState.videoTemplates} scriptSegments=${evidence.localState.scriptSegments} removedTray=true menusKeepPlatform=true moveCopySidebar=true externalTargetsAttached=0 formalPidStillRunning=true`);
  } catch (error) {
    evidence.status = 'failed'; evidence.failure = error.message; throw error;
  } finally {
    if (renderer && initialProjectId) {
      try {
        await renderer(({ id, mode }) => window.creatorAPI.selectProject({ projectId: id, mode }), { id: initialProjectId, mode: initialMode });
        await until(() => renderer(id => state.projectId === id, initialProjectId), '恢复原候选项目');
        await renderer(selection => { state.quickSelectionOrder = selection; updateQuickSelectionUI(); }, originalSelection || []);
      } catch (error) { evidence.restoreFailure = error.message; evidence.status = 'failed'; process.exitCode = 1; }
    }
    if (child) {
      try { if (native) await native(({ app }) => { setTimeout(() => app.quit(), 40); return true; }); }
      catch { child.kill('SIGTERM'); }
      browserCDP?.close(); nodeCDP?.close();
      const closed = await Promise.race([exited.then(() => true), delay(15000).then(() => false)]);
      if (!closed) { child.kill('SIGTERM'); await Promise.race([exited, delay(5000)]); }
      evidence.testOwnedProcessClosed = child.exitCode !== null || child.signalCode !== null;
    }
    if (scratchCreated) {
      if (fs.existsSync(scratchAbsolute)) fs.rmSync(scratchAbsolute, { recursive: true });
      const workflowFile = path.join(data, 'asset-workflow.json');
      if (fs.existsSync(workflowFile)) {
        const workflow = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
        for (const rel of Object.keys(workflow.items || {})) if (rel.startsWith(`${scratchRelative}/`)) delete workflow.items[rel];
        fs.writeFileSync(workflowFile, `${JSON.stringify(workflow, null, 2)}\n`);
      }
      const db = new DatabaseSync(path.join(data, 'production.sqlite'));
      try { for (const id of testAssets) db.prepare('DELETE FROM asset_refs WHERE id = ?').run(id); } finally { db.close(); }
      evidence.ownScratchCleaned = true;
    }
    evidence.creatorExceptionCount = browserCDP?.creatorExceptions ?? null;
    fs.mkdirSync(path.dirname(evidenceOut), { recursive: true }); fs.writeFileSync(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
