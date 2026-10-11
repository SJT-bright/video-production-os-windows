'use strict';

// Real Chromium file inputs and native-like drag data, with the production
// configureSession controller. HTTPS is intercepted inside an isolated Session:
// no ChatGPT account, remote request, or installed App is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixtureOrigin = 'https://chatgpt.com';
const fixturePath = '/video-os-file-access-fixture';
const baselineRef = process.env.CREATOR_FILE_ACCESS_BASELINE_REF || 'b5e9072';
const payload = 'Video OS isolated character source fixture.\n';
const html = `<!doctype html><meta charset="utf-8"><title>Isolated file access fixture</title>
<input id="file" type="file"><button id="restore">Read persisted selected file</button><div id="drop" style="margin:24px;width:360px;height:180px;border:2px dashed blue">Drop fixture</div>
<script>
window.fixture = { input: null, drop: null, restored: null, persistHandle: false };
function selectedFileDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('fixture-selected-file', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function rememberHandle(handle) {
  const db = await selectedFileDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(handle, 'source');
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function rememberedHandle() {
  const db = await selectedFileDatabase();
  const handle = await new Promise((resolve, reject) => {
    const request = db.transaction('handles').objectStore('handles').get('source');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close(); return handle;
}
async function readAndUpload(file) {
  const text = await file.text();
  const form = new FormData(); form.append('source', file);
  const response = await fetch('/fixture-upload', { method: 'POST', body: form });
  return { text, status: response.status, receipt: await response.json() };
}
document.querySelector('#file').addEventListener('change', async event => {
  try { window.fixture.input = await readAndUpload(event.target.files[0]); }
  catch (error) { window.fixture.input = { error: error.name, message: error.message }; }
});
document.querySelector('#drop').addEventListener('dragover', event => { event.preventDefault(); });
document.querySelector('#drop').addEventListener('drop', async event => {
  event.preventDefault();
  const item = event.dataTransfer.items[0];
  // Obtain the promise synchronously, while the drop event's data store is live.
  const handlePromise = item.getAsFileSystemHandle();
  let initialPermission, permission;
  try {
    const handle = await handlePromise;
    if (!handle) throw new Error('No real file system handle from Chromium drag data');
    if (window.fixture.persistHandle) await rememberHandle(handle);
    initialPermission = await handle.queryPermission({ mode: 'read' });
    permission = await handle.requestPermission({ mode: 'read' });
    const file = await handle.getFile();
    window.fixture.drop = { initialPermission, permission, ...(await readAndUpload(file)) };
  } catch (error) { window.fixture.drop = { initialPermission, permission, error: error.name, message: error.message }; }
});
document.querySelector('#restore').addEventListener('click', async () => {
  try {
    const handle = await rememberedHandle();
    const initialPermission = await handle.queryPermission({ mode: 'read' });
    const permission = await handle.requestPermission({ mode: 'read' });
    const file = await handle.getFile();
    window.fixture.restored = { initialPermission, permission, ...(await readAndUpload(file)) };
  } catch (error) { window.fixture.restored = { error: error.name, message: error.message }; }
});
</script>`;

