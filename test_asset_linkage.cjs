'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const runRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-linkage-')));
const root = path.join(runRoot, 'project');
const external = path.join(runRoot, 'exports');
const vault = path.join(runRoot, 'vault');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, abortEvents;

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
function wav() {
  const b = Buffer.alloc(204); b.write('RIFF'); b.writeUInt32LE(196, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(160, 40);
  return b;
}
const box = type => { const b = Buffer.alloc(16); b.writeUInt32BE(16); b.write(type, 4); return b; };
const mp4 = Buffer.concat(['ftyp', 'mdat', 'moov'].map(box));

async function checkBackend() {
  for (const folder of [root, external, vault, path.join(root, '素材库')]) fs.mkdirSync(folder, { recursive: true });
  child = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'server.js'))}).startServer(0,0).then(({server})=>console.log('TEST_PORT='+server.address().port))`], {
    cwd: __dirname, env: { ...process.env, VIDEO_OS_PROJECT_ROOT: root, VIDEO_OS_DATA_DIR: path.join(root, 'data'), OBSIDIAN_VAULT_PATH: vault }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let output = ''; const timeout = setTimeout(() => reject(Error(output || 'Server timeout')), 10000);
    const collect = chunk => { output += chunk; const match = output.match(/TEST_PORT=(\d+)/); if (match) { clearTimeout(timeout); resolve(+match[1]); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('exit', code => { clearTimeout(timeout); reject(Error(`Server exit ${code}: ${output}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function api(route, body, raw = false, expected = 200) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base,
      ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const data = await response.json();
    assert.ok(expected >= 400 ? response.status === expected : response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  }
  const a = (await api('/api/creative-projects', { action: 'create', name: '剧本甲' })).project;
  const b = (await api('/api/creative-projects', { action: 'create', name: '剧本乙' })).project;
  await api('/api/creative-projects', { action: 'activate', id: a.id });
  fs.writeFileSync(path.join(external, '人物音色.wav'), wav());
  fs.writeFileSync(path.join(external, '参考.png'), png);
  fs.writeFileSync(path.join(external, '成片.mp4'), mp4);
  await api('/api/library-sources', { action: 'add', rootPath: external, label: '剪映外部目录', projectId: a.id, purpose: 'finals' });
  let scan = await api('/api/scan');
  assert.equal(scan.files.filter(file => file.projectId === a.id).length, 3);
  const voice = scan.files.find(file => file.name === '人物音色.wav');
  assert.equal(voice.type, 'audio');
  assert.equal(scan.files.find(file => file.name === '成片.mp4').meta.isFinal, true);
  const response = await fetch(base + '/api/file?p=' + encodeURIComponent(voice.path), { headers: { Origin: base, Range: 'bytes=0-11' } });
  assert.equal(response.status, 206); assert.equal(Buffer.from(await response.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');

  abortEvents = new AbortController(); const events = [];
  const stream = await fetch(base + '/api/events', { headers: { Origin: base }, signal: abortEvents.signal });
  const collecting = (async () => { const reader = stream.body.getReader(); try { for (;;) { const result = await reader.read(); if (result.done) break; events.push(Buffer.from(result.value).toString()); } } catch (error) { if (error.name !== 'AbortError') throw error; } })();
  await delay(1200); events.length = 0;
  fs.writeFileSync(path.join(external, '新导出.wav'), wav());
  for (let i = 0; i < 20 && !events.some(value => value.includes('event: rescan')); i++) await delay(150);
  assert.ok(events.some(value => value.includes('event: rescan')), '外部导出应自动通知界面');
  abortEvents.abort(); await collecting;
  console.log('PASS: 外部音频、成片归属、Range 试听和目录刷新');

  const copied = await api('/api/library-use', { path: voice.path, projectId: a.id, category: '音频' });
  assert.ok(copied.path.startsWith(a.folder + '/音频/'));
  assert.ok(fs.existsSync(path.join(external, '人物音色.wav')), '原文件不移动');
  assert.equal((await api('/api/library-use', { path: voice.path, projectId: a.id, category: '音频' })).existing, true);
  assert.equal((await api(`/api/creative-assets?project=${a.id}`)).stats.audio, 1);
  const image = scan.files.find(file => file.name === '参考.png');
  const concurrent = await Promise.all([1, 2].map(() => api('/api/library-use', { path: image.path, projectId: a.id })));
  assert.equal(concurrent[0].path, concurrent[1].path, '并发复用同一素材也只复制一次');
  // 固定目标剧本，不随复制期间的全局当前剧本改变。
  await api('/api/creative-projects', { action: 'activate', id: b.id });
  const copyToA = await api('/api/library-use', { path: voice.path, projectId: a.id, category: 'BGM' });
  assert.ok(copyToA.path.startsWith(a.folder + '/BGM/'));
  assert.equal((await api(`/api/creative-assets?project=${b.id}`)).stats.audio, 0);
  await api('/api/creative-projects', { action: 'activate', id: a.id });
  fs.writeFileSync(path.join(vault, '角色.png'), png);
  const obsidianCopy = await api('/api/library-use', { source: 'obsidian', path: '角色.png', projectId: a.id, category: '人物资产' });
  assert.ok(obsidianCopy.path.startsWith(a.folder + '/人物资产/'));
  assert.ok(fs.existsSync(path.join(vault, '角色.png')));
  await api('/api/library-use', { source: 'obsidian', path: '../outside.png', projectId: a.id }, false, 404);
  await api('/api/library-use', { path: voice.path, projectId: a.id, category: '成片' }, false, 400);
  console.log('PASS: 外部来源与 Obsidian 用于本剧、分类、去重、项目隔离及原文件保留');

  const generic = await api(`/api/creative-assets/import?project=${a.id}&folder=${encodeURIComponent(a.folder + '/BGM')}&name=${encodeURIComponent('直接导入.wav')}`, wav(), true);
  let cards = (await api(`/api/audio-library?project=${a.id}`)).items;
  const direct = cards.find(item => item.path === generic.path); assert.ok(direct?.available);
  await api(`/api/audio-library?project=${a.id}`, { action: 'rename', id: direct.id, name: '温暖主题' });
  await api(`/api/creative-assets/rename?project=${a.id}`, { path: direct.path, name: '换文件名.wav' });
  cards = (await api(`/api/audio-library?project=${a.id}`)).items;
  assert.equal(cards.find(item => item.id === direct.id).name, '温暖主题');
  assert.equal(cards.find(item => item.id === direct.id).available, true);
  await api(`/api/audio-library?project=${a.id}`, { action: 'remove', id: direct.id });
  assert.equal((await api(`/api/audio-library?project=${a.id}`)).items.some(item => item.id === direct.id), false);
  assert.ok(fs.existsSync(path.join(root, '创作资产库', a.folder, 'BGM', '换文件名.wav')));
  const named = await api(`/api/audio-library?project=${a.id}`, { action: 'create', kind: 'sfx', name: '敲门' });
  await api(`/api/audio-library/upload?project=${a.id}&entry=${named.item.id}&kind=sfx&name=knock.wav`, wav(), true);
  cards = (await api(`/api/audio-library?project=${a.id}`)).items;
  assert.equal(cards.filter(item => item.kind === 'sfx').length, 1, '专用导入不产生自动补录的重复条目');
  assert.equal(cards.find(item => item.id === named.item.id).name, '敲门');
  console.log('PASS: BGM 与音效自动补录、名称绑定、改名、移除不复活、专用上传去重');

  scan = await api('/api/scan'); const initial = scan.files.find(file => file.name === '角色.png');
  await api('/api/meta', { path: initial.path, starred: true, note: '保留备注', tags: ['角色'] });
  const overlapping = path.join(root, '创作资产库', a.folder, '人物资产');
  await api('/api/library-sources', { action: 'add', rootPath: overlapping, label: '重复索引', projectId: a.id });
  scan = await api('/api/scan'); const afterIndex = scan.files.find(file => file.name === '角色.png');
  assert.equal(afterIndex.path, initial.path); assert.equal(afterIndex.meta.starred, true);
  assert.equal(scan.files.filter(file => file.name === '角色.png').length, 1);
  // 旧客户端依然持有外部 token，也必须落到统一标记记录。
  await api('/api/meta', { path: afterIndex.aliasPath, note: '旧入口更新' });
  await api(`/api/creative-assets/rename?project=${a.id}`, { path: obsidianCopy.path, name: '改名角色.png' });
  const renamed = (await api('/api/scan')).files.find(file => file.name === '改名角色.png');
  assert.equal(renamed.meta.starred, true); assert.equal(renamed.meta.note, '旧入口更新'); assert.deepEqual(renamed.meta.tags, ['角色']);
  assert.equal((await api('/api/library-use', { source: 'obsidian', path: '角色.png', projectId: a.id, category: '人物资产' })).existing, true, '改名后仍识别已经复用');
  const sourceId = afterIndex.linkedSourceId;
  await api('/api/library-sources', { action: 'remove', id: sourceId });
  assert.equal((await api('/api/scan')).files.find(file => file.name === '改名角色.png').meta.note, '旧入口更新');
  // 旧版本只在外部 token 下存过的标记，在停止索引前也应迁移回来。
  await api('/api/library-sources', { action: 'add', rootPath: overlapping, label: '旧索引迁移', projectId: a.id });
  const legacySource = (await api('/api/scan')).sources.find(item => item.label === '旧索引迁移');
  const metaFile = path.join(root, 'data', 'asset-meta.json');
  const legacyMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  delete legacyMeta.items[renamed.path];
  legacyMeta.items[`@media/${legacySource.id}/改名角色.png`] = { starred: true, note: '旧版记录' };
  fs.writeFileSync(metaFile, JSON.stringify(legacyMeta));
  await api('/api/library-sources', { action: 'remove', id: legacySource.id });
  assert.equal((await api('/api/scan')).files.find(file => file.name === '改名角色.png').meta.note, '旧版记录');
  console.log('PASS: 重复索引不换身份、旧入口标记合并、改名和取消索引不丢标记');
}

async function checkRendererTransitions() {
  const source = fs.readFileSync(path.join(__dirname, 'creator-assets.js'), 'utf8');
  const definitions = source.slice(source.indexOf('let reloadTimer = null;'), source.indexOf('function showToast('));
  const a = { id: 'a', folder: '甲', name: '甲' }, b = { id: 'b', folder: '乙', name: '乙' };
  const timers = new Map(); let next = 0, refreshes = 0;
  const context = { state: { config: { project: a }, knownFolders: new Set(), collapsedFolders: new Set() },
    el: { previewDialog: { open: false }, folderTree: { replaceChildren() {} }, assetGrid: { replaceChildren() {} }, librarySummary: {} },
    window: {}, setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id),
    API: { getConfig: async () => ({ project: b }) }, loadLibrary: async () => { refreshes++; }, showToast: message => { throw Error(message); } };
  vm.createContext(context); vm.runInContext(definitions, context);
  context.scheduleLibraryReload(true); context.scheduleLibraryReload(false);
  for (const callback of timers.values()) await callback();
  assert.equal(context.state.config.project.id, 'b'); assert.equal(context.state.selectedFolder, '乙'); assert.equal(refreshes, 1);
  const uploads = [];
  Object.assign(context, { Array, encodeURIComponent, activeProjectId: () => context.state.config.project.id,
    libraryPaneEl: { classList: { contains: () => false } }, folderLabel: () => '甲',
    fetch: async url => { uploads.push(new URL(url, 'http://localhost')); context.state.selectedFolder = '乙/人物资产'; return { ok: true, json: async () => ({}) }; } });
  Object.assign(context.el, { importAssets: {}, assetStatus: {}, assetFileInput: {} });
  context.state.selectedFolder = '乙/生成图片';
  context.showToast = () => {};
  vm.runInContext(source.slice(source.indexOf('async function importFiles(files)'), source.indexOf('function bindEvents()', source.indexOf('async function importFiles(files)'))), context);
  await context.importFiles([{ name: '一.png' }, { name: '二.png' }]);
  assert.ok(uploads.every(url => url.searchParams.get('folder') === '乙/生成图片'), '批量导入固定开始时的目录');
  uploads.length = 0; context.state.config.project = a; context.state.selectedFolder = '甲/生成图片';
  context.fetch = async url => { uploads.push(url); context.state.config.project = b; return { ok: true, json: async () => ({}) }; };
  await context.importFiles([{ name: '一.png' }, { name: '二.png' }]);
  assert.equal(uploads.length, 1, '剧本切换后剩余文件不可导向新剧本');
  console.log('PASS: 双刷新事件不相互覆盖、批量导入固定归属');
}

(async () => {
  try { await checkBackend(); await checkRendererTransitions(); }
  finally {
    abortEvents?.abort();
    if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    assert.ok(path.basename(runRoot).startsWith('video-os-linkage-'));
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
