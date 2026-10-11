#!/usr/bin/env node
'use strict';

// 单视频置顶浮窗定向测试（FV-BE-20260928）。
// 覆盖：
//  1. creatorAPI.floatVideoAsset(rel) → invoke 'creator:float-video' → 单窗 BrowserWindow、floating 置顶、可见；
//  2. 权限与类型门禁：音频/图片/穿越路径/绝对路径/不存在文件/空路径一律拒绝，且不影响已开的浮窗；
//  3. 一次只保留一个窗：换文件先关旧（旧文件收到 creator:float-video-closed reason='replaced'）再开新；
//     同文件重复请求只置前（同一 BrowserWindow 实例、reused:true、不产生关闭通知）；
//  4. 浮窗 DOM：首帧预览 src、完整文件名、可拖拽卡 draggable、右上角唯一 ×（页面上只有一个 button）；
//  5. 原生拖出调用链：卡片 dragstart → preload → 'float:start-asset-drag' → 主进程校验
//     → event.sender.startDrag() 未抛异常 → 'float:drag-result' {ok:true,count:1}；拖非当前置顶视频 → {ok:false}；
//     成功后隐藏但保留原生拖拽源、通知左栏一次；再次浮出复用，隐藏窗不可重复发起拖拽；
//  6. 剧本切换：切走后旧剧本视频重读信息被拒且窗口自动关闭（reason='stale'）；新剧本自己的视频可正常浮出；
//     再切回原剧本时，浮在窗上的那个视频同样拖不出（{ok:false,'不属于当前剧本'}）；
//  7. × 关闭：窗口销毁 + creator 收到 {path, reason:'user'}；系统关闭（win.close）也通知（reason='closed'）；
//  8. 标题栏兜底拖动与位置记忆落盘；素材目录集合只增测试自己写入的夹具，无复制、无删除。
//
// 【证据边界】第 5 项只证明「渲染层 dragstart → IPC → 主进程校验 → event.sender.startDrag() 调用链成功」
// （float:drag-result 的 ok:true 仅在 startDrag() 同步未抛异常后回发）；不证明 OS 拖拽会话真的弹出，
// 更不证明剪映收到素材 —— 端到端投递只能由人工在真实桌面 + 剪映里验收。
// alwaysOnTop()===true 只证明窗口处于置顶状态；macOS setVisibleOnAllWorkspaces 的跨 Space/全屏覆盖、
// Windows 虚拟桌面下的实际表现需人工确认，本测试只断言调用未抛异常、窗口可见。
// 合成派发的 dragstart 一定能到达处理器；真实鼠标手势是否发起取决于 draggable 属性
// （本测试同时断言该属性恒为 'true'），手势本身由人工与 test_quick_asset_drag.cjs 覆盖。
// 未经真实 requireTrusted 反向验证的项（伪造 sender）在本环境无法构造，见交付报告未验证清单。
//
// 媒体夹具优先用本机 ffmpeg 生成极小 H.264 MP4 / 正弦 WAV，失败退回纯 Node 容器结构，
// 避免假字节被真实解码器拒绝造成偶发失败。

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { _electron: electron } = require('playwright');

const runRoot = path.join(__dirname, 'test-artifacts', `float-video-${process.pid}-${Date.now()}`);
const projectRoot = path.join(runRoot, 'project');
const assetRoot = path.join(projectRoot, '创作资产库');
// 端口按进程号偏移，避免与并行运行的其他定向测试或残留实例相撞：
// 一旦相撞，startServer 会静默退到备用端口，而测试里的 HTTP 断言会打到别人的实例上，得到假失败。
const PORT = Number(process.env.FLOAT_VIDEO_TEST_PORT || 3860 + (process.pid % 120));
const FFMPEG_PATH = '/opt/homebrew/bin/ffmpeg';

