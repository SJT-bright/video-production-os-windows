'use strict';

// Focused native creator-sidebar regression; local fixture platforms only.
// Keeps formal/candidate App profiles and project data completely outside scope.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

const globalKey = 'videoOS.creator.global.v2';
const projectPrefix = 'videoOS.creator.project.v2.';
const accordions = { prompt: 'promptAccordion', scripts: 'scriptAccordion', assets: 'assetAccordion' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 16000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(40); }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(![3750, 3794].includes(port)); return port;
}

async function main() {
  const executablePath = process.env.SIDEBAR_TEST_EXECUTABLE || '';
  const evidenceRoot = path.resolve(process.env.SIDEBAR_TEST_EVIDENCE || path.join(__dirname,
    'test-artifacts', `creator-sidebar-${executablePath ? 'packaged' : 'source'}-${Date.now()}-${process.pid}`));
  assert.equal(fs.existsSync(evidenceRoot), false, 'Do not overwrite evidence');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-sidebar-'));
  const projectRoot = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  const profile = path.join(temp, 'profile'), obsidian = path.join(temp, 'obsidian');
  const alphaName = '侧栏测试剧本甲', betaName = '侧栏测试剧本乙';
  const longName = '第01集_人物资产_角色服装参考与表演微动作连续性整理用非常长的目录名称';
  const report = { status: 'running', testedAt: new Date().toISOString(), checks: {},
    scope: { isolatedProjectAndProfile: true, formalAppTouched: false, candidateAppTouched: false,
      externalPlatformLoginOrGeneration: false, physicalMouseE2E: false,
      draftScope: 'new-template creation drafts and prompt-editor drafts; not unsaved existing-template edits' } };
  let application, creator;
  const watchdog = setTimeout(() => { application?.process()?.kill('SIGKILL'); console.error('SIDEBAR_NATIVE_TIMEOUT'); }, 110000).unref();
  try {
    const assets = path.join(projectRoot, '创作资产库');
    fs.mkdirSync(path.join(assets, alphaName, '人物资产', longName), { recursive: true });
    fs.mkdirSync(path.join(assets, betaName, '场景资产'), { recursive: true });
    fs.mkdirSync(dataDir); fs.mkdirSync(obsidian);
    const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_TAB_MENU_TEST: '0',
      VIDEO_OS_PORT: String(await freePort()), VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: dataDir, VIDEO_OS_USER_DATA: profile, OBSIDIAN_VAULT_PATH: obsidian,
      VIDEO_OS_TEST_OBSIDIAN_VAULT: obsidian, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [__dirname] }), env, timeout: 30000 });
    creator = await application.firstWindow(); creator.setDefaultTimeout(10000);
    await creator.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 25000 });
    await creator.waitForLoadState('load');
    await until(() => application.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      return host?.isVisible() && !host.webContents.isLoading() && host.contentView.children.some(view =>
        view.webContents?.getURL().includes('/creator-fixture.html?service=') && view.getVisible() && !view.webContents.isLoading());
    }), 'fully loaded visible native creator');
    report.runtime = await application.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged,
      appPath: app.getAppPath(), userData: app.getPath('userData') }));
    const config = await creator.evaluate(() => window.creatorAPI.getConfig());
    assert.equal(config.testMode, true);
    assert.equal(fs.realpathSync(config.paths.projectRoot), fs.realpathSync(projectRoot));
    assert.equal(fs.realpathSync(report.runtime.userData), fs.realpathSync(profile));
    assert.equal(report.runtime.packaged, !!executablePath);
    const catalog = await creator.evaluate(() => fetch('/api/creative-projects').then(response => response.json()));
    const alpha = catalog.projects.find(project => project.name === alphaName), beta = catalog.projects.find(project => project.name === betaName);
    assert.ok(alpha && beta);
    const activate = async project => {
      await creator.evaluate(async id => {
        const response = await fetch('/api/creative-projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'activate', id }) });
        const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value));
      }, project.id);
      await until(() => creator.locator('#currentProject').textContent().then(text => text.includes(project.name)), `activate ${project.name}`);
    };
    await activate(alpha);
    const browser = () => creator.evaluate(async () => (await window.creatorAPI.getConfig()).browser);
    const mode = async value => {
      await creator.locator(`.mode-button[data-mode="${value}"]`).click();
      await creator.waitForFunction(value => document.body.dataset.mode === value
        && !document.querySelector(`.mode-button[data-mode="${value}"]`).disabled, value);
    };
    if ((await browser()).mode !== 'image') await mode('image');
    const sourceTabId = (await browser()).tabId;
    await application.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/creator.html'));
      const view = host.contentView.children.find(view => view.webContents?.getURL().includes('/creator-fixture.html?service='));
      if (!view) throw new Error('Source platform missing');
      globalThis.__sidebarNativeProbe = { host, contents: view.webContents, navigations: 0, loads: 0 };
      view.webContents.on('did-navigate', () => globalThis.__sidebarNativeProbe.navigations++);
      view.webContents.on('did-finish-load', () => globalThis.__sidebarNativeProbe.loads++);
    });
    const platformSnapshot = () => application.evaluate(() => {
      const p = globalThis.__sidebarNativeProbe;
      return { id: p.contents.id, url: p.contents.getURL(), destroyed: p.contents.isDestroyed(),
        navigations: p.navigations, loads: p.loads };
    });
    const baseline = await platformSnapshot(); report.platformBefore = baseline;
    const platformUnchanged = async label => assert.deepEqual(await platformSnapshot(), baseline, label);
    const readAccordions = () => creator.evaluate(ids => Object.fromEntries(Object.entries(ids)
      .map(([key, id]) => [key, document.getElementById(id).open])), accordions);
    const setAccordions = async wanted => {
      for (const [key, id] of Object.entries(accordions)) {
        if (await creator.locator(`#${id}`).evaluate(element => element.open) !== wanted[key]) {
          await creator.locator(`#${id} > summary`).click();
          await until(() => creator.locator(`#${id}`).evaluate((element, open) => element.open === open, wanted[key]), `${id} toggle`);
        }
      }
    };
    const expectAccordions = async (wanted, label) => {
      await until(async () => JSON.stringify(await readAccordions()) === JSON.stringify(wanted), label);
      const saved = await creator.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}').accordions, globalKey);
      for (const key of Object.keys(wanted)) assert.equal(saved?.[key], wanted[key], `${label}: global ${key}`);
    };
    const formHidden = async label => {
      const value = await creator.locator('#templateCreateForm').evaluate(element => ({
        nativeHidden: element.hidden, classHidden: element.classList.contains('hidden'), display: getComputedStyle(element).display,
      }));
      assert.deepEqual(value, { nativeHidden: true, classHidden: true, display: 'none' }, label);
    };
    const newDraft = async (name, body) => {
      if (!await creator.locator('#promptAccordion').evaluate(element => element.open)) await creator.locator('#promptAccordion > summary').click();
      if (await creator.locator('#templateCreateForm').evaluate(element => element.hidden)) {
        await creator.locator('#templateCreate').click();
        // Opening deliberately focuses the name on the next animation frame.
        // Wait for that real UI action before sending text to a different field.
        await creator.waitForFunction(() => document.activeElement === document.getElementById('templateCreateName'));
      }
      await creator.locator('#templateCreateName').fill(name);
      await creator.locator('#templateCreateBody').fill(body);
      assert.equal(await creator.locator('#templateCreateName').inputValue(), name);
      assert.equal(await creator.locator('#templateCreateBody').inputValue(), body);
    };
    const readDraft = async () => ({
      name: await creator.locator('#templateCreateName').inputValue(), body: await creator.locator('#templateCreateBody').inputValue(),
      hidden: await creator.locator('#templateCreateForm').evaluate(element => element.hidden),
    });
    const refresh = async () => {
      await creator.reload({ waitUntil: 'load' });
      await creator.waitForFunction(() => document.body.dataset.ready === 'true');
      await until(() => application.evaluate(() => {
        const p = globalThis.__sidebarNativeProbe;
        return p.host.isVisible() && !p.host.webContents.isLoading();
      }), 'refresh loaded host');
    };

    await setAccordions({ prompt: true, scripts: false, assets: true });
    await formHidden('Empty new-template form must not appear when accordion is opened');
    await creator.locator('#promptEditor').fill('甲剧本-图片未提交输入');
    await newDraft('甲图片模板草稿', '甲图片尚未保存模板的内容');
    await mode('video');
    await expectAccordions({ prompt: true, scripts: false, assets: true }, 'Shared accordions after image→video');
    await formHidden('An image creation draft must not leak into an empty video form');
    assert.equal(await creator.locator('#promptEditor').inputValue(), '');
    await creator.locator('#promptEditor').fill('甲剧本-视频未提交输入');
    await newDraft('甲视频模板草稿', '甲视频尚未保存模板的内容');
    await setAccordions({ prompt: false, scripts: true, assets: false });
    await mode('image');
    await expectAccordions({ prompt: false, scripts: true, assets: false }, 'Latest accordions after video→image');
    assert.deepEqual(await readDraft(), { name: '甲图片模板草稿', body: '甲图片尚未保存模板的内容', hidden: false }, 'Mode-local new template draft restored');
    await platformUnchanged('Mode switches must not reload original platform');
    assert.equal((await browser()).tabId, sourceTabId);
    report.checks.sharedAccordionsAcrossModes = true;
    report.checks.newTemplateDraftsModeIsolated = true;

    await setAccordions({ prompt: true, scripts: true, assets: false });
    await creator.locator('#promptEditor').fill('甲剧本-图片260ms防抖竞态输入');
    await activate(beta);
    await expectAccordions({ prompt: true, scripts: true, assets: false }, 'Shared accordions across projects');
    await formHidden('Another project must not inherit an unsubmitted creation form');
    assert.equal(await creator.locator('#promptEditor').inputValue(), '');
    await creator.locator('#promptEditor').fill('乙剧本-图片独立输入');
    await newDraft('乙图片模板草稿', '乙剧本自己的内容');
    await activate(alpha);
    await expectAccordions({ prompt: true, scripts: true, assets: false }, 'Return to original project');
    assert.equal(await creator.locator('#promptEditor').inputValue(), '甲剧本-图片260ms防抖竞态输入');
    assert.deepEqual(await readDraft(), { name: '甲图片模板草稿', body: '甲图片尚未保存模板的内容', hidden: false });
    const projectStorage = await creator.evaluate(({ prefix, alphaId, betaId }) => ({
      alpha: JSON.parse(localStorage.getItem(prefix + alphaId) || '{}'), beta: JSON.parse(localStorage.getItem(prefix + betaId) || '{}'),
    }), { prefix: projectPrefix, alphaId: alpha.id, betaId: beta.id });
    assert.equal(projectStorage.alpha.prompts.image, '甲剧本-图片260ms防抖竞态输入');
    assert.equal(projectStorage.alpha.prompts.video, '甲剧本-视频未提交输入');
    assert.equal(projectStorage.beta.prompts.image, '乙剧本-图片独立输入');
    assert.equal(projectStorage.alpha.templateCreateDrafts.image.name, '甲图片模板草稿');
    assert.equal(projectStorage.alpha.templateCreateDrafts.video.name, '甲视频模板草稿');
    assert.equal(projectStorage.beta.templateCreateDrafts.image.name, '乙图片模板草稿');
    await platformUnchanged('Switching projects must not reload original platform');
    report.checks.projectDraftsIsolatedAndDebounceSafe = true;
    report.checks.newTemplateDraftsProjectIsolated = true;

    await refresh();
    await expectAccordions({ prompt: true, scripts: true, assets: false }, 'Shared accordions after refresh');
    assert.deepEqual(await readDraft(), { name: '甲图片模板草稿', body: '甲图片尚未保存模板的内容', hidden: false });
    assert.equal(await creator.locator('#promptEditor').inputValue(), '甲剧本-图片260ms防抖竞态输入');
    await platformUnchanged('Refreshing creator must preserve embedded platform WebContents');
    report.checks.refreshRestoresSharedStateAndNonemptyDraft = true;
    await creator.locator('#cancelTemplateCreate').click();
    await formHidden('Cancel must clear and hide the creation form');
    assert.deepEqual(await readDraft(), { name: '', body: '', hidden: true });
    await refresh();
    await formHidden('Cancelled empty form must not reappear after refresh');
    // Intentionally open an empty form; switching away/back must not reopen it.
    await creator.locator('#templateCreate').click();
    await mode('video');
    assert.deepEqual(await readDraft(), { name: '甲视频模板草稿', body: '甲视频尚未保存模板的内容', hidden: false });
    await mode('image');
    await formHidden('Empty form must stay closed when returning to its mode');
    report.checks.emptyFormsHiddenUnlessExplicitlyOpened = true;

    await setAccordions({ prompt: false, scripts: false, assets: true });
    const characterPath = `${alpha.folder}/人物资产`, longPath = `${characterPath}/${longName}`;
    const folder = value => creator.locator(`.quick-folder-row[data-folder-path="${value}"] > .quick-folder-name`);
    await folder(characterPath).click();
    await until(() => creator.locator('#quickDropTarget').textContent().then(text => text === '人物资产'), 'selected category target');
    await folder(longPath).click();
    await until(() => creator.locator('#quickDropTarget').textContent().then(text => text === longName), 'selected nested target');
    const targetTitle = await creator.locator('#quickDropTarget').getAttribute('title');
    assert.ok(targetTitle.includes(longName) && targetTitle.includes('人物资产'), 'Full nested relative path must remain available');
    assert.equal(await creator.locator('#quickDropTarget').getAttribute('data-folder-path'), longPath, 'Display shortening must not change the actual import target');
    assert.ok((await creator.locator('#quickDropTargetHint').textContent()).includes('人物资产'), 'Nested parent path must remain discoverable');
    const dropGeometry = () => creator.evaluate(() => {
      const zone = document.getElementById('assetDropZone'), target = document.getElementById('quickDropTarget');
      const label = zone.querySelector('strong:not(#quickDropTarget)'), panel = document.getElementById('promptPanel');
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      return { viewport: { width: innerWidth, height: innerHeight }, zone: rect(zone), target: rect(target), label: rect(label),
        panel: { ...rect(panel), clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth },
        targetFontSize: parseFloat(getComputedStyle(target).fontSize), labelFontSize: parseFloat(getComputedStyle(label).fontSize),
        targetOverflow: getComputedStyle(target).overflow,
        targetLineClamp: getComputedStyle(target).webkitLineClamp };
    });
    const expectRightTarget = async label => {
      const geometry = await dropGeometry();
      report.lastDropzoneGeometry = { case: label, ...geometry };
      assert.ok(geometry.zone.width > 100 && geometry.target.width > 40 && geometry.label.width > 20,
        `${label}: usable dropzone, target and instruction widths`);
      assert.ok(geometry.target.x > geometry.label.x, `${label}: target on the right`);
      assert.ok(geometry.targetFontSize > geometry.labelFontSize, `${label}: target name is emphasized`);
      assert.ok(geometry.target.right <= geometry.zone.right + 1 && geometry.target.x >= geometry.zone.x, `${label}: target bounded inside dropzone`);
      assert.ok(geometry.panel.scrollWidth <= geometry.panel.clientWidth + 1, `${label}: sidebar has no horizontal overflow`);
      assert.equal(geometry.targetOverflow, 'hidden', `${label}: long name stays clipped inside its slot`);
      assert.equal(geometry.targetLineClamp, '2', `${label}: long name uses bounded two-line wrapping`);
      return geometry;
    };
    report.dropzoneWide = await expectRightTarget('Wide sidebar long-name target');
    await creator.locator('#promptPanel').screenshot({ path: path.join(evidenceRoot, 'sidebar-wide-long-target.png') });
    await application.evaluate(() => {
      const host = globalThis.__sidebarNativeProbe.host;
      host.setMinimumSize(720, 640); host.setSize(990, 740);
    });
    await creator.waitForFunction(() => innerWidth <= 1000);
    await delay(220);
    report.dropzoneNarrow = await expectRightTarget('300px narrow sidebar long-name target');
    await creator.locator('#promptPanel').screenshot({ path: path.join(evidenceRoot, 'sidebar-narrow-long-target.png') });
    await application.evaluate(() => globalThis.__sidebarNativeProbe.host.setSize(860, 740));
    await creator.waitForFunction(() => innerWidth <= 900);
    // WM_SIZE and the renderer's resize handler are asynchronous on Windows.
    // Wait for responsive state before deciding whether to use the expand button.
    await creator.waitForFunction(() => document.body.classList.contains('prompt-collapsed')
      === (state.sidebarCollapsed === null ? matchMedia('(max-width: 900px)').matches : state.sidebarCollapsed));
    if (!await creator.locator('body').evaluate(body => body.classList.contains('prompt-expanded'))) await creator.locator('#togglePrompt').click();
    await creator.waitForFunction(() => document.body.classList.contains('prompt-expanded'));
    await setAccordions({ prompt: true, scripts: false, assets: true });
    await formHidden('Responsive expanded sidebar cannot override empty form hidden state');
    await delay(350);
    report.dropzoneCompact = await expectRightTarget('Compact expanded sidebar long-name target');
    await creator.locator('#assetDropZone').scrollIntoViewIfNeeded();
    await creator.locator('#promptPanel').screenshot({ path: path.join(evidenceRoot, 'sidebar-compact-no-empty-form.png') });
    await folder(longPath).click();
    assert.equal(await creator.locator('#quickDropTarget').textContent(), '人物资产', 'Collapse selected child synchronizes target to parent');
    await platformUnchanged('Fold/unfold, responsive resize and folder selection must not reload platform');
    report.checks.dropTargetSynchronizesAndLongNamesBounded = true;
    report.checks.compactSidebarDoesNotExposeEmptyForm = true;
    report.platformAfter = await platformSnapshot();
    report.projectStorageProof = { alphaId: alpha.id, betaId: beta.id,
      alphaPromptImage: projectStorage.alpha.prompts.image, betaPromptImage: projectStorage.beta.prompts.image,
      alphaCreationDraftModes: Object.keys(projectStorage.alpha.templateCreateDrafts) };
    report.status = 'passed';
    console.log(`CREATOR_SIDEBAR_STATE_PASS packaged=${!!executablePath} sharedAccordions=true draftsIsolated=true refresh=true emptyFormHidden=true targetBounded=true platformRetained=true`);
  } catch (error) {
    report.status = 'failed'; report.failure = String(error.stack || error);
    if (creator && !creator.isClosed()) {
      report.dom = await creator.evaluate(() => ({ ready: document.body.dataset.ready, mode: document.body.dataset.mode,
        bodyClass: document.body.className, formHidden: document.getElementById('templateCreateForm')?.hidden,
        formClass: document.getElementById('templateCreateForm')?.className,
        folderPaths: [...document.querySelectorAll('.quick-folder-row')].map(row => row.dataset.folderPath),
        assetStatus: document.getElementById('quickAssetStatus')?.textContent,
        projectId: state.projectId, treeScope: state.quickAssetTree?.scopePath,
        accordions: ['promptAccordion', 'scriptAccordion', 'assetAccordion'].map(id => ({ id, open: document.getElementById(id)?.open })) })).catch(() => null);
      try { await creator.locator('#promptPanel').screenshot({ path: path.join(evidenceRoot, 'failure-sidebar.png') }); } catch {}
    }
    console.error('CREATOR_SIDEBAR_FAILURE ' + JSON.stringify(report));
    throw error;
  } finally {
    clearTimeout(watchdog);
    if (application) await application.close().catch(() => application.process()?.kill('SIGKILL'));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    report.fixtureCleaned = true;
    fs.writeFileSync(path.join(evidenceRoot, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(`CREATOR_SIDEBAR_STATE_EVIDENCE ${evidenceRoot}`);
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
