'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCreativeProjectStore } = require('./creative-projects.cjs');
const { buildCreativeAssetTree } = require('./creative-assets.cjs');
const { createEditorExportMonitor } = require('./editor-exports.cjs');

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-editor-exports-'));
let child;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 合法 PCM WAV；MP4 仅提供容器结构夹具，用于检查未写完的 box，不声称能解码播放。
function wav(samples = 80) {
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}
function box(type, size = 16) {
  const buffer = Buffer.alloc(size); buffer.writeUInt32BE(size); buffer.write(type, 4); return buffer;
}
const mp4 = Buffer.concat([box('ftyp'), box('mdat'), box('moov')]);

function checkMonitor() {
  const root = path.join(runRoot, 'unit');
  const assets = path.join(root, '创作资产库');
  fs.mkdirSync(root);
  const store = createCreativeProjectStore({ filePath: path.join(root, 'projects.json'), assetRoot: assets });
  const a = store.create({ name: '剧本甲' });
  const b = store.create({ name: '剧本乙' });
  let time = Date.now(), changes = 0;
  const monitor = createEditorExportMonitor({ assetRoot: assets, projectStore: store, now: () => time, onChange: () => changes++ });
  monitor.refresh();
  const folder = (project, kind) => monitor.snapshot(project.id).folders.find(item => item.id === kind);
  const voice = folder(a, 'voice');
  assert.equal(voice.absolutePath, store.category(a.id, 'audio').absolutePath, '复用现有音频目录');
  const filename = path.join(voice.absolutePath, '角色.wav');
  fs.writeFileSync(filename, wav().subarray(0, 44));
  monitor.refresh(); time += 5000;
  assert.equal(folder(a, 'voice').pending, 1, 'WAV 未写完声明长度时不能入库');
  fs.writeFileSync(filename, wav());
  monitor.refresh(); time += 2000;
  assert.equal(folder(a, 'voice').pending, 1);
  time += 2500;
  assert.equal(folder(a, 'voice').ready, 1);
  store.activate(b.id);
  fs.writeFileSync(path.join(folder(b, 'voice').absolutePath, '角色.wav'), wav());
  monitor.refresh(); time += 5000;
  assert.equal(folder(a, 'voice').ready, 1, '切换当前剧本不改变原音频归属');
  assert.equal(folder(b, 'voice').ready, 1, '不同剧本同名音频互不覆盖');
  fs.writeFileSync(filename, wav(160));
  assert.equal(folder(a, 'voice').pending, 1, '同名覆盖时重新等待');
  time += 5000;
  assert.equal(folder(a, 'voice').ready, 1, '覆盖后只保留一条');
  const nested = path.join(voice.absolutePath, '女主');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, '音色.wav'), wav());
  const finalFolder = folder(a, 'finals');
  fs.writeFileSync(path.join(finalFolder.absolutePath, '第一集.mp4'), mp4.subarray(0, 36));
  fs.writeFileSync(path.join(finalFolder.absolutePath, '备注.wav'), wav());
  fs.writeFileSync(path.join(voice.absolutePath, '错误类型.mp4'), mp4);
  if (process.platform !== 'win32') fs.symlinkSync(filename, path.join(voice.absolutePath, '链接.wav'));
  monitor.refresh(); time += 5000;
  assert.equal(folder(a, 'voice').ready, 2, '递归读取人物子目录，排除链接及错误媒体类型');
  assert.equal(folder(a, 'finals').pending, 1, '不完整 MP4 不收录');
  fs.writeFileSync(path.join(finalFolder.absolutePath, '第一集.mp4'), mp4);
  monitor.refresh(); time += 5000;
  assert.equal(folder(a, 'finals').ready, 1);
  assert.equal(monitor.owner(`${a.folder}/生成视频/镜头.mp4`, 'video'), undefined, '普通生成视频不是成片');
  fs.writeFileSync(path.join(voice.absolutePath, '正在导出.wav'), wav());
  const tree = buildCreativeAssetTree(assets, { scopePath: a.folder, includeFile: monitor.includeFile });
  assert.equal(tree.stats.audio, 3, '资产树和大厅一致，不计仍在写入的文件');
  fs.unlinkSync(filename);
  assert.equal(folder(a, 'voice').ready, 1, '删除文件后移除索引');
  assert.ok(changes > 0, '状态变化通知前端');
  time += 5000;
  const reopened = createEditorExportMonitor({ assetRoot: assets, projectStore: store, now: () => time });
  assert.equal(reopened.snapshot(a.id).folders.find(item => item.id === 'voice').ready, 2, '重启补充已有导出');
  console.log('PASS: 固定目录、项目隔离、音频/成片识别、写入稳定、覆盖去重、删除、离线补录');
}

