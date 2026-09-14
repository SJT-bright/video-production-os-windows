#!/usr/bin/env node
'use strict';

// 聚焦隔离测试：只验证「快捷面板 → 完整资产库」跳转定位的真实链路，不执行烟测浮层段。
// 双实例确定性设计（不依赖机器速度，不靠长 sleep）：
//  实例 1（TTL=800ms，无门闩）：TTL 内的正常送达——单发 push、面板重载后单发 push、
//    真实 boot consume（面板导离再导回，handler 未就绪 → pending → 新文档 consume 送达）、
//    重复跳转、切项目竞态不误投 + 补发定位、stale-project 作废、关闭重开。
//  实例 2（TTL=800ms + 门闩 2500ms）：门闩保证 pending 确定性滞留越过 TTL——
//    过期在推送前被可观察取消（delivered='expired'）；随后新请求独立判定为 expired，
//    旧过期不得清掉新 pending；面板收到 expired 需实际提示取消且不定位。
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { _electron: electron } = require('playwright');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

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

const waitFor = async (fn, timeout = 8000, round = 60) => {
  for (let i = 0; i < round; i++) {
    try { if (await fn()) return true; } catch {}
    await new Promise(r => setTimeout(r, Math.max(50, Math.round(timeout / round))));
  }
  return false;
};

async function launchInstance(name, ttlMs, gateMs, port) {
  const runRoot = path.join(__dirname, 'test-artifacts', `focus-link-${name}-${process.pid}-${Date.now()}`);
  const projectRoot = path.join(runRoot, 'project');
  fs.mkdirSync(path.join(projectRoot, '创作资产库', '测试剧本'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'user-data'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '创作资产库', '测试剧本', '测试角色.png'), PNG);
  const app = await electron.launch({
    args: [__dirname], timeout: 30000,
    env: {
      ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_PORT: String(port),
      VIDEO_OS_FOCUS_TTL_MS: String(ttlMs), VIDEO_OS_FOCUS_GATE_MS: String(gateMs),
      VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: path.join(runRoot, 'data'), VIDEO_OS_USER_DATA: path.join(runRoot, 'user-data'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
  return { app, runRoot, projectRoot, port };
}

// 面板视图（WebContentsView）不能跨进程返回：面板操作在 app 进程内以表达式完成。
// 面板加载中 URL 可能为空，用 #assetGrid+#previewDialog 探测识别面板页。
async function panelExecute(app, code) {
  return app.evaluate(({ BrowserWindow }, codeText) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('creator.html'));
    if (!win) return { error: 'no-creator-window' };
    const stack = [...win.contentView.children];
    const tryList = [];
    while (stack.length) {
      const node = stack.shift();
      if (node.children) stack.push(...node.children);
      if (node.webContents) tryList.push(node.webContents);
    }
    const finder = async () => {
      for (const wc of tryList) {
        if (wc.isDestroyed()) continue;
        try { if (await wc.executeJavaScript("!!document.getElementById('assetGrid') && !!document.getElementById('previewDialog')", true)) return wc; } catch {}
      }
      return null;
    };
    return finder().then(wc => {
      if (!wc) return { ok: false, error: 'no-asset-view' };
      return wc.executeJavaScript(codeText).then(value => ({ ok: true, value })).catch(e => ({ ok: false, error: String(e).slice(0, 120) }));
    });
  }, code);
}

const makeHelpers = app => {
  const panelReady = async () => {
    const r = await panelExecute(app, "document.body?.dataset?.ready === 'true'");
    return r?.ok === true && r.value === true;
  };
  const readPanel = async () => {
    const r = await panelExecute(app, `({
      previewOpen: document.getElementById('previewDialog')?.open === true,
      previewName: document.getElementById('previewName')?.textContent || '',
      currentPath: document.getElementById('currentPath')?.textContent || '',
    })`);
    return r?.ok ? r.value : null;
  };
  const panelPreviewShows = async name => {
    if (!await waitFor(async () => (await readPanel())?.previewOpen === true, 8000, 40)) return false;
    return (await readPanel()).previewName.includes(name);
  };
  const reloadPanel = async appRef => {
    await appRef.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('creator.html'));
      const stack = [...win.contentView.children];
      while (stack.length) {
        const node = stack.shift();
        if (node.children) stack.push(...node.children);
        if (node.webContents && node.webContents.getURL().includes('creator-assets.html')) { node.webContents.reloadIgnoringCache(); return; }
      }
    });
  };
  const navigatePanel = async (appRef, target) => {
    // target: 'about:blank' 导离；'restore' 导回。面板身份用 DOM 探测（#assetGrid）确定，
    // 以 webContents id 记录在 main 进程全局——绝不按 URL 猜，避免误伤平台 fixture 视图。
    await appRef.evaluate(async ({ BrowserWindow }, target) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('creator.html'));
      const stack = [...win.contentView.children];
      const tryList = [];
      while (stack.length) {
        const node = stack.shift();
        if (node.children) stack.push(...node.children);
        if (node.webContents) tryList.push(node.webContents);
      }
      const findPanel = async () => {
        for (const wc of tryList) {
          if (wc.isDestroyed()) continue;
          try { if (await wc.executeJavaScript("!!document.getElementById('assetGrid')", true)) return wc; } catch {}
        }
        return null;
      };
      if (target === 'restore') {
        const wc = tryList.find(wc => !wc.isDestroyed() && wc.__vosIsPanel);
        if (wc && globalThis.__panelRestoreUrl) await wc.loadURL(globalThis.__panelRestoreUrl);
        return;
      }
      const panel = await findPanel();
      if (panel) {
        globalThis.__panelRestoreUrl = panel.getURL();
        panel.__vosIsPanel = true;  // 同一 main 进程内对象身份持久，恢复时按标记精确还原
        await panel.loadURL(target);
      }
    }, target);
  };
  const dumpViews = async appRef => appRef.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('creator.html'));
    if (!win) return { noCreatorWindow: true };
    const stack = [...win.contentView.children];
    const urls = [];
    while (stack.length) {
      const node = stack.shift();
      if (node.children) stack.push(...node.children);
      if (node.webContents) urls.push(String(node.webContents.getURL()).slice(0, 80));
    }
    return { urls };
  });
  return { panelReady, readPanel, panelPreviewShows, reloadPanel, navigatePanel, dumpViews };
};

