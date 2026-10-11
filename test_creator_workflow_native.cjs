'use strict';
// 真正的 Electron 下载与分类窗口、真实预载 IPC；素材和登录数据完全隔离。
// 文件夹删除仅把系统 Trash 边界替换成隔离目录。浮窗拖出仅验证 IPC，不声称剪映实收。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 16000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(60); }
  throw new Error(`超时：${label}`);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-workflow-native-'));
  let app, server;
  const results = {};
  const watchdog = setTimeout(() => { console.error('WORKFLOW_NATIVE_WATCHDOG'); app?.process()?.kill('SIGKILL'); process.exit(1); }, 100000).unref();
  try {
    const projectRoot = path.join(root, 'project'), assetRoot = path.join(projectRoot, '创作资产库'), data = path.join(root, 'data');
    fs.mkdirSync(path.join(assetRoot, '隔离剧本甲'), { recursive: true }); fs.mkdirSync(data); fs.mkdirSync(path.join(root, 'trash'));
    const movie = path.join(root, 'fixture.mp4');
    const ffmpeg = path.join(__dirname, 'vendor/media-tools/darwin-arm64/ffmpeg');
    const ff = fs.existsSync(ffmpeg) ? ffmpeg : '/opt/homebrew/bin/ffmpeg';
    const generated = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x72:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', movie], { timeout: 20000 });
    assert.equal(generated.status, 0, generated.stderr?.toString());
    const bytes = fs.readFileSync(movie);
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="clip.mp4"', 'Content-Length': bytes.length });
      res.end(bytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const mediaURL = `http://127.0.0.1:${server.address().port}/clip.mp4`;
    const nativeExecutable = process.env.WORKFLOW_TEST_EXECUTABLE;
    app = await _electron.launch({ ...(nativeExecutable ? { executablePath: nativeExecutable, args: [] } : { args: [__dirname] }), timeout: 30000,
      env: { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_PORT: String(4100 + process.pid % 300),
        VIDEO_OS_TEST_PROJECT_ROOT: projectRoot, VIDEO_OS_PROJECT_ROOT: projectRoot,
        VIDEO_OS_DATA_DIR: data, VIDEO_OS_USER_DATA: path.join(root, 'user-data'), OBSIDIAN_VAULT_PATH: path.join(root, 'obsidian'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    });
    const creator = await app.firstWindow();
    await creator.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 20000 });
    const config = await creator.evaluate(() => window.creatorAPI.getConfig());
    console.log('WORKFLOW_STEP creator-ready');
    const projectId = config.project.id, folder = config.project.folder;
    const api = async (action, body = {}) => creator.evaluate(async ({ action, body }) => {
      const response = await fetch('/api/creative-projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }) });
      const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
    }, { action, body });
    await until(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().some(contents => contents.getURL().includes('creator-fixture.html?service='))), '平台页启动');
    const startDownload = query => app.evaluate(({ webContents }, url) => {
      const source = webContents.getAllWebContents().find(contents => contents.getURL().includes('creator-fixture.html?service='));
      if (!source) throw new Error('缺少平台下载页'); source.downloadURL(url);
    }, `${mediaURL}?${query}`);
    const chooser = () => until(async () => {
      const page = app.windows().find(page => page.url().includes('/assets/ui/download-review.html'));
      if (!page || page.isClosed()) return null;
      try { return await page.locator('[data-choice="editable"]').isVisible() ? page : null; } catch { return null; }
    }, '视频分类弹窗');
    const downloads = () => creator.evaluate(() => window.creatorAPI.getDownloads());
    await startDownload('pending');
    const firstChoice = await chooser();
    await until(() => { const file = path.join(data, 'video-download-review/reviews.json'); return fs.existsSync(file) && Object.values(JSON.parse(fs.readFileSync(file)).entries).some(entry => entry.completed); }, '网络完成仍等待分类');
    assert.equal((await downloads())[0].savePath, '', '未分类的视频不可暴露路径/拖拽');
    assert.equal(fs.readdirSync(path.join(assetRoot, folder, '生成视频')).length, 0);
    assert.equal(await firstChoice.locator('[data-choice]').count(), 2);
    await firstChoice.locator('[data-choice="processing"]').click();
    const pending = await until(async () => (await downloads()).find(item => item.state === 'completed' && item.videoDisposition === 'processing'), '待处理归档');
    assert.ok(pending.savePath.includes('/生成视频/待处理/')); assert.deepEqual(fs.readFileSync(pending.savePath), bytes);
    results.realDownloadStagedAndClassified = true;
    console.log('WORKFLOW_STEP staged-download-choice-pass');

    await startDownload('batch1'); await startDownload('batch2');
    const batchChoice1 = await chooser();
    const beta = await api('create', { name: '隔离剧本乙' });
    await batchChoice1.locator('[data-choice="editable"]').click();
    const batchChoice2 = await chooser();
    await batchChoice2.locator('[data-choice="editable"]').click();
    // 下载列表按当前剧本筛选。切回原剧本再读取记录，不把正常的筛选当成下载失败。
    await api('activate', { id: projectId });
    const batch = await until(async () => { const values = (await downloads()).filter(item => item.state === 'completed' && item.videoDisposition === 'editable'); return values.length === 2 ? values : null; }, '并行同名下载');
    assert.notEqual(batch[0].savePath, batch[1].savePath);
    assert.ok(batch.every(item => item.projectId === projectId && item.savePath.includes(`/${folder}/生成视频/可剪辑/`)), '项目切换不能改变下载归属');
    results.concurrentDownloadsKeepOriginalProject = true;
    console.log('WORKFLOW_STEP concurrent-project-binding-pass');

    await startDownload('cancel');
    await (await chooser()).locator('#cancel').click();
    await until(async () => (await downloads()).find(item => item.state === 'cancelled'), '取消分类');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(data, 'video-download-review/reviews.json'))).entries).length, 0);
    results.cancelDoesNotArchive = true;
    console.log('WORKFLOW_STEP cancel-pass');

    assert.equal(await creator.locator('#toggleDragTray').count(), 0);
    assert.equal(await creator.evaluate(() => typeof window.creatorAPI.toggleDragTray), 'undefined');
    results.removedTrayEntryAndAPI = true;
    const postAssets = (operation, body) => creator.evaluate(async ({ operation, body }) => {
      const response = await fetch(`/api/creative-assets/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
    }, { operation, body });
    await postAssets('folder', { parent: folder, name: '第01集' });
    const oldPendingRel = path.relative(fs.realpathSync(assetRoot), fs.realpathSync(pending.savePath)).split(path.sep).join('/');
    const movedPending = await postAssets('move', { path: oldPendingRel, folder: `${folder}/第01集` });
    assert.equal(movedPending.videoDisposition, 'processing');
    const movedDownload = (await downloads()).find(item => item.id === pending.id);
    assert.equal(fs.realpathSync(movedDownload.savePath), fs.realpathSync(path.join(assetRoot, movedPending.path)));
    pending.savePath = movedDownload.savePath;
    const editableRel = path.relative(fs.realpathSync(assetRoot), fs.realpathSync(batch[0].savePath)).split(path.sep).join('/');
    const movedEditable = await postAssets('move', { path: editableRel, folder: `${folder}/第01集` });
    assert.equal(movedEditable.videoDisposition, 'editable');
    results.persistentStatusMatchesNativeAfterMove = true;
    console.log('WORKFLOW_STEP asset-status-after-move-pass');

    const rel = path.relative(fs.realpathSync(assetRoot), fs.realpathSync(pending.savePath)).split(path.sep).join('/');
    await creator.evaluate(p => window.creatorAPI.floatVideoAsset({ path: p, origin: { x: 80, y: 180, width: 140, height: 170 } }), rel);
    const float = await until(() => app.windows().find(page => page.url().includes('/float-video.html')), '视频浮窗');
    const motion = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/float-video.html'));
      return { anchored: win.__floatVideoRecord.presentation?.render.anchored, focusable: win.isFocusable(), top: win.isAlwaysOnTop() };
    });
    assert.equal(motion.anchored, true); assert.equal(motion.top, true);
    if (process.platform === 'darwin') assert.equal(motion.focusable, false);
    await float.waitForFunction(() => document.body.dataset.presenting === 'false');
    assert.ok((await float.locator('#fvKind').textContent()).includes('Updream'));
    assert.equal(await float.locator('button').count(), 1);
    assert.equal(await float.locator('#fvCard').getAttribute('draggable'), 'true');
    results.anchoredNonActivatingFloat = true;
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/float-video.html'));
      win.webContents.startDrag = options => { globalThis.__workflowDragFile = options.file; };
    });
    await float.evaluate(() => document.querySelector('#fvCard').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })));
    await until(() => app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/float-video.html'));
      return win && !win.isVisible();
    }), '拖出自动收起');
    await delay(850);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/float-video.html')).isVisible()), false);
    assert.deepEqual(fs.readFileSync(pending.savePath), bytes);
    results.floatDragHidesWithoutDeletingSource = true;
    console.log('WORKFLOW_STEP float-presentation-drag-pass');

    // 模拟系统菜单选择，仍执行 main.cjs 的实际受信任 IPC 和删除控制器。
    await app.evaluate(({ Menu, dialog, shell }, trash) => {
      const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path');
      globalThis.__workflowConfirm = []; globalThis.__workflowResponse = 0;
      Menu.prototype.popup = function(options) { this.items.find(item => item.label.startsWith('删除文件夹'))?.click(); options.callback?.(); };
      dialog.showMessageBox = async (_owner, options) => { globalThis.__workflowConfirm.push(options); return { response: globalThis.__workflowResponse }; };
      shell.trashItem = async absolute => {
        if (!absolute.includes('/video-os-workflow-native-')) throw new Error('拒绝操作非隔离数据');
        fs.renameSync(absolute, path.join(trash, path.basename(absolute)));
      };
    }, path.join(root, 'trash'));
    const tabsBefore = (await creator.evaluate(() => window.creatorAPI.getConfig())).browser.tabs;
    const cancelClear = await creator.evaluate(() => window.creatorAPI.clearTabs());
    assert.equal(cancelClear.clearCancelled, true);
    assert.deepEqual((await creator.evaluate(() => window.creatorAPI.getConfig())).browser.tabs, tabsBefore);
    assert.equal(await app.evaluate(() => globalThis.__workflowConfirm.at(-1).cancelId), 0);
    results.clearConfirmationCancelPreservesTabs = true;
    console.log('WORKFLOW_STEP clear-cancel-pass');

    const characters = `${folder}/人物资产`;
    const cancelledFolder = await creator.evaluate(p => window.creatorAPI.showFolderMenu({ path: p, x: 80, y: 200 }), characters);
    assert.equal(cancelledFolder.cancelled, true); assert.ok(fs.existsSync(path.join(assetRoot, characters)));
    await app.evaluate(() => { globalThis.__workflowResponse = 1; });
    const deletion = await creator.evaluate(p => window.creatorAPI.showFolderMenu({ path: p, x: 80, y: 200 }), characters);
    assert.equal(deletion.deleted, true); assert.equal(fs.existsSync(path.join(assetRoot, characters)), false);
    await creator.evaluate(() => fetch('/api/creative-assets').then(r => r.json()));
    assert.equal(fs.existsSync(path.join(assetRoot, characters)), false);
    results.folderDeleteConfirmedAndNotRecreated = true;
    await app.evaluate(({ Menu }) => {
      Menu.prototype.popup = function(options) {
        globalThis.__folderMenuLabels = this.items.map(item => item.label);
        this.items.find(item => item.label === '改名…')?.click(); options.callback?.();
      };
    });
    const finalPath = `${folder}/成片`;
    await creator.locator(`.quick-folder-row[data-folder-path="${finalPath}"]`).dispatchEvent('contextmenu', { clientX: 100, clientY: 220 });
    const renameInput = creator.getByRole('textbox', { name: '文件夹名称', exact: true });
    await renameInput.waitFor();
    await renameInput.fill('最后的成品'); await renameInput.press('Enter');
    await creator.locator(`.quick-folder-row[data-folder-path="${folder}/最后的成品"]`).waitFor();
    assert.equal(fs.existsSync(path.join(assetRoot, finalPath)), false);
    assert.ok(fs.existsSync(path.join(assetRoot, folder, '最后的成品')));
    assert.ok((await app.evaluate(() => globalThis.__folderMenuLabels)).some(label => label.startsWith('删除文件夹')));
    const renamedProject = (await creator.evaluate(() => window.creatorAPI.getConfig())).project;
    assert.equal(renamedProject.categories.find(item => item.id === 'finals').folder, '最后的成品');
    const wrongProject = await creator.evaluate(request => window.creatorAPI.renameFolder(request).then(() => false, () => true),
      { projectId: beta.project.id, path: `${folder}/最后的成品`, name: '不得跨剧本修改' });
    assert.equal(wrongProject, true);
    results.nativeFolderRenameInlineAndProjectGuard = true;
    const gate = await creator.evaluate(p => window.creatorAPI.showFolderMenu({ path: p }), folder);
    assert.equal(gate.cancelled, true);
    const rootLabels = await app.evaluate(() => globalThis.__folderMenuLabels);
    assert.ok(rootLabels.includes('新建文件夹…'));
    assert.ok(!rootLabels.some(label => label.startsWith('删除文件夹')));
    results.projectRootCannotBeDeleted = true;
    const packaged = await app.evaluate(({ app }) => app.isPackaged);
    console.log('WORKFLOW_NATIVE_PASS', JSON.stringify({ ...results, packaged }));
  } finally {
    clearTimeout(watchdog);
    if (app) await app.close().catch(() => app.process()?.kill('SIGTERM'));
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
