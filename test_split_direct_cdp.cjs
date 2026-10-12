'use strict';
// Only the spawned App, its exact localhost creator target and two local lab
// origins. Chromium payload transport is separate from physical OS dragging.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(50); }
  throw new Error('Timeout: ' + label);
}
class CDP {
  constructor(url) {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    this.ws = new WebSocket(url); this.seq = 0; this.pending = new Map();
    this.ready = new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); });
    this.ws.addEventListener('message', event => {
      const data = JSON.parse(event.data), pending = this.pending.get(data.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error.message)); else pending.resolve(data.result);
    });
  }
  async send(method, params = {}, sessionId) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.seq, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, 20000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression, sessionId) {
    const value = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: !sessionId }, sessionId);
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result?.value;
  }
  close() { this.ws.close(); }
}
async function main() {
  const executable = process.env.SPLIT_TEST_EXECUTABLE;
  assert.ok(executable && fs.existsSync(executable));
  const evidence = path.resolve(process.env.SPLIT_TEST_EVIDENCE); assert.equal(fs.existsSync(evidence), false); fs.mkdirSync(evidence, { recursive: true });
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-split-cdp-')));
  const project = path.join(temp, 'project'), profile = path.join(temp, 'profile'), data = path.join(temp, 'data'), obsidian = path.join(temp, 'obsidian');
  for (const dir of [path.join(project, '创作资产库'), data, obsidian]) fs.mkdirSync(dir, { recursive: true });
  const image = fs.readFileSync(path.join(__dirname, 'assets/ui/creator/image-system-identifier-v1.png'));
  const labs = [], report = { status: 'running', checks: {}, processes: [], scope: { formalDataTouched: false, isolated: true, externalTargetsAttached: 0, physicalOsDrag: false } };
  let child, exited, node, browser, native, renderer;
  const watchdog = setTimeout(() => child?.kill('SIGKILL'), 240000).unref();
  const lab = async role => {
    const server = http.createServer((req, res) => {
      if (req.url === '/asset.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(image); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><meta charset="utf-8"><title>双拼验收-${role}</title><style>body{margin:0;background:${role === 'left' ? '#dbedff' : '#fff0d9'};font:18px sans-serif}#text{position:fixed;left:20px;top:20px;width:160px;height:48px;background:#234;color:white}#image{position:fixed;left:20px;top:90px;width:96px;height:96px}#drop{position:fixed;left:220px;top:20px;width:200px;height:200px;border:3px dashed #345}#draft{position:fixed;left:20px;top:250px;width:310px;height:64px}body:after{content:'';display:block;height:1800px}</style><div id="text" draggable="true">${role} 文字</div><img id="image" src="/asset.png" draggable="true"><div id="drop">拖到这里</div><textarea id="draft"></textarea><script>window.__drops=[];window.__starts=[];document.getElementById('text').addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain','${role} 原始文字');e.dataTransfer.setData('text/html','<b>${role}</b>');window.__starts.push({kind:'text',trusted:e.isTrusted})});document.getElementById('image').addEventListener('dragstart',e=>window.__starts.push({kind:'image',trusted:e.isTrusted}));const zone=document.getElementById('drop');zone.addEventListener('dragover',e=>e.preventDefault());zone.addEventListener('drop',e=>{e.preventDefault();const row={trusted:e.isTrusted,types:[...e.dataTransfer.types],text:e.dataTransfer.getData('text/plain'),html:e.dataTransfer.getData('text/html'),uri:e.dataTransfer.getData('text/uri-list'),files:[...e.dataTransfer.files].map(f=>({name:f.name,size:f.size,type:f.type}))};window.__drops.push(row);zone.textContent='收到 '+(row.text||row.uri||row.files.map(f=>f.name).join(','));});</script></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); labs.push(server); return `http://127.0.0.1:${server.address().port}/?splitlab=${role}`;
  };
  const closeApp = async () => {
    if (!child) return;
    try { if (native) await native(({ app }) => { setTimeout(() => app.quit(), 50); return true; }); } catch {}
    node?.close(); browser?.close();
    if (!await Promise.race([exited.then(() => true), delay(5000).then(() => false)])) child.kill('SIGKILL');
    await Promise.race([exited, delay(2000)]); report.processes.at(-1).exited = child.exitCode !== null || child.signalCode !== null;
    child = node = browser = native = renderer = null;
  };
  try {
    const leftUrl = await lab('left'), rightUrl = await lab('right'); report.origins = [new URL(leftUrl).origin, new URL(rightUrl).origin];
    const portServer = net.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve)); const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
    const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0', VIDEO_OS_PORT: String(port), VIDEO_OS_PROJECT_ROOT: project, VIDEO_OS_TEST_PROJECT_ROOT: project, VIDEO_OS_DATA_DIR: data, VIDEO_OS_USER_DATA: profile, OBSIDIAN_VAULT_PATH: obsidian, VIDEO_OS_TEST_OBSIDIAN_VAULT: obsidian }; delete env.ELECTRON_RUN_AS_NODE;
    const launch = async () => {
      let nodeURL, browserURL, partial = '';
      child = spawn(executable, ['--inspect=0', '--remote-debugging-port=0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      report.processes.push({ pid: child.pid, exited: false }); exited = new Promise(resolve => child.once('exit', resolve));
      child.stderr.on('data', bytes => { partial += bytes; const lines = partial.split('\n'); partial = lines.pop(); for (const line of lines) { const n = line.match(/^Debugger listening on (ws:\/\/\S+)/), b = line.match(/^DevTools listening on (ws:\/\/\S+)/); if (n) nodeURL = n[1]; if (b) browserURL = b[1]; } });
      await until(() => nodeURL && browserURL, 'own endpoints'); node = new CDP(nodeURL); browser = new CDP(browserURL);
      native = (fn, arg) => node.evaluate(`(${fn.toString()})(require('electron'),${JSON.stringify(arg ?? null)})`);
      const target = await until(async () => (await browser.send('Target.getTargets')).targetInfos.find(item => { try { const url = new URL(item.url); return item.type === 'page' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === String(port) && url.pathname === '/creator.html'; } catch { return false; } }), 'exact local creator');
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }); await browser.send('Runtime.enable', {}, sessionId);
      renderer = (fn, arg) => browser.evaluate(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`, sessionId);
      await until(() => renderer(() => document.body?.dataset.ready === 'true'), 'ready creator');
      const runtime = await native(({ app }) => ({ pid: process.pid, version: app.getVersion(), packaged: app.isPackaged, profile: app.getPath('userData') }));
      assert.equal(runtime.pid, child.pid); assert.equal(runtime.version, process.env.SPLIT_TEST_VERSION || require('./package.json').version); assert.equal(runtime.packaged, true); assert.equal(fs.realpathSync(runtime.profile), fs.realpathSync(profile));
      const config = await renderer(() => window.creatorAPI.getConfig()); assert.equal(fs.realpathSync.native(config.paths.projectRoot), fs.realpathSync.native(project)); report.runtime = runtime; return config.browser;
    };
    const getState = () => renderer(async () => (await window.creatorAPI.getConfig()).browser);
    const surface = () => native(async ({ BrowserWindow, webContents }) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      const rows = []; for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed() || !wc.getURL().includes('splitlab=')) continue;
        const view = host.contentView.children.find(v => v.webContents === wc), prefs = wc.getLastWebPreferences();
        rows.push({ id: wc.id, url: wc.getURL(), visible: !!view?.getVisible(), bounds: view?.getBounds(), draft: await wc.executeJavaScript('document.getElementById("draft").value'), drops: await wc.executeJavaScript('window.__drops'), starts: await wc.executeJavaScript('window.__starts'), security: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, webSecurity: prefs.webSecurity, nodeIntegration: prefs.nodeIntegration } });
      } return { rows, windowId: host.getMediaSourceId(), bounds: host.getContentBounds() };
    });
    const first = await launch(), leftId = first.tabId;
    await renderer(url => window.creatorAPI.navigateUrl(url), leftUrl);
    const opened = await renderer(() => window.creatorAPI.openTab('gemini', 'image')), rightId = opened.tabId;
    await renderer(url => window.creatorAPI.navigateUrl(url), rightUrl);
    await until(async () => (await surface()).rows.length === 2, 'two local documents');
    await native(async ({ webContents }) => { for (const wc of webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getURL().includes('splitlab='))) await wc.executeJavaScript('document.getElementById("draft").value="保留草稿"'); });
    await renderer(id => window.creatorAPI.selectTab(id), leftId);
    await renderer(() => document.getElementById('splitViewToggle').click());
    await until(() => renderer(() => document.getElementById('splitPickerDialog').open), 'split chooser');
    await renderer(() => [...document.querySelectorAll('#splitPickerBody .split-picker-choice')].find(b => b.textContent.includes('Gemini')).click());
    await until(async () => (await getState()).split.enabled && (await surface()).rows.every(row => row.visible), 'both views visible');
    const before = await surface(); for (const row of before.rows) assert.deepEqual(row.security, { sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false });
    report.checks.realChooserAndTwoSecureNativeViews = true;
    if (process.env.SPLIT_CAPTURE_DIAGNOSTIC === '1') {
      report.captureProbe = await native(async ({ webContents, BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/creator.html'));
        const rows = [];
        for (const wc of webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getURL().includes('splitlab='))) {
          const bounds = host.contentView.children.find(v => v.webContents === wc).getBounds();
          for (const variant of ['default', 'undefined-options', 'rect-options']) {
            const start = Date.now();
            try {
              const capture = variant === 'default' ? wc.capturePage() : variant === 'undefined-options'
                ? wc.capturePage(undefined, { stayHidden: true, stayAwake: true })
                : wc.capturePage({ x: 0, y: 0, width: bounds.width, height: bounds.height }, { stayHidden: true, stayAwake: true });
              const image = await Promise.race([capture, new Promise(resolve => setTimeout(() => resolve(null), 1000))]);
              rows.push({ id: wc.id, variant, elapsed: Date.now() - start, size: image?.getSize(), empty: image?.isEmpty(), timeout: !image });
            } catch (error) { rows.push({ id: wc.id, variant, error: error.message }); }
          }
        } return rows;
      });
      report.status = 'capture-diagnostic'; console.log(JSON.stringify(report.captureProbe)); return;
    }
    await renderer(() => window.creatorAPI.setSplitRatio(0.35));
    const size = await surface(), left = size.rows.find(row => row.url.includes('splitlab=left')), right = size.rows.find(row => row.url.includes('splitlab=right'));
    assert.equal(right.bounds.x - left.bounds.x - left.bounds.width, 4); assert.ok(Math.abs(left.bounds.width / (left.bounds.width + right.bounds.width) - 0.35) < 0.01); report.checks.ratioAndNonOverlappingBounds = true;
    await renderer(() => window.creatorAPI.setSplitRatio(0.5));
    const backdrop = () => renderer(() => {
      const stage = document.getElementById('browserStage').getBoundingClientRect();
      const gutter = document.getElementById('splitGutter').getBoundingClientRect();
      return { hidden: document.getElementById('platformBackdropLayer').hidden,
        stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height },
        gutter: { x: gutter.x, y: gutter.y, width: gutter.width, height: gutter.height },
        color: getComputedStyle(document.getElementById('splitGutter')).backgroundColor,
        panes: [...document.querySelectorAll('#platformBackdropLayer .platform-backdrop-pane')].filter(p => !p.hidden).map(p => {
          const r = p.getBoundingClientRect(), img = p.querySelector('img');
          return { pane: p.dataset.pane, x: r.x, y: r.y, width: r.width, height: r.height, decoded: img.complete && img.naturalWidth > 0 };
        }) };
    });
    await renderer(() => document.getElementById('splitReplace').click());
    await until(async () => { const b = await backdrop(); return !b.hidden && b.panes.length === 2 && b.panes.every(p => p.decoded) && (await surface()).rows.every(r => !r.visible); }, 'pair-aware backdrop');
    report.backdrops = [];
    for (const dimensions of [[1261, 861], [1437, 917]]) {
      await native(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/creator.html')).setContentSize(...size), dimensions);
      await delay(220);
      const b = await until(async () => { const v = await backdrop(); return !v.hidden && v.panes.length === 2 && v.panes.every(p => p.decoded) && Math.abs(v.panes[1].x - v.panes[0].x - v.panes[0].width - 4) < 0.15 ? v : false; }, 'resized paired background');
      assert.equal(b.color, 'rgb(217, 217, 222)'); assert.equal(b.gutter.width, 4);
      assert.ok(Math.abs(b.panes[0].x - b.stage.x) < .15); assert.ok(Math.abs(b.panes[1].x + b.panes[1].width - b.stage.x - b.stage.width) < .15);
      assert.ok(Math.abs(b.gutter.x - b.panes[0].x - b.panes[0].width) < .55);
      report.backdrops.push(b);
    }
    const hostImage = await native(async ({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/creator.html'));
      return (await host.webContents.capturePage()).toDataURL();
    });
    fs.writeFileSync(path.join(evidence, 'paired-modal-background.png'), Buffer.from(hostImage.split(',')[1], 'base64'));
    await renderer(() => document.getElementById('splitPickerDialog').close());
    await until(async () => (await backdrop()).hidden && (await surface()).rows.every(r => r.visible), 'cancel restores both native pages');
    const restoredPair = await surface(); assert.deepEqual(restoredPair.rows.map(r => [r.id, r.draft]).sort(), before.rows.map(r => [r.id, r.draft]).sort());
    for (const row of restoredPair.rows) assert.equal(row.bounds.width + 4 + restoredPair.rows.find(r => r.id !== row.id).bounds.width, Math.round((await backdrop()).stage.width));
    // Delayed capture may not re-hide either native pane after a rapid cancel.
    await native(({ webContents }) => {
      for (const wc of webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getURL().includes('splitlab='))) {
        wc.__capture = wc.capturePage.bind(wc); wc.capturePage = (...args) => wc.__capture(...args).then(image => new Promise(resolve => setTimeout(() => resolve(image), 130)));
      }
    });
    await renderer(async () => { const opening = window.creatorAPI.setPlatformViewHidden(true); const closing = window.creatorAPI.setPlatformViewHidden(false); await Promise.all([opening, closing]); });
    await delay(220); assert.equal((await backdrop()).hidden, true); assert.ok((await surface()).rows.every(r => r.visible));
    await native(({ webContents }) => { for (const wc of webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getURL().includes('splitlab='))) { wc.capturePage = wc.__capture; delete wc.__capture; } });
    report.checks.pairBackdropResizeCancelAndLateCapture = true;
    report.assetPanelRequest = await renderer(() => window.creatorAPI.setAssetPanel({ open: true, layout: 'push', width: 420 }));
    await until(() => native(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().includes('/creator-assets.html'));
      return wc && !wc.isLoading() && await wc.executeJavaScript('document.body?.dataset.ready === "true"');
    }), 'local asset panel');
    await renderer(() => document.getElementById('splitReplace').click());
    const pushed = await until(async () => { const b = await backdrop(); return !b.hidden && b.panes.length === 3 && (await surface()).rows.every(r => !r.visible) ? b : false; }, 'two pages and pushed asset backdrop');
    const asset = pushed.panes.find(p => p.pane === 'asset'), pushedRight = pushed.panes.find(p => p.pane === 'right');
    assert.ok(Math.abs(pushedRight.x + pushedRight.width - asset.x) < .15);
    assert.ok(Math.abs(asset.x + asset.width - pushed.stage.x - pushed.stage.width) < .15);
    assert.ok(Math.abs(pushed.gutter.x - pushed.panes[0].x - pushed.panes[0].width) < .55);
    await renderer(() => document.getElementById('splitPickerDialog').close());
    await until(async () => (await backdrop()).hidden && (await surface()).rows.every(r => r.visible), 'asset dialog restore');
    await renderer(() => window.creatorAPI.setAssetPanel({ open: false }));
    report.checks.pushedAssetPanelDoesNotCropSecondPage = true;
    // An unavailable capture keeps an opaque pane, not a hole into the host.
    await native(({ webContents }) => {
      const wc = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().includes('splitlab=right'));
      wc.__capture = wc.capturePage.bind(wc); wc.capturePage = () => Promise.reject(new Error('isolated capture failure'));
    });
    await renderer(() => document.getElementById('splitReplace').click());
    const fallback = await until(async () => { const b = await backdrop(); return !b.hidden && b.panes.length === 2 && !b.panes[1].decoded && (await surface()).rows.every(r => !r.visible) ? b : false; }, 'opaque failed capture fallback');
    assert.equal(await renderer(() => getComputedStyle(document.querySelector('[data-pane="right"]')).backgroundColor), 'rgb(255, 255, 255)');
    await renderer(() => document.getElementById('splitPickerDialog').close());
    await until(async () => (await backdrop()).hidden && (await surface()).rows.every(r => r.visible), 'fallback cancel restores pages');
    await native(({ webContents }) => {
      const wc = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().includes('splitlab=right'));
      wc.capturePage = wc.__capture; delete wc.__capture;
    });
    report.checks.captureFailureHasOpaqueFallbackAndRestores = true;
    const thirdUrl = await lab('third');
    const third = await renderer(() => window.creatorAPI.openTab('gpt', 'image'));
    await renderer(url => window.creatorAPI.navigateUrl(url), thirdUrl);
    await until(async () => (await surface()).rows.some(r => r.url === thirdUrl), 'third local page');
    await renderer(ids => window.creatorAPI.setSplitView({ enabled: true, primaryTabId: ids.leftId, secondaryTabId: ids.rightId }), { leftId, rightId });
    await renderer(() => document.getElementById('splitReplace').click());
    await until(async () => !(await backdrop()).hidden, 'replacement chooser background');
    await renderer(() => [...document.querySelectorAll('#splitPickerBody .split-picker-choice')].find(b => b.querySelector('.split-picker-name')?.textContent === 'GPT 图片·2').click());
    await until(async () => (await getState()).split.rightTabId === third.tabId && (await surface()).rows.filter(r => r.visible).length === 2, 'replaced second native page');
    const replaced = await surface(); assert.equal(replaced.rows.find(r => r.url === leftUrl).id, before.rows.find(r => r.url === leftUrl).id);
    assert.equal(replaced.rows.find(r => r.url === rightUrl).visible, false);
    await renderer(ids => window.creatorAPI.setSplitView({ enabled: true, primaryTabId: ids.leftId, secondaryTabId: ids.rightId }), { leftId, rightId });
    await renderer(id => window.creatorAPI.closeTab(id), third.tabId);
    await until(async () => (await surface()).rows.length === 2 && (await surface()).rows.every(r => r.visible), 'original pair restored');
    report.checks.realSecondPageReplacementKeepsFirstPage = true;
    await renderer(() => document.getElementById('collapseMaterialSidebar').click());
    await until(async () => (await surface()).rows.every(r => r.visible) && (await surface()).rows.find(r => r.url === leftUrl).bounds.x === 48, 'collapsed sidebar resizes real pages');
    const previousDocument = await renderer(() => performance.timeOrigin);
    await native(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/creator.html')).webContents.reload());
    await until(() => renderer(old => performance.timeOrigin > old && document.body?.dataset.ready === 'true' && document.body.classList.contains('prompt-collapsed') && !!document.getElementById('collapseMaterialSidebar'), previousDocument), 'sidebar state restored after reload');
    await renderer(() => document.getElementById('collapseMaterialSidebar').click());
    await until(async () => (await surface()).rows.every(r => r.visible) && (await surface()).rows.find(r => r.url === leftUrl).bounds.x > 250, 'sidebar restored with both pages');
    assert.deepEqual((await surface()).rows.map(r => [r.id, r.draft]).sort(), before.rows.map(r => [r.id, r.draft]).sort());
    report.checks.sidebarCollapseReloadExpandKeepsNativePages = true;
    report.chromiumDrag = [];
    for (const from of process.env.SPLIT_LAYOUT_ONLY === '1' ? [] : ['left', 'right']) for (const kind of ['text', 'image']) {
      try {
      const result = await native(async ({ webContents }, { from, kind, origins }) => {
        const own = webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getURL().includes('splitlab=') && origins.includes(new URL(w.getURL()).origin));
        const source = own.find(w => new URL(w.getURL()).searchParams.get('splitlab') === from), target = own.find(w => w !== source);
        let captured; source.debugger.attach('1.3'); target.debugger.attach('1.3');
        const listener = (_event, method, params) => { if (method === 'Input.dragIntercepted') captured = params.data; }; source.debugger.on('message', listener);
        try {
          await source.debugger.sendCommand('Input.setInterceptDrags', { enabled: true });
          const y = kind === 'text' ? 40 : 130;
          await source.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y, button: 'left', buttons: 1, clickCount: 1 });
          await source.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 90, y: y + 10, button: 'left', buttons: 1 });
          for (let i = 0; i < 100 && !captured; i++) await new Promise(r => setTimeout(r, 20));
          if (!captured) throw new Error('No source Chromium drag payload');
          await source.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 90, y: y + 10, button: 'left', buttons: 0, clickCount: 1 });
          for (const type of ['dragEnter', 'dragOver', 'drop']) await target.debugger.sendCommand('Input.dispatchDragEvent', { type, x: 270, y: 100, data: captured });
          const drop = await target.executeJavaScript('window.__drops.at(-1)');
          return { from, kind, payloadTypes: captured.items.map(item => item.mimeType), drop, method: 'genuine source Chromium payload, target CDP dispatch; not OS physical proof' };
        } finally { source.debugger.removeListener('message', listener); if (source.debugger.isAttached()) source.debugger.detach(); if (target.debugger.isAttached()) target.debugger.detach(); }
      }, { from, kind, origins: report.origins });
      if (kind === 'text') assert.equal(result.drop.text, from + ' 原始文字'); else assert.ok(result.drop.uri.startsWith(report.origins[from === 'left' ? 0 : 1] + '/asset.png'));
      report.chromiumDrag.push(result);
      } catch (error) { report.chromiumDrag.push({ from, kind, error: error.message, passed: false }); }
    }
    report.checks.bidirectionalChromiumTextAndImageUriPayloads = report.chromiumDrag.length === 4 && report.chromiumDrag.every(row => !row.error);
    if (process.env.SPLIT_PHYSICAL_PROBE === '1') {
      await native(async ({ webContents, BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/creator.html')); host.setContentSize(1200, 760); host.show(); host.focus();
        for (const wc of webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getURL().includes('splitlab='))) await wc.executeJavaScript('window.__drops=[];window.__starts=[]');
      });
      await delay(150); const info = await surface(); fs.writeFileSync(path.join(evidence, 'physical-ready.json'), JSON.stringify(info, null, 2));
      console.log('SPLIT_PHYSICAL_READY ' + path.join(evidence, 'physical-ready.json'));
      await until(async () => { fs.writeFileSync(path.join(evidence, 'physical-progress.json'), JSON.stringify(await surface(), null, 2)); return fs.existsSync(path.join(evidence, 'continue')); }, 'physical probe', 120000);
      report.physical = await surface(); report.scope.physicalOsDrag = report.physical.rows.some(row => row.drops.length > 0);
    }
    await renderer(() => document.getElementById('splitClose').click()); await until(async () => !(await getState()).split.enabled, 'exit split');
    const after = await surface(); assert.deepEqual(after.rows.map(r => [r.id, r.draft]).sort(), before.rows.map(r => [r.id, r.draft]).sort()); report.checks.closePreservesBothDocumentsAndDrafts = true;
    await closeApp(); await launch();
    const restored = await getState(); assert.ok(restored.tabs.some(t => t.id === leftId && t.url === leftUrl)); assert.ok(restored.tabs.some(t => t.id === rightId && t.url === rightUrl)); assert.equal(restored.split.enabled, false);
    await renderer(ids => window.creatorAPI.setSplitView({ enabled: true, primaryTabId: ids.leftId, secondaryTabId: ids.rightId }), { leftId, rightId });
    await until(async () => (await surface()).rows.length === 2 && (await surface()).rows.every(r => r.visible), 'restored split views'); report.checks.restartKeepsBothTabsAndCanSplitAgain = true;
    report.status = process.env.SPLIT_LAYOUT_ONLY === '1' ? 'layout-passed-drag-not-tested' : report.checks.bidirectionalChromiumTextAndImageUriPayloads || report.scope.physicalOsDrag ? 'passed' : 'behavior-passed-drag-unverified';
    report.scope.imageFileUploadProven = false; console.log('SPLIT_DIRECT_CDP_' + report.status.toUpperCase());
  } catch (error) {
    report.status = 'failed'; report.failure = error.stack; console.error(error); process.exitCode = 1;
    if (renderer) report.diagnostics = await renderer(async () => ({panel:(await window.creatorAPI.getConfig()).panel,
      dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.id),backdropHidden:document.getElementById('platformBackdropLayer').hidden,
      panes:[...document.querySelectorAll('#platformBackdropLayer .platform-backdrop-pane')].map(p=>({pane:p.dataset.pane,hidden:p.hidden,
        image:p.querySelector('img')?.getAttribute('src')?.slice(0,40),decoded:p.querySelector('img')?.naturalWidth}))})).catch(()=>null);
  }
  finally {
    clearTimeout(watchdog); await closeApp().catch(() => {});
    for (const server of labs) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify(report, null, 2));
    await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main();