function post(port, route, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(route, `http://127.0.0.1:${port}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || 'null')); } catch (error) { reject(error); } });
    });
    req.once('error', reject);
    req.end(data);
  });
}

function getJson(port, route) {
  return new Promise((resolve, reject) => {
    http.get(new URL(route, `http://127.0.0.1:${port}`), res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || 'null')); } catch (error) { reject(error); } });
    }).once('error', reject);
  });
}

function box(type, size = 16) {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32BE(size);
  buffer.write(type, 4);
  return buffer;
}

function nodeWavBytes(samples = 3600) {
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 12000), 44 + i * 2);
  }
  return buffer;
}

const nodeMp4Bytes = Buffer.concat([box('ftyp'), box('mdat'), box('moov')]);
const isMp4Bytes = bytes => bytes.length > 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
const isWavBytes = bytes => bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF';

function ffmpegBytes(args, outFile, verify) {
  try { fs.accessSync(FFMPEG_PATH, fs.constants.X_OK); } catch { return null; }
  try {
    const { status } = spawnSync(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y', ...args, outFile], { timeout: 30000 });
    const bytes = status === 0 && fs.existsSync(outFile) ? fs.readFileSync(outFile) : null;
    return bytes && verify(bytes) ? bytes : null;
  } catch { return null; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(absolute, rel));
    else if (entry.isFile()) out.push(`${rel}:${fs.statSync(absolute).size}`);
  }
  return out;
}