async function launchFixture() {
  const { app, BrowserWindow, session, ipcMain } = require('electron');
  const vm = require('node:vm');
  app.setName('Video OS isolated file access test');
  app.setPath('userData', process.env.CREATOR_FILE_ACCESS_TEST_PROFILE);
  app.disableHardwareAcceleration();
  await app.whenReady();
  const ses = session.fromPartition('persist:file-access-isolated');
  const probe = globalThis.__fileAccessProbe = { requests: [], permissions: [], diagnostics: [], authorizations: [] };
  const { authorizeSelectedCreatorFileRead } = require('./electron/creator-file-access.cjs');
  ipcMain.on('creator:selected-file-read', (event, paths) => {
    const started = performance.now();
    const allowed = authorizeSelectedCreatorFileRead(event, paths);
    probe.authorizations.push({ allowed, selectedCount: paths.length,
      elapsedMs: Number((performance.now() - started).toFixed(3)) });
  });
  await ses.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (url.origin !== fixtureOrigin) throw new Error('No external domains in the fixture');
    if (url.pathname === fixturePath) return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    if (url.pathname === '/fixture-upload' && request.method === 'POST') {
      const body = Buffer.from(await request.arrayBuffer());
      const containsFixture = body.includes(Buffer.from(payload));
      probe.requests.push({ method: request.method, containsFixture,
        multipart: String(request.headers.get('content-type')).startsWith('multipart/form-data; boundary=') });
      return new Response(JSON.stringify({ containsFixture }), { status: 200,
        headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Fixture only', { status: 403 });
  });
  const check = ses.setPermissionCheckHandler.bind(ses);
  const ask = ses.setPermissionRequestHandler.bind(ses);
  ses.setPermissionCheckHandler = handler => check((contents, permission, origin, details) => {
    const result = handler(contents, permission, origin, details);
    if (permission === 'fileSystem') probe.permissions.push({ phase: 'check', origin,
      fileAccessType: details.fileAccessType, isDirectory: details.isDirectory, allowed: result,
      hasContents: !!contents, fieldNames: Object.keys(details),
      hasFilePath: typeof details.filePath === 'string' && details.filePath.length > 0,
      absoluteFilePath: typeof details.filePath === 'string' && path.isAbsolute(details.filePath),
      topOrigin: contents ? new URL(contents.getURL()).origin : null,
      requestingUrlOrigin: details.requestingUrl ? new URL(details.requestingUrl).origin : null });
    return result;
  });
  ses.setPermissionRequestHandler = handler => ask((contents, permission, callback, details) => {
    handler(contents, permission, result => {
      if (permission === 'fileSystem') probe.permissions.push({ phase: 'request',
        fileAccessType: details.fileAccessType, isDirectory: details.isDirectory, allowed: result });
      callback(result);
    }, details);
  });
  const source = process.env.CREATOR_FILE_ACCESS_EXPECT_DENIED === '1'
    ? require('node:child_process').execFileSync('git', ['show', `${baselineRef}:electron/main.cjs`], { cwd: __dirname, encoding: 'utf8' })
    : fs.readFileSync(path.join(__dirname, 'electron/main.cjs'), 'utf8');
  const start = source.indexOf('function configureSession(');
  const end = source.indexOf('\nasync function copyFileWithProgress(', start);
  assert.ok(start >= 0 && end > start, 'Production configureSession boundary is required');
  const context = vm.createContext({
    require, process, path, __dirname: path.join(__dirname, 'electron'),
    configuredSessions: new Set(), CREATOR_BROWSER_UA: app.userAgentFallback,
    logDiagnostic: (scope, message) => probe.diagnostics?.push({ scope, message }),
    ...require('./electron/creator-file-access.cjs'),
  });
  vm.runInContext(source.slice(start, end), context, { filename: 'main.cjs:file-access-fixture' });
  context.configureSession('gpt', ses);
  const win = new BrowserWindow({ show: false, width: 720, height: 480,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
  globalThis.__fileAccessWindow = win;
  await win.loadURL(fixtureOrigin + fixturePath);
}

async function run() {
  const { _electron } = require('playwright');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-file-access-'));
  const file = path.join(temp, '人物来源.txt');
  const inputFile = path.join(temp, '选择来源.txt');
  fs.writeFileSync(file, payload);
  fs.writeFileSync(inputFile, payload);
  const evidence = path.join(__dirname, 'test-artifacts', `creator-file-access-native-${Date.now()}-${process.pid}.json`);
  let app;
  const report = { status: 'running', runKind: process.env.CREATOR_FILE_ACCESS_EXPECT_DENIED === '1' ? 'baseline' : 'fixed',
    baselineRef: process.env.CREATOR_FILE_ACCESS_EXPECT_DENIED === '1' ? baselineRef : null,
    scope: { isolatedSession: true, network: 'intercepted fixture only',
    realChatGPTTested: false, installedAppChanged: false }, checks: {} };
  try {
    const env = { ...process.env, CREATOR_FILE_ACCESS_TEST_PROFILE: path.join(temp, 'profile') };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ args: [__filename], env, timeout: 30000 });
    let page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.waitForLoadState('networkidle');
    await page.locator('#file').setInputFiles(inputFile);
    await page.waitForFunction(() => window.fixture.input !== null);
    report.input = await page.evaluate(() => window.fixture.input);
    assert.equal(report.input.text, payload, 'Standard selected file must retain its bytes');
    assert.equal(report.input.status, 200);
    assert.equal(report.input.receipt.containsFixture, true);
    report.checks.fileInputAndMultipartUpload = true;
    const dragFile = () => app.evaluate(async (_electron, fixtureFile) => {
        const contents = globalThis.__fileAccessWindow.webContents;
        contents.debugger.attach('1.3');
        const data = { items: [], files: [fixtureFile], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await contents.debugger.sendCommand('Input.dispatchDragEvent', { type, x: 100, y: 120, data });
        }
        contents.debugger.detach();
      }, file);
    await dragFile();
    await page.waitForFunction(() => window.fixture.drop !== null);
    report.drop = await page.evaluate(() => window.fixture.drop);
    report.probe = await app.evaluate(() => globalThis.__fileAccessProbe);
    if (process.env.CREATOR_FILE_ACCESS_EXPECT_DENIED === '1') {
      assert.equal(report.drop.error, 'NotAllowedError');
      assert.ok(report.probe.permissions.some(entry => entry.allowed === false));
      report.checks.oldPolicyDeniedImmediateNativeHandle = true;
    } else {
      assert.equal(report.drop.text, payload, 'A newly dropped file must be readable');
      assert.equal(report.drop.status, 200);
      assert.equal(report.drop.receipt.containsFixture, true);
      report.checks.immediateNativeHandleReadAndMultipartUpload = true;
    }
    await page.evaluate(() => { window.fixture.persistHandle = true; window.fixture.drop = null; });
    await dragFile();
    await page.waitForFunction(() => window.fixture.drop !== null);
    report.deferredDrop = await page.evaluate(() => window.fixture.drop);
    report.deferredProbe = await app.evaluate(() => globalThis.__fileAccessProbe);
    if (process.env.CREATOR_FILE_ACCESS_EXPECT_DENIED === '1') {
      assert.equal(report.deferredDrop.error, 'NotAllowedError', 'Old policy must deny the actual deferred native handle read');
      assert.ok(report.deferredProbe.permissions.some(entry => entry.allowed === false));
      report.checks.oldPolicyDeniedDeferredNativeHandle = true;
      report.status = 'PASS';
      return;
    }
    assert.equal(report.deferredDrop.text, payload, 'Deferred selected file must retain its bytes');
    assert.equal(report.deferredDrop.status, 200);
    assert.equal(report.deferredDrop.permission, 'granted');
    assert.equal(report.deferredDrop.receipt.containsFixture, true);
    report.checks.deferredNativeHandleReadAndMultipartUpload = true;
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#restore').click();
    await page.waitForFunction(() => window.fixture.restored !== null);
    report.unselectedAfterNavigation = await page.evaluate(() => window.fixture.restored);
    assert.equal(report.unselectedAfterNavigation.error, 'NotAllowedError', 'Full same-origin navigation revokes old selected-path grants');
    report.checks.persistedUnselectedHandleDeniedAfterNavigation = true;
    await page.evaluate(() => { window.fixture.persistHandle = true; window.fixture.drop = null; window.fixture.restored = null; });
    await dragFile();
    await page.waitForFunction(() => window.fixture.drop !== null);
    report.reselectedAfterNavigation = await page.evaluate(() => window.fixture.drop);
    assert.equal(report.reselectedAfterNavigation.text, payload, 'Fresh native selection reauthorizes the new document');
    assert.equal(report.reselectedAfterNavigation.status, 200);
    report.checks.freshNativeSelectionAfterNavigation = true;
    await app.close(); app = null;
    app = await _electron.launch({ args: [__filename], env, timeout: 30000 });
    page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.waitForLoadState('networkidle');
    await page.locator('#restore').click();
    await page.waitForFunction(() => window.fixture.restored !== null);
    report.unselectedAfterRestart = await page.evaluate(() => window.fixture.restored);
    assert.equal(report.unselectedAfterRestart.error, 'NotAllowedError', 'Old persisted handles must not gain arbitrary read access');
    report.checks.persistedUnselectedHandleDeniedAfterRestart = true;
    await page.evaluate(() => { window.fixture.persistHandle = true; window.fixture.drop = null; window.fixture.restored = null; });
    await dragFile();
    await page.waitForFunction(() => window.fixture.drop !== null);
    await page.locator('#restore').click();
    await page.waitForFunction(() => window.fixture.restored !== null);
    report.restored = await page.evaluate(() => window.fixture.restored);
    report.restoreProbe = await app.evaluate(() => globalThis.__fileAccessProbe);
    assert.equal(report.restored.text, payload, 'Restored file handle must retain its bytes');
    assert.equal(report.restored.status, 200);
    assert.equal(report.restored.permission, 'granted');
    assert.equal(report.restored.receipt.containsFixture, true);
    report.checks.restoredNativeHandleReadAndMultipartUpload = true;
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.error = error.message;
    throw error;
  } finally {
    await app?.close().catch(() => {});
    fs.mkdirSync(path.dirname(evidence), { recursive: true });
    fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`CREATOR_FILE_ACCESS_${report.status} ${evidence}`);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.versions.electron) launchFixture().catch(error => { console.error(error.stack); require('electron').app.exit(1); });
else run().catch(error => { console.error(error.stack); process.exitCode = 1; });
