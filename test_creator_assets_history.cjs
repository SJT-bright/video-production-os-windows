'use strict';

// 纯展示分组验收：使用一次性本地静态服务器、合成目录与独立浏览器上下文。
// 不连接运行 App，不读写正式项目素材；所有修改请求均在 fixture bridge 截获。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { launchChromium } = require('./test-playwright.cjs');

const PREFIX = 'videoOS-history://';
const PROJECT_FOLDER = '隔离分集剧本';
const PROJECT = {
  id: 'project-11111111-1111-4111-8111-111111111111', name: PROJECT_FOLDER, folder: PROJECT_FOLDER, kind: 'script',
  categories: [
    { id: 'characters', label: '人物资产', path: `${PROJECT_FOLDER}/人物资产` },
    { id: 'generated-images', label: '生成图片', path: `${PROJECT_FOLDER}/生成图片` },
    { id: 'generated-videos', label: '生成视频', path: `${PROJECT_FOLDER}/生成视频` },
    { id: 'audio', label: '音色素材（已改名）', path: `${PROJECT_FOLDER}/音色素材（已改名）` },
    { id: 'browser-downloads', label: '浏览器下载', path: `${PROJECT_FOLDER}/浏览器下载` },
  ],
};
const IMAGE_SITE = `${PROJECT_FOLDER}/生成图片/GPT`;
const VIDEO_SITE = `${PROJECT_FOLDER}/生成视频/核绘`;
const LEGACY_EDITABLE = `${PROJECT_FOLDER}/生成视频/可剪辑/核绘`;
const LEGACY_PROCESSING = `${PROJECT_FOLDER}/生成视频/待处理/核绘`;
const AUDIO_SITE = `${PROJECT_FOLDER}/音色素材（已改名）/音色平台`;
const BATCH = {
  projectId: PROJECT.id,
  states: [
    { kind: 'image', platformFolder: 'GPT', platformPath: IMAGE_SITE, episode: 1 },
    { kind: 'video', platformFolder: '核绘', platformPath: VIDEO_SITE, episode: 2 },
    { kind: 'audio', platformFolder: '音色平台', platformPath: AUDIO_SITE, episode: 1 },
    null, // malformed/unknown entries must not weaken the whitelist or crash the view
    { kind: 'other', platformFolder: '用户网站', platformPath: `${PROJECT_FOLDER}/生成图片/用户网站` },
    { kind: 'image', platformFolder: '../用户网站', platformPath: `${PROJECT_FOLDER}/生成图片/../用户网站` },
    { kind: 'image', platformFolder: '假网站', platformPath: `${PROJECT_FOLDER}/人物资产/假网站` },
    { kind: 'image', platformFolder: '用户网站', platformPath: `${PROJECT_FOLDER}/生成图片/用户网站`, available: false },
    { kind: 'image', platformFolder: '用户网站', platformPath: `${PROJECT_FOLDER}/生成图片/用户网站`, projectId: '另一个剧本' },
  ].map(entry => entry && ({ projectId: PROJECT.id, available: true, ...entry })),
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const HISTORY_IMAGES = Array.from({ length: 133 }, (_, index) => {
  const date = index < 67 ? '2026-10-07' : '2026-10-08';
  return `${IMAGE_SITE}/${date}/历史图片-${String(index + 1).padStart(3, '0')}.png`;
});
const NESTED_HISTORY = `${IMAGE_SITE}/2026-10-07/原有子目录/嵌套历史图片.png`;
const HISTORY_VIDEO = `${IMAGE_SITE}/2026-10-08/原有视频.mp4`;
const HISTORY_DOCUMENT = `${IMAGE_SITE}/2026-10-08/原有说明.txt`;
const NORMAL_DATES = [
  `${PROJECT_FOLDER}/人物资产/2026-10-08`,
  `${PROJECT_FOLDER}/生成图片/用户网站/2026-10-08`,
  `${IMAGE_SITE}/用户自定义/2026-10-08`,
  `${IMAGE_SITE}/2026-02-31`,
  `${PROJECT_FOLDER}/浏览器下载/GPT/2026-10-08`,
];
const MANIFEST = [
  ...HISTORY_IMAGES, NESTED_HISTORY, HISTORY_VIDEO, HISTORY_DOCUMENT,
  `${VIDEO_SITE}/2026-10-08/历史视频.mp4`, `${LEGACY_EDITABLE}/2026-10-07/旧可剪辑.mp4`,
  `${LEGACY_PROCESSING}/2026-10-07/旧待处理.mp4`, `${AUDIO_SITE}/2026-10-08/旧音色.wav`,
  ...NORMAL_DATES.map(folder => `${folder}/普通日期素材.png`),
  `${VIDEO_SITE}/第10集/第10集素材.mp4`, `${VIDEO_SITE}/第1集/第1集素材.mp4`, `${VIDEO_SITE}/第2集/第2集素材.mp4`,
  // 与历史搜索目标同名，证明虚拟入口搜索不会泄漏普通文件夹结果。
  `${PROJECT_FOLDER}/人物资产/${path.basename(HISTORY_IMAGES[0])}`,
];

function fixtureTree(paths = MANIFEST) {
  const root = { kind: 'folder', name: '创作资产库', path: '', children: [], fileCount: 0 };
  paths.forEach((relativePath, index) => {
    const parts = relativePath.split('/');
    let current = root;
    for (const name of parts.slice(0, -1)) {
      const folderPath = current.path ? `${current.path}/${name}` : name;
      let folder = current.children.find(item => item.kind === 'folder' && item.path === folderPath);
      if (!folder) { folder = { kind: 'folder', name, path: folderPath, children: [], fileCount: 0 }; current.children.push(folder); }
      current = folder;
    }
    const ext = path.extname(relativePath);
    const type = ext === '.mp4' ? 'video' : ext === '.wav' ? 'audio' : ext === '.txt' ? 'document' : 'image';
    current.children.push({ kind: 'file', type, ext, path: relativePath, name: parts.at(-1), size: 1024, sizeText: '1 KB',
      mtime: new Date(Date.UTC(2026, 9, 11, 0, 0, index)).toISOString() });
  });
  const count = folder => (folder.fileCount = folder.children.reduce((sum, item) => sum + (item.kind === 'file' ? 1 : count(item)), 0));
  count(root);
  return { available: true, rootName: '创作资产库', project: PROJECT, stats: { files: root.fileCount, sizeText: 'fixture' }, tree: root };
}

async function staticServer() {
  const root = path.resolve(__dirname);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch { response.writeHead(400).end(); return; }
    const absolute = path.resolve(root, `.${pathname}`);
    if (!absolute.startsWith(root + path.sep) || request.method !== 'GET'
      || !(pathname.startsWith('/assets/ui/') || ['/creator-assets.html', '/creator-assets.js', '/creator-assets.css'].includes(pathname))) {
      response.writeHead(404).end(); return;
    }
    fs.readFile(absolute, (error, body) => {
      if (error) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(absolute)] || 'application/octet-stream' }); response.end(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function run() {
  const { server, url } = await staticServer();
  const browser = await launchChromium();
  const pageErrors = [], writes = [];
  const fixture = fixtureTree();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.route('**/api/**', async route => {
      const request = route.request(), requestUrl = new URL(request.url());
      if (request.method() === 'POST') {
        writes.push({ pathname: requestUrl.pathname, body: request.postDataJSON() });
        const body = request.postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, oldPath: body.path,
          path: `${body.folder}/${path.basename(body.path || 'fixture.png')}`, name: path.basename(body.path || 'fixture.png') }) });
      } else if (requestUrl.pathname === '/api/creative-assets') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
      } else if (requestUrl.pathname === '/api/creative-assets/file') {
        await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
      }
    });
    await page.addInitScript(({ project, batch, site }) => {
      window.EventSource = class { addEventListener() {} close() {} };
      window.confirm = () => true;
      window.__historyTest = { menus: [], drags: [], deleted: [], episodes: [] };
      window.__mockConfig = { project, downloadEpisodes: batch, rootName: project.name, creativeAssetAvailable: true,
        panel: { open: true, layout: 'push', width: 720 } };
      localStorage.setItem(`videoOS.assetFolderOrder.v1.${project.id}`, JSON.stringify({ [site]: [`${site}/第10集`, `${site}/第2集`, `${site}/第1集`] }));
      window.assetAPI = {
        getConfig: async () => window.__mockConfig,
        setPanelState: async patch => ({ ...window.__mockConfig.panel, ...patch }),
        startDrag: realPath => { window.__historyTest.drags.push(realPath); },
        showFolderMenu: async payload => { window.__historyTest.menus.push(payload); return null; },
        deleteItem: async realPath => { window.__historyTest.deleted.push(realPath); return true; },
        copyImage: async () => true, showItem: async () => true, openLibrary: async () => true,
        onPanelState: () => () => {}, onDragResult: () => () => {},
        onDownloadEpisodesChanged: callback => { window.__historyTest.episodes.push(callback); return () => {}; },
      };
    }, { project: PROJECT, batch: BATCH, site: VIDEO_SITE });
    await page.goto(`${url}/creator-assets.html?surface=library`, { waitUntil: 'networkidle' });
    await page.locator('body[data-ready="true"]').waitFor();

    const snapshot = await page.evaluate(() => ({ history: [...state.historyFolders.keys()],
      tree: state.tree, paths: state.assets.map(item => item.path).sort(), folders: state.folders.map(item => item.node.path) }));
    assert.equal(snapshot.history.length, 5, '仅当前项目的明确网站和旧状态布局应出现历史入口');
    assert.deepEqual(snapshot.tree, fixture.tree, '展示收拢不得改动原始目录树');
    assert.deepEqual(snapshot.paths, [...MANIFEST].sort(), '素材真实 path 不得被虚拟路径替代');
    NORMAL_DATES.forEach(folder => assert.ok(snapshot.folders.includes(folder), `普通/未知/无效日期目录应保留：${folder}`));
    const imageHistory = PREFIX + encodeURIComponent(IMAGE_SITE);
    const historyRow = page.locator('.folder-row').filter({ has: page.locator(`.folder-button[data-folder-path="${imageHistory}"]`) });
    assert.equal(await historyRow.locator('.folder-disclosure').getAttribute('aria-expanded'), 'false', '历史素材默认收起');
    assert.equal(await historyRow.locator('.folder-order-grip').count(), 0);
    assert.equal(await historyRow.locator('.folder-count').innerText(), '136');
    await historyRow.dispatchEvent('contextmenu', { clientX: 40, clientY: 40 });
    assert.equal(await page.evaluate(() => window.__historyTest.menus.length), 0, '虚拟节点不能调用原生重命名/删除菜单');
    for (const number of [1, 2, 10]) {
      assert.equal(await page.locator(`.folder-row[data-folder-path="${VIDEO_SITE}/第${number}集"] .folder-order-grip`).count(), 0, '第N集不得手工打乱数字顺序');
    }
    const episodeOrder = await page.evaluate(site => [...document.querySelectorAll('.folder-row')]
      .filter(row => row.dataset.folderPath.startsWith(site + '/') && /^第\d+集$/.test(row.dataset.folderName)).map(row => row.dataset.folderName), VIDEO_SITE);
    assert.deepEqual(episodeOrder, ['第1集', '第2集', '第10集']);

    await page.evaluate(key => selectFolder(key), imageHistory);
    assert.equal(await page.locator('#currentPath').innerText(), '未分集历史素材');
    assert.equal(await page.locator('#assetCount').innerText(), '136 项');
    assert.equal(await page.locator('.asset-card').count(), 120, '聚合列表首批120条');
    assert.ok(!(await page.locator('.asset-card').evaluateAll(cards => cards.map(card => card.dataset.path))).includes(HISTORY_IMAGES[0]), '搜索测试目标须在未渲染批次');
    await page.locator('.load-more').click();
    assert.equal(await page.locator('.asset-card').count(), 136, '显示更多必须覆盖全部历史，不能限于30条');
    for (const id of ['importAssets', 'newSubfolder', 'normalizeNames']) assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id}应禁用`);

    await page.evaluate(({ key, site }) => {
      state.collapsedFolders.delete(key);
      site.split('/').forEach((_, index, parts) => state.collapsedFolders.delete(parts.slice(0, index + 1).join('/')));
      renderFolders();
    }, { key: imageHistory, site: IMAGE_SITE });
    const childFiles = historyRow.locator('xpath=following-sibling::div[1]').locator(':scope > .folder-children-inner');
    assert.equal(await childFiles.locator(':scope > .folder-file').count(), 60, '树内聚合文件仍分批渲染');
    await childFiles.getByText('显示更多文件', { exact: true }).click();
    assert.equal(await childFiles.locator(':scope > .folder-file').count(), 120);
    await childFiles.getByText('显示更多文件', { exact: true }).click();
    assert.equal(await childFiles.locator(':scope > .folder-file').count(), 136);

    await page.locator('#assetSearch').fill(path.basename(HISTORY_IMAGES[0]));
    await page.waitForFunction(() => document.querySelector('#assetCount').textContent === '1 项');
    assert.equal(await page.locator('.asset-card').getAttribute('data-path'), HISTORY_IMAGES[0], '筛选使用全量历史且不混入其他目录同名文件');
    await page.locator('#clearSearch').click();
    await page.locator('[data-filter="video"]').click();
    assert.equal(await page.locator('#assetCount').innerText(), '1 项');
    assert.equal(await page.locator('.asset-card').getAttribute('data-path'), HISTORY_VIDEO);
    await page.locator('[data-filter="all"]').click();

    const rejected = await page.evaluate(async key => {
      startLibraryFolderCreate(key); openFolderDialog({ parent: key });
      state.folderParent = key; el.folderName.value = '不应创建'; await createFolder();
      await importFiles([new File(['fixture'], '不应导入.png', { type: 'image/png' })]); await normalizeNames();
      let blocked = false;
      try { await postAssetAction('rename', { path: key, name: '不应改名' }); } catch { blocked = true; }
      const data = new DataTransfer(); data.items.add(new File(['fixture'], '不应拖入.png', { type: 'image/png' }));
      libraryPaneEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      const dropEffect = data.dropEffect;
      libraryPaneEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      return { blocked, dropEffect, dialogOpen: el.folderDialog.open, highlighted: libraryPaneEl.classList.contains('is-drop-import') };
    }, imageHistory);
    assert.deepEqual(rejected, { blocked: true, dropEffect: 'none', dialogOpen: false, highlighted: false });
    assert.equal(writes.length, 0, '所有虚拟文件夹写入口必须在请求发送前拦截');

    await page.evaluate(key => { saveAssetView(); localStorage.setItem('__savedHistory', key); }, imageHistory);
    await page.reload({ waitUntil: 'networkidle' }); await page.locator('body[data-ready="true"]').waitFor();
    assert.equal(await page.evaluate(() => state.selectedFolder), imageHistory, '刷新应保持历史范围，不落到整库');
    await page.evaluate(async realPath => {
      await focusExternalAsset({ path: realPath, projectId: state.config.project.id });
    }, NESTED_HISTORY);
    assert.equal(await page.evaluate(() => state.selectedFolder), imageHistory);
    assert.match(await page.locator('#previewPath').innerText(), /2026-10-07\/原有子目录/, '预览保留原始磁盘位置');
    await page.locator('#closePreview').click(); await page.waitForFunction(() => !el.previewDialog.open);
    await page.locator('.asset-card').filter({ has: page.locator(`[data-check-path="${NESTED_HISTORY}"]`) }).dispatchEvent('dragstart');
    assert.deepEqual(await page.evaluate(() => window.__historyTest.drags), [NESTED_HISTORY], '拖出发送真实文件路径');
    await page.evaluate(realPath => openMoveDialog([realPath]), NESTED_HISTORY);
    assert.equal(await page.locator(`.move-folder-row[data-folder-path^="${PREFIX}"]`).count(), 0, '虚拟入口不进入目标目录选择');
    await page.evaluate(key => submitMove(key), imageHistory);
    assert.equal(writes.length, 0, '人为调用虚拟目标也不能发送移动请求');
    await page.evaluate(folder => submitMove(folder), `${VIDEO_SITE}/第2集`);
    assert.deepEqual(writes[0], { pathname: '/api/creative-assets/move', body: { path: NESTED_HISTORY, folder: `${VIDEO_SITE}/第2集` } });
    await page.waitForFunction(() => !el.moveDialog.open);

    await page.evaluate(key => selectFolder(key), imageHistory);
    await page.evaluate(async realPath => { await deleteItem(state.assets.find(item => item.path === realPath)); }, HISTORY_IMAGES[0]);
    assert.deepEqual(await page.evaluate(() => window.__historyTest.deleted), [HISTORY_IMAGES[0]], '真实历史文件仍可以删除，且路径不变');
    assert.ok(writes.every(request => !JSON.stringify(request.body).includes(PREFIX)), '任何真实写请求都不能夹带虚拟URI');

    const metadataGuards = await page.evaluate(batch => {
      const original = state.config.downloadEpisodes;
      const counts = [];
      state.config.downloadEpisodes = undefined; collectTree(state.tree); counts.push(state.historyFolders.size);
      state.config.downloadEpisodes = { ...batch, projectId: '另一个剧本' }; collectTree(state.tree); counts.push(state.historyFolders.size);
      const rawDates = state.folders.some(item => item.node.path === `${state.config.project.folder}/生成图片/GPT/2026-10-07`);
      state.config.downloadEpisodes = { ...batch, states: [{ ...batch.states[0], platformFolder: '人物资产', platformPath: `${state.config.project.folder}/人物资产` }] };
      collectTree(state.tree); counts.push(state.historyFolders.size);
      state.config.downloadEpisodes = { ...batch, states: batch.states.filter(Boolean).map(entry => ({ ...entry, available: false })) };
      collectTree(state.tree); counts.push(state.historyFolders.size);
      state.config.downloadEpisodes = { ...batch, states: batch.states.filter(Boolean).map(entry => ({ ...entry, projectId: '另一个剧本' })) };
      collectTree(state.tree); counts.push(state.historyFolders.size);
      state.config.downloadEpisodes = original; collectTree(state.tree); renderFolders(); renderAssets();
      return { counts, rawDates };
    }, BATCH);
    assert.deepEqual(metadataGuards, { counts: [0, 0, 0, 0, 0], rawDates: true }, '无元数据/跨剧本/路径不匹配/停用/单项跨剧本必须保留原树');
    await page.evaluate(() => window.__historyTest.episodes.forEach(callback => callback({ projectId: '另一个剧本', states: [] })));
    assert.equal(await page.evaluate(() => state.historyFolders.size), 5, '外来项目事件不影响当前历史入口');
    await page.evaluate(() => { window.__mockConfig.downloadEpisodes = { projectId: state.config.project.id, states: [] };
      window.__historyTest.episodes.forEach(callback => callback(window.__mockConfig.downloadEpisodes)); });
    assert.equal(await page.evaluate(() => state.historyFolders.size), 0, '当前项目映射改变时历史入口即时刷新');
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));

    const receipt = { ok: true, scope: 'isolated-synthetic-browser', realAppTouched: false, projectId: PROJECT.id,
      historyEntries: snapshot.history.length, fixtureAssets: MANIFEST.length, aggregatedAssets: 136, gridBatch: 120, treeBatch: 60,
      fullPagination: true, originalTreeUnchanged: true, originalPathsUnchanged: true, virtualWritesBlocked: true,
      ordinaryDatesPreserved: NORMAL_DATES.length, moveRequest: writes[0], deleteRequestPath: HISTORY_IMAGES[0], pageErrors,
      creatorAssetsSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'creator-assets.js'))).digest('hex') };
    if (process.env.ASSET_HISTORY_EVIDENCE) fs.writeFileSync(path.resolve(process.env.ASSET_HISTORY_EVIDENCE), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