async function run() {
  let app = null;
  // 硬超时看门狗：playwright 的 page.evaluate 没有默认超时，Electron 在本机偶发启动/上下文异常时
  // 整批会静默挂住（2026-09-28 实测出现过），必须让它失败退出而不是拖死回归。
  setTimeout(() => {
    console.error('FLOAT_VIDEO_WATCHDOG 超过 300s 未结束，判定失败（看最后一条 FLOAT_VIDEO_ASSERT 定位卡点）');
    try { app?.process()?.kill('SIGKILL'); } catch {}
    process.exit(1);
  }, 300000).unref();
  fs.mkdirSync(path.join(assetRoot, '测试剧本'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'user-data'), { recursive: true });
  const fixturesDir = path.join(runRoot, 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });
  const ffmpegMp4 = ffmpegBytes(
    ['-f', 'lavfi', '-i', 'color=c=#1d4ed8:s=96x54:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    path.join(fixturesDir, 'template.mp4'), isMp4Bytes);
  const ffmpegWav = ffmpegBytes(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3'],
    path.join(fixturesDir, 'template.wav'), isWavBytes);
  const mp4Bytes = ffmpegMp4 || nodeMp4Bytes;
  const wavBytes = ffmpegWav || nodeWavBytes();
  console.log(`FLOAT_VIDEO_FIXTURES mp4=${ffmpegMp4 ? 'ffmpeg' : 'node-fallback'} wav=${ffmpegWav ? 'ffmpeg' : 'node-fallback'} port=${PORT}`);

  const videoA = '测试剧本/生成视频-029.mp4';
  const videoB = '测试剧本/测试片段甲.mp4';
  const write = (rel, bytes) => fs.writeFileSync(path.join(assetRoot, ...rel.split('/')), bytes);
  write(videoA, mp4Bytes);
  write(videoB, mp4Bytes);
  write('测试剧本/测试配音.wav', wavBytes);
  write('测试剧本/生成视频-029.prompt.txt', '生成来源｜测试');
  write('测试剧本/测试角色.png', Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const beforeTree = walk(assetRoot);

  app = await electron.launch({
    args: [__dirname], timeout: 60000,
    env: {
      ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_PORT: String(PORT),
      VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: path.join(runRoot, 'data'), VIDEO_OS_USER_DATA: path.join(runRoot, 'user-data'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
  const results = new Proxy({}, {
    // 每条断言落定就打印一行：playwright 的 page.evaluate 没有默认超时，
    // Electron 环境异常时整批会静默挂住（本机 2026-09-28 出现过），有进度行才能立刻看出停在哪一步。
    set(target, key, value) {
      target[key] = value;
      console.log(`FLOAT_VIDEO_ASSERT ${String(key)}=${JSON.stringify(value)}`);
      return true;
    },
  });
  let failed = false;
  let window = null;
  let lastClosedEvents = [];

  const findFloat = () => app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('float-video.html'));
    const win = wins[wins.length - 1] || null;
    if (!win) return { count: wins.length };
    return {
      count: wins.length, id: win.id, alwaysOnTop: win.isAlwaysOnTop(), visible: win.isVisible(),
      visibleOnAllWorkspaces: typeof win.isVisibleOnAllWorkspaces === 'function' ? win.isVisibleOnAllWorkspaces() : null,
      // Electron 43 只暴露 isAlwaysOnTop()，没有 getAlwaysOnTopLevel()。
      level: typeof win.getAlwaysOnTopLevel === 'function' ? win.getAlwaysOnTopLevel() : null,
      bounds: win.getBounds(), title: win.getTitle(),
    };
  });
  const waitFloat = async want => {
    for (let i = 0; i < 80; i++) {
      const found = await findFloat();
      const ready = want === 'gone'
        ? found.count === 0
        : want === 'shown'
          ? found.count === 1 && found.visible === true && found.alwaysOnTop === true
          : want === 'hidden'
            ? found.count === 1 && found.visible === false
          : found.count === 1;
      if (ready) return found;
      await sleep(100);
    }
    return findFloat();
  };
  // 窗口先存在（loadURL 已发起）再在 ready-to-show 里 showInactive，可见性是浮窗的本职，单独轮询。
  const waitFloatVisible = async () => {
    for (let i = 0; i < 80; i++) {
      const found = await findFloat();
      if (found.count === 1 && found.visible === true) return found;
      await sleep(100);
    }
    return findFloat();
  };
  const readFloatDom = () => app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()
      && !w.webContents.isDestroyed() && w.webContents.getURL().includes('float-video.html'));
    const win = wins[wins.length - 1];
    if (!win) return { gone: true };
    // 换视频时旧 renderer 可能在 executeJavaScript 期间销毁；主进程侧设限，允许下一轮读取新窗。
    return Promise.race([win.webContents.executeJavaScript(`({
      ready: document.body.dataset.ready || '',
      floatPath: document.body.dataset.floatPath || '',
      name: document.getElementById('fvName')?.textContent || '',
      project: document.getElementById('fvProject')?.textContent || '',
      cardPath: document.getElementById('fvCard')?.dataset.path || '',
      draggable: document.getElementById('fvCard')?.getAttribute('draggable'),
      previewSrc: document.getElementById('fvPreview')?.getAttribute('src') || '',
      previewMuted: document.getElementById('fvPreview')?.muted,
      videoCount: document.querySelectorAll('video').length,
      buttons: document.querySelectorAll('button').length,
      closeButtons: document.querySelectorAll('.fv-close').length,
      hasClose: Boolean(document.getElementById('fvClose')),
      tip: document.querySelector('.fv-tip')?.textContent || '',
    })`).catch(() => ({ retry: true })),
    new Promise(resolve => setTimeout(() => resolve({ retry: true }), 1200))]);
  });
  const waitFloatDom = async check => {
    for (let i = 0; i < 80; i++) {
      const dom = await readFloatDom();
      if (!dom.gone && check(dom)) return dom;
      await sleep(100);
    }
    return readFloatDom();
  };
  // 在浮窗里发起一次拖拽并等主进程回执；回执到达时立即 resolve。
  // 失败回执会让页面重新读取信息并关掉过期浮窗，轮询可能在关闭前来不及运行。
  const dragProbe = trigger => app.evaluate(({ BrowserWindow }, source) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('float-video.html'));
    if (!win) return { ok: false, error: 'no-float-window' };
    return win.webContents.executeJavaScript(`new Promise(resolve => {
      let done = false;
      const finish = item => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(item);
      };
      const unsubscribe = window.floatVideoAPI.onDragResult(finish);
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout-no-result' }), 6000);
      ${source}
    })`);
  }, trigger);
  const dragCard = () => dragProbe(`document.getElementById('fvCard').dispatchEvent(new DragEvent('dragstart', {
    bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));`);
  const floatAsset = relativePath => window.evaluate(target => window.creatorAPI.floatVideoAsset(target).then(
    value => ({ resolved: true, value }),
    error => ({ resolved: false, message: String((error && error.message) || error) }),
  ), relativePath);
  const closedEvents = async () => {
    lastClosedEvents = await window.evaluate(() => (window.__fvClosed || []).slice());
    return lastClosedEvents;
  };
  const waitClosedCount = async count => {
    for (let i = 0; i < 40; i++) {
      const events = await closedEvents();
      if (events.length >= count) return events;
      await sleep(100);
    }
    return closedEvents();
  };
  const messageOf = outcome => (outcome && outcome.message) || '';
  // 拖拽回执的错误字段是 error，invoke 的失败信息在 message —— 断言时统一取值。
  const errorText = outcome => messageOf(outcome) || (outcome && outcome.error) || '';

  try {
    window = await app.firstWindow();
    await window.waitForFunction(() => document.body?.dataset?.ready === 'true', null, { timeout: 20000 });
    results.creatorReady = true;

    await window.evaluate(() => {
      window.__fvClosed = window.__fvClosed || [];
      if (!window.__fvCollectorOn) {
        window.creatorAPI.onFloatVideoClosed(payload => window.__fvClosed.push(payload));
        window.__fvCollectorOn = true;
      }
      return true;
    });
    results.preloadApiShape = await window.evaluate(() => typeof window.creatorAPI.floatVideoAsset === 'function'
      && typeof window.creatorAPI.onFloatVideoClosed === 'function');
    // 下线迷你拖拽窗后，创作资产原生单文件／多文件拖动与右键单视频浮窗仍保留。
    results.multiSelectDragApiIntact = await window.evaluate(() => typeof window.creatorAPI.startAssetDrag === 'function'
      && typeof window.creatorAPI.startAssetDragSelection === 'function'
      && !('toggleDragTray' in window.creatorAPI));

    const projectsNow = await getJson(PORT, '/api/creative-projects');
    const projectIdA = projectsNow.activeProjectId;
    results.activeProjectA = Boolean(projectIdA);

    // —— 1. 打开 ——
    const opened = await floatAsset(videoA);
    results.openFirst = opened.resolved === true && opened.value?.ok === true
      && opened.value?.path === videoA && opened.value?.reused === false;
    const win1 = await waitFloat('one');
    const win1Visible = await waitFloatVisible();
    results.singleWindow = win1.count === 1;
    results.alwaysOnTop = win1.count === 1 && win1.alwaysOnTop === true;
    results.windowVisible = win1Visible.count === 1 && win1Visible.visible === true
      && win1Visible.bounds.width >= 300 && win1Visible.bounds.height >= 240;
    results.visibleOnAllWorkspaces = process.platform !== 'darwin' || win1Visible.visibleOnAllWorkspaces === true;
    // Electron 43 无级别回读 API。null 表示未测到具体级别，不能当作 floating 的证据；
    // 置顶状态由 isAlwaysOnTop() 单独断言，floating 参数由源码与实际跨 Space 行为分别核对。
    results.floatingLevelIfReadable = process.platform !== 'darwin'
      || win1Visible.level === 'floating' || win1Visible.level === null;
    console.log('FLOAT_VIDEO_LEVEL', JSON.stringify({
      level: win1Visible.level, spaces: win1Visible.visibleOnAllWorkspaces, top: win1Visible.alwaysOnTop,
    }));
    const dom1 = await waitFloatDom(dom => dom.ready === 'true' && dom.cardPath === videoA);
    results.firstFramePreview = dom1.videoCount === 1 && dom1.previewMuted === true
      && (dom1.previewSrc || '').includes('/api/creative-assets/file')
      && (dom1.previewSrc || '').includes(encodeURIComponent(videoA))
      && dom1.previewSrc.endsWith('#t=0.001');
    results.fullNameShown = dom1.name === '生成视频-029.mp4';
    results.draggableCard = dom1.draggable === 'true' && dom1.cardPath === videoA;
    results.onlyCloseButton = dom1.buttons === 1 && dom1.closeButtons === 1 && dom1.hasClose === true;
    results.relativePathOnly = JSON.stringify(dom1).includes(videoA)
      && !(JSON.stringify(dom1).includes(projectRoot) || (dom1.previewSrc || '').includes('file://'));
    const preloadSurface = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('float-video.html'));
      if (!win) return null;
      return win.webContents.executeJavaScript(`({
        keys: Object.keys(window.floatVideoAPI || {}).sort(),
        noRequire: typeof require === 'undefined',
        noProcess: typeof process === 'undefined',
        noIpc: typeof window.ipcRenderer === 'undefined',
      })`);
    });
    results.preloadOnlyWindowAndAsset = !!preloadSurface
      && preloadSurface.noRequire === true
      && preloadSurface.noProcess === true
      && preloadSurface.noIpc === true
      && JSON.stringify(preloadSurface.keys) === JSON.stringify(['closeWindow', 'getInfo', 'moveWindow', 'onDragResult', 'onPrepare', 'onPresent', 'onSettled', 'readyToPresent', 'settlePresentation', 'startAssetDrag']);
    if (!results.preloadOnlyWindowAndAsset) console.log('FLOAT_VIDEO_PRELOAD', JSON.stringify(preloadSurface));

    // —— 2. 门禁 ——
    const rejectAudio = await floatAsset('测试剧本/测试配音.wav');
    const rejectImage = await floatAsset('测试剧本/测试角色.png');
    const rejectTraversal = await floatAsset('测试剧本/../../etc/passwd');
    const rejectAbsolute = await floatAsset('/etc/passwd');
    const rejectEncodedEscape = await floatAsset('..%2f..%2fetc%2fpasswd');
    const rejectMissing = await floatAsset('测试剧本/不存在-999.mp4');
    const rejectEmpty = await floatAsset('');
    const rejectPromptSidecar = await floatAsset('测试剧本/生成视频-029.prompt.txt');
    results.rejectAudio = rejectAudio.resolved === false && messageOf(rejectAudio).includes('不在创作资产库内');
    results.rejectImage = rejectImage.resolved === false && messageOf(rejectImage).includes('不在创作资产库内');
    results.rejectTraversal = rejectTraversal.resolved === false
      && (messageOf(rejectTraversal).includes('不属于当前剧本')
        || messageOf(rejectTraversal).includes('不在创作资产库内'));
    results.rejectAbsolute = rejectAbsolute.resolved === false && Boolean(messageOf(rejectAbsolute));
    results.rejectEncodedEscape = rejectEncodedEscape.resolved === false && Boolean(messageOf(rejectEncodedEscape));
    results.rejectMissing = rejectMissing.resolved === false && messageOf(rejectMissing).includes('不在创作资产库内');
    results.rejectEmpty = rejectEmpty.resolved === false && messageOf(rejectEmpty).includes('缺少视频路径');
    results.rejectNonVideoDocument = rejectPromptSidecar.resolved === false
      && messageOf(rejectPromptSidecar).includes('不在创作资产库内');
    const afterRejects = await Promise.all([findFloat(), readFloatDom(), closedEvents()]);
    results.rejectsKeepCurrentWindow = afterRejects[0].count === 1 && afterRejects[1].cardPath === videoA
      && afterRejects[2].length === 0;

    // —— 3. 原生拖出调用链 ——
    const dragForeign = await dragProbe('window.floatVideoAPI.startAssetDrag(\'测试剧本/测试片段甲.mp4\');');
    results.dragOnlyCurrentVideo = dragForeign.ok === false && errorText(dragForeign).includes('当前置顶的视频');
    const dragEscape = await dragProbe('window.floatVideoAPI.startAssetDrag(\'/etc/passwd\');');
    results.dragRejectsOutsideVideo = dragEscape.ok === false && Boolean(errorText(dragEscape));
    const dragAudio = await dragProbe('window.floatVideoAPI.startAssetDrag(\'测试剧本/测试配音.wav\');');
    results.dragRejectsAudio = dragAudio.ok === false && Boolean(errorText(dragAudio));
    results.failedDragKeepsWindowVisible = (await findFloat()).visible === true && (await closedEvents()).length === 0;
    const dragSelf = await dragCard();
    results.nativeDragChainOk = dragSelf.ok === true && dragSelf.path === videoA && dragSelf.count === 1;
    const afterDrag = await waitFloat('hidden');
    results.dragAutoDismissesWithoutDestroyingSource = afterDrag.count === 1 && afterDrag.visible === false
      && afterDrag.id === win1.id;
    const draggedEvents = await waitClosedCount(1);
    results.dragRestoresCardOnce = draggedEvents.length === 1 && draggedEvents[0].path === videoA
      && draggedEvents[0].reason === 'dragged';
    const hiddenDrag = await dragCard();
    results.hiddenWindowRejectsRepeatedDrag = hiddenDrag.ok === false && errorText(hiddenDrag).includes('已收起')
      && (await closedEvents()).length === 1;
    const reopenDragged = await floatAsset(videoA);
    const reopenedDraggedWin = await waitFloatVisible();
    results.draggedVideoCanFloatAgain = reopenDragged.value?.reused === true && reopenedDraggedWin.visible === true
      && reopenedDraggedWin.id === win1.id;

    // —— 4. 换文件：先关旧再开新，仍只有一个窗 ——
    const openedB = await floatAsset(videoB);
    results.openSecond = openedB.resolved === true && openedB.value?.path === videoB;
    const domB = await waitFloatDom(dom => dom.cardPath === videoB && dom.ready === 'true');
    results.replacedWindowDom = domB.name === '测试片段甲.mp4';
    const win2 = await waitFloat('one');
    results.singleWindowAfterReplace = win2.count === 1;
    results.newWindowInstance = win2.id !== win1.id;
    const replacedEvents = await waitClosedCount(2);
    results.replaceNotifiesOldPath = replacedEvents.length === 2
      && replacedEvents[1].path === videoA && replacedEvents[1].reason === 'replaced';

    // —— 5. 同文件只置前 ——
    const openedSame = await floatAsset(videoB);
    results.sameFileReused = openedSame.resolved === true && openedSame.value?.reused === true
      && openedSame.value?.path === videoB;
    const win3 = await waitFloat('one');
    results.sameFileSameWindow = win3.count === 1 && win3.id === win2.id;
    results.sameFileNoExtraClose = (await closedEvents()).length === 2;

    // —— 6. × 关闭 ——
    const floatPage = app.windows().find(page => (page.url() || '').includes('float-video.html'));
    results.floatPageAttachable = Boolean(floatPage);
    await floatPage.locator('#fvClose').click();
    results.closeDestroysWindow = (await waitFloat('gone')).count === 0;
    const closeEvents = await waitClosedCount(3);
    results.closeNotifiesPath = closeEvents.length === 3
      && closeEvents[2].path === videoB && closeEvents[2].reason === 'user';
    results.filesStillOnDisk = fs.existsSync(path.join(assetRoot, ...videoB.split('/')))
      && fs.existsSync(path.join(assetRoot, ...videoA.split('/')));

    // —— 7. 剧本切换 ——
    const reopened = await floatAsset(videoA);
    results.reopenAfterClose = reopened.resolved === true && reopened.value?.reused === false;
    const winReopened = await waitFloatVisible();
    results.reopenVisibleAgain = winReopened.count === 1 && winReopened.visible === true;
    await post(PORT, '/api/creative-projects', { action: 'create', name: '浮窗乙剧本' });
    const listB = await getJson(PORT, '/api/creative-projects');
    const projectB = (listB.projects || []).find(item => item.name === '浮窗乙剧本');
    results.projectBCreated = Boolean(projectB);
    const videoC = '浮窗乙剧本/乙片段-001.mp4';
    write(videoC, mp4Bytes);
    await post(PORT, '/api/creative-projects', { action: 'activate', id: projectB.id });
    await sleep(300);

    // 切剧本后浮窗重读信息：主进程拒绝并立刻关窗 + 通知左栏还原
    const staleRead = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('float-video.html'));
      if (!win) return 'no-window';
      return win.webContents.executeJavaScript('window.floatVideoAPI.getInfo()'
        + '.then(() => "resolved").catch(error => String((error && error.message) || error))');
    });
    results.staleInfoRejected = typeof staleRead === 'string' && staleRead !== 'resolved'
      && staleRead !== 'no-window' && staleRead.includes('不属于当前剧本');
    results.staleWindowClosed = (await waitFloat('gone')).count === 0;
    const staleEvents = await waitClosedCount(4);
    results.staleNotifies = staleEvents.length === 4 && staleEvents[3].path === videoA
      && staleEvents[3].reason === 'stale';

    // 新剧本自己的视频可以浮出并拖出
    const openedC = await floatAsset(videoC);
    results.otherProjectVideoAllowed = openedC.resolved === true && openedC.value?.path === videoC;
    const domC = await waitFloatDom(dom => dom.ready === 'true' && dom.cardPath === videoC);
    results.otherProjectDom = domC.name === '乙片段-001.mp4' && domC.project === '浮窗乙剧本';
    const dragC = await dragCard();
    results.newProjectDragOk = dragC.ok === true && dragC.path === videoC;
    const hiddenC = await waitFloat('hidden');
    const draggedCEvents = await waitClosedCount(5);
    results.newProjectDragAutoDismisses = hiddenC.visible === false && draggedCEvents.length === 5
      && draggedCEvents[4].path === videoC && draggedCEvents[4].reason === 'dragged';
    await floatAsset(videoC);
    await waitFloatVisible();

    // 再切回原剧本：窗上那个视频属于别的剧本，必须拖不出
    await post(PORT, '/api/creative-projects', { action: 'activate', id: projectIdA });
    await sleep(300);
    const dragStale = await dragCard();
    results.projectSwitchBlocksOldDrag = dragStale.ok === false
      && errorText(dragStale).includes('不属于当前剧本');
    // 拖拽失败后渲染层会自动重读信息 → 主进程判定过期 → 关窗
    results.staleWindowClosedAfterDrag = (await waitFloat('gone')).count === 0;
    const lastEvents = await waitClosedCount(6);
    results.staleAfterDragNotifies = lastEvents.length === 6 && lastEvents[5].path === videoC
      && lastEvents[5].reason === 'stale';

    // —— 8. 标题栏兜底拖动 + 位置记忆 ——
    const openedAgain = await floatAsset(videoA);
    results.reopenForBoundsCheck = openedAgain.resolved === true;
    await waitFloat('one');
    const posBefore = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('float-video.html'));
      return win ? win.getPosition() : null;
    });
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('float-video.html'));
      if (!win) return false;
      return win.webContents.executeJavaScript(`(() => {
        const head = document.querySelector('.fv-head');
        const opts = { bubbles: true, cancelable: true, pointerId: 7, isPrimary: true, button: 0, pointerType: 'mouse' };
        head.dispatchEvent(new PointerEvent('pointerdown', { ...opts, screenX: 600, screenY: 500 }));
        head.dispatchEvent(new PointerEvent('pointermove', { ...opts, screenX: 630, screenY: 524 }));
        head.dispatchEvent(new PointerEvent('pointerup', { ...opts, screenX: 630, screenY: 524 }));
        return true;
      })()`);
    });
    await sleep(800);
    const posAfter = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('float-video.html'));
      return win ? win.getPosition() : null;
    });
    results.windowDragFallback = Array.isArray(posBefore) && Array.isArray(posAfter)
      && posAfter[0] - posBefore[0] === 30 && posAfter[1] - posBefore[1] === 24;
    let savedBounds = null;
    for (let i = 0; i < 15 && !savedBounds; i++) {
      await sleep(200);
      try {
        savedBounds = JSON.parse(fs.readFileSync(path.join(runRoot, 'data', 'float-video-bounds.json'), 'utf-8'));
      } catch {
        savedBounds = null;
      }
      if (savedBounds && Array.isArray(posAfter) && savedBounds.x === posAfter[0] && savedBounds.y === posAfter[1]) break;
      savedBounds = null;
    }
    results.boundsRemembered = Boolean(savedBounds);
    if (!results.windowDragFallback || !results.boundsRemembered) {
      console.log('FLOAT_VIDEO_DIAG', JSON.stringify({ posBefore, posAfter, savedBounds }));
    }

    // —— 9. 系统关闭同样通知左栏 ——
    const systemClosed = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('float-video.html'));
      if (!win) return 'none';
      win.close();
      return 'closing';
    });
    results.systemCloseAllowed = systemClosed === 'closing';
    results.systemCloseDestroysWindow = (await waitFloat('gone')).count === 0;
    const finalEvents = await waitClosedCount(7);
    results.systemCloseNotifies = finalEvents.length === 7 && finalEvents[6].path === videoA
      && finalEvents[6].reason === 'closed';

    // —— 10. 素材文件零复制、零删除 ——
    const afterSet = new Set(walk(assetRoot));
    const beforeSet = new Set(beforeTree);
    results.nothingRemoved = [...beforeSet].every(item => afterSet.has(item));
    results.newFilesOnlyOwnProject = [...afterSet]
      .filter(item => !beforeSet.has(item))
      .every(item => item.startsWith('浮窗乙剧本/'));
    results.noTraySideFiles = ![...afterSet].some(item => /drag-tray|float-video-bounds/.test(item));

    const failedKeys = Object.keys(results).filter(key => results[key] !== true);
    if (failedKeys.length) {
      const peek = value => (typeof value === 'undefined' ? 'n/a' : JSON.stringify(value));
      throw new Error(`浮窗断言失败：${failedKeys.map(key => `${key}=${JSON.stringify(results[key])}`).join(', ')}`
        + ` dom=${peek(dom1)} closed=${peek(lastClosedEvents)}`
        + ` staleRead=${peek(staleRead)} dragSelf=${peek(dragSelf)}`
        + ` dragStale=${peek(dragStale)} posBefore=${peek(posBefore)} posAfter=${peek(posAfter)}`);
    }
    assert.ok(results.nativeDragChainOk);
    console.log(`FLOAT_VIDEO_PASS ${JSON.stringify(results)}`);
  } catch (error) {
    failed = true;
    console.error('FLOAT_VIDEO_FAIL', error.message || error);
    process.exitCode = 1;
  } finally {
    let closeTimer;
    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Electron 关闭超时')), 8000); }),
      ]);
    } catch {
      app.process()?.kill('SIGKILL');
    } finally {
      clearTimeout(closeTimer);
    }
    if (!failed) { try { fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 5 }); } catch {} }
    else console.log(`DEBUG-RUNROOT-KEPT(测试失败，保留现场): ${runRoot}`);
    // 断言与清理都已结束后显式退出：Playwright/Electron 句柄偶尔会让事件循环继续活跃，
    // 挂住会拖垮整批回归。留 500ms 让 stdout 在管道里 flush 完，避免结果行被截断。
    setTimeout(() => process.exit(process.exitCode === 1 ? 1 : 0), 500).unref?.();
  }
}

run();
