'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { _electron } = require('playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, name) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await read()) return; await pause(40); }
  throw new Error('Timeout: ' + name);
}
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function main() {
  const executablePath = process.env.RENAME_TEST_EXECUTABLE;
  assert.ok(executablePath && fs.existsSync(executablePath));
  const evidence = path.resolve(process.env.RENAME_TEST_EVIDENCE);
  assert.equal(fs.existsSync(evidence), false); fs.mkdirSync(evidence, { recursive: true });
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-image-rename-'));
  const projectRoot = path.join(temp, 'project'), profile = path.join(temp, 'profile');
  const data = path.join(temp, 'data'), obsidian = path.join(temp, 'obsidian');
  const projectName = '图片改名隔离', folder = projectName + '/人物资产';
  const mediaRoot = path.join(projectRoot, '创作资产库');
  fs.mkdirSync(path.join(mediaRoot, folder), { recursive: true }); fs.mkdirSync(data); fs.mkdirSync(obsidian);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  for (const name of ['原始001.png', '已有名称.png']) fs.writeFileSync(path.join(mediaRoot, folder, name), png);
  const report = { status: 'running', checks: {}, scope: { isolated: true, formalDataTouched: false, realApiAndDisk: true } };
  let app;
  const watchdog = setTimeout(() => app?.process()?.kill('SIGKILL'), 120000).unref();
  try {
    const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0',
      VIDEO_OS_PORT: String(await freePort()), VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: data, VIDEO_OS_USER_DATA: profile, OBSIDIAN_VAULT_PATH: obsidian, VIDEO_OS_TEST_OBSIDIAN_VAULT: obsidian };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath, args: [], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    await page.waitForFunction(() => document.body?.dataset.ready === 'true');
    const runtime = await app.evaluate(({ app }) => ({ pid: process.pid, packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData') }));
    assert.equal(runtime.packaged, true); assert.equal(runtime.version, process.env.RENAME_TEST_VERSION || require('./package.json').version);
    assert.equal(fs.realpathSync(runtime.profile), fs.realpathSync(profile)); report.runtime = runtime;
    const project = await page.evaluate(async name => (await fetch('/api/creative-projects').then(r => r.json())).projects.find(p => p.name === name), projectName);
    assert.ok(project);
    await page.evaluate(id => window.creatorAPI.selectProject({ projectId: id, mode: 'image' }), project.id);
    await until(async () => (await page.locator('#currentProject').innerText()).includes(projectName), 'correct project');
    let currentName = '原始001.png';
    const begin = async () => {
      if (!(await page.locator('#assetAccordion').evaluate(node => node.open))) await page.locator('#assetAccordion > summary').click();
      for (const value of [project.folder, folder]) {
        const exact = page.locator(`.quick-folder-row[data-folder-path="${value}"] .quick-folder-name`);
        await exact.waitFor(); if (await exact.getAttribute('aria-expanded') === 'false') await exact.click();
      }
      const card = page.locator(`.asset-card-wrap[data-asset-path="${folder}/${currentName}"] .asset-image-card`);
      await card.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '改名…', exact: true }).click();
      await page.locator('#renameName').waitFor();
      assert.equal(await page.locator('#renameName').inputValue(), currentName.slice(0, -4));
    };
    await begin(); await page.locator('#renameName').fill('不要保存'); await page.locator('#renameCancel').click();
    assert.ok(fs.existsSync(path.join(mediaRoot, folder, currentName))); report.checks.cancelWithoutWrite = true;
    await begin(); await page.locator('#renameName').fill('已有名称'); await page.locator('#renameSave').click();
    await until(async () => (await page.locator('#renameError').innerText()).includes('同名'), 'collision feedback');
    assert.ok(await page.locator('#renameDialog').isVisible()); assert.ok(fs.existsSync(path.join(mediaRoot, folder, currentName)));
    report.checks.collisionPreservesFileAndDialog = true;
    for (const [mode, name] of [['image', '人物正面参考'], ['video', '人物服装参考']]) {
      if (mode === 'video') {
        await page.locator('.mode-button[data-mode="video"]').click();
        await page.waitForFunction(() => document.body.dataset.mode === 'video'); await begin();
      }
      await page.locator('#renameName').fill(name); await page.locator('#renameSave').click();
      const next = name + '.png';
      await until(() => fs.existsSync(path.join(mediaRoot, folder, next)) && !fs.existsSync(path.join(mediaRoot, folder, currentName)), 'rename on disk');
      assert.deepEqual(fs.readFileSync(path.join(mediaRoot, folder, next)), png); currentName = next;
      await page.locator(`.asset-card-wrap[data-asset-path="${folder}/${next}"]`).waitFor();
      report.checks[mode + 'RenameUpdatesFileAndUi'] = true;
    }
    report.status = 'passed'; console.log('IMAGE_RENAME_NATIVE_PASS');
  } catch (error) { report.status = 'failed'; report.error = error.stack; console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog);
    if (app) { const child = app.process(); await Promise.race([app.close().catch(() => {}), pause(3000)]); if (child.exitCode === null) child.kill('SIGTERM'); }
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(report, null, 2));
    await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main();
