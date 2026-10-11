'use strict';
// 使用真实 Electron / preload / IPC 和隔离数据；仅替代原生菜单的用户选择。
// 不操作正式剧本、模板、浏览器配置，也不将适配器选择称为真人菜单验收。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright');
const prefix = 'videoOS.creator.project.v2.';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 16000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(70); }
  throw new Error(`超时：${label}`);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-prompt-native-'));
  let app;
  const watchdog = setTimeout(() => {
    console.error('PROMPT_NATIVE_WATCHDOG'); app?.process()?.kill('SIGKILL'); process.exit(1);
  }, 85000).unref();
  try {
    const projectRoot = path.join(root, 'project'), data = path.join(root, 'data');
    const assets = path.join(projectRoot, '创作资产库');
    for (const name of ['来源剧本', '目标剧本', '不可用剧本']) fs.mkdirSync(path.join(assets, name), { recursive: true });
    fs.mkdirSync(data);
    const sentinel = path.join(assets, '来源剧本', '保留原文件.txt');
    fs.writeFileSync(sentinel, 'do not modify');
    const executablePath = process.env.PROMPT_TEST_EXECUTABLE;
    app = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [__dirname] }), timeout: 30000,
      env: { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_PORT: String(4450 + process.pid % 150),
        VIDEO_OS_TEST_PROJECT_ROOT: projectRoot, VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_DATA_DIR: data,
        VIDEO_OS_USER_DATA: path.join(root, 'user-data'), OBSIDIAN_VAULT_PATH: path.join(root, 'obsidian'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    });
    const creator = await app.firstWindow();
    await creator.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 20000 });
    const catalog = await creator.evaluate(() => fetch('/api/creative-projects').then(r => r.json()));
    const source = catalog.projects.find(project => project.name === '来源剧本');
    const target = catalog.projects.find(project => project.name === '目标剧本');
    const unavailable = catalog.projects.find(project => project.name === '不可用剧本');
    assert.ok(source && target && unavailable);
    fs.renameSync(path.join(assets, '不可用剧本'), path.join(root, 'offline-project'));
    await creator.evaluate(id => window.creatorAPI.selectProject({ projectId: id, mode: 'image' }), source.id);
    await until(() => creator.locator('#currentProject').textContent().then(text => text.includes('来源剧本')), '切换来源剧本');
    await creator.evaluate(({ sourceId, targetId, prefix }) => {
      localStorage.setItem(prefix + sourceId, JSON.stringify({ version: 2, promptTemplatesVersion: 3,
        promptTemplates: { image: [{ id: 'src-image', title: '通用', body: '图片模板' }], video: [{ id: 'src-video', title: '对白', body: '视频模板' }] },
        prompts: { image: '来源草稿', video: '' }, scripts: { groups: [] } }));
      localStorage.setItem(prefix + targetId, JSON.stringify({ version: 2, promptTemplatesVersion: 3,
        promptTemplates: { image: [{ id: 'target-original', title: '通用', body: '目标原模板' }], video: [] },
        prompts: { image: '目标原草稿', video: '' }, scripts: { groups: [] }, extra: 'keep' }));
      // 正式页面刷新前会保存内存工作区；先走实际加载函数，避免旧的空内存覆盖测试种子。
      loadWorkspace();
    }, { sourceId: source.id, targetId: target.id, prefix });
    await creator.reload();
    await creator.waitForFunction(() => document.body.dataset.ready === 'true');
    const read = id => creator.evaluate(key => JSON.parse(localStorage.getItem(key)), prefix + id);
    const sourceBefore = (await read(source.id)).promptTemplates;
    const tabsBefore = (await creator.evaluate(() => window.creatorAPI.getConfig())).browser.tabs;

    await app.evaluate(({ Menu }, targetName) => {
      globalThis.__promptMenuChoice = targetName;
      globalThis.__promptMenuCalls = [];
      Menu.prototype.popup = function(options) {
        const action = this.items.find(item => item.label === '迁移固定提示词到…');
        globalThis.__promptMenuCalls.push({ labels: this.items.map(item => item.label), enabled: action?.enabled,
          targets: action?.submenu?.items.map(item => item.label), x: options.x, y: options.y });
        action?.submenu?.items.find(item => item.label === globalThis.__promptMenuChoice)?.click();
        options.callback?.();
      };
    }, target.name);
    await creator.locator('#currentProject').click();
    await creator.locator(`#projectMenuList [data-project-id="${source.id}"]`).click({ button: 'right' });
    await until(() => creator.locator('#creatorToast').textContent().then(text => text.includes('已新增到')), '原生右键追加');
    assert.deepEqual((await read(source.id)).promptTemplates, sourceBefore);
    const migrated = await read(target.id);
    assert.equal(migrated.extra, 'keep'); assert.equal(migrated.prompts.image, '目标原草稿');
    assert.deepEqual(migrated.promptTemplates.image.map(item => item.body), ['目标原模板', '图片模板']);
    assert.equal(migrated.promptTemplates.image[1].title, '通用（2）');
    assert.notEqual(migrated.promptTemplates.image[1].id, 'src-image');
    assert.equal(migrated.promptTemplates.video[0].body, '视频模板');
    const menu = await app.evaluate(() => globalThis.__promptMenuCalls.at(-1));
    assert.ok(menu.enabled); assert.ok(menu.targets.includes(target.name));
    assert.ok(!menu.targets.includes(source.name) && !menu.targets.includes(unavailable.name));
    console.log('PROMPT_NATIVE_STEP append-and-native-menu-pass');

    await creator.locator('#currentProject').click({ button: 'right' });
    await until(() => creator.locator('#creatorToast').textContent().then(text => text.includes('无需重复添加')), '重复迁移');
    assert.deepEqual(await read(target.id), migrated);
    await app.evaluate(() => { globalThis.__promptMenuChoice = ''; });
    const cancelled = await creator.evaluate(id => window.creatorAPI.showProjectTemplateMenu({ sourceProjectId: id, counts: { image: 1, video: 1 } }), source.id);
    assert.equal(cancelled.cancelled, true); assert.deepEqual(await read(target.id), migrated);
    for (const invalidId of ['project-does-not-exist', unavailable.id]) {
      const denied = await creator.evaluate(id => window.creatorAPI.selectProject({ projectId: id }).then(() => false, () => true), invalidId);
      assert.equal(denied, true);
    }

    await creator.locator('#currentProject').click();
    await creator.locator(`#projectMenuList [data-project-id="${target.id}"]`).click();
    await until(() => creator.locator('#currentProject').textContent().then(text => text.includes(target.name)), '切换目标剧本');
    try {
      await until(() => creator.locator('#promptTemplateList .saved-template-item').count().then(count => count === 2), '目标图片模板');
    } catch (error) {
      console.error('PROMPT_NATIVE_SWITCH_DIAGNOSTIC', JSON.stringify(await creator.evaluate(({ prefix, targetId }) => ({
        toast: document.getElementById('creatorToast').textContent, mode: state.mode, projectId: state.projectId,
        current: document.getElementById('currentProject').textContent, templateCount: state.promptTemplates.image.length,
        target: JSON.parse(localStorage.getItem(prefix + targetId)),
      }), { prefix, targetId: target.id })));
      throw error;
    }
    assert.equal(await creator.locator('#promptEditor').inputValue(), '目标原草稿');
    assert.deepEqual((await creator.evaluate(() => window.creatorAPI.getConfig())).browser.tabs, tabsBefore);
    // 在目标剧本下，右键来源剧本，确认读取来源而不是误用当前剧本。
    await app.evaluate(() => { globalThis.__promptMenuChoice = '目标剧本'; });
    await creator.locator('#currentProject').click();
    await creator.locator(`#projectMenuList [data-project-id="${source.id}"]`).click({ button: 'right' });
    await until(() => creator.locator('#creatorToast').textContent().then(text => text.includes('无需重复添加')), '非当前来源剧本');
    const inactiveMenu = await app.evaluate(() => globalThis.__promptMenuCalls.at(-1));
    assert.match(inactiveMenu.labels[0], /来源剧本/);
    await creator.reload(); await creator.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await creator.locator('#promptTemplateList .saved-template-item').count(), 2);
    assert.equal(fs.readFileSync(sentinel, 'utf-8'), 'do not modify');
    const report = { passed: true, packaged: await app.evaluate(({ app }) => app.isPackaged),
      actualPreloadAndIPC: true, nativeMenuSelectionAdapter: true, bothModesAppended: true,
      sourceAndDestinationPreserved: true, cancelAndRepeatPreserved: true, unavailableExcluded: true,
      projectSwitchKeepsBrowserTabs: true, inactiveSourceRightClick: true, reloadRetained: true };
    console.log('PROMPT_TEMPLATE_MIGRATION_NATIVE_PASS', JSON.stringify(report));
  } finally {
    clearTimeout(watchdog);
    if (app) await app.close().catch(() => app.process()?.kill('SIGTERM'));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
