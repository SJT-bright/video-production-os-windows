'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { findFFmpeg, readWav, createVoiceClipService, SAMPLE_RATE } = require('./voice-clips.cjs');
const { createCreativeProjectStore } = require('./creative-projects.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function makeVideo(target, audio = true) {
  execFileSync(findFFmpeg(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=0xadcbe8:s=320x180:r=24', ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
    '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : ['-an']),
    '-movflags', '+faststart', '-y', target], { timeout: 20000 });
}

async function fixture(port = 0) {
  const appRoot = path.resolve(process.env.VOICE_TEST_APP_ROOT || __dirname);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-voice-test-')));
  const child = spawn(process.execPath, ['-e', `
    const mod = require(${JSON.stringify(path.join(appRoot, 'server.js'))});
    console.log('TEST_FFMPEG=' + require(${JSON.stringify(path.join(appRoot, 'voice-clips.cjs'))}).findFFmpeg());
    mod.startServer(${Number(port)}, 0, {open:false}).then(({server}) => console.log('TEST_PORT=' + server.address().port));
    process.on('SIGTERM', () => { mod.server.closeAllConnections(); mod.server.close(() => {
      mod.productionStore?.close(); process.exit(0);
    }); });
  `], { cwd: __dirname, env: { ...process.env, VIDEO_OS_PROJECT_ROOT: root,
    VIDEO_OS_DATA_DIR: path.join(root, 'data'), VIDEO_OS_OBSIDIAN_VAULT: path.join(root, 'vault') },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试服务启动超时: ' + serverLog)), 15000);
    const collect = chunk => { serverLog += chunk; const match = serverLog.match(/TEST_PORT=(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}: ${serverLog}`)); });
  });
  if (process.env.VOICE_TEST_APP_ROOT) {
    const packagedTool = path.join(appRoot, 'vendor', 'media-tools', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    assert.ok(serverLog.includes('TEST_FFMPEG=' + packagedTool), '发行包必须使用内置 FFmpeg，而不是开发环境依赖');
    console.log('VOICE_CLIPS_PACKAGED_TOOL_PASS');
  }
  async function api(route, body, status) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (status) assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}`);
    else assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  }
  const a = (await api('/api/creative-projects', { action: 'create', name: '人物音频测试剧本' })).project;
  const b = (await api('/api/creative-projects', { action: 'create', name: '另一个测试剧本' })).project;
  await api('/api/creative-projects', { action: 'activate', id: a.id });
  const sourcePath = `${a.folder}/生成视频/对白测试.mp4`;
  const sourceFile = path.join(root, '创作资产库', sourcePath);
  makeVideo(sourceFile);
  makeVideo(path.join(root, '创作资产库', a.folder, '生成视频', '无音轨.mp4'), false);
  const sourceHash = hash(sourceFile);
  async function stop() {
    if (child.exitCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000); timeout.unref();
      await exited; clearTimeout(timeout);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { root, base, api, a, b, sourcePath, sourceFile, sourceHash, stop };
}

async function integration() {
  const f = await fixture();
  try {
    const { a, b, api, sourcePath, base } = f;
    const route = action => `/api/voice-clips/${action}?project=${a.id}`;
    const track = await api(route('prepare'), { projectId: a.id, sourcePath });
    assert.ok(track.duration >= 5.9 && track.duration <= 6.1);
    assert.equal(track.sampleRate, SAMPLE_RATE);
    assert.equal(track.peaks.length, 1000);
    assert.ok(track.peaks.every(v => v >= 0 && v <= 1) && track.peaks.some(v => v > .05));
    const previewUrl = `${base}${route('preview')}&token=${track.token}`;
    const partial = await fetch(previewUrl, { headers: { Origin: base, Range: 'bytes=0-11' } });
    assert.equal(partial.status, 206);
    assert.equal(Buffer.from(await partial.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
    const full = Buffer.from(await (await fetch(previewUrl)).arrayBuffer());
    const decoded = path.join(f.root, 'decoded.wav'); fs.writeFileSync(decoded, full);
    const decodedInfo = readWav(decoded);
    const request = { projectId: a.id, token: track.token, start: 1, end: 3.1,
      name: '女主-平静音色', characterName: '女主', description: '清亮、轻声、平静' };
    const clip = (await api(route('save'), request, 201)).item;
    assert.equal(clip.kind, 'voice'); assert.equal(clip.duration, 2.1);
    assert.equal(clip.path, `${a.folder}/音频/女主-平静音色.wav`);
    assert.equal(clip.sourceStart, 1); assert.equal(clip.sourceEnd, 3.1);
    assert.equal(clip.sourcePath, sourcePath);
    const file = path.join(f.root, '创作资产库', clip.path);
    const pcm = fs.readFileSync(file); const info = readWav(file);
    assert.equal(info.duration, 2.1); assert.equal(info.frames, 50400);
    assert.deepEqual(pcm.subarray(info.offset), full.subarray(decodedInfo.offset + 24000 * 2, decodedInfo.offset + 74400 * 2), '截取的是选中范围的原音轨采样');
    const firstHash = hash(file);
    const next = (await api(route('save'), request, 201)).item;
    assert.equal(next.filename, '女主-平静音色-2.wav'); assert.equal(hash(file), firstHash);
    const track2 = await api(route('prepare'), { projectId: a.id, sourcePath });
    const parallel = await Promise.all([track, track2].map(t => api(route('save'), { ...request, token: t.token, name: '并行音色' }, 201)));
    assert.equal(new Set(parallel.map(result => result.item.path)).size, 2, '并行保存不覆盖');
    const library = await api(`/api/audio-library?project=${a.id}`);
    assert.equal(library.items.filter(item => item.kind === 'voice' && item.available).length, 4);
    assert.equal(library.items.filter(item => item.kind === 'bgm' || item.kind === 'sfx').length, 0);
    assert.equal(library.items.find(item => item.id === clip.id).description, request.description);
    const scan = await api('/api/scan');
    const scanned = scan.files.find(item => item.relativePath === clip.path);
    assert.ok(scanned, '工作台音频素材可读到新文件');
    assert.equal(scanned.audioRole, 'voice'); assert.equal(scanned.projectId, a.id);
    assert.equal(scanned.voice.characterName, '女主');
    const tree = await api(`/api/creative-assets?project=${a.id}`);
    assert.equal(tree.stats.audio, 4, '左侧资产树立即同步，不重复计数');
    const monitor = await api(`/api/editor-exports?project=${a.id}`);
    assert.equal(monitor.folders.find(folder => folder.id === 'voice').ready, 4);
    for (const changes of [{ start: -1 }, { end: 30 }, { end: 1 }, { end: 1.001 }, { start: null }, { name: '' }]) {
      await api(route('save'), { ...request, ...changes }, 400);
    }
    await api(route('prepare'), { projectId: a.id, sourcePath: `${a.folder}/生成视频/无音轨.mp4` }, 422);
    await api(route('prepare'), { projectId: a.id, sourcePath: `${b.folder}/生成视频/镜头.mp4` }, 403);
    await api(route('prepare'), { projectId: a.id, sourcePath: `${a.folder}/../${b.folder}/生成视频/镜头.mp4` }, 404);
    fs.symlinkSync(f.sourceFile, path.join(f.root, '创作资产库', a.folder, '生成视频', '链接.mp4'));
    await api(route('prepare'), { projectId: a.id, sourcePath: `${a.folder}/生成视频/链接.mp4` }, 404);
    const spoofed = await fetch(base + route('prepare'), { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: a.id, sourcePath }) });
    assert.equal(spoofed.status, 403);
    await api('/api/creative-projects', { action: 'activate', id: b.id });
    await api(`/api/voice-clips/save?project=${b.id}`, request, 409);
    await api(route('release'), { projectId: a.id, token: track.token });
    await api(route('release'), { projectId: a.id, token: track2.token });
    await api('/api/creative-projects', { action: 'activate', id: a.id });
    await api(route('save'), request, 410);
    assert.equal(fs.readdirSync(path.join(f.root, '创作资产库', b.folder, '音频')).length, 0);
    assert.equal(hash(f.sourceFile), f.sourceHash, '原视频内容未改动');
    assert.equal((await api(`/api/audio-library?project=${a.id}`)).items.length, 4);
    console.log('VOICE_CLIPS_API_PASS: 波形、试听 Range、精确 2.1 秒、同名/并行保存、当前剧本归属、工作台与资产树同步、来源备注、无音轨、跨项目、链接和输入校验');
  } finally { await f.stop(); }
}

async function rollback() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-voice-rollback-'));
  let service;
  try {
    const assetRoot = path.join(root, '资产');
    const projectStore = createCreativeProjectStore({ filePath: path.join(root, 'projects.json'), assetRoot });
    const project = projectStore.create({ name: '回滚测试' }); projectStore.activate(project.id);
    const relative = `${project.folder}/生成视频/测试.mp4`; makeVideo(path.join(assetRoot, relative));
    service = createVoiceClipService({ assetRoot, projectStore, onSaved: () => { throw new Error('登记失败'); } });
    const track = await service.prepare({ projectId: project.id, sourcePath: relative });
    const tempFile = service.preview(track.token, project.id);
    await assert.rejects(service.save({ projectId: project.id, token: track.token, start: 0, end: 2.1, name: '不能留半成品' }), /登记失败/);
    assert.equal(fs.readdirSync(projectStore.category(project.id, 'audio').absolutePath).length, 0);
    service.release(track.token, project.id); assert.equal(fs.existsSync(tempFile), false);
    console.log('VOICE_CLIPS_ROLLBACK_PASS: 失败清理、临时试听释放');
  } finally { service?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv.includes('--serve')) {
  const index = process.argv.indexOf('--port');
  fixture(index >= 0 ? process.argv[index + 1] : 0).then(f => {
    console.log('VOICE_UI_READY=' + JSON.stringify({ base: f.base, projectId: f.a.id, sourcePath: f.sourcePath }));
    const stop = () => f.stop().then(() => process.exit(0));
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else if (require.main === module) {
  integration().then(rollback).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { fixture, makeVideo };