async function checkServer() {
  const root = path.join(runRoot, 'integration');
  fs.mkdirSync(root);
  child = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'server.js'))}).startServer(0, 0).then(({server}) => console.log('TEST_PORT=' + server.address().port))`], {
    cwd: __dirname, env: { ...process.env, VIDEO_OS_PROJECT_ROOT: root,
      VIDEO_OS_DATA_DIR: path.join(root, 'data'), VIDEO_OS_OBSIDIAN_VAULT: path.join(root, 'vault') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(output || '服务器启动超时')), 10000);
    const collect = data => {
      output += data;
      const match = output.match(/TEST_PORT=(\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`服务器退出 ${code}: ${output}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function api(route, body) {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET',
      headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload;
  }
  const a = (await api('/api/creative-projects', { action: 'create', name: '测试剧本甲' })).project;
  const dirs = await api(`/api/editor-exports?project=${a.id}`);
  assert.equal(dirs.folders.length, 2);
  const audio = dirs.folders.find(item => item.id === 'voice');
  const finals = dirs.folders.find(item => item.id === 'finals');
  fs.writeFileSync(path.join(audio.absolutePath, '甲-音色.wav'), wav());
  fs.writeFileSync(path.join(finals.absolutePath, '甲-成片.mp4'), mp4);
  fs.writeFileSync(path.join(root, '创作资产库', a.folder, '生成视频', '普通镜头.mp4'), mp4);
  const first = await api('/api/scan');
  assert.ok(!first.files.some(item => item.name === '甲-音色.wav'), '音频导出途中不显示');
  const b = (await api('/api/creative-projects', { action: 'create', name: '测试剧本乙' })).project;
  let scan;
  for (let index = 0; index < 20; index++) {
    await delay(350);
    scan = await api('/api/scan');
    if (scan.files.some(item => item.name === '甲-音色.wav')) break;
  }
  const voice = scan.files.find(item => item.name === '甲-音色.wav');
  const film = scan.files.find(item => item.name === '甲-成片.mp4');
  assert.equal(voice?.projectId, a.id);
  assert.equal(voice?.exportKind, 'voice');
  assert.equal(film?.projectId, a.id);
  assert.equal(film?.meta.isFinal, true);
  assert.equal(film?.finalSource, true);
  assert.ok(!scan.files.find(item => item.name === '普通镜头.mp4').meta.isFinal);
  assert.equal((await api(`/api/editor-exports?project=${a.id}`)).project.id, a.id, '查看其他剧本导出目录不受当前剧本限制');
  assert.equal((await api('/api/creative-projects')).activeProjectId, b.id, '查看目录不会切换当前创作');
  await api('/api/creative-projects', { action: 'activate', id: a.id });
  const assets = await api(`/api/creative-assets?project=${a.id}`);
  assert.equal(assets.stats.audio, 1, '创作资产库自动显示同一个音频');
  await api('/api/creative-projects', { action: 'activate', id: b.id });
  assert.equal((await api(`/api/creative-assets?project=${b.id}`)).stats.audio, 0);
  const audioFile = await fetch(`${base}/api/file?${new URLSearchParams({ p: voice.path })}`, { headers: { Range: 'bytes=0-11' } });
  assert.equal(audioFile.status, 206, '音频可按 Range 读取试听');
  assert.equal(Buffer.from(await audioFile.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
  const blocked = await fetch(`${base}/api/editor-exports?project=${a.id}`, { headers: { Origin: 'https://unrelated.example' } });
  assert.equal(blocked.status, 403);
  const unknown = await fetch(`${base}/api/editor-exports?project=missing`);
  assert.equal(unknown.status, 404);
  assert.ok((await (await fetch(`${base}/creator-assets.html`)).text()).includes('id="editorExports"'));
  console.log('PASS: 真实服务目录 API、自动索引、项目切换、成片归类、音频 Range、资产库同步及来源限制');
}

(async () => {
  try { checkMonitor(); await checkServer(); }
  finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
    assert.ok(path.basename(runRoot).startsWith('video-os-editor-exports-'));
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