function creatorFocusOf(window) {
  return async (assetPath, projectId) => window.evaluate(({ assetPath, projectId }) => (
    window.creatorAPI.focusAssetInLibrary(assetPath, projectId)
  ), { assetPath, projectId });
}

async function runInstance1() {
  const { app, runRoot, projectRoot, port } = await launchInstance('ttl', 800, 0, 3790);
  const results = {};
  let failed = false;
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => document.body?.dataset?.ready === 'true', null, { timeout: 15000 });
    const { panelReady, readPanel, panelPreviewShows, reloadPanel, navigatePanel, dumpViews } = makeHelpers(app);
    const creatorFocus = creatorFocusOf(window);
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.__panelConsole = [];
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('creator.html'));
      const stack = [...win.contentView.children];
      while (stack.length) {
        const node = stack.shift();
        if (node.children) stack.push(...node.children);
        if (node.webContents) node.webContents.on('console-message', (_e, _l, message) => {
          globalThis.__panelConsole.push(String(message).slice(0, 160));
        });
      }
    });

    const projects = await getJson(port, '/api/creative-projects');
    const projectIdA = projects.activeProjectId;
    const projectA = projects.projects.find(p => p.id === projectIdA);
    assert.ok(projectA, '默认激活项目缺失');
    const assetA = '测试剧本/测试角色.png';
    await window.evaluate(() => window.creatorAPI.setAssetPanel({ open: true }));
    assert.ok(await waitFor(panelReady, 12000, 80), '面板页未就绪');

    // 1. TTL 内单发 push：一次发送，只观察
    const basicDelivered = await creatorFocus(assetA, projectIdA);
    results.basicDeliveredOk = basicDelivered?.delivered === 'push';
    results.basicLocate = await panelPreviewShows('测试角色.png');
    if (!results.basicLocate) {
      const focusDiag = await panelExecute(app, `({
        focusCalls: window.__focusExternalCalls || 0,
        ready: document.body?.dataset?.ready,
        activeProject: (window.state && window.state.config && window.state.config.project && window.state.config.project.id) || null,
        assetCount: (window.state && window.state.assets ? window.state.assets.length : -1),
        previewOpen: document.getElementById('previewDialog')?.open === true,
        previewName: document.getElementById('previewName')?.textContent || '',
      })`);
      const consoleLines = await app.evaluate(() => (globalThis.__panelConsole || []).slice(-12));
      console.log('BASIC-DIAG', JSON.stringify(focusDiag), 'CONSOLE', JSON.stringify(consoleLines));
    }

    // 2. 面板页导航（reload）后单发：pending/推送机制在 TTL 内仍送达
    await reloadPanel(app);
    const navDelivered = await creatorFocus(assetA, projectIdA);
    // 重载窗口内送达路径可能是 push（加载快于检测）或 consume/pending（未就绪兜底），均为合法送达
    results.navDeliveredOk = ['push', 'consume', 'pending'].includes(navDelivered?.delivered);
    results.navLocate = await panelPreviewShows('测试角色.png');

    // 3. 真实 boot consume：把面板导离（about:blank）→ 未就绪单发（delivered=pending）→ 导回 → 新文档 boot consume 送达
    await navigatePanel(app, 'about:blank');
    await new Promise(r => setTimeout(r, 150));
    const consumeDelivered = await creatorFocus(assetA, projectIdA);
    // 面板已导离（未就绪）：handler 必须登记 pending，回执 'pending'；导回后 boot consume 送达
    results.consumeDeliveredOk = consumeDelivered?.delivered === 'pending';
    await navigatePanel(app, 'restore');
    results.consumeLocate = await panelPreviewShows('测试角色.png');

    // 4. 已就绪重复跳转 + 建第二项目（create 自动激活）后对当前项目跳转
    await post(port, '/api/creative-projects', { action: 'create', name: 'B剧本项目' });
    const list = await getJson(port, '/api/creative-projects');
    const projectB = list.projects.find(p => p.name === 'B剧本项目');
    assert.ok(projectB, 'B剧本项目未创建');
    fs.mkdirSync(path.join(projectRoot, '创作资产库', projectB.folder), { recursive: true });
    const assetB = `${projectB.folder}/B资产.png`;
    fs.writeFileSync(path.join(projectRoot, '创作资产库', assetB), PNG);
    await new Promise(r => setTimeout(r, 1200));
    const repeatDelivered = await creatorFocus(assetB, projectB.id);
    results.repeatDeliveredOk = repeatDelivered?.delivered === 'push';
    results.repeatLocate = await panelPreviewShows('B资产.png');
    await creatorFocus(assetB, projectB.id);
    results.repeatLocate2 = await panelPreviewShows('B资产.png');

    // 5. 切项目竞态：activate 与 focus 同时发起——不误投；导航完成后补发（单发）必定位
    for (let round = 1; round <= 2; round++) {
      await post(port, '/api/creative-projects', { action: 'activate', id: projectIdA });
      await creatorFocus(assetA, projectIdA);
      await new Promise(r => setTimeout(r, 1500));
      const panelA = await readPanel();
      results[`raceNoCrossA${round}`] = panelA === null || panelA.previewOpen !== true || !(panelA.previewName || '').includes('B资产.png');
      await creatorFocus(assetA, projectIdA);
      results[`raceToA${round}`] = await panelPreviewShows('测试角色.png');

      await post(port, '/api/creative-projects', { action: 'activate', id: projectB.id });
      await creatorFocus(assetB, projectB.id);
      await new Promise(r => setTimeout(r, 1500));
      const panelB = await readPanel();
      results[`raceNoCrossB${round}`] = panelB === null || panelB.previewOpen !== true || !(panelB.previewName || '').includes('测试角色.png');
      await creatorFocus(assetB, projectB.id);
      results[`raceToB${round}`] = await panelPreviewShows('B资产.png');
    }

    // 6. stale-project：面板确认在 B 后，携带 A 项目身份的请求作废（不误投）
    await post(port, '/api/creative-projects', { action: 'activate', id: projectIdA });
    await waitFor(async () => {
      const panel = await readPanel();
      return panel !== null && (panel.currentPath || '').includes(projectA.folder);
    }, 8000, 30);
    const staleDelivered = await creatorFocus(assetB, projectB.id);
    results.staleProjectCancelled = staleDelivered?.delivered === 'stale-project';
    await new Promise(r => setTimeout(r, 600));
    const stalePanel = await readPanel();
    results.staleNoCross = stalePanel === null || stalePanel.previewOpen !== true || !(stalePanel.previewName || '').includes('B资产.png');

    // 7. 关闭重开（先切回 A 使目标合法）
    await post(port, '/api/creative-projects', { action: 'activate', id: projectIdA });
    await window.evaluate(() => window.creatorAPI.setAssetPanel({ open: false }));
    await new Promise(r => setTimeout(r, 200));
    await creatorFocus(assetA, projectIdA);
    results.reopenLocate = await panelPreviewShows('测试角色.png');

    const failedKeys = Object.keys(results).filter(key => results[key] !== true);
    if (failedKeys.length) {
      const diag = await panelExecute(app, `({
        focusCalls: window.__focusExternalCalls || 0,
        ready: document.body?.dataset?.ready,
        activeProject: (window.state && window.state.config && window.state.config.project && window.state.config.project.id) || null,
        assetCount: (window.state && window.state.assets ? window.state.assets.length : -1),
      })`);
      const views = await dumpViews(app);
      const consoleLines = await app.evaluate(() => (globalThis.__panelConsole || []).slice(-12));
      console.log('PANEL-DIAG', JSON.stringify(diag), 'VIEWS', JSON.stringify(views), 'CONSOLE', JSON.stringify(consoleLines));
      throw new Error(`实例1 断言失败：${failedKeys.map(key => `${key}=${results[key]}`).join(', ')}`);
    }
    console.log(`FOCUS_TTL_PASS ${JSON.stringify(results)}`);
  } catch (error) {
    failed = true;
    console.error(`FOCUS_TTL_FAIL ${error.message || error}`);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    if (!failed) { try { fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 5 }); } catch {} }
    else console.log(`DEBUG-RUNROOT-KEPT(测试失败，保留现场): ${runRoot}`);
  }
}

