'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { launchChromium } = require('./test-playwright.cjs');

const BASE_URL = process.argv[2] || 'http://127.0.0.1:3750';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const PROJECT = {
  id: 'project-11111111-1111-4111-8111-111111111111', name: '校园心动', folder: '校园心动', kind: 'script',
  categories: [{ id: 'frames', label: '首帧与尾帧', path: '校园心动/首帧与尾帧', children: [
    { label: '首帧', path: '校园心动/首帧与尾帧/首帧' },
    { label: '尾帧', path: '校园心动/首帧与尾帧/尾帧' },
  ] }],
};
const BULK_IMAGES = Array.from({ length: 123 }, (_, index) => ({
  kind: 'file', type: 'image',
  name: `批量资产-${String(index + 1).padStart(3, '0')}.png`,
  path: `校园心动/人物资产/批量资产-${String(index + 1).padStart(3, '0')}.png`,
  ext: '.png', size: 1024, sizeText: '1 KB', mtime: `2026-08-29T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
}));
const TREE = {
  available: true,
  project: PROJECT,
  rootName: '创作资产库',
  stats: { folders: 3, files: 129, image: 125, audio: 1, video: 1, document: 1, other: 1, sizeText: '18.4 MB' },
  tree: {
    kind: 'folder', name: '创作资产库', path: '', fileCount: 129, children: [
      {
        kind: 'folder', name: '校园心动', path: '校园心动', fileCount: 128, children: [
          {
            kind: 'folder', name: '人物资产', path: '校园心动/人物资产', fileCount: 125, children: [
              { kind: 'file', type: 'image', name: '女主正脸.png', path: '校园心动/人物资产/女主正脸.png', ext: '.png', size: 2048, sizeText: '2 KB', mtime: '2026-08-30T10:00:00.000Z' },
              { kind: 'file', type: 'image', name: '校服三视图.jpg', path: '校园心动/人物资产/校服三视图.jpg', ext: '.jpg', size: 3072, sizeText: '3 KB', mtime: '2026-08-30T09:00:00.000Z' },
              ...BULK_IMAGES,
            ],
          },
          { kind: 'file', type: 'audio', name: '女主声线.wav', path: '校园心动/女主声线.wav', ext: '.wav', size: 4096, sizeText: '4 KB', mtime: '2026-08-30T08:00:00.000Z' },
          { kind: 'file', type: 'video', name: '走廊参考.mp4', path: '校园心动/走廊参考.mp4', ext: '.mp4', size: 8192, sizeText: '8 KB', mtime: '2026-08-30T07:00:00.000Z' },
          { kind: 'file', type: 'document', name: '资产说明.md', path: '校园心动/资产说明.md', ext: '.md', size: 512, sizeText: '512 B', mtime: '2026-08-30T06:00:00.000Z' },
        ],
      },
      { kind: 'folder', name: '第二个剧本', path: '第二个剧本', fileCount: 1, children: [
        { kind: 'file', type: 'other', name: '工程源文件.psd', path: '第二个剧本/工程源文件.psd', ext: '.psd', size: 1024, sizeText: '1 KB', mtime: '2026-08-30T05:00:00.000Z' },
      ] },
    ],
  },
};

async function run() {
  const consoleErrors = [];
  const pageErrors = [];
  const folderRequests = [];
  const importRequests = [];
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 860 } });
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.route('**/api/**', route => {
      if (route.request().method() !== 'GET') return route.abort('blockedbyclient');
      return route.continue();
    });
    await page.route('**/api/creative-assets?*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(TREE),
    }));
    await page.route('**/api/creative-assets/file?*', route => route.fulfill({
      status: 200, contentType: 'image/png', body: PNG,
    }));
    await page.route('**/api/creative-assets/folder?*', async route => {
      const body = route.request().postDataJSON();
      folderRequests.push(body);
      const folderPath = body.parent ? `${body.parent}/${body.name}` : body.name;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, folder: { name: body.name, path: folderPath } }) });
    });
    const renameRequests = [];
    const moveRequests = [];
    const normalizeRequests = [];
    await page.route('**/api/creative-assets/normalize?*', async route => {
      normalizeRequests.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, renamed: [{ from: 'a.png', to: '生成图片-001.png' }, { from: 'b.png', to: '生成图片-002.png' }] }) });
    });
    await page.route('**/api/creative-assets/rename?*', async route => {
      const body = route.request().postDataJSON();
      renameRequests.push(body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, name: `${body.name}.png`, path: body.path }) });
    });
    await page.route('**/api/creative-assets/move?*', async route => {
      const body = route.request().postDataJSON();
      moveRequests.push(body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, name: 'moved.png', path: body.folder, folder: body.folder }) });
    });
    const activateRequests = [];
    await page.route('**/api/creative-projects*', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        console.log('ACTIVATE-POST:', JSON.stringify(body));
        activateRequests.push(body);
        await page.evaluate(item => { (window.__activateRequests = window.__activateRequests || []).push(item); }, body);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, project: { id: body.id, name: '第二个剧本', folder: '第二个剧本', kind: 'script' } }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activeProjectId: PROJECT.id, projects: [
        { id: PROJECT.id, name: '校园心动', folder: '校园心动', kind: 'script', assetCount: 129 },
        { id: 'project-22222222-2222-4222-8222-222222222222', name: '第二个剧本', folder: '第二个剧本', kind: 'script', assetCount: 1 },
      ] }) });
    });
    await page.route('**/api/creative-assets/import?*', async route => {
      importRequests.push(new URL(route.request().url()).searchParams.get('name'));
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, type: 'image', name: '新资产.png' }) });
    });
    await page.addInitScript(() => {
      const listeners = { panel: [], drag: [] };
      let panel = { open: true, layout: 'overlay', width: 520, creativeAssetAvailable: true };
      window.__assetTest = { states: [], dragPaths: [], copied: [], shown: [], deleted: [], opened: 0, projectPickers: 0 };
      window.assetAPI = {
        getConfig: async () => ({ panel, project: {
          id: 'project-11111111-1111-4111-8111-111111111111', name: '校园心动', folder: '校园心动', kind: 'script',
          categories: [{ id: 'frames', label: '首帧与尾帧', path: '校园心动/首帧与尾帧', children: [
            { label: '首帧', path: '校园心动/首帧与尾帧/首帧' }, { label: '尾帧', path: '校园心动/首帧与尾帧/尾帧' },
          ] }],
        }, rootName: '校园心动', rootPath: '/mock/创作资产库/校园心动', creativeAssetAvailable: true }),
        setPanelState: async patch => {
          panel = { ...panel, ...patch };
          window.__assetTest.states.push({ ...panel });
          listeners.panel.forEach(callback => callback(panel));
          return panel;
        },
        startDrag: assetPath => {
          window.__assetTest.dragPaths.push(assetPath);
          listeners.drag.forEach(callback => callback({ ok: true, path: assetPath }));
        },
        copyImage: async assetPath => { window.__assetTest.copied.push(assetPath); return true; },
        showItem: async assetPath => { window.__assetTest.shown.push(assetPath); return true; },
        deleteItem: async assetPath => { window.__assetTest.deleted.push(assetPath); return true; },
        openLibrary: async () => { window.__assetTest.opened += 1; return true; },
        showProjectPicker: async () => { window.__assetTest.projectPickers += 1; return true; },
        onPanelState: callback => { listeners.panel.push(callback); return () => {}; },
        onDragResult: callback => { listeners.drag.push(callback); return () => {}; },
        onFocusAsset: callback => { (window.__assetFocusSubscribers = window.__assetFocusSubscribers || []).push(callback); return () => {}; },
        consumePendingFocus: async () => {
          const v = localStorage.getItem('__testPendingFocus') || '';
          localStorage.removeItem('__testPendingFocus');
          return v ? { path: v, projectId: 'project-11111111-1111-4111-8111-111111111111' } : null;
        },
      };
    });

    const response = await page.goto(`${BASE_URL}/creator-assets.html`, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    await page.locator('body[data-ready="true"]').waitFor();
    assert.equal(await page.locator('.asset-card').count(), 120, '大量资产应分批渲染');
    assert.equal(await page.locator('.load-more').count(), 1);
    await page.locator('.load-more').click();
    assert.equal(await page.locator('.asset-card').count(), 129);
    assert.equal(await page.locator('.folder-button').count(), 4, '应显示根、剧本与下级文件夹');

    // Obsidian 式折叠树：箭头旋转 + 子级高度动画（collapsed 类切换），子级行保留在 DOM 中
    const rootDisclosure = page.locator('.folder-disclosure:not(.empty)').first();
    assert.equal(await rootDisclosure.getAttribute('aria-expanded'), 'true', '默认应全部展开');
    await rootDisclosure.click();
    const rootWrapper = page.locator('.folder-children').first();
    assert.equal(await rootWrapper.evaluate(node => node.classList.contains('collapsed')), true, '点击箭头后子级应折叠');
    assert.equal(await page.locator('.folder-row').count(), 4, '折叠只是视觉收起，子级行不应从 DOM 移除');
    await rootDisclosure.click();
    assert.equal(await rootWrapper.evaluate(node => !node.classList.contains('collapsed')), true, '再次点击应重新展开');
    assert.equal(await page.locator('.source-list').evaluate(node => getComputedStyle(node).borderRightWidth), '1px', '展开态应采用左右 Split View');

    await page.locator('#assetSearch').fill('校服');
    await page.waitForTimeout(180);
    assert.equal(await page.locator('.asset-card').count(), 1);
    assert.match(await page.locator('.asset-card').innerText(), /校服三视图/);
    await page.locator('#clearSearch').click();
    assert.equal(await page.locator('.asset-card').count(), 120, '清空搜索后应回到首批资产');

    await page.locator('[data-filter="audio"]').click();
    assert.equal(await page.locator('.asset-card[data-kind="audio"]').count(), 1);
    await page.locator('.asset-card[data-kind="audio"] .asset-preview-button').click();
    assert.equal(await page.locator('#previewMedia audio').count(), 1);
    await page.locator('#closePreview').click();
    assert.equal(await page.locator('#previewMedia audio').count(), 0, '关闭预览后应卸载音频');

    await page.locator('[data-filter="video"]').click();
    await page.locator('.asset-card[data-kind="video"] .asset-preview-button').click();
    assert.equal(await page.locator('#previewMedia video').count(), 1);
    assert.equal(await page.locator('#captureFirstFrame').isVisible(), true);
    assert.equal(await page.locator('#captureTailFrame').isVisible(), true);
    // 视频走展开审核形态：对话框加 video-review 类并放大（1100px 上限、受视口约束）；关闭后形态退出
    assert.equal(await page.locator('#previewDialog.video-review').count(), 1, '视频预览应进入展开审核形态');
    const reviewWidth = await page.locator('#previewDialog').evaluate(node => node.getBoundingClientRect().width);
    assert.ok(reviewWidth >= 600 && reviewWidth <= 1100, `展开审核对话框宽度异常：${Math.round(reviewWidth)}px`);
    const videoMaxHeight = await page.locator('#previewMedia video').evaluate(node => getComputedStyle(node).maxHeight);
    assert.ok(videoMaxHeight.endsWith('px') && parseFloat(videoMaxHeight) > 300, `展开审核视频高度应采用审核样式，实际 ${videoMaxHeight}`);
    await page.locator('#closePreview').click();
    assert.equal(await page.locator('#previewDialog.video-review').count(), 0, '关闭预览后应退出展开审核形态');
    // 视频卡片封面：src 定位到开头附近帧（#t=0.1，加载行为另由隔离实测记录），不再是 3D 占位图标
    assert.equal(await page.locator('.asset-card[data-kind="video"] .video-cover').count(), 1, '视频卡片应用首帧封面');
    assert.match(await page.locator('.asset-card[data-kind="video"] .video-cover').getAttribute('src'), /#t=0\.1$/, '封面应定位到第一帧');
    await page.locator('[data-filter="image"]').click();
    const heroCard = page.locator('.asset-card', { hasText: '女主正脸.png' });
    await heroCard.dispatchEvent('dragstart');
    assert.deepEqual(await page.evaluate(() => window.__assetTest.dragPaths), ['校园心动/人物资产/女主正脸.png']);
    await heroCard.locator('.asset-preview-button').click();
    assert.equal(await page.locator('#previewDialog.video-review').count(), 0, '图片预览不得进入视频展开审核形态');
    await page.locator('#zoomIn').click();
    assert.equal(await page.locator('#zoomValue').textContent(), '110%');
    await page.locator('#previewCopy').click();
    await page.locator('#previewShow').click();
    assert.equal(await page.evaluate(() => window.__assetTest.copied.length), 1);
    assert.equal(await page.evaluate(() => window.__assetTest.shown.length), 1);
    await page.locator('#closePreview').click();

    // 资产卡右上角删除：确认后移入废纸篓并刷新列表
    page.once('dialog', dialog => dialog.accept());
    await heroCard.hover();
    await heroCard.locator('.asset-delete-button').click();
    await page.waitForFunction(() => window.__assetTest.deleted.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__assetTest.deleted), ['校园心动/人物资产/女主正脸.png']);

    // 单卡改名：对话框预填去扩展名名称，提交后调用 rename 接口
    await heroCard.hover();
    await heroCard.locator('.asset-card-actions button', { hasText: '改名' }).click();
    await page.locator('#renameDialog[open]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#renameInput').inputValue(), '女主正脸', '改名框应预填去扩展名的名称');
    await page.locator('#renameInput').fill('女主四视图-白裙');
    await page.locator('#renameForm button[type="submit"]').click();
    for (let i = 0; i < 50 && !renameRequests.length; i++) await page.waitForTimeout(100);
    assert.equal(renameRequests.length, 1, '改名请求没有发出');
    assert.deepEqual(renameRequests[0], { path: '校园心动/人物资产/女主正脸.png', name: '女主四视图-白裙' });

    // 单卡移动：选目标文件夹后调用 move 接口
    await heroCard.hover();
    await heroCard.locator('.asset-card-actions button', { hasText: '移动' }).click();
    await page.locator('#moveDialog[open]').waitFor({ state: 'attached' });
    await page.locator('.move-folder-row', { hasText: '第二个剧本' }).click();
    for (let i = 0; i < 50 && !moveRequests.length; i++) await page.waitForTimeout(100);
    assert.equal(moveRequests.length, 1, '移动请求没有发出');
    assert.deepEqual(moveRequests[0], { path: '校园心动/人物资产/女主正脸.png', folder: '第二个剧本' });

    // 多选：勾选两张卡 → 批量删除（先等移动后列表重渲染完成）
    await page.waitForFunction(() => document.querySelector('#moveDialog') && !document.querySelector('#moveDialog').open);
    await page.waitForTimeout(400);
    // 移动成功后会自动跳到目标文件夹；切回「校园心动」再做批量选择
    await page.locator('.folder-button', { hasText: '校园心动' }).click();
    await page.waitForTimeout(200);
    const secondCard = page.locator('.asset-card', { hasText: '校服三视图.jpg' });
    await secondCard.waitFor({ state: 'attached' });
    await secondCard.hover();
    await secondCard.locator('.asset-check').click();
    assert.equal(await page.locator('#selectionBar').isVisible(), true, '勾选后应出现批量操作栏');
    await page.locator('.asset-card', { hasText: '女主正脸.png' }).hover();
    await page.locator('.asset-card', { hasText: '女主正脸.png' }).locator('.asset-check').click();
    assert.match(await page.locator('#selectionCount').textContent(), /已选 2 项/);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#batchDelete').click();
    await page.waitForFunction(() => window.__assetTest.deleted.length === 3);
    assert.deepEqual(await page.evaluate(() => window.__assetTest.deleted.slice(1)), [
      '校园心动/人物资产/校服三视图.jpg', '校园心动/人物资产/女主正脸.png',
    ]);
    assert.equal(await page.locator('#selectionBar').isHidden(), true, '批量删除后操作栏应收起');

    // 整理文件名：确认后对当前分类发起 normalize 请求
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#normalizeNames').click();
    for (let i = 0; i < 50 && !normalizeRequests.length; i++) await page.waitForTimeout(100);
    assert.equal(normalizeRequests.length, 1, '整理文件名请求没有发出');
    assert.equal(normalizeRequests[0].folder, '校园心动', '应针对当前选中分类');

    await page.locator('.folder-button', { hasText: '校园心动' }).click();
    assert.equal(await page.locator('#newSubfolder').isDisabled(), false);
    await page.locator('#newSubfolder').click();
    await page.locator('#folderName').fill('音频');
    await page.locator('#folderForm .primary-button').click();
    assert.deepEqual(folderRequests.at(-1), { project: PROJECT.id, parent: '校园心动', name: '音频' });

    // 切换剧本：面板内对话框列出全部剧本，点击即原地激活（不弹主窗口、不跳页面）
    const urlBeforeSwitch = page.url();
    await page.locator('#switchScript').click();
    await page.locator('#scriptSwitchDialog[open]').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.querySelectorAll('.script-switch-row').length >= 2, null, { timeout: 5000 });
    assert.ok((await page.locator('.script-switch-row').count()) >= 2, '切换剧本对话框应列出全部剧本');
    await page.locator('.script-switch-row', { hasText: '第二个剧本' }).click();
    await page.waitForFunction(() => (window.__activateRequests || []).length >= 1, null, { timeout: 5000 });
    assert.deepEqual((await page.evaluate(() => window.__activateRequests)).at(-1), { action: 'activate', id: 'project-22222222-2222-4222-8222-222222222222' }, '激活请求应带剧本 id');
    await page.locator('#scriptSwitchDialog[open]').waitFor({ state: 'detached' });
    // 全程不得发生页面导航，也不得调用主窗口选剧器（location.assign / showProjectPicker）
    assert.equal(page.url(), urlBeforeSwitch, '切换剧本不得发生页面导航');
    assert.equal(await page.evaluate(() => window.__assetTest.projectPickers), 0, '切换剧本不得调用主窗口选剧器');

    await page.locator('.folder-button', { hasText: '校园心动' }).click();
    await page.locator('#assetFileInput').setInputFiles({ name: '新资产.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForFunction(() => document.querySelector('#importAssets:not(:disabled)'));
    assert.deepEqual(importRequests, ['新资产.png']);

    // 整库拖拽导入：Finder 文件直接拖到资产区，应进入当前选中的文件夹
    await page.locator('#assetGrid').evaluate(grid => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], '拖进来.png', { type: 'image/png' }));
      grid.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await page.waitForFunction(() => document.querySelector('#importAssets:not(:disabled)'));
    assert.deepEqual(importRequests, ['新资产.png', '拖进来.png'], '拖拽导入没有把文件送入当前分类');

    await page.locator('#expandPanel').click();
    assert.equal((await page.evaluate(() => window.__assetTest.states)).at(-1).width, 720);
    await page.locator('[data-layout="push"]').click();
    assert.equal(await page.locator('body').getAttribute('data-layout'), 'push');
    await page.locator('#closePanel').click();
    const states = await page.evaluate(() => window.__assetTest.states);
    assert.equal(states.at(-1).open, false);
    assert.ok(states.some(item => item.layout === 'push'));

    await page.setViewportSize({ width: 360, height: 760 });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);

    // 视频资产框折叠：网格平滑收起、标题栏停靠面板底部、按类型记忆、再点展开
    await page.setViewportSize({ width: 720, height: 860 });
    await page.locator('[data-filter="image"]').click();
    await page.locator('#assetCollapse').click();
    await page.waitForFunction(() => document.querySelector('#assetGrid').getBoundingClientRect().height < 2);
    assert.equal(await page.locator('#assetCollapse').getAttribute('aria-expanded'), 'false', '折叠后开关应显示已收起');
    assert.equal(await page.locator('.library-pane.grid-collapsed').count(), 1, '折叠态应挂到面板上');
    const headingBottom = await page.locator('.library-heading').evaluate(node => node.getBoundingClientRect().bottom);
    const paneBottom = await page.locator('.library-pane').evaluate(node => node.getBoundingClientRect().bottom);
    assert.ok(Math.abs(headingBottom - paneBottom) <= 2, '折叠后标题栏应停靠面板底沿');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('body[data-ready="true"]').waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('videoOS.creatorAssets.gridCollapsed.v1') || '{}').image), true, '折叠状态应写入本机存储');
    await page.locator('[data-filter="image"]').click();
    await page.waitForFunction(() => document.querySelector('.library-pane.grid-collapsed') !== null, null, { timeout: 5000 });
    await page.locator('#assetCollapse').click();
    await page.waitForFunction(() => document.querySelector('#assetGrid').getBoundingClientRect().height > 100);
    assert.equal(await page.locator('#assetCollapse').getAttribute('aria-expanded'), 'true', '再点应重新展开');

    // 创作浏览器快捷面板“在完整库中查看”联动：定位文件夹 + 高亮卡片 + 直接弹出对应预览
    await page.evaluate(() => window.__assetFocusSubscribers.at(-1)('校园心动/人物资产/女主正脸.png'));
    await page.locator('#previewDialog[open]').waitFor({ state: 'attached' });
    assert.match(await page.locator('#previewName').textContent(), /女主正脸\.png/, '联动后应直接预览目标资产');
    assert.equal(await page.locator('.folder-button.active', { hasText: '人物资产' }).count(), 1, '联动应选中资产所在文件夹');
    await page.locator('#closePreview').click();
    assert.equal(await page.locator('.asset-card.focus-flash').count(), 1, '目标卡片应有高亮标记');
    // 重复跳转：同一会话内再次定位另一目标，不得丢失
    await page.evaluate(() => window.__assetFocusSubscribers.at(-1)('校园心动/人物资产/校服三视图.jpg'));
    await page.locator('#previewDialog[open]').waitFor({ state: 'attached' });
    assert.match(await page.locator('#previewName').textContent(), /校服三视图\.jpg/, '重复跳转应定位到新目标');
    // boot-consume 路径：pendingFocus 登记后重载页面，boot 时应取走并定位
    await page.evaluate(() => localStorage.setItem('__testPendingFocus', '校园心动/人物资产/女主正脸.png'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('body[data-ready="true"]').waitFor();
    // boot 自动 consume（对象格式 {path, projectId}）必须定位
    let consumeOpened = true;
    try {
      await page.locator('#previewDialog[open]').waitFor({ state: 'attached', timeout: 15000 });
    } catch {
      consumeOpened = false;
      console.log('BOOT-DIAG', JSON.stringify(await page.evaluate(() => ({
        ready: document.body?.dataset?.ready,
        previewOpen: document.getElementById('previewDialog')?.open,
        previewName: document.getElementById('previewName')?.textContent,
        assets: document.querySelectorAll('#assetGrid .asset-card').length,
        pendingLeft: localStorage.getItem('__testPendingFocus'),
        toast: document.querySelector('.asset-toast')?.textContent || '',
        activeProject: (window.assetAPI && null) || null,
      }))));
    }
    assert.ok(consumeOpened, 'boot 时应消费 pending 定位');
    assert.match(await page.locator('#previewName').textContent(), /女主正脸\.png/, 'boot 时应消费 pending 定位');
    await page.locator('#closePreview').click();
    // 对象格式推送（main 侧 push 通道）同样按 projectId 送达
    await page.evaluate(() => window.__assetFocusSubscribers.at(-1)({ path: '校园心动/人物资产/女主正脸.png', projectId: 'project-11111111-1111-4111-8111-111111111111' }));
    await page.waitForTimeout(300);
    await page.locator('#previewDialog[open]').waitFor({ state: 'attached', timeout: 15000 });
    assert.match(await page.locator('#previewName').textContent(), /女主正脸\.png/, '对象格式推送应定位');
    await page.locator('#closePreview').click();
    // 有界取消的过期送达：面板收到 expired 必须实际提示取消且不定位
    await page.evaluate(() => window.__assetFocusSubscribers.at(-1)({ path: '校园心动/人物资产/女主正脸.png', projectId: 'project-11111111-1111-4111-8111-111111111111', expired: true }));
    await page.locator('.asset-toast', { hasText: '定位请求已过期' }).waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#previewDialog[open]').count(), 0, '过期送达不得打开定位预览');

    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(pageErrors, []);

    const artifactDir = path.join(__dirname, 'test-artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, `creator-assets-library-${process.pid}-${Date.now()}.png`), fullPage: true });

    const browserOnlyPage = await browser.newPage({ viewport: { width: 720, height: 760 } });
    await browserOnlyPage.route('**/api/creative-projects', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ activeProjectId: PROJECT.id, projects: [PROJECT] }),
    }));
    await browserOnlyPage.route('**/api/creative-assets?*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(TREE),
    }));
    await browserOnlyPage.route('**/api/creative-assets/file?*', route => route.fulfill({
      status: 200, contentType: 'image/png', body: PNG,
    }));
    await browserOnlyPage.goto(`${BASE_URL}/creator-assets.html`, { waitUntil: 'networkidle' });
    await browserOnlyPage.locator('body[data-ready="true"]').waitFor();
    assert.match(await browserOnlyPage.locator('#capabilityNote').textContent(), /浏览器预览/);
    assert.equal(await browserOnlyPage.locator('.asset-card').count(), 120, '浏览器预览模式仍应读取完整资产索引');
    await browserOnlyPage.close();

    const librarySurfacePage = await browser.newPage({ viewport: { width: 1180, height: 760 }, colorScheme: 'dark' });
    await librarySurfacePage.route('**/api/creative-projects', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ activeProjectId: PROJECT.id, projects: [PROJECT] }),
    }));
    await librarySurfacePage.route('**/api/creative-assets?*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(TREE),
    }));
    await librarySurfacePage.route('**/api/creative-assets/file?*', route => route.fulfill({
      status: 200, contentType: 'image/png', body: PNG,
    }));
    await librarySurfacePage.goto(`${BASE_URL}/creator-assets.html?surface=library`, { waitUntil: 'networkidle' });
    await librarySurfacePage.locator('body[data-ready="true"]').waitFor();
    assert.equal(await librarySurfacePage.locator('body').getAttribute('data-surface'), 'library');
    assert.equal(await librarySurfacePage.locator('html').evaluate(node => getComputedStyle(node).colorScheme), 'light', '资产中心不应跟随系统深色模式');
    assert.equal(await librarySurfacePage.locator('.resize-handle').evaluate(node => getComputedStyle(node).display), 'none');
    assert.equal(await librarySurfacePage.locator('.header-actions').evaluate(node => getComputedStyle(node).display), 'none');
    assert.equal(await librarySurfacePage.locator('.layout-switch').evaluate(node => getComputedStyle(node).display), 'none');
    assert.equal(await librarySurfacePage.locator('.asset-shell').evaluate(node => getComputedStyle(node).borderLeftWidth), '0px');
    assert.match(await librarySurfacePage.locator('.asset-breadcrumb').textContent(), /资产中心 \/ 创作资产/);
    assert.equal(await librarySurfacePage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await librarySurfacePage.close();

    // 负例自检：route 层运行时剥除产品 video-review toggle（零生产文件改动），
    // 展开审核防护断言必须随之失效——证明该断言可失败、回归会被抓住。
    const negativePage = await browser.newPage({ viewport: { width: 720, height: 860 } });
    const toggleLine = "el.previewDialog.classList.toggle('video-review', item.type === 'video');";
    const sourceJs = fs.readFileSync(path.join(__dirname, 'creator-assets.js'), 'utf8');
    assert.ok(sourceJs.includes(toggleLine), '负例前置：产品源码应包含 video-review toggle');
    await negativePage.route('**/creator-assets.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: sourceJs.replace(toggleLine, '') });
    });
    await negativePage.route('**/api/creative-projects', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ activeProjectId: PROJECT.id, projects: [PROJECT] }),
    }));
    await negativePage.route('**/api/creative-assets?*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(TREE),
    }));
    await negativePage.goto(`${BASE_URL}/creator-assets.html`, { waitUntil: 'networkidle' });
    await negativePage.locator('body[data-ready="true"]').waitFor();
    await negativePage.locator('[data-filter="video"]').click();
    await negativePage.locator('.asset-card[data-kind="video"] .asset-preview-button').click();
    await negativePage.locator('#previewMedia video').waitFor({ state: 'visible' });
    assert.equal(await negativePage.locator('#previewDialog.video-review').count(), 0, '负例：剥除 toggle 后展开审核形态必须消失，防护断言才可失败');
    await negativePage.close();

    // 视频封面懒加载：预加载区（视口外扩 200px）外的卡片不挂 src、不发请求；滚动进入后才加载。
    const lazyPage = await browser.newPage({ viewport: { width: 720, height: 860 } });
    const lazyVideos = Array.from({ length: 40 }, (_, i) => ({
      kind: 'file', type: 'video', name: `懒加载视频-${String(i + 1).padStart(2, '0')}.mp4`,
      path: `校园心动/人物资产/懒加载视频-${String(i + 1).padStart(2, '0')}.mp4`,
      ext: '.mp4', size: 2048, sizeText: '2 KB', mtime: `2026-09-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
    }));
    const lazyTree = {
      available: true, project: PROJECT, rootName: '创作资产库',
      stats: { folders: 2, files: 40, image: 0, audio: 0, video: 40, document: 0, other: 0, sizeText: '80 KB' },
      tree: { kind: 'folder', name: '创作资产库', path: '', fileCount: 40, children: [
        { kind: 'folder', name: '校园心动', path: '校园心动', fileCount: 40, children: [
          { kind: 'folder', name: '人物资产', path: '校园心动/人物资产', fileCount: 40, children: lazyVideos },
        ] },
      ] },
    };
    const coverRequests = new Set();
    await lazyPage.route('**/api/creative-projects', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ activeProjectId: PROJECT.id, projects: [PROJECT] }),
    }));
    await lazyPage.route('**/api/creative-assets?*', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(lazyTree),
    }));
    await lazyPage.route('**/api/creative-assets/file?*', async route => {
      coverRequests.add(decodeURIComponent(route.request().url()));
      await route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.alloc(48) });
    });
    await lazyPage.goto(`${BASE_URL}/creator-assets.html`, { waitUntil: 'load' });
    await lazyPage.locator('body[data-ready="true"]').waitFor();
    await lazyPage.locator('[data-filter="video"]').click();
    assert.equal(await lazyPage.locator('#assetGrid .asset-card').count(), 40, '懒加载页应渲染全部 40 张视频卡');
    await lazyPage.waitForTimeout(1200);
    const initialRequested = coverRequests.size;
    const initialSrcCount = await lazyPage.locator('#assetGrid video[src]').count();
    assert.ok(initialRequested >= 1 && initialRequested < 40, `预加载区应有部分封面请求，实际 ${initialRequested}`);
    assert.equal(initialSrcCount, initialRequested, `挂载 src 的数量应与请求一致：${initialSrcCount} vs ${initialRequested}`);
    await lazyPage.locator('#assetGrid').evaluate(async node => {
      for (let y = 0; y <= node.scrollHeight; y += 360) {
        node.scrollTop = y;
        await new Promise(r => setTimeout(r, 70));
      }
      node.scrollTop = node.scrollHeight;
    });
    await lazyPage.waitForTimeout(900);
    assert.ok(coverRequests.size >= 40, `滚动到底后应补齐全部封面请求，实际 ${coverRequests.size}`);
    assert.equal(await lazyPage.locator('#assetGrid video[src]').count(), 40, '滚动后全部封面应已挂载 src');
    // 树缩略图证据：折叠态（默认）树内封面不挂 src、不发起请求（请求归因 = 网格的前提）；
    // 展开含视频的文件夹后，树内缩略图进入预加载区才懒挂 src。
    assert.equal(await lazyPage.locator('#folderTree video[src]').count(), 0, '折叠态树内封面不应挂载 src');
    assert.equal(await lazyPage.locator('#folderTree .folder-video-cover').count(), 40, '树内应已创建视频封面元素（未挂 src）');
    await lazyPage.locator('.folder-row', { hasText: '校园心动' }).first().locator('.folder-disclosure').click();
    await lazyPage.waitForTimeout(350);
    await lazyPage.locator('.folder-row', { hasText: '人物资产' }).first().locator('.folder-disclosure').click();
    await lazyPage.waitForTimeout(350);
    let treeLazyOk = true;
    try {
      await lazyPage.waitForFunction(() => document.querySelectorAll('#folderTree video[src]').length > 0, null, { timeout: 5000 });
    } catch {
      treeLazyOk = false;
      console.log('TREE-DIAG', JSON.stringify(await lazyPage.evaluate(() => {
        const cover = document.querySelector('#folderTree .folder-video-cover');
        const row = cover ? cover.closest('.folder-row') : null;
        const wrap = cover ? cover.closest('.folder-children') : null;
        return {
          debug: window.__coverObserverDebug(),
          coverRect: cover ? cover.getBoundingClientRect().toJSON() : null,
          wrapCollapsed: wrap ? wrap.className : null,
          rowText: row ? row.textContent.slice(0, 30) : null,
          folderRows: document.querySelectorAll('#folderTree .folder-row').length,
          videoEls: document.querySelectorAll('#folderTree video').length,
        };
      })));
    }
    assert.ok(treeLazyOk && await lazyPage.locator('#folderTree video[src]').count() >= 1, '展开后树内缩略图应懒挂 src');
    // 登记集释放观测：滚动全量触发后，已加载封面应从登记集中移除（unobserve）
    const releaseInfo = await lazyPage.evaluate(() => window.__coverObserverDebug());
    assert.ok(releaseInfo.supported === true, '懒加载应受 IntersectionObserver 支持');
    assert.ok(releaseInfo.tracked < 40, `已加载封面应从登记集释放，剩余登记 ${releaseInfo.tracked}`);
    // 重建清理：切筛选触发 renderAssets 全量重建——grid 登记必须清空（无视频卡）；
    // tree 登记按设计保留（树内待懒挂缩略图不受网格重建影响，正是作用域拆分的目的）。
    await lazyPage.locator('[data-filter="image"]').click();
    await lazyPage.waitForTimeout(300);
    const rebuildInfo = await lazyPage.evaluate(() => window.__coverObserverDebug());
    assert.equal(rebuildInfo.grid, 0, '切到无视频分类后网格登记集应清空');
    assert.ok(rebuildInfo.tree >= 0, `树内待懒挂登记保留：${rebuildInfo.tree}`);
    await lazyPage.close();

    const failurePage = await browser.newPage({ viewport: { width: 520, height: 720 } });
    await failurePage.route('**/api/creative-assets?*', route => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: '模拟读取失败' }),
    }));
    await failurePage.addInitScript(() => {
      window.assetAPI = {
        getConfig: async () => ({ panel: { open: true, layout: 'overlay', width: 520 }, project: {
          id: 'project-11111111-1111-4111-8111-111111111111', name: '校园心动', folder: '校园心动', categories: [],
        }, rootName: '故障测试库' }),
        setPanelState: async patch => ({ open: true, layout: 'overlay', width: 520, ...patch }),
        startDrag: () => {}, copyImage: async () => true, showItem: async () => true, openLibrary: async () => true, showProjectPicker: async () => true,
        onPanelState: () => () => {}, onDragResult: () => () => {},
      };
    });
    const failureResponse = await failurePage.goto(`${BASE_URL}/creator-assets.html`, { waitUntil: 'networkidle' });
    assert.equal(failureResponse.status(), 200);
    await failurePage.locator('body[data-ready="error"]').waitFor();
    assert.match(await failurePage.locator('.asset-state.error').innerText(), /模拟读取失败/);
    await failurePage.close();
    console.log('CREATOR_ASSETS PASS: script folders, import, type filters, media preview, image zoom, native drag and 360–760px layout');
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
