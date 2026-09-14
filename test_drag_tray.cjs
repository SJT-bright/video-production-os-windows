#!/usr/bin/env node
'use strict';

// 剪映拖拽助手悬浮窗隔离测试：
//  1. creatorAPI.toggleDragTray() 打开悬浮窗（BrowserWindow 存在、置顶、URL 正确）
//  2. 悬浮窗列出当前剧本资产（tray-card > 0）且包含测试资产
//  3. 再次 toggle 关闭；窗口销毁
// 不触碰系统剪贴板（复制行为由 stub 级测试覆盖）。
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { _electron: electron } = require('playwright');

const runRoot = path.join(__dirname, 'test-artifacts', `drag-tray-${process.pid}-${Date.now()}`);
const projectRoot = path.join(runRoot, 'project');

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

async function run() {
  fs.mkdirSync(path.join(projectRoot, '创作资产库', '测试剧本'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'user-data'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '创作资产库', '测试剧本', '测试角色.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );
  fs.writeFileSync(
    path.join(projectRoot, '创作资产库', '测试剧本', '测试片段乙.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );

  const app = await electron.launch({
    args: [__dirname], timeout: 60000,
    env: {
      ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_PORT: '3784',
      VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: path.join(runRoot, 'data'), VIDEO_OS_USER_DATA: path.join(runRoot, 'user-data'), VIDEO_OS_CLIPBOARD_STUB: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
  let failed = false;
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => document.body?.dataset?.ready === 'true', null, { timeout: 15000 });

    const results = {};
    await window.evaluate(() => window.creatorAPI.setAssetPanel({ open: true }));
    const opened = await window.evaluate(() => window.creatorAPI.toggleDragTray());
    results.toggleOpens = opened?.open === true;

    const findTray = () => app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('drag-tray.html'));
      if (!win) return null;
      return {
        alwaysOnTop: win.isAlwaysOnTop(),
        itemCount: -1,
      };
    });
    let trayInfo = null;
    for (let i = 0; i < 40 && !(trayInfo = await findTray()); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(trayInfo, '悬浮窗未创建');
    results.trayCreated = true;
    results.alwaysOnTop = trayInfo.alwaysOnTop === true;

    const readItems = () => app.evaluate(({ BrowserWindow }) => new Promise(resolve => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('drag-tray.html'));
      if (!win) return resolve({ ok: false, error: 'gone' });
      win.webContents.executeJavaScript(`({
        cards: document.querySelectorAll('.tray-card').length,
        hasTarget: [...document.querySelectorAll('.tray-card')].some(card => card.dataset.path === '测试剧本/测试角色.png'),
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

    // 选择模式：真实点击「选」进入 → 依次点两张卡（顺序选入）→ 拖动任一选中卡整批拖出
    const trayPage = app.windows().find(w => w.url().includes('drag-tray.html'));
    assert.ok(trayPage, '悬浮窗页面未找到');
    // —— 乱序守卫（屏障式）：A→B→A→B 回环，旧响应后完成不得覆盖新渲染 ——

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
    await trayPage.locator('#traySelectMode').click();
    await trayPage.locator('.tray-card').first().click();
    await trayPage.locator('.tray-card').nth(1).click();
    const selectResult = await trayPage.evaluate(`({
      batchVisible: !document.getElementById('trayBatch').hidden,
      selectMode: window.__trayDebug().selectMode,
      selection: window.__trayDebug().selection,
    })`);
    results.selectModeBatchVisible = selectResult.batchVisible === true;
    results.selectOrderMarked = JSON.stringify(selectResult.selection) === JSON.stringify(['测试剧本/测试角色.png', '测试剧本/测试片段乙.png']);

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
    console.error('DRAG_TRAY_FAIL', error.message || error);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    if (!failed) { try { fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 5 }); } catch {} }
    else console.log(`DEBUG-RUNROOT-KEPT(测试失败，保留现场): ${runRoot}`);
  }
}

run();
