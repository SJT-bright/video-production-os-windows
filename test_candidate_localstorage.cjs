'use strict';

// 双进程实测：已关闭源 fixture 的 LevelDB clone → 独立候选 session → 新 origin。
// live 正式 profile 的一致性依然只标为未保证。
if (process.versions.electron) {
  const { app, BrowserWindow, session } = require('electron');
  app.setPath('userData', process.env.CANDIDATE_TEST_PROFILE);
  globalThis.candidateStorageMigrate = require('./electron/candidate-workspace.cjs').migrateCandidateLocalStorage;
  globalThis.candidateStorageProbe = async ({ origin, write }) => {
    const bootstrap = new URL('/__fixture_storage', origin).href;
    session.defaultSession.protocol.handle('http', request => new Response(
      request.url === bootstrap ? '<!doctype html><title>Fixture</title>' : 'blocked',
      { status: request.url === bootstrap ? 200 : 403, headers: { 'Content-Type': 'text/html' } }));
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await window.loadURL(bootstrap);
      if (write) await window.webContents.executeJavaScript(`(() => { for (const [key, value] of ${JSON.stringify(write)}) localStorage.setItem(key, value); })()`);
      return await window.webContents.executeJavaScript('Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]))');
    } finally { window.destroy(); session.defaultSession.protocol.unhandle('http'); }
  };
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => { globalThis.candidateStorageFixtureReady = true; });
} else {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const http = require('node:http');
  const { _electron } = require('playwright');
  const { cloneTree } = require('./prepare-candidate-workspace.cjs');
  (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vos-candidate-storage-'));
    let app;
    let requested = 0;
    const server = http.createServer((req, res) => { requested += 1; res.end('must not be requested'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const sourceOrigin = `http://localhost:${server.address().port}`;
    const targetOrigin = `http://localhost:${server.address().port + 1}`;
    const laterOrigin = `http://localhost:${server.address().port + 2}`;
    const key = 'videoOS.creator.project.v2.project-fixture';
    const originalRoot = path.join(root, 'original-workspace');
    const candidateRoot = path.join(root, 'candidate-profile/workspace');
    const oldValue = JSON.stringify({ promptTemplates: { image: [{ title: '模板', body: '合成测试内容' }], video: [] },
      scripts: { groups: [{ segments: ['合成剧本文本'] }] }, file: originalRoot + '/创作资产库/ref.png' });
    const launch = async profile => {
      const child = await _electron.launch({ args: [__filename], timeout: 30000,
        env: { ...process.env, CANDIDATE_TEST_PROFILE: profile, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
      await child.evaluate(async () => { while (!globalThis.candidateStorageFixtureReady) await new Promise(resolve => setTimeout(resolve, 20)); });
      return child;
    };
    try {
      const originalProfile = path.join(root, 'original-profile');
      app = await launch(originalProfile);
      await app.evaluate(async ({ session }, { sourceOrigin, key, oldValue }) => {
        await globalThis.candidateStorageProbe({ origin: sourceOrigin, write: [[key, oldValue], ['website.auth.fake', 'exclude-me']] });
        await session.defaultSession.flushStorageData();
      }, { sourceOrigin, key, oldValue });
      await app.close(); app = null;
      const profile = path.join(root, 'candidate-profile');
      fs.mkdirSync(profile);
      cloneTree(path.join(originalProfile, 'Local Storage'), path.join(profile, 'Local Storage'),
        { files: 0, logicalBytes: 0, changedDuringCopy: 0 }, '测试状态', name => name === 'LOCK');
      fs.writeFileSync(path.join(profile, 'candidate-seed.json'), JSON.stringify({ sourceProject: originalRoot, candidateWorkspace: candidateRoot,
        localStorage: { liveCopyConsistency: 'fixture closed before clone' } }));
      app = await launch(profile);
      const receipt = await app.evaluate(async (_, options) => globalThis.candidateStorageMigrate(options),
        { userData: profile, sourceOrigin, targetOrigin });
      assert.equal(receipt.copied, 1); assert.equal(receipt.externalSourceRequested, false);
      const readback = await app.evaluate(async (_, origin) => globalThis.candidateStorageProbe({ origin }), targetOrigin);
      const preserved = JSON.parse(readback[key]);
      assert.equal(preserved.promptTemplates.image[0].body, '合成测试内容');
      assert.deepEqual(preserved.scripts.groups[0].segments, ['合成剧本文本']);
      assert.equal(preserved.file, candidateRoot + '/创作资产库/ref.png');
      assert.equal(readback['website.auth.fake'], undefined);
      const newValue = JSON.stringify({ candidateCreation: 'NEW-KEEP' });
      await app.evaluate(async (_, { targetOrigin, key, newValue }) => globalThis.candidateStorageProbe({ origin: targetOrigin, write: [[key, newValue]] }),
        { targetOrigin, key, newValue });
      await app.evaluate(async (_, options) => globalThis.candidateStorageMigrate(options),
        { userData: profile, sourceOrigin, targetOrigin: laterOrigin });
      const later = await app.evaluate(async (_, origin) => globalThis.candidateStorageProbe({ origin }), laterOrigin);
      assert.equal(later[key], newValue, '端口再次变化必须保留候选的新创作');
      await app.evaluate(async (_, options) => globalThis.candidateStorageMigrate(options),
        { userData: profile, sourceOrigin, targetOrigin: sourceOrigin });
      const backToOldOrigin = await app.evaluate(async (_, origin) => globalThis.candidateStorageProbe({ origin }), sourceOrigin);
      assert.equal(backToOldOrigin[key], newValue, '回到已克隆的原端口必须使用候选最新状态');
      assert.equal(requested, 0, '状态迁移不能请求源 HTTP 服务');
      assert.equal(await app.evaluate(({ session }) => session.defaultSession.protocol.isProtocolHandled('http')), false);
      await app.close(); app = null;
      const sameProfile = path.join(root, 'same-origin-profile');
      fs.mkdirSync(sameProfile);
      cloneTree(path.join(originalProfile, 'Local Storage'), path.join(sameProfile, 'Local Storage'),
        { files: 0, logicalBytes: 0, changedDuringCopy: 0 }, '同端口测试状态', name => name === 'LOCK');
      fs.writeFileSync(path.join(sameProfile, 'candidate-seed.json'), JSON.stringify({ sourceProject: originalRoot, candidateWorkspace: candidateRoot }));
      app = await launch(sameProfile);
      await app.evaluate(async (_, options) => globalThis.candidateStorageMigrate(options),
        { userData: sameProfile, sourceOrigin, targetOrigin: sourceOrigin });
      const sameOrigin = await app.evaluate(async (_, origin) => globalThis.candidateStorageProbe({ origin }), sourceOrigin);
      assert.equal(JSON.parse(sameOrigin[key]).file, candidateRoot + '/创作资产库/ref.png', '首启同端口也须重映射clone路径');
      assert.equal(requested, 0);
      console.log('CANDIDATE_LOCAL_STORAGE_PASS separateProfile=true templateAndScriptReadback=true originalHttpRequests=0 candidateNewStatePreserved=true handlerRemoved=true');
    } finally {
      if (app) await app.close();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
