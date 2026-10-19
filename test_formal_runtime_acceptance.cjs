'use strict';

// Installed-app acceptance. The test itself writes only its new evidence file.
// Opening the real project menu may cause the app to persist its existing workspace.
// No external page is attached, evaluated, captured, or read.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const BUSINESS_TABLES = ['shots', 'shot_asset_uses', 'inbox_items'];
const JSON_FILES = ['agent-knowledge.json', 'asset-meta.json', 'audio-library.json', 'doc-annotations.json',
  'media-sources.json', 'library-sources.json', 'library-links.json', 'creative-projects.json', 'asset-workflow.json'];
const usage = `Usage: node test_formal_runtime_acceptance.cjs --app /absolute/App.app
  --project-root /absolute/project --data-dir /absolute/data --profile /absolute/profile
  --docx /absolute/source.docx --evidence-out /absolute/new-evidence.json
  [--baseline /absolute/baseline.json] [--protected-pids 123,456]
  [--version 1.3.0] [--bundle-id local.video-production-os] [--paragraph-count 376] [--scene-count 20]
  [--body-start-paragraph 0]
  [--run | --snapshot-only]

Without --run: read-only preflight; no App is launched and no evidence is written.
--snapshot-only: write a new baseline { formalData } without launching the App.
--run: require the exact installed executable to be stopped, then launch and close
only the test-owned process. The expected profile is asserted, never set via env.
Baseline comparison checks business tables, existing JSON bytes and asset paths/sizes;
other SQLite row counts are reported separately as startup metadata changes.
`;

function parseArgs(argv) {
  const values = {}, flags = new Set();
  const names = new Set(['--app', '--project-root', '--data-dir', '--profile', '--docx', '--evidence-out',
    '--baseline', '--protected-pids', '--version', '--bundle-id', '--paragraph-count', '--scene-count', '--body-start-paragraph']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (['--run', '--snapshot-only', '--help'].includes(name)) {
      assert.ok(!flags.has(name), `重复参数：${name}`); flags.add(name); continue;
    }
    assert.ok(names.has(name), `未知参数：${name}`);
    assert.ok(!Object.hasOwn(values, name), `重复参数：${name}`);
    assert.ok(argv[i + 1] && !argv[i + 1].startsWith('--'), `参数缺少值：${name}`);
    values[name] = argv[++i];
  }
  assert.ok(!(flags.has('--run') && flags.has('--snapshot-only')), '--run 与 --snapshot-only 不能同时使用');
  return { values, flags };
}

