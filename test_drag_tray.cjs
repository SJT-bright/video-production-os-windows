#!/usr/bin/env node
'use strict';

// 剪映拖拽助手悬浮窗隔离测试：
//  1. creatorAPI.toggleDragTray() 打开悬浮窗（BrowserWindow 存在、置顶、URL 正确）
//  2. 悬浮窗列出当前剧本资产（tray-card > 0）且包含测试资产
//  3. 再次 toggle 关闭；窗口销毁
//  4. 对 .tray-card 合成派发真实 DragEvent('dragstart')，验证两条调用链：
//     单卡 dragstart → IPC 'tray:start-asset-drag' → 主进程 startAssetDrag 校验
//     → event.sender.startDrag() → 'tray:drag-result' 回发 {ok:true,count:1}；
//     多选整批同链路回发 {ok:true,count:2}，且批量顺序 = 点击选入顺序。
//  5. 角标规则：尾号需分隔符（final_v2 无索引角标）、日期只取目录部分（日期文件夹优先于
//     mtime）、mtime 按本地时区显示；当前板块超过 120 项时状态行追加「已显示前 120 项」。
// 不触碰系统剪贴板（复制行为由 stub 级测试覆盖）。
//
// 【证据边界】以上 dragstart 断言只证明「渲染层 dragstart → IPC → 主进程 startAssetDrag →
// event.sender.startDrag() 调用链成功」（main.cjs 的 drag-result 仅在 startDrag() 未抛异常后回发）；
// 不证明剪映应用收到素材——OS 端到端投递只能由人工在真实桌面 + 剪映中验收，IPC 成功 ≠ 剪映接收。
// 另：合成派发的 dragstart 一定能到达处理器，但原生鼠标拖拽是否发起还取决于卡片 draggable 属性
// （本测试同时断言该属性恒为 true）；原生拖拽手势本身不在此验证，由人工与
// test_quick_asset_drag.cjs（真实系统鼠标）覆盖。
//
// 媒体夹具为有效合成媒体（非假字节）：优先由本机 ffmpeg（/opt/homebrew/bin/ffmpeg）生成
// 极小 H.264 MP4（64x64、0.3s、faststart）与 440Hz 正弦 WAV（0.3s）；ffmpeg 不可用或生成失败时
// 退回纯 Node 兜底——MP4 手写 ftyp/mdat/moov box（同 test_editor_exports.cjs 写法，仅保证容器结构），
// WAV 手写 RIFF/WAVE 头 + 16bit PCM 正弦样本。
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { _electron: electron } = require('playwright');

// runRoot / projectRoot 按次生成（initRunRoot）：整体重跑时必须换新目录，不得复用失败现场
let runRoot = '';
let projectRoot = '';

function initRunRoot(attempt) {
  runRoot = path.join(__dirname, 'test-artifacts', `drag-tray-${process.pid}-${Date.now()}-a${attempt}`);
  projectRoot = path.join(runRoot, 'project');
}

