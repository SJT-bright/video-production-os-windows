'use strict';

// 原生手势验收：启动隔离窗口，再通过系统鼠标将左侧两个素材拖到本地测试页。
// 只有目标网页读取到与原文件一致的字节才通过，不调用 startDrag 的替身。
// 显式 --manual 才启动并等待手势；默认只说明用途，不冒充自动回归。
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { _electron: electron } = require('playwright');

async function isolatedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function run() {
  if (!process.argv.includes('--manual')) {
    console.log('NATIVE_DRAG_MANUAL_ONLY: node test_quick_asset_drag.cjs --manual。此脚本需要隔离窗口中的真实系统鼠标拖动；未启动 App、未执行拖动，也不是自动测试通过。');
    return;
  }
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-native-drag-'));
  const project = path.join(testRoot, 'project');
  const assets = path.join(project, '创作资产库', '测试剧本', '人物资产');
  fs.mkdirSync(assets, { recursive: true });
  for (const name of ['data', 'user-data', 'obsidian']) fs.mkdirSync(path.join(testRoot, name));
  const imagePath = path.join(assets, 'drag-image.png');
  const videoPath = path.join(assets, 'drag-video.mp4');
  fs.copyFileSync(path.join(__dirname, 'assets/app-icon.iconset/icon_128x128.png'), imagePath);
  fs.writeFileSync(videoPath, Buffer.from('AAAAHGZ0eXBpc29tAAACAGlzb21pc28y', 'base64'));
  const expected = [imagePath, videoPath].map(file => ({ name: path.basename(file), size: fs.statSync(file).size, hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  let app;
  try {
    const port = await isolatedPort();
    const env = {
      ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_PORT: String(port),
      VIDEO_OS_USER_DATA: path.join(testRoot, 'user-data'), VIDEO_OS_DATA_DIR: path.join(testRoot, 'data'),
      VIDEO_OS_PROJECT_ROOT: project, VIDEO_OS_TEST_PROJECT_ROOT: project,
      VIDEO_OS_TEST_OBSIDIAN_VAULT: path.join(testRoot, 'obsidian'), OBSIDIAN_VAULT_PATH: path.join(testRoot, 'obsidian'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: require('electron'), args: [__dirname], timeout: 20000,
      env,
    });
    const creator = await app.firstWindow();
    await creator.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(new URL(creator.url()).origin, `http://localhost:${port}`, '测试必须连接自己启动的随机端口');
    const identity = await app.evaluate(({ app }) => ({ pid: process.pid, userData: app.getPath('userData') }));
    assert.equal(identity.pid, app.process().pid, '必须绑定本次启动的准确 Electron PID');
    assert.equal(fs.realpathSync(identity.userData), fs.realpathSync(path.join(testRoot, 'user-data')), '必须使用隔离登录与工作台状态');
    const config = await creator.evaluate(() => window.creatorAPI.getConfig());
    assert.equal(config.testMode, true);
    assert.equal(fs.realpathSync(config.paths.creativeAssetLibraryRoot), fs.realpathSync(path.join(project, '创作资产库')), '原生素材源必须是本次临时项目');
    if (!await creator.locator('#assetAccordion').evaluate(node => node.open)) await creator.locator('#assetAccordion > summary').click();
    for (const folder of ['测试剧本', '测试剧本/人物资产']) {
      const disclosure = creator.locator(`.quick-folder-row[data-folder-path="${folder}"] > .quick-folder-chevron-wrap`);
      if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
    }
    for (const file of expected) {
      await creator.locator(`[data-asset-path="测试剧本/人物资产/${file.name}"] .asset-image-card`).waitFor({ state: 'visible' });
    }
    await creator.evaluate(() => {
      window.__dragDebug = [];
      for (const type of ['mousedown', 'mouseup', 'dragstart', 'dragend']) {
        document.addEventListener(type, event => window.__dragDebug.push({ type, target: event.target.tagName, x: event.clientX, y: event.clientY }), true);
      }
      window.creatorAPI.onAssetDragResult(result => window.__dragDebug.push({ result }));
    });
    console.log(`NATIVE_DRAG_READY: 仅操作本次隔离 Electron PID=${identity.pid}、端口=${port}、profile=${identity.userData}。将其左侧 drag-image.png 和 drag-video.mp4 拖到右侧本地虚线框；不得操作正式 App。`);
    const deadline = Date.now() + 600000;
    let received = [];
    let lastDebugCount = 0;
    while (Date.now() < deadline) {
      received = await app.evaluate(async ({ webContents }) => {
        const target = webContents.getAllWebContents().find(contents => contents.getURL().includes('/creator-fixture.html?service=gpt'));
        return target ? target.executeJavaScript('window.fixtureDroppedFiles || []').catch(() => []) : [];
      });
      const debug = await creator.evaluate(() => window.__dragDebug);
      if (debug.length !== lastDebugCount) { console.log('DRAG_EVENTS', JSON.stringify(debug.slice(lastDebugCount))); lastDebugCount = debug.length; }
      if (expected.every(file => received.some(item => item.name === file.name))) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    for (const file of expected) {
      const actual = received.find(item => item.name === file.name);
      assert.ok(actual, `目标网页没有收到 ${file.name}`);
      assert.equal(actual.size, file.size);
      assert.equal(actual.hash, file.hash, '拖入网页的必须是原文件字节，不是预览图或网址');
    }
    console.log(`NATIVE_QUICK_ASSET_DRAG_PASS ${JSON.stringify(received)}`);
  } finally {
    if (app) await app.close();
    fs.rmSync(testRoot, { recursive: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