function absoluteExisting(value, label, directory, formalScope = false) {
  assert.ok(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} 必须是绝对路径`);
  const resolved = fs.realpathSync(value), stat = fs.statSync(resolved);
  assert.ok(directory ? stat.isDirectory() : stat.isFile(), `${label} 类型不正确`);
  assert.notEqual(resolved, path.parse(resolved).root, `${label} 不能是磁盘根目录`);
  if (formalScope) assert.ok(!resolved.split(path.sep).some(part => part === '.worktrees' || /candidate|候选/i.test(part)), `${label} 不能指向 worktree 或候选目录`);
  return resolved;
}

function plistValue(plist, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
}

function validateOptions(parsed) {
  const { values, flags } = parsed;
  assert.equal(process.platform, 'darwin', '正式安装验收必须在 macOS 执行');
  const app = absoluteExisting(values['--app'], 'App', true, true);
  assert.ok(app.endsWith('.app'), 'App 路径必须以 .app 结尾');
  const projectRoot = absoluteExisting(values['--project-root'], '项目根目录', true, true);
  const dataDir = absoluteExisting(values['--data-dir'], 'data', true, true);
  const profile = absoluteExisting(values['--profile'], 'profile', true, true);
  const docx = absoluteExisting(values['--docx'], 'DOCX', false);
  assert.equal(path.extname(docx).toLowerCase(), '.docx', '只接受 .docx 正文源文件');
  assert.equal(dataDir, fs.realpathSync(path.join(projectRoot, '视频制作OS', 'data')), 'data 必须属于指定正式项目');
  const evidenceOut = values['--evidence-out'];
  assert.ok(evidenceOut && path.isAbsolute(evidenceOut) && !evidenceOut.includes('\0'), 'evidence-out 必须是新的绝对路径');
  assert.equal(fs.existsSync(evidenceOut), false, '不覆盖已有回执');
  const inside = (base, target) => target === base || target.startsWith(base + path.sep);
  assert.ok(![app, dataDir, profile, path.join(projectRoot, '创作资产库')].some(base => inside(base, path.resolve(evidenceOut))),
    '回执不能写入 App、正式 data、profile 或创作素材目录');
  const plist = path.join(app, 'Contents', 'Info.plist');
  const appRoot = path.join(app, 'Contents', 'Resources', 'app');
  const executableName = plistValue(plist, 'CFBundleExecutable');
  assert.ok(executableName && !executableName.includes(path.sep), 'Bundle 可执行名称无效');
  const executable = path.join(app, 'Contents', 'MacOS', executableName);
  const stat = fs.lstatSync(executable);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111), 'Bundle 主程序必须是普通可执行文件');
  const version = values['--version'] || '1.3.0', bundleId = values['--bundle-id'] || 'local.video-production-os';
  assert.equal(plistValue(plist, 'CFBundleShortVersionString'), version, '安装包版本不匹配');
  assert.equal(plistValue(plist, 'CFBundleIdentifier'), bundleId, '正式 Bundle ID 不匹配');
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const runtimeConfig = JSON.parse(fs.readFileSync(path.join(appRoot, 'runtime-config.json'), 'utf8'));
  assert.equal(pkg.version, version, '安装包 runtime package 版本不匹配');
  assert.ok(!runtimeConfig.candidateId && !runtimeConfig.candidateUserData && !runtimeConfig.candidateVersion,
    '正式包不能包含候选 runtime 契约');
  assert.notEqual(runtimeConfig.dataLocation, 'userData', '正式项目包不能使用 portable workspace');
  assert.equal(path.resolve(appRoot, runtimeConfig.projectRootFromBundle || ''), projectRoot, 'Bundle 回溯必须定位正式项目');
  assert.equal(fs.existsSync(path.join(appRoot, 'data')), false, 'Bundle 不得包含正式实时 data');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  const paragraphCount = Number(values['--paragraph-count'] || 376);
  assert.ok(Number.isSafeInteger(paragraphCount) && paragraphCount > 0, 'paragraph-count 必须是正整数');
  const sceneCount = Number(values['--scene-count'] || 20);
  assert.ok(Number.isSafeInteger(sceneCount) && sceneCount > 0, 'scene-count 必须是正整数');
  const bodyStartParagraph = Number(values['--body-start-paragraph'] || 0);
  assert.ok(Number.isSafeInteger(bodyStartParagraph) && bodyStartParagraph >= 0 && bodyStartParagraph < paragraphCount,
    'body-start-paragraph 必须是源文档范围内的非负整数');
  const protectedPids = values['--protected-pids'] ? values['--protected-pids'].split(',').map(Number) : [];
  assert.ok(protectedPids.every(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid), 'protected-pids 无效');
  const baseline = values['--baseline'] ? JSON.parse(fs.readFileSync(absoluteExisting(values['--baseline'], 'baseline', false), 'utf8')) : null;
  return { app, appRoot, executable, plist, projectRoot, dataDir, profile, docx, evidenceOut: path.resolve(evidenceOut),
    version, bundleId, paragraphCount, sceneCount, bodyStartParagraph, protectedPids, baseline: baseline?.formalData || baseline,
    run: flags.has('--run'), snapshotOnly: flags.has('--snapshot-only'),
    buildManifestSha256: sha256(fs.readFileSync(path.join(appRoot, 'build-manifest.json'))) };
}

function assertProtectedAlive(pids) { for (const pid of pids) process.kill(pid, 0); }

function executablePids(executable) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-t', '--', executable], { encoding: 'utf8' });
  if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return [];
  assert.equal(result.status, 0, '无法确认指定正式程序已停止');
  return [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
}

function assetInventory(assetRoot) {
  const result = [];
  const visit = (dir, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
      assert.ok(!entry.isSymbolicLink(), `素材清单遇到符号链接：${name}`);
      if (entry.isDirectory()) visit(absolute, name);
      else if (entry.isFile()) result.push({ path: name, size: fs.statSync(absolute).size });
    }
  };
  visit(assetRoot); return result;
}

function snapshotFormalData(dataDir, projectRoot) {
  const jsonHashes = Object.fromEntries(JSON_FILES.filter(name => fs.existsSync(path.join(dataDir, name)))
    .map(name => [name, sha256(fs.readFileSync(path.join(dataDir, name)))]));
  const databaseFile = path.join(dataDir, 'production.sqlite');
  assert.ok(fs.existsSync(databaseFile), '正式 production.sqlite 必须已存在');
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  let business = {}, metadata = {}, integrity;
  try {
    db.exec('PRAGMA query_only = ON');
    integrity = db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check);
    assert.deepEqual(integrity, ['ok'], '正式数据库完整性检查失败');
    const quote = value => '"' + value.replace(/"/g, '""') + '"';
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    for (const table of tables) {
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get().count;
      if (!BUSINESS_TABLES.includes(table)) { metadata[table] = count; continue; }
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
      const rows = db.prepare(`SELECT * FROM ${quote(table)} ORDER BY ${columns.map(quote).join(', ')}`).all();
      business[table] = { count, rowsSha256: sha256(JSON.stringify(rows)) };
      const statusColumn = columns.includes('status') ? 'status' : columns.includes('state') ? 'state' : null;
      if (statusColumn) business[table].statuses = db.prepare(`SELECT ${quote(statusColumn)} AS status, COUNT(*) AS count FROM ${quote(table)} GROUP BY ${quote(statusColumn)} ORDER BY ${quote(statusColumn)}`).all().map(row => ({ ...row }));
    }
  } finally { db.close(); }
  return { projectRoot, dataDir, integrity, business, metadata, jsonHashes,
    assets: assetInventory(path.join(projectRoot, '创作资产库')) };
}

function compareBaseline(actual, baseline, label) {
  assert.equal(actual.projectRoot, baseline.projectRoot, `${label}项目来源变更`);
  assert.equal(actual.dataDir, baseline.dataDir, `${label}data 来源变更`);
  assert.deepEqual(actual.business, baseline.business, `${label}业务 SQLite 行或状态变化`);
  assert.deepEqual(actual.assets, baseline.assets, `${label}素材路径或大小变化`);
  for (const [name, digest] of Object.entries(baseline.jsonHashes || {})) {
    assert.equal(actual.jsonHashes[name], digest, `${label}既有 ${name} 字节变化`);
  }
}

async function until(read, label, child, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`验收启动程序提前退出：${label}`);
    const value = await read(); if (value) return value; await delay(100);
  }
  throw new Error(`正式验收超时：${label}`);
}

class DirectCDP {
  constructor(url, role) {
    const parsed = new URL(url);
    assert.ok(parsed.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), '只接受 loopback 调试端点');
    this.role = role; this.socket = new WebSocket(url); this.sequence = 0; this.pending = new Map(); this.creatorExceptions = 0;
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('本机 CDP 连接失败')), { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown' && message.sessionId === this.creatorSession) this.creatorExceptions++;
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`)); else pending.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP 已关闭')); }
      this.pending.clear();
    });
  }
  async send(method, params = {}, sessionId) {
    if (this.role === 'main') assert.equal(method, 'Runtime.evaluate', '主进程仅允许限定的 Runtime.evaluate');
    else {
      assert.ok(['Target.getTargets', 'Target.attachToTarget', 'Runtime.enable', 'Runtime.evaluate'].includes(method), '浏览器 CDP 命令不在验收范围');
      if (method === 'Target.attachToTarget') assert.equal(params.targetId, this.creatorTargetId, '只可 attach 已确认的本地 creator target');
      if (method.startsWith('Runtime.')) assert.ok(sessionId && sessionId === this.creatorSession, '只可读取本地 creator session');
    }
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 命令超时：${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression, sessionId) {
    // Inspector awaitPromise keeps a weak reference. Pin this test-only Promise
    // until its response is received, including IPC cancellation during menus.
    const slot = `__videoOSAcceptance_${this.role}_${Date.now()}_${this.pinSequence = (this.pinSequence || 0) + 1}`;
    const key = JSON.stringify(slot);
    try {
      const pinned = `(() => { globalThis[${key}] = Promise.resolve(${expression}); return globalThis[${key}]; })()`;
      const response = await this.send('Runtime.evaluate', { expression: pinned, awaitPromise: true, returnByValue: true,
        includeCommandLineAPI: !sessionId }, sessionId);
      if (response.exceptionDetails) throw new Error(`CDP 执行失败：${response.exceptionDetails.text}`);
      return response.result?.value;
    } finally {
      await this.send('Runtime.evaluate', { expression: `delete globalThis[${key}]`, returnByValue: true }, sessionId).catch(() => {});
    }
  }
  close() { this.socket.close(); }
}

function sanitizedLaunchEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^VIDEO_OS_/.test(key) || /^CREATOR_BROWSER_TEST$/.test(key)
    || /^ELECTRON_RUN_AS_NODE$/.test(key) || /^NODE_OPTIONS$/.test(key) || /^OBSIDIAN_VAULT_PATH$/.test(key)) delete env[key];
  return env;
}

async function run(options) {
  assertProtectedAlive(options.protectedPids);
  assert.deepEqual(executablePids(options.executable), [], '请先正常退出精确目标正式 App；脚本不关闭已有 App');
  const before = snapshotFormalData(options.dataDir, options.projectRoot);
  if (options.baseline) compareBaseline(before, options.baseline, '启动前与 supplied baseline：');
  // Independent OOXML source; unzip streams into memory and never extracts files.
  const docxBytes = fs.readFileSync(options.docx);
  const sourceXml = execFileSync('/usr/bin/unzip', ['-p', options.docx, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  let child, nodeCDP, browserCDP, native, renderer, exited;
  const evidence = { status: 'running', version: options.version, bundleId: options.bundleId,
    buildManifestSha256: options.buildManifestSha256, signedInstalledBundle: true,
    connection: 'direct CDP: local creator target plus main Node inspector', externalTargetsAttached: 0,
    externalPageContentRead: false, screenshotsTaken: false, automaticConnectionTokenRead: false,
    explicitDataWrites: false, scriptImportCalled: false, templateMigrationCalled: false,
    normalProjectMenuMayPersistExistingWorkspace: true, formalDataBefore: before };
  let failure;
  try {
    child = spawn(options.executable, ['--inspect=0', '--remote-debugging-port=0'], {
      env: sanitizedLaunchEnv(), cwd: options.projectRoot, stdio: ['ignore', 'ignore', 'pipe'],
    });
    exited = new Promise(resolve => child.once('exit', resolve));
    let nodeUrl, browserUrl, partial = '', spawnError;
    child.once('error', error => { spawnError = error; });
    child.stderr.on('data', bytes => {
      partial = (partial + bytes.toString()).slice(-65536);
      const lines = partial.split('\n'); partial = lines.pop();
      for (const line of lines) {
        const nodeMatch = line.match(/^Debugger listening on (ws:\/\/[^\s]+)/), browserMatch = line.match(/^DevTools listening on (ws:\/\/[^\s]+)/);
        if (nodeMatch) nodeUrl = nodeMatch[1]; if (browserMatch) browserUrl = browserMatch[1];
      }
      // Do not save stdout/stderr, which may include external-page diagnostics.
    });
    await until(() => { if (spawnError) throw spawnError; return nodeUrl && browserUrl; }, '本机调试端点', child);
    nodeCDP = new DirectCDP(nodeUrl, 'main'); browserCDP = new DirectCDP(browserUrl, 'browser');
    await Promise.all([nodeCDP.ready, browserCDP.ready]);
    native = (fn, argument) => nodeCDP.evaluate(`(${fn.toString()})(require('electron'), ${JSON.stringify(argument ?? null)})`);
    const target = await until(async () => (await browserCDP.send('Target.getTargets')).targetInfos.find(item => {
      if (item.type !== 'page') return false;
      try { const url = new URL(item.url); return ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/creator.html'; }
      catch { return false; }
    }), '正式本地工作台 target', child);
    const origin = new URL(target.url).origin, uiPort = Number(new URL(target.url).port);
    const listeners = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-iTCP:' + uiPort, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' })
      .split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1)));
    assert.deepEqual([...new Set(listeners)], [child.pid], '本地 UI listener 必须属于测试启动的正式 PID');
    browserCDP.creatorTargetId = target.targetId;
    const { sessionId } = await browserCDP.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    browserCDP.creatorSession = sessionId;
    await browserCDP.send('Runtime.enable', {}, sessionId);
    renderer = (fn, argument) => browserCDP.evaluate(`(${fn.toString()})(${JSON.stringify(argument ?? null)})`, sessionId);
    await until(() => renderer(() => document.body?.dataset.ready === 'true'), '工作台就绪', child);
    const runtime = await native(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged,
      profile: app.getPath('userData'), appPath: app.getAppPath(), executable: process.execPath,
      projectRoot: process.env.VIDEO_OS_PROJECT_ROOT, dataDir: process.env.VIDEO_OS_DATA_DIR, pid: process.pid }));
    assert.equal(runtime.version, options.version); assert.equal(runtime.packaged, true); assert.equal(runtime.pid, child.pid);
    for (const [key, expected] of [['profile', options.profile], ['appPath', options.appRoot], ['executable', options.executable],
      ['projectRoot', options.projectRoot], ['dataDir', options.dataDir]]) assert.equal(fs.realpathSync(runtime[key]), expected, `实际 ${key} 来源不匹配`);
    const config = await renderer(async () => {
      const config = await window.creatorAPI.getConfig();
      return { paths: { projectRoot: config.paths.projectRoot, creativeAssetLibraryRoot: config.paths.creativeAssetLibraryRoot },
        candidate: config.candidate, testMode: config.testMode, projectId: config.project?.id, mode: config.browser?.mode };
    });
    assert.equal(fs.realpathSync(config.paths.projectRoot), options.projectRoot);
    assert.equal(fs.realpathSync(config.paths.creativeAssetLibraryRoot), fs.realpathSync(path.join(options.projectRoot, '创作资产库')));
    assert.equal(config.candidate, null); assert.equal(config.testMode, false);
    const ui = await renderer(() => ({ title: document.title,
      removedTrayEntryAndAPI: !document.querySelector('#toggleDragTray, #dragTray, .drag-tray')
        && !Object.keys(window.creatorAPI).some(key => /dragtray/i.test(key)),
      projectButton: !!document.querySelector('#currentProject'), allTabsButton: !!document.querySelector('#allTabsButton'),
      splitButton: !!document.querySelector('#splitViewToggle .split-icon rect'),
      splitPicker: !!document.querySelector('#splitPickerDialog'),
      materialSidebarControl: !!document.querySelector('#collapseMaterialSidebar svg rect'),
      splitApis: ['setSplitView', 'setSplitRatio', 'focusSplitPane', 'closeSplitView'].every(key => typeof window.creatorAPI[key] === 'function') }));
    assert.ok(ui.removedTrayEntryAndAPI && ui.projectButton && ui.allTabsButton, '旧托盘必须已移除且两个菜单按钮存在');
    if (['1.3.6', '1.3.7'].includes(options.version)) assert.ok(ui.splitButton && ui.splitPicker && ui.splitApis, '正式包必须同时包含双拼按钮、选择器与原生 API');
    if (options.version === '1.3.7') assert.ok(ui.materialSidebarControl, '正式包必须包含创作材料侧栏收起按钮');
    evidence.runtime = { ...runtime, bundleId: options.bundleId, origin, uiPort, listenerPidConfirmed: true,
      defaultProfileConfirmed: true, environmentOverridesApplied: false, candidate: false };
    evidence.ui = ui;
    const workspaceSnapshot = () => renderer(async () => {
      const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
      const rows = [];
      for (const key of Object.keys(localStorage).filter(key => key.startsWith('videoOS.creator.project.v2.')).sort()) {
        const value = JSON.parse(localStorage.getItem(key));
        const business = { prompts: value.prompts, history: value.history, promptTemplates: value.promptTemplates, scripts: value.scripts };
        rows.push({ projectId: value.projectId || key.slice('videoOS.creator.project.v2.'.length),
          imageTemplates: value.promptTemplates?.image?.length || 0, videoTemplates: value.promptTemplates?.video?.length || 0,
          scriptGroups: value.scripts?.groups?.length || 0,
          scriptSegments: (value.scripts?.groups || []).reduce((n, group) => n + (group.items?.length || 0), 0),
          businessSha256: await digest(JSON.stringify(business)) });
      }
      return { projectId: state.projectId, mode: state.mode, rows,
        active: { imageTemplates: state.promptTemplates.image.length, videoTemplates: state.promptTemplates.video.length,
          scriptGroups: state.scripts.groups.length, scriptSegments: state.scripts.groups.reduce((n, group) => n + group.items.length, 0) },
        totals: rows.reduce((result, row) => { for (const key of ['imageTemplates', 'videoTemplates', 'scriptGroups', 'scriptSegments']) result[key] += row[key]; return result; },
          { imageTemplates: 0, videoTemplates: 0, scriptGroups: 0, scriptSegments: 0 }) };
    });
    const workspaceBefore = await workspaceSnapshot();
    assert.equal(workspaceBefore.projectId, config.projectId); assert.equal(workspaceBefore.mode, config.mode);
    evidence.localState = workspaceBefore;
    const platformSnapshot = () => native(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(win => { try { return new URL(win.webContents.getURL()).pathname === '/creator.html'; } catch { return false; } });
      if (!host) return null;
      const views = host.contentView.children.filter(view => {
        if (!view.webContents) return false;
        try { const url = new URL(view.webContents.getURL()); return /^https?:$/.test(url.protocol) && !['localhost', '127.0.0.1'].includes(url.hostname) && view.getVisible(); }
        catch { return false; }
      });
      return { hostId: host.id, hostVisible: host.isVisible(), views: views.map(view => ({ id: view.webContents.id, attached: true,
        visible: view.getVisible(), origin: new URL(view.webContents.getURL()).origin,
        urlSha256: require('node:crypto').createHash('sha256').update(view.webContents.getURL()).digest('hex') })) };
    });
    const platformBefore = await until(async () => { const value = await platformSnapshot(); return value?.hostVisible && value.views.length ? value : null; }, '既有平台 View 可见', child);
    for (const selector of ['#currentProject', '#allTabsButton']) {
      await renderer(selector => { const button = document.querySelector(selector); if (!button || button.disabled) throw new Error('菜单按钮不可用'); button.click(); }, selector);
      await until(() => native(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => {
        try { return new URL(win.webContents.getURL()).pathname === '/workspace-menu.html' && win.isVisible(); } catch { return false; }
      })), '真实菜单可见', child);
      assert.deepEqual(await platformSnapshot(), platformBefore, '菜单打开须保留同一外部 native WC、URL、附着及可见状态');
      const cancelled = await renderer(() => window.creatorAPI.closeWorkspaceMenu());
      assert.equal(cancelled.cancelled, true, '取消必须取得明确回执');
      await until(() => renderer(selector => document.querySelector(selector)?.getAttribute('aria-expanded') === 'false', selector), '菜单取消', child);
      assert.deepEqual(await platformSnapshot(), platformBefore, '菜单取消须保留同一外部 native WC、URL、附着及可见状态');
      assert.deepEqual(await workspaceSnapshot(), workspaceBefore, '菜单不能改变项目、模式、模板、草稿、历史或剧本内容');
    }
    evidence.workspaceMenus = { projectsAndAllTabs: true, cancelled: true, samePlatformWcUrlAttachedVisible: true,
      platform: platformBefore, workspaceBusinessUnchanged: true, externalPageContentRead: false };
    const docx = await renderer(async ({ bytes, xml, expectedParagraphCount, expectedSceneCount, expectedBodyStartParagraph }) => {
      const fail = message => { throw new Error(message); };
      if (typeof extractDocxText !== 'function' || typeof splitScriptByEpisodes !== 'function') fail('安装包纯解析函数不可用');
      const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      const source = new DOMParser().parseFromString(xml, 'application/xml');
      if (source.querySelector('parsererror')) fail('独立 OOXML XML 解析失败');
      const paragraphs = [...source.getElementsByTagNameNS(ns, 'p')].map(paragraph => {
        const fragments = [];
        for (const node of paragraph.getElementsByTagNameNS(ns, '*')) {
          if (node.localName === 't') fragments.push(node.textContent || '');
          else if (node.localName === 'tab') fragments.push('\t');
          else if (node.localName === 'br' || node.localName === 'cr') fragments.push('\n');
        }
        return fragments.join('');
      });
      if (paragraphs.length !== expectedParagraphCount) fail('源文档段数与指定预期不一致');
      const headings = paragraphs.map((text, index) => ({ text, index, match: /^第\s*(\d+)\s*集$/.exec(text.trim()) }))
        .filter(row => row.match && row.index >= expectedBodyStartParagraph);
      if (JSON.stringify(headings.map(row => Number(row.match[1]))) !== JSON.stringify(Array.from({ length: 10 }, (_, i) => i + 1))) fail('源文档必须有完整第 1 集至第 10 集');
      if (headings[0].index !== expectedBodyStartParagraph) fail('源文档正文起点与独立核验的指定段落不一致');
      const oracleChunks = headings.map((heading, index) => ({ title: heading.text.trim(),
        text: paragraphs.slice(heading.index, headings[index + 1]?.index ?? paragraphs.length).join('\n').trim() }));
      const raw = Uint8Array.from(atob(bytes), char => char.charCodeAt(0));
      const file = new File([raw], 'acceptance-source.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const extracted = (await extractDocxText(file)).replace(/\r\n/g, '\n').trim();
      if (extracted !== paragraphs.join('\n').trim()) fail('安装包 DOCX 正文与独立 XML 全文不一致');
      const chunks = splitScriptByEpisodes(extracted);
      if (!chunks || JSON.stringify(chunks) !== JSON.stringify(oracleChunks)) fail('安装包 10 集标题或完整正文与独立 XML 不一致');
      const sceneIds = text => text.split(/\r?\n/).map(line => /^\s*(\d+\s*[-－—]\s*\d+)(?=$|\s)/.exec(line)?.[1]?.replace(/\s/g, '').replace(/[－—]/g, '-')).filter(Boolean);
      const sourceScenes = sceneIds(paragraphs.slice(expectedBodyStartParagraph).join('\n')), parsedScenes = sceneIds(chunks.map(chunk => chunk.text).join('\n'));
      if (sourceScenes.length !== expectedSceneCount) fail('源文档 scene ID 数量与指定预期不一致');
      if (!sourceScenes.length || JSON.stringify(sourceScenes) !== JSON.stringify(parsedScenes)) fail('分集后 scene IDs 必须与源文档全部一致');
      const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
      return { episodes: chunks.length, paragraphCount: paragraphs.length, titles: chunks.map(chunk => chunk.title),
        excludedPrefixParagraphCount: expectedBodyStartParagraph,
        textLength: extracted.length, textSha256: await digest(extracted), completeTextMatchesIndependentXml: true,
        completeEpisodeTextMatchesIndependentXml: true, tenthEpisodeTitleConfirmed: /^第\s*10\s*集$/.test(chunks[9].title),
        sceneIds: sourceScenes, sceneIdsPreserved: true, inMemoryOnly: true, importCalled: false, persisted: false };
    }, { bytes: docxBytes.toString('base64'), xml: sourceXml, expectedParagraphCount: options.paragraphCount,
      expectedSceneCount: options.sceneCount, expectedBodyStartParagraph: options.bodyStartParagraph });
    assert.equal(docx.episodes, 10); assert.equal(docx.tenthEpisodeTitleConfirmed, true);
    assert.deepEqual(await workspaceSnapshot(), workspaceBefore, 'DOCX 纯函数验证不能保存或改变工作区');
    assert.equal(sha256(fs.readFileSync(options.docx)), sha256(docxBytes), '验收过程中源 DOCX 必须保持原字节');
    evidence.docx = { sourceSha256: sha256(docxBytes), sourceBytes: docxBytes.length, ...docx };
    // Exercise the actual installed main-sidebar entry, not only the creator's
    // separate native asset panel. Reads existing assets; no import or deletion.
    await native(() => {
      const probe = globalThis.__formalAssetEntryProbe = { ticks: 0, maxGapMs: 0, last: performance.now() };
      probe.timer = setInterval(() => { const now = performance.now(); probe.ticks++;
        probe.maxGapMs = Math.max(probe.maxGapMs, now - probe.last); probe.last = now; }, 25);
      probe.timer.unref(); return true;
    });
    await renderer(() => { window.creatorAPI.showMainWindow(); return true; });
    const mainRead = async expression => native(async ({ BrowserWindow }, { origin, expression }) => {
      const host = BrowserWindow.getAllWindows().find(win => {
        try { const url = new URL(win.webContents.getURL()); return url.origin === origin && url.pathname === '/'; }
        catch { return false; }
      });
      return host && !host.isDestroyed() ? host.webContents.executeJavaScript(expression, true) : null;
    }, { origin, expression });
    await until(() => mainRead('!!document.querySelector("#windowsLayer .window")'), '正式主壳初始模块就绪', child);
    const entryStarted = Date.now();
    assert.equal(await mainRead('(() => { const button=document.querySelector(".side-nav-item[data-app=creative-assets]"); if(!button)return false; button.click(); return true; })()'), true);
    try {
      await until(() => mainRead('document.querySelector(".creative-assets-frame")?.contentDocument?.body?.dataset.ready === "true"'), '正式本剧资产目录就绪', child);
    } catch (error) {
      evidence.assetEntryFailureState = await mainRead(`(() => ({
        readyState: document.readyState,
        activeModule: document.querySelector('.side-nav-item.active')?.dataset.app,
        frames: [...document.querySelectorAll('.creative-assets-frame')].map(frame => ({
          src: frame.getAttribute('src'), readyState: frame.contentDocument?.readyState,
          ready: frame.contentDocument?.body?.dataset.ready,
          error: frame.contentDocument?.querySelector('#assetGrid .asset-state.error')?.textContent,
          status: frame.contentDocument?.querySelector('#assetStatus')?.textContent,
          summary: frame.contentDocument?.querySelector('#librarySummary')?.textContent,
          cards: frame.contentDocument?.querySelectorAll('#assetGrid .asset-card').length,
          nativeApi: typeof frame.contentWindow?.assetAPI,
          resourceTimings: frame.contentWindow?.performance.getEntriesByType('resource').map(item => ({
            path:new URL(item.name).pathname, duration:item.duration, responseEnd:item.responseEnd
          }))
        }))
      }))()`);
      evidence.assetEntryApiProbe = await mainRead(`(async () => {
        const start=performance.now();
        try {
          const projects=await fetch('/api/creative-projects',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
          const assets=await fetch('/api/creative-assets?project='+encodeURIComponent(projects.activeProjectId),{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
          return {ok:assets.available,files:assets.stats?.files,elapsedMs:performance.now()-start};
        } catch(error) { return {error:error.message,elapsedMs:performance.now()-start}; }
      })()`);
      throw error;
    }
    const entryReadyMs = Date.now() - entryStarted;
    const entryRead = await mainRead(`(async () => {
      const requests = Array.from({length:4}, () => fetch('/api/scan').then(response => {
        if(!response.ok)throw new Error('正式扫描失败'); return response.json();
      }));
      document.querySelector('.side-nav-item[data-app="audio"]').click();
      document.querySelector('.side-nav-item[data-app="creative-assets"]').click();
      const scans = await Promise.all(requests);
      const health = await fetch('/api/production/health').then(response => response.json());
      const frame = document.querySelector('.creative-assets-frame');
      return { scanRequests:scans.length, indexedFiles:scans[0].files.length,
        documentScan:scans[0].documentScan, healthOK:health.ok,
        iframeReady:frame.contentDocument.body.dataset.ready === 'true',
        visibleCards:frame.contentDocument.querySelectorAll('#assetGrid .asset-card').length };
    })()`);
    await delay(200);
    const heartbeat = await native(() => {
      const probe = globalThis.__formalAssetEntryProbe; clearInterval(probe.timer);
      return { ticks:probe.ticks, maxGapMs:probe.maxGapMs };
    });
    assert.equal(entryRead.healthOK, true); assert.equal(entryRead.iframeReady, true);
    assert.ok(entryRead.documentScan && !entryRead.documentScan.truncated, '正式文档扫描不能截断');
    assert.ok(entryReadyMs < 5000, '正式本剧资产入口读取超时');
    assert.ok(heartbeat.ticks > 0 && heartbeat.maxGapMs < 500, '正式素材刷新阻塞主线程');
    evidence.assetEntry = { ...entryRead, entryReadyMs, heartbeat, mainSidebarConfirmed:true,
      existingAssetsReadOnly:true, simulatedDownload:false, realPlatformDownload:false };
    await mainRead(`(() => { window.desktopOS.openCreatorBrowser({mode:${JSON.stringify(config.mode)}}); return true; })()`);
    await until(() => renderer(() => location.pathname === '/creator.html' && document.body?.dataset.ready === 'true'), '返回正式创作浏览器', child);
    assert.deepEqual(await workspaceSnapshot(), workspaceBefore, '资产入口检查不能修改剧本或模板');
    assert.equal(browserCDP.creatorExceptions, 0, 'creator 不应出现未捕获异常');
    assertProtectedAlive(options.protectedPids);
  } catch (error) { failure = error; evidence.failure = error.message; }
  finally {
    if (child) {
      const owned = child.pid && (child.exitCode === null && child.signalCode === null);
      if (owned) {
        try { if (native) await native(({ app }) => { setTimeout(() => app.quit(), 40); return true; }); else child.kill('SIGTERM'); }
        catch { child.kill('SIGTERM'); }
        browserCDP?.close(); nodeCDP?.close();
        const closed = await Promise.race([exited.then(() => true), delay(15000).then(() => false)]);
        if (!closed) { child.kill('SIGTERM'); await Promise.race([exited, delay(5000)]); }
      }
      browserCDP?.close(); nodeCDP?.close();
      evidence.testOwnedProcessClosed = child.exitCode !== null || child.signalCode !== null;
      if (!evidence.testOwnedProcessClosed) failure ||= new Error('测试启动的正式程序未退出');
    }
    try {
      const after = snapshotFormalData(options.dataDir, options.projectRoot);
      compareBaseline(after, before, '验收后与启动前：');
      if (options.baseline) compareBaseline(after, options.baseline, '验收后与 supplied baseline：');
      evidence.formalDataAfter = after;
      evidence.dataPreservation = { businessRowsAndStatusesUnchanged: true, existingJsonBytesUnchanged: true,
        assetPathsAndSizesUnchanged: true, metadataBefore: before.metadata, metadataAfter: after.metadata,
        newJsonFiles: Object.keys(after.jsonHashes).filter(name => !Object.hasOwn(before.jsonHashes, name)),
        suppliedBaselineCompared: !!options.baseline };
      assertProtectedAlive(options.protectedPids);
      evidence.protectedPidsStillAlive = options.protectedPids;
    } catch (error) { failure ||= error; evidence.dataPreservationFailure = error.message; }
    evidence.creatorExceptionCount = browserCDP?.creatorExceptions ?? null;
    evidence.status = failure ? 'failed' : 'passed';
    fs.mkdirSync(path.dirname(options.evidenceOut), { recursive: true });
    fs.writeFileSync(options.evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  }
  if (failure) throw failure;
  console.log(`FORMAL_RUNTIME_ACCEPTANCE_PASS version=${options.version} packaged=true defaultProfile=true listenerPid=true menusKeepPlatform=true docxEpisodes=10 docxParagraphs=${options.paragraphCount} dataPreserved=true externalTargetsAttached=0`);
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.flags.has('--help')) { console.log(usage); return; }
  const options = validateOptions(parsed);
  if (options.run) return run(options);
  if (options.snapshotOnly) {
    assert.deepEqual(executablePids(options.executable), [], '基线应在精确目标正式程序退出后采集');
    const baseline = { status: 'baseline', formalData: snapshotFormalData(options.dataDir, options.projectRoot) };
    fs.mkdirSync(path.dirname(options.evidenceOut), { recursive: true });
    fs.writeFileSync(options.evidenceOut, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
    console.log('FORMAL_BASELINE_SNAPSHOT_PASS appLaunched=false tokenRead=false'); return;
  }
  console.log(`FORMAL_RUNTIME_PREFLIGHT_PASS version=${options.version} signed=true appLaunched=false evidenceWritten=false`);
}

module.exports = { parseArgs, validateOptions, sanitizedLaunchEnv, snapshotFormalData, compareBaseline, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