function post(port, route, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(route, `http://127.0.0.1:${port}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || 'null')); } catch (e) { reject(e); } });
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
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || 'null')); } catch (e) { reject(e); } });
    }).once('error', reject);
  });
}

// —— 有效合成媒体夹具（见文件头说明）——
const FFMPEG_PATH = '/opt/homebrew/bin/ffmpeg';

function box(type, size = 16) {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32BE(size);
  buffer.write(type, 4);
  return buffer;
}

// 纯 Node 兜底 WAV：44 字节 RIFF/WAVE 头 + 16bit PCM 440Hz 正弦样本（8000Hz 采样）
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

// 纯 Node 兜底 MP4：ftyp/mdat/moov box 结构完整，但不声称可解码播放（同 test_editor_exports.cjs）
const nodeMp4Bytes = Buffer.concat([box('ftyp'), box('mdat'), box('moov')]);

// ffmpeg 不可执行或生成失败时返回 null，由调用方退回纯 Node 兜底
function ffmpegBytes(args, outFile, verify) {
  try {
    fs.accessSync(FFMPEG_PATH, fs.constants.X_OK);
  } catch {
    return null;
  }
  try {
    const { status } = spawnSync(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y', ...args, outFile], { timeout: 30000 });
    const bytes = status === 0 && fs.existsSync(outFile) ? fs.readFileSync(outFile) : null;
    return bytes && verify(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

const isMp4Bytes = bytes => bytes.length > 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
const isWavBytes = bytes => bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF';

async function runOnce(attempt) {
  initRunRoot(attempt);
  let app = null;
  let failed = false;
  let failureError = null;
  try {
    fs.mkdirSync(path.join(projectRoot, '创作资产库', '测试剧本', '成片'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'user-data'), { recursive: true });
  // 先生成一次模板字节（记录来源便于诊断），再写入各媒体夹具
  const fixturesDir = path.join(runRoot, 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });
  const ffmpegMp4 = ffmpegBytes(
    ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    path.join(fixturesDir, 'template.mp4'), isMp4Bytes);
  const ffmpegWav = ffmpegBytes(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3'],
    path.join(fixturesDir, 'template.wav'), isWavBytes);
  const mp4Bytes = ffmpegMp4 || nodeMp4Bytes;
  const wavBytes = ffmpegWav || nodeWavBytes();
  console.log(`DRAG_TRAY_FIXTURES mp4=${ffmpegMp4 ? 'ffmpeg' : 'node-fallback'} wav=${ffmpegWav ? 'ffmpeg' : 'node-fallback'}`);
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', '测试角色.png'), pngBytes);
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', '测试片段乙.png'), pngBytes);
  // 悬浮窗只联动视频和音频：夹具为有效合成媒体（非假字节，见文件头说明）
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', '生成视频-029.mp4'), mp4Bytes);
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', '测试片段甲.mp4'), mp4Bytes);
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', '测试配音.wav'), wavBytes);
  // 角标索引收紧：生成视频-030 尾号有分隔符 → #030 保持；final_v2 尾号前是字母 → 无索引角标
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', '生成视频-030.mp4'), mp4Bytes);
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', 'final_v2.mp4'), mp4Bytes);
  // 日期来源优先级：日期写在目录部分（2026-01-02 → 1/2），应优先于文件修改时间
  fs.mkdirSync(path.join(projectRoot, '创作资产库', '测试剧本', '生成视频', '2026-01-02'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', '生成视频', '2026-01-02', '生成视频-050.mp4'), mp4Bytes);
  // 成片目录不进悬浮窗
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', '成片', '成片片段.mp4'), mp4Bytes);
  // 提示词伴生文件是媒体元数据：既不计数也不出现在任何资产列表
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', '生成视频-029.prompt.txt'), '生成来源｜测试');

  // 期望顺序按应用内 newestFirst 规则动态计算（生成日期降序 → mtime 降序 → 名称 zh-CN numeric 降序），
  // 规则变更时只需同步此函数，不再手工维护硬编码顺序。
  const badgeDateFor = rel => {
    const dirPart = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    const m = dirPart.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const stat = fs.statSync(path.join(projectRoot, '创作资产库', ...rel.split('/')));
    const local = new Date(stat.mtime);
    return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  };
  const VIDEO_ORDER_FIXTURES = [
    '测试剧本/生成视频/2026-01-02/生成视频-050.mp4',
    '测试剧本/测试片段甲.mp4',
    '测试剧本/生成视频-029.mp4',
    '测试剧本/生成视频-030.mp4',
    '测试剧本/final_v2.mp4',
  ];
  const expectedVideoOrder = VIDEO_ORDER_FIXTURES
    .map(rel => ({ rel, date: badgeDateFor(rel), mtime: fs.statSync(path.join(projectRoot, '创作资产库', ...rel.split('/'))).mtimeMs }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.mtime - a.mtime
      || b.rel.localeCompare(a.rel, 'zh-CN', { numeric: true }))
    .map(item => item.rel);

  app = await electron.launch({
    args: [__dirname], timeout: 60000,
    env: {
      ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_PORT: '3784',
      VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: path.join(runRoot, 'data'), VIDEO_OS_USER_DATA: path.join(runRoot, 'user-data'), VIDEO_OS_CLIPBOARD_STUB: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
    const window = await app.firstWindow();
    try {
      await window.waitForFunction(() => document.body?.dataset?.ready === 'true', null, { timeout: 15000 });
    } catch (bootError) {
      // 打标记：只在 data-ready 引导等待超时这一处标注，供 isEnvironmentFlake 精确识别
      // （文件里其余 15s waitForFunction——如拖拽结果等待——属于功能断言，不打标、不重试）
      if (bootError?.name === 'TimeoutError' || String(bootError?.message || '').includes('Timeout 15000ms exceeded')) {
        bootError.bootDataReadyTimeout = true;
      }
      throw bootError;
    }

    const results = {};
    await window.evaluate(() => window.creatorAPI.setAssetPanel({ open: true }));
    const opened = await window.evaluate(() => window.creatorAPI.toggleDragTray());
    results.toggleOpens = opened?.open === true;

    const findTray = () => app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('drag-tray.html'));
      if (!win) return null;
      return {
        alwaysOnTop: win.isAlwaysOnTop(),
        bounds: win.getBounds(),
        itemCount: -1,
      };
    });
    let trayInfo = null;
    for (let i = 0; i < 40 && !(trayInfo = await findTray()); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(trayInfo, '悬浮窗未创建');
    results.trayCreated = true;
    results.alwaysOnTop = trayInfo.alwaysOnTop === true;
    // Computer Use 适配：无旧尺寸记忆时按 340×640 大卡片布局打开
    results.defaultSizedForAutomation = trayInfo.bounds
      && trayInfo.bounds.width >= 320 && trayInfo.bounds.height >= 600;

    const readItems = () => app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('drag-tray.html'));
      if (!win) return resolve({ ok: false, error: 'gone' });
      win.webContents.executeJavaScript(`({
        cards: document.querySelectorAll('.tray-card').length,
        hasTarget: [...document.querySelectorAll('.tray-card')].some(card => card.dataset.path === '测试剧本/生成视频-029.mp4'),
        paths: [...document.querySelectorAll('.tray-card')].map(card => card.dataset.path),
        badges: [...document.querySelectorAll('.tray-card')].map(card => card.querySelector('.tray-badge')?.textContent || ''),
        ariaLabels: [...document.querySelectorAll('.tray-card')].map(card => card.getAttribute('aria-label') || ''),
        chips: [...document.querySelectorAll('.chip')].map(chip => chip.dataset.filter),
        chipTexts: [...document.querySelectorAll('.chip')].map(chip => chip.textContent),
        status: document.getElementById('trayStatus')?.textContent || '',
        project: document.getElementById('trayProject')?.textContent || '',
        classes: [...document.querySelectorAll('.tray-card')].map(card => card.className),
      })`).then(v => resolve(v)).catch(e => resolve({ ok: false, error: String(e).slice(0, 100) }));
    }));
    let items = { cards: 0, hasTarget: false, project: '' };
    for (let i = 0; i < 40; i++) {
      items = await readItems();
      if (items.cards >= 2 && items.hasTarget) break;
      await new Promise(r => setTimeout(r, 200));
    }
    results.itemCounted = typeof items.cards === 'number' && items.cards >= 1;
    results.targetListed = items.hasTarget === true;
    results.projectShown = (items.project || '').length > 0;
    // 剪映联动只有视频/音频两个板块，默认视频：图片和成片不出现在默认列表。
    // 视频期望值重算（zh-CN 排序、文件夹优先）：生成视频/2026-01-02/生成视频-050、
    // 测试片段甲、生成视频-029、生成视频-030、final_v2 = 5 个；音频 = 测试配音 1 个。
    results.videoAudioChipsOnly = JSON.stringify(items.chips) === JSON.stringify(['video', 'audio']);
    results.chipCountsShown = JSON.stringify(items.chipTexts) === JSON.stringify(['视频 5', '音频 1']);
    results.statusLineShown = (items.status || '').includes('视频 5') && (items.status || '').includes('音频 1');
    // 小库（当前板块 ≤ 120）不得出现截断说明
    results.statusNoCapNoteWhenSmall = !(items.status || '').includes('已显示前 120 项');
    results.cardAriaLabels = (items.ariaLabels || []).some(text => text.includes('生成视频-029.mp4'));
    results.videosOnlyByDefault = Array.isArray(items.paths) && items.paths.length >= 2
      && items.paths.every(p => p.endsWith('.mp4'));
    results.imagesExcluded = !(items.paths || []).some(p => p.endsWith('.png'));
    results.finalsExcluded = !(items.paths || []).some(p => p.includes('成片/'));
    // 角标：与全部资产一致的索引号（生成视频-029 → #029）
    const targetBadge = (items.badges || []).find(text => text.includes('#029'));
    results.indexBadge = Boolean(targetBadge);
    // 索引收紧：生成视频-030 → #030 保持
    results.badge030Kept = (items.badges || []).some(text => text.includes('#030'));
    // 索引收紧：final_v2 尾号前是字母（无分隔符）→ 角标不得含 #（只可能有 mtime 日期）
    const v2Idx = (items.paths || []).indexOf('测试剧本/final_v2.mp4');
    results.finalV2NoIndexBadge = v2Idx !== -1 && !((items.badges || [])[v2Idx] || '').includes('#');
    // 日期来源优先级：日期只取目录部分 → 生成视频/2026-01-02/生成视频-050 → #050 1/2（而非 mtime 的今天）
    const d050Idx = (items.paths || []).indexOf('测试剧本/生成视频/2026-01-02/生成视频-050.mp4');
    const d050Badge = (items.badges || [])[d050Idx] || '';
    results.dateFolderBadgeWins = d050Idx !== -1 && d050Badge.includes('#050') && d050Badge.includes('1/2');
    // mtime 本地时区：无日期文件夹的生成视频-029 角标日期 = 本地时区的真实修改月/日
    const stat029 = fs.statSync(path.join(projectRoot, '创作资产库', '测试剧本', '生成视频-029.mp4'));
    const mtime029 = new Date(stat029.mtime);
    const expectedShort = `${mtime029.getMonth() + 1}/${mtime029.getDate()}`;
    const badge029 = (items.badges || []).find(text => text.includes('#029')) || '';
    results.mtimeBadgeLocalTimezone = badge029.includes(expectedShort);

    // 音频板块：切到音频 chip 后只列音频
    const trayPage0 = app.windows().find(w => w.url().includes('drag-tray.html'));
    await trayPage0.locator('.chip[data-filter="audio"]').click();
    let audioItems = { paths: [] };
    for (let i = 0; i < 20; i++) {
      audioItems = await readItems();
      if ((audioItems.paths || []).some(p => p === '测试剧本/测试配音.wav')) break;
      await new Promise(r => setTimeout(r, 200));
    }
    results.audioTabWorks = (audioItems.paths || []).some(p => p === '测试剧本/测试配音.wav')
      && (audioItems.paths || []).every(p => p.endsWith('.wav'));
    await trayPage0.locator('.chip[data-filter="video"]').click();
    await new Promise(r => setTimeout(r, 200));

    // —— 状态行 120 上限：临时写入 130 个微型有效 WAV 到独立子文件夹「音频库」， ——
    // 音频板块过滤后 131 项（含测试配音）> 120：只渲染 120 张卡且状态行追加截断说明；
    // 断言后删除该子文件夹并刷新，恢复「视频 5 / 音频 1」的其余断言环境（临时目录内操作）。
    const bulkAudioDir = path.join(projectRoot, '创作资产库', '测试剧本', '音频库');
    fs.mkdirSync(bulkAudioDir, { recursive: true });
    for (let i = 1; i <= 130; i++) {
      fs.writeFileSync(path.join(bulkAudioDir, `批量配音-${String(i).padStart(3, '0')}.wav`), wavBytes);
    }
    await trayPage0.locator('#trayRefresh').click();
    let bulkItems = { cards: 0, chipTexts: [], status: '' };
    for (let i = 0; i < 60; i++) {
      bulkItems = await readItems();
      if (JSON.stringify(bulkItems.chipTexts) === JSON.stringify(['视频 5', '音频 131'])) break;
      await new Promise(r => setTimeout(r, 300));
    }
    // 板块计数 chips 仍按全部资产统计（音频 131），不随渲染截断变小
    results.bulkChipCountsUntruncated = JSON.stringify(bulkItems.chipTexts) === JSON.stringify(['视频 5', '音频 131']);
    await trayPage0.locator('.chip[data-filter="audio"]').click();
    await new Promise(r => setTimeout(r, 300));
    bulkItems = await readItems();
    results.bulkCardsCappedAt120 = bulkItems.cards === 120;
    results.bulkStatusCapNote = (bulkItems.status || '').includes('已显示前 120 项');
    if (!results.bulkCardsCappedAt120 || !results.bulkStatusCapNote) {
      console.log('BULK-CAP-DIAG', JSON.stringify({
        cards: bulkItems.cards, status: bulkItems.status, chipTexts: bulkItems.chipTexts,
      }));
    }
    await trayPage0.locator('.chip[data-filter="video"]').click();
    fs.rmSync(bulkAudioDir, { recursive: true, force: true, maxRetries: 5 });
    await trayPage0.locator('#trayRefresh').click();
    for (let i = 0; i < 60; i++) {
      const restored = await readItems();
      if (JSON.stringify(restored.chipTexts) === JSON.stringify(['视频 5', '音频 1'])
        && !(restored.status || '').includes('已显示前 120 项')) break;
      await new Promise(r => setTimeout(r, 300));
    }
    await new Promise(r => setTimeout(r, 300));

    // 选择模式：真实点击「选」进入 → 依次点两张卡（顺序选入）→ 拖动任一选中卡整批拖出
    const trayPage = app.windows().find(w => w.url().includes('drag-tray.html'));
    assert.ok(trayPage, '悬浮窗页面未找到');

    // —— 断言 A：单卡拖拽调用链（默认视频板块、未开多选）——
    // 合成派发 DragEvent('dragstart')（Chromium 下可构造；处理链不依赖 dataTransfer）。
    // 证据边界见文件头：只证明 dragstart → IPC → startAssetDrag → startDrag() 调用链成功。
    // 注入与派发放在同一个带重试的 evaluate 里：SSE 触发的 loadAssets 会先把列表清成
    // 「正在读取资产…」，等卡片就绪再派发，避免瞬时空列表误报。
    const firstCardPath = await trayPage.evaluate(() => new Promise((resolve, reject) => {
      window.__dragResults = [];
      window.trayAPI.onDragResult(r => window.__dragResults.push(r));
      let tries = 0;
      const attempt = () => {
        const card = [...document.querySelectorAll('.tray-card')].find(c => (c.dataset.path || '').endsWith('.mp4'));
        if (card) {
          card.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
          resolve(card.dataset.path);
          return;
        }
        if (++tries > 100) { reject(new Error('拖拽卡片未就绪（列表持续为空）')); return; }
        setTimeout(attempt, 100);
      };
      attempt();
    }));
    results.defaultCardsDraggable = await trayPage.evaluate(() =>
      [...document.querySelectorAll('.tray-card')].every(card => card.getAttribute('draggable') === 'true'));
    await trayPage.waitForFunction(() => (window.__dragResults || []).length > 0, null, { timeout: 15000 });
    const singleDrag = await trayPage.evaluate(() => window.__dragResults[0]);
    // {ok:true,count:1,path=被拖卡} 只在主进程 event.sender.startDrag() 未抛异常后回发
    results.singleDragChainOk = singleDrag?.ok === true && singleDrag?.count === 1
      && singleDrag?.path === firstCardPath;
    if (!results.singleDragChainOk) console.log('SINGLE-DRAG-DIAG', JSON.stringify({ firstCardPath, singleDrag }));

    // 选择模式：真实点击「选」进入 → 依次点两张卡（顺序选入）→ 拖动任一选中卡整批拖出。
    // 屏障 route（乱序守卫）在本断言之后才挂起：若提前挂起，SSE 触发的资产刷新会停在
    // 「正在读取资产…」，选中卡从 DOM 消失，整批拖出断言无从派发。
    await trayPage.locator('#traySelectMode').click();
    await trayPage.locator('.tray-card').first().click();
    await trayPage.locator('.tray-card').nth(1).click();
    const selectResult = await trayPage.evaluate(`({
      batchVisible: !document.getElementById('trayBatch').hidden,
      selectMode: window.__trayDebug().selectMode,
      selection: window.__trayDebug().selection,
      allCardsDraggable: [...document.querySelectorAll('.tray-card')].every(card => card.getAttribute('draggable') === 'true'),
    })`);
    // 选择顺序期望值重算：视频卡 DOM 顺序（zh-CN 排序、文件夹优先）=
    // [生成视频-050（日期文件夹内）、测试片段甲、生成视频-029、生成视频-030、final_v2]，
    // 依次点击 first / nth(1) → 选中 [生成视频-050, 测试片段甲]。
    results.selectModeBatchVisible = selectResult.batchVisible === true;
    results.selectOrderMarked = JSON.stringify(selectResult.selection) === JSON.stringify(expectedVideoOrder.slice(0, 2));
    // 修复锚点：选择模式下卡片必须仍 draggable=true——若随多选关闭 draggable，
    // 真实鼠标拖拽不会发起 dragstart，「拖任一选中卡整批拖出」不可达（HTML 规范行为）。
    results.selectModeStillDraggable = selectResult.allCardsDraggable === true;

    // —— 断言 B：多选整批拖出调用链 ——
    // 拖动任一选中卡 → startDragSelection([...selectionOrder]) → 主进程按数组顺序整批拖出。
    // drag-result 的 path 是批量请求的第一项（main.cjs 里 requested[0]），可佐证点击顺序 = 拖出顺序。
    // 同样用带重试的 evaluate 派发，规避 SSE 触发重渲染的瞬时空列表。
    await trayPage.evaluate(() => new Promise((resolve, reject) => {
      window.__dragResults = [];
      let tries = 0;
      const attempt = () => {
        const card = document.querySelector('.tray-card.selected');
        if (card) {
          card.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
          resolve(true);
          return;
        }
        if (++tries > 100) {
          reject(new Error('选中卡片未就绪: ' + JSON.stringify({
            cards: document.querySelectorAll('.tray-card').length,
            selected: document.querySelectorAll('.tray-card.selected').length,
            debug: window.__trayDebug(),
          })));
          return;
        }
        setTimeout(attempt, 100);
      };
      attempt();
    }));
    await trayPage.waitForFunction(() => (window.__dragResults || []).length > 0, null, { timeout: 15000 });
    const batchDrag = await trayPage.evaluate(() => ({
      results: window.__dragResults,
      selection: window.__trayDebug().selection,
    }));
    results.batchDragChainOk = batchDrag.results.some(r => r?.ok === true && r?.count === 2
      && r?.path === expectedVideoOrder[0]);
    results.batchSelectionKeptAfterDrag = JSON.stringify(batchDrag.selection)
      === JSON.stringify(expectedVideoOrder.slice(0, 2));
    if (!results.batchDragChainOk || !results.batchSelectionKeptAfterDrag) {
      console.log('BATCH-DRAG-DIAG', JSON.stringify(batchDrag));
    }

    // 批量条提示文案（trayBatchHint 注册修复的锚点）：选中 2 项后应显示「已选 2 项」
    results.batchHintText = await trayPage.evaluate(() =>
      (document.querySelector('#trayBatch .tray-batch-hint')?.textContent || '').includes('已选 2 项'));

    // 选择模式下拖「未选中」的卡 = 只拖该卡本身（count 1），不得误发整批
    const unselectedTarget = expectedVideoOrder[2];
    await trayPage.evaluate(targetPath => new Promise((resolve, reject) => {
      window.__dragResults.length = 0;
      let tries = 0;
      const attempt = () => {
        const card = [...document.querySelectorAll('.tray-card')]
          .find(candidate => candidate.dataset.path === targetPath);
        if (card && !card.classList.contains('selected')) {
          card.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
          resolve(true);
          return;
        }
        if (++tries > 100) { reject(new Error('未选中卡片未就绪')); return; }
        setTimeout(attempt, 100);
      };
      attempt();
    }), unselectedTarget);
    await trayPage.waitForFunction(() => (window.__dragResults || []).length > 0, null, { timeout: 15000 });
    results.unselectedDragSingleOk = await trayPage.evaluate(targetPath => {
      const r = (window.__dragResults || [])[0];
      return r?.ok === true && r?.count === 1 && r?.path === targetPath;
    }, unselectedTarget);

    // —— 乱序守卫（屏障式）：A→B→A→B 回环，旧响应后完成不得覆盖新渲染 ——
    // route 按请求到达顺序挂起（屏障），测试显式按“新请求先释放、旧请求后释放”的逆序放行。
    globalThis.__assetGateHold = true;
    globalThis.__assetGate = [];
    await trayPage.route('**/api/creative-assets?*', async route => {
      const url = route.request().url();
      const projectParam = new URL(url).searchParams.get('project') || '';
      if (!globalThis.__assetGateHold) { await route.continue(); return; }
      globalThis.__assetGate.push({ route, projectParam });
    });
    const drainGate = async order => {
      for (const projectParam of order) {
        const idx = (globalThis.__assetGate || []).findIndex(item => item.projectParam === projectParam);
        if (idx === -1) continue;
        const item = (globalThis.__assetGate || []).splice(idx, 1)[0];
        await item.route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ available: true, stats: {}, tree: { kind: 'folder', name: projectParam, path: '', fileCount: 0, children: [] } }),
        });
      }
    };

    // —— 乱序守卫用例：A→B→A 回环，屏障保证旧响应最后完成 ——
    globalThis.__assetGateHold = false;
    for (const item of globalThis.__assetGate.splice(0)) {
      await item.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, stats: {}, tree: { kind: 'folder', name: item.projectParam, path: '', fileCount: 0, children: [] } }) }).catch(() => {});
    }
    for (let i = 0; i < 20; i++) {
      if ((await readItems()).cards >= 0) break;
      await new Promise(r => setTimeout(r, 200));
    }
    const heldResponses = [];
    const trayPort = 3784;
    const projectsNow = await getJson(trayPort, '/api/creative-projects');
    const projectIdA = projectsNow.activeProjectId;
    const projectA = projectsNow.projects.find(p => p.id === projectIdA);
    assert.ok(projectA, '默认激活项目缺失');
    await post(trayPort, '/api/creative-projects', { action: 'create', name: '乱序项目B' });
    const listB = await getJson(trayPort, '/api/creative-projects');
    const projectB = listB.projects.find(p => p.name === '乱序项目B');
    assert.ok(projectB, '乱序项目B 未创建');
    await trayPage.route('**/api/creative-assets?*', async route => {
      const url = route.request().url();
      const projectParam = new URL(url).searchParams.get('project') || '(none)';
      heldResponses.push({ projectParam, route });
    });
    // A→B→A 回环：三次 SSE 刷新，assets 请求按序 hold
    await post(trayPort, '/api/creative-projects', { action: 'create', name: '乱序项目C' });
    const listC = await getJson(trayPort, '/api/creative-projects');
    const projectC = listC.projects.find(p => p.name === '乱序项目C');
    await post(trayPort, '/api/creative-projects', { action: 'activate', id: projectIdA });
    await post(trayPort, '/api/creative-projects', { action: 'activate', id: projectB.id });
    await post(trayPort, '/api/creative-projects', { action: 'activate', id: projectIdA });
    await new Promise(r => setTimeout(r, 1200));  // 等 SSE 驱动的三次请求全部挂起
    const heldProjects = heldResponses.map(item => item.projectParam);
    // 逆序放行：最后激活的 A 先完成，早期的 B/旧 A 后完成
    for (let i = heldResponses.length - 1; i >= 0; i--) {
      await heldResponses[i].route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ available: true, stats: {}, tree: { kind: 'folder', name: heldResponses[i].projectParam, path: '', fileCount: 0, children: [] } }),
      });
      await new Promise(r => setTimeout(r, 150));
    }
    heldResponses.length = 0;
    await new Promise(r => setTimeout(r, 400));
    const staleState = await trayPage.evaluate(`({
      projectId: window.__trayProjectId,
      label: document.getElementById('trayProject')?.textContent || '',
      cards: document.querySelectorAll('.tray-card').length,
    })`);
    results.staleGuardProjectId = staleState.projectId === projectIdA;
    results.staleGuardLabel = staleState.label.includes(projectA.folder);
    if (!results.staleGuardProjectId || !results.staleGuardLabel) {
      console.log('STALE-DIAG', JSON.stringify({ heldProjects, staleState }));
    }

    // —— 项目切换跟随用例：切换后悬浮窗必须重载到新项目，不得卡在旧项目列表 ——
    // 回归锚点：旧版守卫 `activeProjectId() !== newProjectId` 用旧项目 ID 对比新项目 ID，
    // 项目一切换渲染就自弃，悬浮窗永久卡在旧项目，之后每次拖拽都被主进程以
    // 「资产不属于当前剧本」拒绝（真实鼠标端到端复现于 2026-09-27）。
    await post(trayPort, '/api/creative-projects', { action: 'activate', id: projectB.id });
    let switchFollowed = false;
    for (let i = 0; i < 25 && !switchFollowed; i++) {
      await new Promise(r => setTimeout(r, 200));
      const after = await trayPage.evaluate(`({
        projectId: window.__trayProjectId,
        label: document.getElementById('trayProject')?.textContent || '',
        status: document.getElementById('trayStatus')?.textContent || '',
      })`);
      switchFollowed = after.projectId === projectB.id && after.label.includes(projectB.folder);
    }
    results.trayFollowsProjectSwitch = switchFollowed;
    // 切回 A，保持后续用例环境不变
    await post(trayPort, '/api/creative-projects', { action: 'activate', id: projectIdA });
    await new Promise(r => setTimeout(r, 900));

    // 窗口拖拽兜底：合成指针事件走 JS 路径（原生 app-region 只拦截真实输入，不影响合成事件），
    // 断言窗口按位移移动且位置记忆落盘
    const boundsFile = path.join(runRoot, 'data', 'drag-tray-bounds.json');
    const posBefore = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('drag-tray.html'));
      return win ? win.getPosition() : null;
    });
    await trayPage.evaluate(() => {
      const head = document.querySelector('.tray-head');
      const opts = { bubbles: true, pointerId: 7, screenX: 500, screenY: 500 };
      head.dispatchEvent(new PointerEvent('pointerdown', opts));
      head.dispatchEvent(new PointerEvent('pointermove', { ...opts, screenX: 530, screenY: 524 }));
      head.dispatchEvent(new PointerEvent('pointerup', { ...opts, screenX: 530, screenY: 524 }));
    });
    await new Promise(r => setTimeout(r, 700));
    const posAfter = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('drag-tray.html'));
      return win ? win.getPosition() : null;
    });
    results.windowDragFallbackMoved = Array.isArray(posAfter) && Array.isArray(posBefore)
      && posAfter[0] - posBefore[0] === 30 && posAfter[1] - posBefore[1] === 24;
    let savedBounds = null;
    for (let i = 0; i < 10 && !savedBounds; i++) {
      await new Promise(r => setTimeout(r, 200));
      try { savedBounds = JSON.parse(fs.readFileSync(boundsFile, 'utf-8')); } catch { savedBounds = null; }
      if (savedBounds && Array.isArray(posAfter) && savedBounds.x === posAfter[0] && savedBounds.y === posAfter[1]) break;
      savedBounds = null;
    }
    results.windowDragBoundsSaved = Boolean(savedBounds);
    if (!results.windowDragFallbackMoved || !results.windowDragBoundsSaved) {
      console.log('DRAG-DIAG', JSON.stringify({ posBefore, posAfter, savedBounds }));
    }

    const closed = await window.evaluate(() => window.creatorAPI.toggleDragTray());
    results.toggleCloses = closed?.open === false;
    await new Promise(r => setTimeout(r, 400));
    results.windowDestroyed = await app.evaluate(({ BrowserWindow }) =>
      !BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('drag-tray.html')));


    const failedKeys = Object.keys(results).filter(key => results[key] !== true);
    if (failedKeys.length) throw new Error(`悬浮窗断言失败：${failedKeys.map(key => `${key}=${results[key]}`).join(', ')} items=${JSON.stringify(items)} select=${JSON.stringify(selectResult)}`);
    console.log(`DRAG_TRAY_PASS ${JSON.stringify(results)}`);
  } catch (error) {
    failed = true;
    failureError = error;
    console.error(`DRAG_TRAY_FAIL(第 ${attempt} 次运行)`, error.message || error);
  } finally {
    // 断言通过后仍要给原生窗口一个有界的退出时间，避免 Playwright 清理挂起拖住整批回归。
    if (app) {
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
    }
    if (!failed) { try { fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 5 }); } catch {} }
    else console.log(`DEBUG-RUNROOT-KEPT(第 ${attempt} 次运行失败，暂留现场): ${runRoot}`);
  }
  return { failed, failureError, runRoot };
}

// —— 环境性抖动签名（只豁免这两种，真实功能断言失败一律不重试）——
// A. data-ready 引导等待超时：runOnce 内已在该处给 TimeoutError 打 bootDataReadyTimeout 标记；
//    文件里其余 15s waitForFunction（拖拽结果等待等）属于功能断言，不打标、不进本签名。
// B. 中段 app.windows().find(...) 找不到拖拽窗 → "Cannot read properties of undefined (reading 'locator')"
function isEnvironmentFlake(error) {
  if (error && error.bootDataReadyTimeout === true) return true;
  const message = String((error && error.message) || error);
  return message.includes("Cannot read properties of undefined (reading 'locator')");
}

async function main() {
  const first = await runOnce(1);
  if (!first.failed) return;
  if (!isEnvironmentFlake(first.failureError)) {
    console.error('DRAG_TRAY_FAIL_FINAL: 非环境性失败（真实功能断言），不重试');
    process.exitCode = 1;
    return;
  }
  console.log(`DRAG_TRAY_RETRY: 命中环境性抖动签名（${String((first.failureError && first.failureError.message) || first.failureError).slice(0, 200)}），清理现场后整体重跑一次`);
  // 重试必须在新 runRoot 下进行：清掉第一次失败留下的脏目录
  try { fs.rmSync(first.runRoot, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  const second = await runOnce(2);
  if (second.failed) {
    console.error('DRAG_TRAY_FAIL_FINAL: 合法重试一次后仍失败');
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0; // 第一次的环境性失败不影响最终结果
}

main();
