'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { scanProjectDocuments } = require('./project-documents.cjs');
const { buildCreativeAssetTree, buildCreativeAssetTreeAsync } = require('./creative-assets.cjs');
const { createAssetWorkflowStore } = require('./asset-workflow.cjs');

const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'video-os-project-documents-'));
const root = path.join(temp, 'project');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
function put(relative, content = '# 文档\n\n## 一句话蒸馏\n保留项目知识。\n') {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
}

async function main() {
  for (const name of ['手册.md', '说明.txt', '字幕.srt', 'AGENTS.md', 'MEMORY-MANIFEST.md',
    '学习/VIDEO-001_原理.md', '.analysis/TOOL-001_工具.md', '学习/规范/AGENTS.md']) put(name);
  for (const directory of ['视频制作OS', '创作资产库', 'data', '.worktrees', '.git', 'node_modules',
    'test-artifacts', '旧软件.app', '运行时.framework', '学习/node_modules', '学习/test-artifacts']) {
    put(`${directory}/VIDEO-999_技术伪文档.md`);
  }
  put('学习/普通笔记.md');
  fs.symlinkSync(path.join(root, '学习'), path.join(root, '链接目录'));
  fs.symlinkSync(path.join(root, '手册.md'), path.join(root, '链接.md'));
  const options = { root, excludedRoots: ['视频制作OS', '创作资产库', 'data'].map(name => path.join(root, name)) };
  const result = await scanProjectDocuments(options);
  assert.deepEqual(result.files.map(file => file.path).sort(), ['手册.md', '说明.txt', '字幕.srt', 'AGENTS.md',
    'MEMORY-MANIFEST.md', '学习/VIDEO-001_原理.md', '.analysis/TOOL-001_工具.md', '学习/规范/AGENTS.md'].sort());
  assert.equal(result.limits.truncated, false); assert.equal(result.limits.readErrors, 0);
  assert.equal(result.files.find(file => file.path.startsWith('.analysis/')).hidden, true);
  assert.equal((await scanProjectDocuments({ ...options, maxEntries: 1 })).limits.truncated, true);
  const shallow = await scanProjectDocuments({ ...options, maxDepth: 0 });
  assert.equal(shallow.limits.truncated, true);
  assert.deepEqual(shallow.files.map(file => file.path).sort(), result.files.filter(file => !file.path.includes('/')).map(file => file.path).sort(),
    'A deep folder must not stop the remaining root documents');

  for (let i = 0; i < 36; i++) put(`文档${String(i).padStart(2, '0')}/VIDEO-${i + 2}_正文.md`);
  const originalOpen = fs.promises.opendir;
  let rootOpens = 0, ticks = 0, maxGap = 0, lastTick = performance.now();
  fs.promises.opendir = async function (absolute, ...args) {
    if (absolute === root) rootOpens++;
    await delay(3); return originalOpen.call(this, absolute, ...args);
  };
  const heartbeat = setInterval(() => { const now = performance.now(); ticks++; maxGap = Math.max(maxGap, now - lastTick); lastTick = now; }, 5);
  try { await scanProjectDocuments(options); }
  finally { clearInterval(heartbeat); fs.promises.opendir = originalOpen; }
  assert.equal(rootOpens, 1); assert.ok(ticks > 10, 'Main event loop must remain available during directory I/O');
  assert.ok(maxGap < 100, `Main loop paused for ${maxGap}ms`);

  const assetRoot = path.join(root, '创作资产库'), project = { id: 'fixture-project', folder: '异步资产验收',
    categories: [{ id: 'generated-videos', path: '异步资产验收/生成视频' }] };
  for (let i = 0; i < 280; i++) put(`创作资产库/${project.folder}/生成视频/核绘/第${i % 3 + 1}集/片段${i}.mp4`, 'fixture media');
  put(`创作资产库/${project.folder}/生成视频/核绘/第1集/片段0.prompt.txt`);
  fs.symlinkSync(path.join(root, '学习'), path.join(assetRoot, project.folder, '链接目录'));
  const treeOptions = { scopePath: project.folder };
  const asyncTree = await buildCreativeAssetTreeAsync(assetRoot, treeOptions);
  assert.deepEqual(asyncTree, buildCreativeAssetTree(assetRoot, treeOptions), 'Async tree must preserve normal folder order, file order, counts, paths and sidecar exclusions');
  assert.equal((await buildCreativeAssetTreeAsync(assetRoot, { ...treeOptions, maxEntries: 2 })).truncated, true);
  assert.equal((await buildCreativeAssetTreeAsync(assetRoot, { ...treeOptions, maxDepth: 0 })).truncated, true);
  let registrations = 0, registrationTicks = 0;
  const workflow = createAssetWorkflowStore({ filePath: path.join(temp, 'workflow.json'), assetRoot,
    registerAsset: () => ({ id: `asset-${++registrations}` }) });
  const registrationHeartbeat = setInterval(() => registrationTicks++, 1);
  try { await workflow.enrichAsync(asyncTree, project); }
  finally { clearInterval(registrationHeartbeat); }
  assert.equal(registrations, 280); assert.ok(registrationTicks > 0, 'Asset registration must yield to the main event loop');
  const persisted = JSON.parse(fs.readFileSync(path.join(temp, 'workflow.json'), 'utf8'));
  assert.equal(Object.keys(persisted.items).length, 280);
  const repeatTree = await workflow.enrichAsync(await buildCreativeAssetTreeAsync(assetRoot, treeOptions), project);
  assert.deepEqual(repeatTree, asyncTree); assert.equal(registrations, 280, 'Repeated listing must preserve asset IDs without duplicate registration');

  // The real HTTP handler shares concurrent scans. An artificial I/O delay is
  // confined to this disposable child, and makes the concurrency measurable.
  const program = `
    const fs = require('node:fs');
    const original = fs.promises.opendir;
    fs.promises.opendir = async function(dir, ...args) {
      if (dir === process.env.VIDEO_OS_PROJECT_ROOT) console.log('DOC_SCAN_START');
      await new Promise(resolve => setTimeout(resolve, 5));
      return original.call(this, dir, ...args);
    };
    require(${JSON.stringify(path.join(__dirname, 'server.js'))}).startServer(0, 0)
      .then(({server}) => console.log('TEST_PORT=' + server.address().port));
  `;
  child = spawn(process.execPath, ['-e', program], { cwd: __dirname, env: { ...process.env,
    VIDEO_OS_PROJECT_ROOT: root, VIDEO_OS_DATA_DIR: path.join(root, 'data'), OBSIDIAN_VAULT_PATH: path.join(temp, 'vault') },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = chunk => { output += chunk; };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  let port;
  for (let i = 0; i < 200 && !port; i++) { const match = output.match(/TEST_PORT=(\d+)/); if (match) port = Number(match[1]); else await delay(25); }
  assert.ok(port, output || 'HTTP server did not start');
  const base = `http://127.0.0.1:${port}`;
  const api = async route => {
    const response = await fetch(base + route, { headers: { Origin: base }, signal: AbortSignal.timeout(15000) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
  };
  let scansFinished = false;
  const scans = Promise.all(Array.from({ length: 8 }, () => api('/api/scan'))).then(value => { scansFinished = true; return value; });
  // Attach failure handling before a diagnostic assertion can tear down the
  // child. Cold filesystem scans may precede the deliberately delayed phase.
  scans.catch(() => {});
  for (let i = 0; i < 1000 && !output.includes('DOC_SCAN_START'); i++) await delay(5);
  assert.ok(output.includes('DOC_SCAN_START'), output);
  const pingStarted = performance.now();
  const health = await api('/api/production/health');
  const healthMs = performance.now() - pingStarted;
  assert.equal(health.ok, true); assert.equal(scansFinished, false, 'A second API must respond before the delayed scan finishes');
  assert.ok(healthMs < 200, `Health request stalled for ${healthMs}ms`);
  const responses = await scans;
  assert.equal((output.match(/DOC_SCAN_START/g) || []).length, 1, 'Eight concurrent requests should run one document scan');
  assert.ok(responses.every(value => JSON.stringify(value) === JSON.stringify(responses[0])));
  assert.ok(!responses[0].docs.some(file => file.name.includes('技术伪文档')));
  put('后续新手册.md');
  assert.ok((await api('/api/scan')).docs.some(file => file.name === '后续新手册.md'), 'The next scan must not return a stale persistent cache');
  assert.equal((output.match(/DOC_SCAN_START/g) || []).length, 2);
  console.log('PROJECT_DOCUMENTS_TEST_PASS ' + JSON.stringify({ checkedDocs: result.files.length,
    heartbeatTicks: ticks, maxHeartbeatGapMs: Math.round(maxGap), concurrentScans: 8, underlyingScans: 1,
    healthDuringScanMs: Math.round(healthMs), nextScanFresh: true, asyncAssets: 280, stableAssetIds: true, isolatedRoots: true }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]); }
  fs.rmSync(temp, { recursive: true, force: true });
});
