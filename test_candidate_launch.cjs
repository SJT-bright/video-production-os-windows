'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { _electron } = require('playwright');
const { assertCandidateBundle } = require('./verify-candidate-build.cjs');
const { readArg } = require('./candidate-contract.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(80); }
  throw new Error(`候选检查超时：${label}`);
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const flatten = node => node.kind === 'file' ? [node] : (node.children || []).flatMap(flatten);

async function run() {
  const argv = process.argv.slice(2);
  const appBundle = readArg(argv, '--app');
  const profile = readArg(argv, '--candidate-user-data');
  const evidenceOut = readArg(argv, '--evidence-out') || path.join(path.dirname(profile), 'candidate-native-launch.json');
  const formalPid = Number(readArg(argv, '--formal-pid'));
  const verified = assertCandidateBundle({ appBundle, candidateUserData: profile, arch: readArg(argv, '--arch') || process.arch });
  const seed = JSON.parse(fs.readFileSync(path.join(profile, 'candidate-seed.json'), 'utf8'));
  assert.equal(seed.complete, true);
  if (formalPid) process.kill(formalPid, 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vos-candidate-native-'));
  const assetRoot = path.join(verified.candidateWorkspace, '创作资产库');
  const data = path.join(verified.candidateWorkspace, '视频制作OS/data');
  let app, scratchAbsolute, scratchRelative, scratchCreated = false, selectedAsset, initialProjectId;
  const errors = [];
  const evidence = { version: verified.candidateVersion, bundleIdIsolated: true, formalPid,
    originalAppStopped: false, sourceFilesChanged: false, externalEditorReceived: false, status: 'running' };
  const testAssets = [];
  try {
    const overrideProfile = path.join(root, 'override-profile');
    const overrideProject = path.join(root, 'override-project');
    const overrideData = path.join(root, 'override-data');
    for (const dir of [overrideProfile, overrideProject, overrideData]) fs.mkdirSync(dir);
    const env = { ...process.env, VIDEO_OS_USER_DATA: overrideProfile, VIDEO_OS_PROJECT_ROOT: overrideProject,
      VIDEO_OS_DATA_DIR: overrideData, VIDEO_OS_PORT: '3750', OBSIDIAN_VAULT_PATH: path.join(root, 'empty-obsidian'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'CREATOR_BROWSER_TEST', 'VIDEO_OS_SMOKE_TEST', 'VIDEO_OS_TEST_PROJECT_ROOT']) delete env[key];
    // 真实候选会恢复已有网页登录；调试连接可能晚于隔离空 profile，不据 30s 连接超时认定 App 启动失败。
    app = await _electron.launch({ executablePath: verified.executable, args: [], env, timeout: 90000 });
    const creator = await until(() => app.windows().find(page => page.url().includes('/creator.html')), '工作台窗口');
    creator.on('pageerror', error => errors.push(error.message));
    await creator.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 25000 });
    const native = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), version: app.getVersion(), packaged: app.isPackaged }));
    assert.equal(native.userData, profile); assert.equal(native.version, verified.candidateVersion); assert.equal(native.packaged, true);
    const listenerPorts = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(app.process().pid), '-iTCP', '-sTCP:LISTEN', '-F', 'n'], { encoding: 'utf8' })
      .split('\n').filter(line => line.startsWith('n')).map(line => Number(line.match(/:(\d+)$/)?.[1])).filter(Boolean);
    const uiPort = Number(new URL(creator.url()).port);
    assert.ok(listenerPorts.includes(uiPort), '候选页面必须使用候选进程实际监听的端口');
    if (formalPid) assert.notEqual(uiPort, 3750, '正式3750被占用时不得返回旧listen回调中的3750');
    const config = await creator.evaluate(() => window.creatorAPI.getConfig());
    assert.equal(config.paths.projectRoot, verified.candidateWorkspace);
    assert.equal(config.paths.creativeAssetLibraryRoot, assetRoot);
    assert.equal(config.candidate.version, verified.candidateVersion);
    assert.match(await creator.locator('.creator-brand strong').textContent(), /候选版/);
    assert.ok((await creator.title()).includes(verified.candidateVersion));
    for (const dir of [overrideProfile, overrideProject, overrideData]) assert.equal(fs.readdirSync(dir).length, 0, '候选必须忽略外部工作区覆盖');
    assert.ok(fs.existsSync(path.join(data, 'creator-automation-connection.json')));
    evidence.runtime = { ...native, candidatePid: app.process().pid, projectRoot: config.paths.projectRoot, dataDir: data, envOverrideIgnored: true,
      badgeVisible: true, origin: new URL(creator.url()).origin, uiPort, candidateListenerConfirmed: true, ready: await creator.locator('body').getAttribute('data-ready') };
    evidence.localState = await creator.evaluate(() => {
      const records = Object.keys(localStorage).filter(key => key.startsWith('videoOS.creator.project.v2.'))
        .map(key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return {}; } });
      return { projects: records.length,
        imageTemplates: records.reduce((n, row) => n + (row.promptTemplates?.image?.length || 0), 0),
        videoTemplates: records.reduce((n, row) => n + (row.promptTemplates?.video?.length || 0), 0),
        scriptGroups: records.reduce((n, row) => n + (row.scripts?.groups?.length || 0), 0),
        scriptSegments: records.reduce((n, row) => n + (row.scripts?.groups || []).reduce((sum, group) => sum + (group.items?.length || 0), 0), 0) };
    });
    const localMigration = JSON.parse(fs.readFileSync(path.join(profile, 'candidate-local-storage.json'), 'utf8'));
    assert.equal(localMigration.externalSourceRequested, false);
    evidence.localStorageMigration = { copied: localMigration.copied, preserved: localMigration.preserved,
      sourceKeys: localMigration.sourceKeys, snapshotConsistency: localMigration.liveSourceSnapshotConsistency };
    const api = (endpoint, body, projectId) => creator.evaluate(async ({ endpoint, body, projectId }) => {
      const response = await fetch(endpoint + (projectId ? `?project=${encodeURIComponent(projectId)}` : ''), body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : { cache: 'no-store' });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
    }, { endpoint, body, projectId });
    const projects = await api('/api/creative-projects');
    initialProjectId = projects.activeProjectId;
    let selectedProject;
    const orderedProjects = [...projects.projects].sort((a, b) => Number(b.id === initialProjectId) - Number(a.id === initialProjectId));
    for (const project of orderedProjects) {
      if (!project.available) continue;
      const active = await creator.evaluate(() => window.creatorAPI.getConfig());
      if (active.project.id !== project.id) {
        await creator.evaluate(id => window.creatorAPI.selectProject({ projectId: id, mode: 'video' }), project.id);
        await until(() => creator.evaluate(id => state.projectId === id, project.id), '切换素材检查项目');
      }
      const tree = await api('/api/creative-assets', null, project.id);
      const media = flatten(tree.tree).filter(item => ['audio', 'video'].includes(item.type)
        && item.assetRole !== 'finals' && (item.type !== 'video' || item.videoDisposition !== 'processing')
        && fs.existsSync(path.join(seed.sourceProject, '创作资产库', item.path)))
        .sort((a, b) => (a.size || 0) - (b.size || 0));
      if (media.length) { selectedProject = project; selectedAsset = media[0]; break; }
    }
    assert.ok(selectedProject && selectedAsset, '候选副本须有一个可剪辑视频或音频供move/copy检查');
    if (selectedProject.id !== initialProjectId) {
      await creator.evaluate(id => window.creatorAPI.selectProject({ projectId: id, mode: 'video' }), selectedProject.id);
      await until(() => creator.evaluate(id => state.projectId === id, selectedProject.id), '选择验收素材所属项目');
    }
    const originalAsset = path.join(seed.sourceProject, '创作资产库', selectedAsset.path);
    const clonedAsset = path.join(assetRoot, selectedAsset.path);
    const originalHash = hash(originalAsset), cloneHash = hash(clonedAsset);
    assert.equal(cloneHash, originalHash);
    const scratchName = `候选验收-${process.pid}`;
    scratchRelative = `${selectedProject.folder}/${scratchName}`;
    scratchAbsolute = path.join(assetRoot, scratchRelative);
    assert.equal(fs.existsSync(scratchAbsolute), false);
    await api('/api/creative-assets/folder', { parent: selectedProject.folder, name: scratchName }, selectedProject.id);
    scratchCreated = true;
    await api('/api/creative-assets/folder', { parent: scratchRelative, name: '已移动' }, selectedProject.id);
    const copied = await api('/api/creative-assets/copy', { path: selectedAsset.path, folder: scratchRelative }, selectedProject.id);
    testAssets.push(copied.assetId);
    assert.notEqual(copied.assetId, selectedAsset.assetId);
    assert.equal(copied.sourceAssetId, selectedAsset.assetId);
    assert.equal(hash(path.join(assetRoot, copied.path)), originalHash);
    assert.equal(await creator.locator('#toggleDragTray').count(), 0);
    assert.equal(await creator.evaluate(() => typeof window.creatorAPI.toggleDragTray), 'undefined');
    await creator.evaluate(async assetPath => {
      await loadAssetItems(); state.quickSelectionOrder = [assetPath]; updateQuickSelectionUI();
    }, copied.path);
    const moved = await api('/api/creative-assets/move', { path: copied.path, folder: `${scratchRelative}/已移动` }, selectedProject.id);
    assert.equal(moved.assetId, copied.assetId);
    assert.equal(fs.existsSync(path.join(assetRoot, copied.path)), false);
    assert.equal(hash(path.join(assetRoot, moved.path)), originalHash);
    await until(() => creator.evaluate(assetPath => state.quickSelectionOrder.includes(assetPath), moved.path), '选中素材随move更新');
    await app.evaluate(({ webContents }) => {
      globalThis.__candidateAssetDrag = null;
      const contents = webContents.getAllWebContents().find(item => item.getURL().includes('/creator.html'));
      if (!contents) throw new Error('创作浏览器未创建');
      contents.startDrag = payload => { globalThis.__candidateAssetDrag = { file: payload.file, files: payload.files }; };
    });
    await creator.evaluate(assetPath => window.creatorAPI.startAssetDrag(assetPath), moved.path);
    const drag = await until(() => app.evaluate(() => globalThis.__candidateAssetDrag), '原生拖拽IPC路径');
    assert.equal(drag.file, path.join(assetRoot, moved.path));
    assert.equal(hash(originalAsset), originalHash); assert.equal(hash(clonedAsset), cloneHash);
    evidence.assetLinkage = { cloneSourceUnchanged: true, formalSourceUnchanged: true, copyCreatesNewId: true,
      copySourceIdPreserved: true, moveKeepsId: true, sidebarSelectionFollowsMove: true, removedTrayEntryAndAPI: true,
      nativeDragResolvesCandidatePath: true, externalEditorReceived: false };
    if (selectedProject.id !== initialProjectId) await creator.evaluate(id => window.creatorAPI.selectProject({ projectId: id, mode: 'video' }), initialProjectId);
    assert.deepEqual(errors, []);
    if (formalPid) process.kill(formalPid, 0);
    evidence.status = 'passed';
    console.log(`CANDIDATE_NATIVE_LAUNCH_PASS version=${verified.candidateVersion} candidatePid=${evidence.runtime.candidatePid} origin=${evidence.runtime.origin} listeningPidConfirmed=true isolatedRuntime=true envOverrideIgnored=true badge=true projects=${evidence.localState.projects} templates=${evidence.localState.imageTemplates + evidence.localState.videoTemplates} scriptGroups=${evidence.localState.scriptGroups} scriptSegments=${evidence.localState.scriptSegments} moveCopySidebarLinkage=true formalPidStillRunning=true`);
  } catch (error) {
    evidence.status = 'failed'; evidence.failure = error.message;
    throw error;
  } finally {
    if (app) await app.close();
    if (scratchCreated && scratchAbsolute && fs.existsSync(scratchAbsolute)) fs.rmSync(scratchAbsolute, { recursive: true });
    // 仅清理由此脚本创建的候选验收元数据；用户原有素材和状态保留。
    if (scratchCreated && scratchRelative) {
      const workflowFile = path.join(data, 'asset-workflow.json');
      if (fs.existsSync(workflowFile)) {
        const workflow = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
        for (const rel of Object.keys(workflow.items || {})) if (rel.startsWith(`${scratchRelative}/`)) delete workflow.items[rel];
        fs.writeFileSync(workflowFile, `${JSON.stringify(workflow, null, 2)}\n`);
      }
      const db = new DatabaseSync(path.join(data, 'production.sqlite'));
      try { for (const id of testAssets) db.prepare('DELETE FROM asset_refs WHERE id = ?').run(id); }
      finally { db.close(); }
    }
    fs.mkdirSync(path.dirname(evidenceOut), { recursive: true });
    fs.writeFileSync(evidenceOut, `${JSON.stringify({ ...evidence, errors }, null, 2)}\n`);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
