'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { createCreativeProjectStore } = require('./creative-projects.cjs');

async function until(read, label) {
  const deadline = Date.now() + 15000;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}

async function run() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vos-project-web-'));
  const projectRoot = path.join(root, 'project'), profile = path.join(root, 'profile');
  const dataDir = path.join(root, 'data'), obsidian = path.join(root, 'obsidian');
  for (const dir of [projectRoot, profile, dataDir, obsidian]) fs.mkdirSync(dir);
  let app, page;
  try {
    const projectStore = createCreativeProjectStore({
      filePath: path.join(dataDir, 'creative-projects.json'),
      assetRoot: path.join(projectRoot, '创作资产库'),
    });
    const alpha = projectStore.create({ name: '逼我退差价' });
    const beta = projectStore.create({ name: '独立剧本乙' });
    const portProbe = net.createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    const origin = 'http://127.0.0.1:' + port;
    const url = label => origin + '/creator-fixture.html?service=gpt&record=' + label;
    const legacy = {
      schemaVersion: 1, activeMode: 'video',
      initializedModes: { image: true, video: true },
      lastModeTabs: { image: null, video: 'a2' },
      tabs: ['a1', 'a2'].map((id, index) => ({ id, mode: 'video', serviceId: 'gpt',
        url: url(id), customName: '记录' + (index + 1), ...(index ? {} : { pinned: true }) })),
    };
    const legacyPath = path.join(profile, 'creator-browser-session.json');
    const scopedPath = path.join(profile, 'creator-project-browser-sessions.json');
    fs.writeFileSync(legacyPath, JSON.stringify(legacy));
    const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0',
      VIDEO_OS_USER_DATA: profile, VIDEO_OS_PORT: String(port), VIDEO_OS_DATA_DIR: dataDir,
      VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      OBSIDIAN_VAULT_PATH: obsidian, VIDEO_OS_TEST_OBSIDIAN_VAULT: obsidian };
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = async () => {
      app = await _electron.launch({ args: [__dirname], env, timeout: 30000 });
      page = await until(() => app.windows().find(candidate => new URL(candidate.url(), origin).pathname === '/creator.html'), 'creator host');
      await page.waitForFunction(() => document.body.dataset.ready === 'true');
      assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
    };
    const browser = () => page.evaluate(async () => (await window.creatorAPI.getConfig()).browser);
    const switchNative = id => page.evaluate(id => window.creatorAPI.selectProject({ projectId: id, mode: 'image' }), id);
    const switchHttp = body => page.evaluate(async body => {
      const res = await fetch('/api/creative-projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      const reply = await res.json();
      if (!res.ok) throw Error(reply.error);
      return reply.project;
    }, body);
    const visible = name => page.waitForFunction(name => document.querySelector('#currentProject').textContent.includes(name), name);
    const pageContents = tag => app.evaluate(({ webContents }, tag) =>
      webContents.getAllWebContents().filter(w => w.getURL().includes('record=' + tag)).map(w => w.id), tag);
    const assertAlpha = async () => {
      const state = await browser();
      assert.equal(state.projectId, alpha.id);
      assert.equal(state.mode, 'video');
      assert.equal(state.tabId, 'a2');
      assert.deepEqual(state.tabs.map(t => [t.id, t.url, t.customName, t.pinned]),
        legacy.tabs.map(t => [t.id, t.url, t.customName, !!t.pinned]));
    };

    await launch();
    assert.equal((await browser()).projectId, beta.id);
    assert.deepEqual((await browser()).tabs, [], 'upgrade starts on the unrelated project');
    assert.equal(await page.locator('.platform-tab').count(), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(scopedPath)).projects[alpha.id], legacy);
    await switchNative(alpha.id);
    await visible(alpha.name);
    await assertAlpha();
    const original = await until(async () => (await pageContents('a2'))[0], 'legacy active webpage loaded');
    assert.deepEqual(await pageContents('a1'), [], 'inactive saved tab must not load');
    await app.evaluate(async ({ session }, origin) => {
      await session.fromPartition('persist:video-os-creator-gpt').cookies.set({ url: origin, name: 'isolated-test', value: 'retained' });
    }, origin);
    await switchHttp({ action: 'activate', id: beta.id });
    await visible(beta.name);
    assert.deepEqual((await browser()).tabs, []);
    await until(() => app.evaluate(({ webContents }, id) => !webContents.fromId(id), original), 'outgoing WebContents destroyed');
    const b = await page.evaluate(async target => {
      await window.creatorAPI.openTab('gpt', 'video');
      return window.creatorAPI.navigateUrl(target);
    }, url('b'));
    const bId = b.tabId;
    assert.ok(bId);
    await until(async () => (await pageContents('b'))[0], 'beta webpage loaded');
    await switchNative(alpha.id);
    await visible(alpha.name);
    await assertAlpha();
    assert.notEqual(await until(async () => (await pageContents('a2'))[0], 'alpha restored'), original);
    assert.deepEqual(await pageContents('b'), []);
    assert.equal(await app.evaluate(async ({ session }, origin) =>
      (await session.fromPartition('persist:video-os-creator-gpt').cookies.get({ url: origin, name: 'isolated-test' }))[0]?.value, origin), 'retained');
    await app.close(); app = null;

    await launch();
    await assertAlpha();
    await switchHttp({ action: 'activate', id: beta.id });
    await visible(beta.name);
    assert.deepEqual((await browser()).tabs.map(t => [t.id, t.url]), [[bId, url('b')]]);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.evaluate(() => window.creatorAPI.clearTabs());
    assert.deepEqual((await browser()).tabs, []);
    const gamma = await switchHttp({ action: 'create', name: '全新剧本丙' });
    await visible(gamma.name);
    assert.deepEqual((await browser()).tabs, []);
    await switchNative(alpha.id);
    await visible(alpha.name);
    await assertAlpha();
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), JSON.stringify(legacy));
    console.log('PROJECT_BROWSER_SESSIONS_NATIVE_PASS migration=oneOwner independentTabs=true unloadedWebContents=true lazyRestore=true restart=true scopedClear=true newProjectEmpty=true sharedCookie=true');
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