async function runInstance2() {
  const { app, runRoot, projectRoot, port } = await launchInstance('gate', 800, 2500, 3789);
  const results = {};
  let failed = false;
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => document.body?.dataset?.ready === 'true', null, { timeout: 15000 });
    const { panelReady, readPanel } = makeHelpers(app);
    const creatorFocus = creatorFocusOf(window);

    const projects = await getJson(port, '/api/creative-projects');
    const projectIdA = projects.activeProjectId;
    const projectA = projects.projects.find(p => p.id === projectIdA);
    assert.ok(projectA, '默认激活项目缺失');
    fs.mkdirSync(path.join(projectRoot, '创作资产库', projectA.folder, '竞态'), { recursive: true });
    const assetX = `${projectA.folder}/竞态/过期目标X.png`;
    const assetY = `${projectA.folder}/竞态/过期目标Y.png`;
    fs.writeFileSync(path.join(projectRoot, '创作资产库', assetX), PNG);
    fs.writeFileSync(path.join(projectRoot, '创作资产库', assetY), PNG);
    await window.evaluate(() => window.creatorAPI.setAssetPanel({ open: true }));
    assert.ok(await waitFor(panelReady, 12000, 80), '面板页未就绪');

    // 过期确定性：门闩 2500ms > TTL 800ms——X 先发（滞留过期），Y 覆盖 pending；
    // X 恢复时 pending=Y → superseded 让位；Y 恢复时自身已过期 → 可观察取消，面板不定位。
    const promiseX = creatorFocus(assetX, projectIdA);
    await new Promise(r => setTimeout(r, 120));
    const promiseY = creatorFocus(assetY, projectIdA);
    const [deliveredX, deliveredY] = await Promise.all([promiseX, promiseY]);
    results.xSuperseded = deliveredX?.delivered === 'superseded';
    results.yExpired = deliveredY?.delivered === 'expired';
    await new Promise(r => setTimeout(r, 400));
    const panel = await readPanel();
    results.panelNotLocated = panel === null || panel.previewOpen !== true;

    // 过期后新请求独立判定：新单发在门闩下同样过期，但 ok:true 且作废的是新目标自身
    const deliveredZ = await creatorFocus(assetY, projectIdA);
    results.zIndependentlyExpired = deliveredZ?.delivered === 'expired';
    results.zOkTrue = deliveredZ?.ok === true;

    const failedKeys = Object.keys(results).filter(key => results[key] !== true);
    if (failedKeys.length) throw new Error(`实例2 过期边界断言失败：${failedKeys.map(key => `${key}=${results[key]}`).join(', ')}`);
    console.log(`FOCUS_EXPIRE_PASS ${JSON.stringify(results)}`);
  } catch (error) {
    failed = true;
    console.error(`FOCUS_EXPIRE_FAIL ${error.message || error}`);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    if (!failed) { try { fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 5 }); } catch {} }
    else console.log(`DEBUG-RUNROOT-KEPT(测试失败，保留现场): ${runRoot}`);
  }
}

async function run() {
  await runInstance1();
  await runInstance2();
}

run();
