'use strict';

// Isolated API regression. All files, JSON and SQLite fixtures live under one mkdtemp root.
// Folder rename uses the exported helper shared with Electron; there is no HTTP rename-folder route.
// Container fixtures exercise storage/reference behavior, not video decoding or external editor delivery.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-asset-workflow-')));
const projectRoot = path.join(fixture, 'project');
const dataRoot = path.join(fixture, 'data');
const assetRoot = path.join(projectRoot, '创作资产库');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const abs = relative => path.join(assetRoot, ...relative.split('/'));
const metadataKey = relative => `@media/creative-assets/${relative}`;
const readData = name => JSON.parse(fs.readFileSync(path.join(dataRoot, name), 'utf8'));
const writeData = (name, data) => fs.writeFileSync(path.join(dataRoot, name), JSON.stringify(data));
const sidecar = relative => path.posix.join(path.posix.dirname(relative), `${path.posix.parse(relative).name}.prompt.txt`);
const movie = Buffer.concat(['ftyp', 'mdat', 'moov'].map(type => {
  const box = Buffer.alloc(16); box.writeUInt32BE(16); box.write(type, 4); return box;
}));
const wave = Buffer.alloc(204);
wave.write('RIFF'); wave.writeUInt32LE(196, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28);
wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(160, 40);
const promptText = '历史提示词原文\n素材整理后仍须完整保留。\n';

let child = null, base = '', rpcSequence = 0;
let eventAbort = null, eventCollection = null;
const pendingRpc = new Map();
const eventPayloads = [];

async function start() {
  const script = `
    const api = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
    const fixtureFs = require('node:fs');
    let copyGate = null;
    process.on('message', message => {
      try {
        let result;
        if (message.action === 'seedDownload') result = api.productionStore.recordDownload(message.input, message.snapshot);
        else if (message.action === 'ledger') result = {
          assets: api.productionStore.db.prepare('SELECT id, project_id, path, kind FROM asset_refs ORDER BY id').all(),
          inbox: api.productionStore.db.prepare('SELECT download_key, asset_id, asset_path, filename FROM inbox_items ORDER BY download_key').all(),
        };
        else if (message.action === 'renameFolder') result = api.renameCreativeFolder(message.projectId, message.path, message.name);
        else if (message.action === 'failNextRelocation') {
          if (!['relocateAsset', 'relocateFolder'].includes(message.method)) throw new Error('Invalid fixture method');
          const original = api.productionStore[message.method];
          api.productionStore[message.method] = function () {
            api.productionStore[message.method] = original;
            throw new Error('fixture ledger failure: ' + message.method);
          };
          result = { armed: message.method };
        }
        else if (message.action === 'armCopyGate') {
          if (copyGate) throw new Error('Copy gate already armed');
          const original = fixtureFs.promises.copyFile;
          copyGate = { original, waiting: [], count: message.count, phase: message.phase || 'before' };
          fixtureFs.promises.copyFile = function (...args) {
            const gate = copyGate;
            return new Promise((resolve, reject) => {
              const hold = () => {
                gate.waiting.push({ args, resolve, reject });
                if (gate.waiting.length === gate.count) fixtureFs.promises.copyFile = original;
              };
              if (gate.phase === 'after') original.apply(fixtureFs.promises, args).then(hold, reject);
              else hold();
            });
          };
          result = { armed: message.count };
        }
        else if (message.action === 'copyGateStatus') result = { waiting: copyGate?.waiting.length || 0 };
        else if (message.action === 'releaseCopyGate') {
          const gate = copyGate;
          if (!gate || gate.waiting.length !== gate.count) throw new Error('Copy gate not ready');
          copyGate = null;
          fixtureFs.promises.copyFile = gate.original;
          for (const call of gate.waiting) {
            if (gate.phase === 'after') call.resolve();
            else gate.original.apply(fixtureFs.promises, call.args).then(call.resolve, call.reject);
          }
          result = { released: gate.count };
        }
        else throw new Error('Unknown fixture action');
        process.send({ requestId: message.requestId, result });
      } catch (error) { process.send({ requestId: message.requestId, error: error.message }); }
    });
    api.startServer(0, 0).then(({ server }) => console.log('ASSET_WORKFLOW_PORT=' + server.address().port));
  `;
  child = spawn(process.execPath, ['-e', script], {
    cwd: __dirname,
    // Deliberately pass the OS spelling (/var or Windows TEMP's 8.3 alias),
    // while assertions use the canonical native path stored in the ledger.
    env: { ...process.env, VIDEO_OS_PROJECT_ROOT: path.join(os.tmpdir(), path.basename(fixture), 'project'), VIDEO_OS_TEST_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: dataRoot, OBSIDIAN_VAULT_PATH: path.join(fixture, 'vault') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', message => {
    const pending = pendingRpc.get(message.requestId);
    if (!pending) return;
    pendingRpc.delete(message.requestId); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 15000);
    const collect = chunk => {
      output += chunk.toString();
      const match = output.match(/ASSET_WORKFLOW_PORT=(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
  base = `http://127.0.0.1:${port}`;
}

function rpc(action, body = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++rpcSequence;
    const timer = setTimeout(() => { pendingRpc.delete(requestId); reject(new Error(`Fixture RPC timeout: ${action}`)); }, 10000);
    pendingRpc.set(requestId, { resolve, reject, timer });
    child.send({ requestId, action, ...body });
  });
}

async function api(route, body, expectedStatus) {
  const { response, data } = await request(route, body);
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, `${route}: ${JSON.stringify(data)}`);
  else assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function request(route, body) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}
async function waitCopyGate(count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await rpc('copyGateStatus')).waiting === count) return;
    await delay(20);
  }
  assert.fail(`Copy gate did not receive ${count} disk-copy calls`);
}

async function stop() {
  eventAbort?.abort();
  if (eventCollection) { await eventCollection; eventCollection = null; }
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  }
  child = null;
}

async function collectEvents() {
  eventAbort = new AbortController();
  const response = await fetch(base + '/api/events', { headers: { Origin: base }, signal: eventAbort.signal });
  eventCollection = (async () => {
    let buffered = '';
    const reader = response.body.getReader();
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        buffered += Buffer.from(item.value).toString();
        let index;
        while ((index = buffered.indexOf('\n\n')) !== -1) {
          const frame = buffered.slice(0, index); buffered = buffered.slice(index + 2);
          if (!frame.includes('event: creative-assets')) continue;
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) eventPayloads.push(JSON.parse(data.slice(6)));
        }
      }
    } catch (error) { if (error.name !== 'AbortError') throw error; }
  })();
}

function flatten(node, result = []) {
  if (node.kind === 'file') result.push(node);
  else (node.children || []).forEach(child => flatten(child, result));
  return result;
}
async function files(projectId) { return flatten((await api(`/api/creative-assets?project=${projectId}`)).tree); }
async function asset(projectId, relative) {
  const item = (await files(projectId)).find(file => file.path === relative);
  assert.ok(item, `Tree must include ${relative}`); return item;
}
function expectInfo(item, id, status, role = 'material') {
  assert.equal(item.assetId, id, '移动/改名必须保留同一素材 ID');
  assert.equal(item.videoDisposition, status, '状态应由持久记录或指定分类动作决定');
  assert.equal(item.assetRole, role, '普通目录整理必须保留素材角色');
}
async function move(projectId, relative, folder) {
  const result = await api(`/api/creative-assets/move?project=${projectId}`, { path: relative, folder });
  assert.ok(!fs.existsSync(abs(relative)), '成功移动后原文件不再占原位置');
  assert.deepEqual(fs.readFileSync(abs(result.path)), movie);
  return result.path;
}
async function expectLinks(relative, id) {
  assert.equal(readData('audio-library.json').items.find(item => item.id === 'fixture-voice').sourcePath, relative);
  assert.equal(readData('library-links.json').items.fixture.path, relative);
  const ledger = await rpc('ledger');
  assert.equal(ledger.assets.find(item => item.id === id).path, abs(relative));
  const inbox = ledger.inbox.find(item => item.download_key === 'fixture-download');
  assert.equal(inbox.asset_id, id); assert.equal(inbox.asset_path, abs(relative));
  assert.equal(inbox.filename, path.posix.basename(relative));
}
async function referenceSnapshot() {
  const names = ['asset-workflow.json', 'audio-library.json', 'library-links.json', 'asset-meta.json', 'creative-projects.json'];
  return { documents: Object.fromEntries(names.map(name => [name, readData(name)])), ledger: await rpc('ledger') };
}
async function expectRollback(before, relative, target) {
  assert.deepEqual(fs.readFileSync(abs(relative)), movie, '失败后原媒体文件仍在原路径');
  assert.equal(fs.readFileSync(abs(sidecar(relative)), 'utf8'), promptText, '失败后原 sidecar 仍在原路径');
  assert.ok(!fs.existsSync(abs(target)), '失败目标必须不存在');
  assert.ok(!fs.existsSync(abs(sidecar(target))), '失败目标 sidecar 必须不存在');
  assert.deepEqual(await referenceSnapshot(), before, '失败后 workflow/音频/复用/meta/注册表/DB 应恢复原记录');
}

(async () => {
  try {
    for (const folder of [projectRoot, dataRoot, path.join(fixture, 'vault')]) fs.mkdirSync(folder, { recursive: true });
    await start();
    const a = (await api('/api/creative-projects', { action: 'create', name: '素材整理回归甲' })).project;
    const b = (await api('/api/creative-projects', { action: 'create', name: '素材整理回归乙' })).project;
    await api('/api/creative-projects', { action: 'activate', id: a.id });
    const category = (project, id) => project.categories.find(item => item.id === id).path;
    let videoRoot = category(a, 'generated-videos');
    const audioRoot = category(a, 'audio'), finalRoot = category(a, 'finals');
    const episode = `${a.folder}/第01集`, office = `${episode}/办公室`;
    const copies = `${a.folder}/独立副本`, shadow = `${episode}/生成视频/待处理`;
    for (const folder of [office, copies, shadow, `${videoRoot}/待处理/第01集`, `${videoRoot}/可剪辑/第01集`]) {
      fs.mkdirSync(abs(folder), { recursive: true });
    }
    let pendingPath = `${videoRoot}/待处理/源视频.mp4`;
    let editablePath = `${videoRoot}/可剪辑/可用视频.mp4`;
    let finalPath = `${finalRoot}/成片视频.mp4`;
    const audioPath = `${audioRoot}/人物片段.wav`;
    for (const relative of [pendingPath, editablePath, finalPath]) fs.writeFileSync(abs(relative), movie);
    fs.writeFileSync(abs(audioPath), wave);
    fs.writeFileSync(abs(sidecar(pendingPath)), promptText);
    // 成片库只公开写入稳定后的文件；等真实 API 就绪，不绕过监视器。
    let initial = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      initial = await files(a.id);
      if ([pendingPath, editablePath, finalPath, audioPath].every(relative => initial.some(item => item.path === relative))) break;
      await delay(150);
    }
    for (const relative of [pendingPath, editablePath, finalPath, audioPath]) assert.ok(initial.some(item => item.path === relative), `初始 API 素材应完成收录：${relative}`);
    const pendingId = initial.find(item => item.path === pendingPath).assetId;
    const editableId = initial.find(item => item.path === editablePath).assetId;
    const finalId = initial.find(item => item.path === finalPath).assetId;
    assert.ok(pendingId && editableId && finalId && new Set([pendingId, editableId, finalId]).size === 3);
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    expectInfo(await asset(a.id, editablePath), editableId, 'editable');
    expectInfo(await asset(a.id, finalPath), finalId, 'editable', 'finals');
    assert.ok(initial.every(item => item.assetId && item.assetRole), '所有文件应获得持久身份和角色');
    await rpc('seedDownload', { input: { id: 'fixture-download', savePath: abs(pendingPath), filename: '源视频.mp4', kind: 'video', mode: 'video' }, snapshot: { projectId: a.id } });
    writeData('audio-library.json', { version: 1, items: [{ id: 'fixture-voice', projectId: a.id, kind: 'voice', name: '人物音色', path: audioPath, sourcePath: pendingPath }], ignoredPaths: [] });
    writeData('library-links.json', { items: { fixture: { path: pendingPath, source: 'fixture' } } });
    await api('/api/meta', { path: metadataKey(pendingPath), starred: true, note: '收藏与状态分开保存', tags: ['回归'] });
    await api('/api/meta', { path: metadataKey(pendingPath), note: '只改备注仍保留收藏和处理状态' });
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    assert.equal((await api('/api/meta')).items[metadataKey(pendingPath)].starred, true);
    console.log('PASS: 树中持久身份/状态/角色与 meta 字段合并');

    const beforeFailedMove = await referenceSnapshot();
    const failedMoveTarget = `${office}/${path.posix.basename(pendingPath)}`;
    await rpc('failNextRelocation', { method: 'relocateAsset' });
    const failedMove = await api(`/api/creative-assets/move?project=${a.id}`, { path: pendingPath, folder: office }, 400);
    assert.match(failedMove.error, /fixture ledger failure: relocateAsset/);
    await expectRollback(beforeFailedMove, pendingPath, failedMoveTarget);
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    await expectLinks(pendingPath, pendingId);
    console.log('PASS: 注入文件台账失败后媒体、sidecar、workflow、关联与 DB 全部回滚');

    await collectEvents();
    const oldPending = pendingPath;
    pendingPath = await move(a.id, pendingPath, office);
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    assert.equal(fs.readFileSync(abs(sidecar(pendingPath)), 'utf8'), promptText);
    assert.ok(!fs.existsSync(abs(sidecar(oldPending))));
    await expectLinks(pendingPath, pendingId);
    for (let i = 0; i < 30 && !eventPayloads.some(payload => payload.moves?.some(item => item.oldPath === oldPending && item.path === pendingPath && item.assetId === pendingId)); i++) await delay(50);
    assert.ok(eventPayloads.some(payload => payload.moves?.some(item => item.oldPath === oldPending && item.path === pendingPath && item.assetId === pendingId)), '移动事件应带完整 oldPath/path/assetId');
    editablePath = await move(a.id, editablePath, shadow);
    expectInfo(await asset(a.id, editablePath), editableId, 'editable');
    finalPath = await move(a.id, finalPath, office);
    expectInfo(await asset(a.id, finalPath), finalId, 'editable', 'finals');
    console.log('PASS: 普通目录和同名非分类目录不改状态/角色，sidecar、音频、复用记录、台账和 SSE 同步');

    const beforeFailedFolderRename = await referenceSnapshot();
    const failedEpisode = `${a.folder}/第01集_失败`;
    await rpc('failNextRelocation', { method: 'relocateFolder' });
    await assert.rejects(rpc('renameFolder', { projectId: a.id, path: episode, name: '第01集_失败' }), /fixture ledger failure: relocateFolder/);
    await expectRollback(beforeFailedFolderRename, pendingPath, failedEpisode + pendingPath.slice(episode.length));
    assert.ok(fs.existsSync(abs(episode)) && !fs.existsSync(abs(failedEpisode)));
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    await expectLinks(pendingPath, pendingId);
    console.log('PASS: 注入目录台账失败后源目录、素材、sidecar、注册表和所有关联全部回滚');

    const newEpisode = `${a.folder}/第01集_已整理`;
    await rpc('renameFolder', { projectId: a.id, path: episode, name: '第01集_已整理' });
    const relocated = relative => newEpisode + relative.slice(episode.length);
    pendingPath = relocated(pendingPath); editablePath = relocated(editablePath); finalPath = relocated(finalPath);
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    expectInfo(await asset(a.id, editablePath), editableId, 'editable');
    expectInfo(await asset(a.id, finalPath), finalId, 'editable', 'finals');
    await expectLinks(pendingPath, pendingId);
    assert.ok(!fs.existsSync(abs(episode)));
    assert.equal(fs.readFileSync(abs(sidecar(pendingPath)), 'utf8'), promptText);
    const renamed = await api(`/api/creative-assets/rename?project=${a.id}`, { path: pendingPath, name: '处理前片段.mp4' });
    pendingPath = renamed.path;
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    await expectLinks(pendingPath, pendingId);
    assert.equal(fs.readFileSync(abs(sidecar(pendingPath)), 'utf8'), promptText);
    assert.equal((await api('/api/meta')).items[metadataKey(pendingPath)].starred, true);
    console.log('PASS: 普通目录与文件改名保留 ID/状态/角色/收藏及关联');

    pendingPath = await move(a.id, pendingPath, `${videoRoot}/可剪辑/第01集`);
    expectInfo(await asset(a.id, pendingPath), pendingId, 'editable');
    pendingPath = await move(a.id, pendingPath, `${videoRoot}/待处理/第01集`);
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    await expectLinks(pendingPath, pendingId);
    let copied = await api(`/api/creative-assets/copy?project=${a.id}`, { path: pendingPath, folder: copies });
    const copyPath = copied.path;
    let copyId = copied.assetId;
    assert.ok(copyId && copyId !== pendingId, '复制必须创建独立 ID');
    assert.equal(copied.sourceAssetId, pendingId);
    expectInfo(await asset(a.id, copyPath), copyId, 'processing');
    assert.deepEqual(fs.readFileSync(abs(copyPath)), movie);
    assert.deepEqual(fs.readFileSync(abs(pendingPath)), movie, '复制不得移动或修改原件');
    assert.equal(fs.readFileSync(abs(sidecar(copyPath)), 'utf8'), promptText);
    assert.equal(fs.readFileSync(abs(sidecar(pendingPath)), 'utf8'), promptText);
    copied = await api(`/api/creative-assets/copy?project=${a.id}`, { path: pendingPath, folder: `${videoRoot}/可剪辑/第01集` });
    let classifiedCopyPath = copied.path;
    const classifiedCopyId = copied.assetId;
    expectInfo(await asset(a.id, classifiedCopyPath), classifiedCopyId, 'editable');
    assert.equal(copied.sourceAssetId, pendingId);
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    console.log('PASS: 指定分类主动重设状态，复制新 ID/sourceAssetId、sidecar 与原件保留');

    // 既有 native 删除保留元数据；目标磁盘路径再次腾空时复制必须产生新的独立身份。
    const oldCopyId = copyId;
    await rpc('seedDownload', { input: { id: 'fixture-copy-download', savePath: abs(copyPath), filename: path.posix.basename(copyPath), kind: 'video', mode: 'video' }, snapshot: { projectId: a.id } });
    fs.unlinkSync(abs(copyPath));
    fs.unlinkSync(abs(sidecar(copyPath)));
    const recreatedCopy = await api(`/api/creative-assets/copy?project=${a.id}`, { path: pendingPath, folder: copies });
    assert.equal(recreatedCopy.path, copyPath, '删除后允许重新占用原副本路径');
    assert.ok(recreatedCopy.assetId && recreatedCopy.assetId !== oldCopyId, '重新复制到旧路径必须获得新 ID');
    assert.equal(recreatedCopy.sourceAssetId, pendingId);
    copyId = recreatedCopy.assetId;
    expectInfo(await asset(a.id, copyPath), copyId, 'processing');
    assert.equal(fs.readFileSync(abs(sidecar(copyPath)), 'utf8'), promptText);
    const recreatedLedger = await rpc('ledger');
    const retiredCopy = recreatedLedger.assets.find(item => item.id === oldCopyId);
    assert.ok(retiredCopy, '旧副本 ID 与历史关联必须保留');
    assert.notEqual(retiredCopy.path, abs(copyPath), '旧记录不应继续占据新副本路径');
    assert.ok(!fs.existsSync(retiredCopy.path), '旧副本记录应保持缺失状态');
    const retiredInbox = recreatedLedger.inbox.find(item => item.download_key === 'fixture-copy-download');
    assert.equal(retiredInbox.asset_id, oldCopyId, '旧下载关联仍引用旧素材 ID');
    assert.equal(retiredInbox.asset_path, retiredCopy.path, '旧下载关联同步到缺失的历史路径');
    assert.equal(recreatedLedger.assets.find(item => item.id === copyId).path, abs(copyPath));
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    console.log('PASS: 删除副本后同路径重新复制获得新 ID，旧 ID 历史关联保留为缺失');

    // 两个异步请求已选择同一空目标再一起放行：失败请求不能恢复早于成功请求的全局快照。
    const concurrentFolder = `${a.folder}/并发副本`;
    fs.mkdirSync(abs(concurrentFolder));
    await rpc('armCopyGate', { count: 2 });
    const competing = [1, 2].map(() => request(`/api/creative-assets/copy?project=${a.id}`, { path: pendingPath, folder: concurrentFolder }));
    await waitCopyGate(2);
    await rpc('releaseCopyGate');
    const competed = await Promise.all(competing);
    assert.deepEqual(competed.map(item => item.response.status).sort(), [200, 400], '同目标竞争只能一个成功，一个拒绝覆盖');
    const winner = competed.find(item => item.response.ok).data;
    const winnerMetadata = readData('asset-workflow.json').items[winner.path];
    assert.ok(winnerMetadata, '失败请求不得删除已成功副本的持久记录');
    assert.equal(winnerMetadata.assetId, winner.assetId);
    assert.equal(winnerMetadata.sourceAssetId, pendingId, '失败请求不得丢掉另一成功复制的 lineage');
    assert.equal(winnerMetadata.videoDisposition, 'processing');
    expectInfo(await asset(a.id, winner.path), winner.assetId, 'processing');
    assert.equal((await rpc('ledger')).assets.find(item => item.id === winner.assetId).path, abs(winner.path));
    assert.equal(fs.readFileSync(abs(sidecar(winner.path)), 'utf8'), promptText);
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    console.log('PASS: 同目标并发复制一成一败，失败不覆盖成功副本的身份/状态/来源');

    // 媒体已复制但 Promise 尚未完成时移动源：短事务前重核验来源，拒绝幽灵 lineage。
    const asyncSource = `${videoRoot}/待处理/复制期间可移动.mp4`;
    fs.writeFileSync(abs(asyncSource), movie); fs.writeFileSync(abs(sidecar(asyncSource)), promptText);
    const asyncSourceId = (await asset(a.id, asyncSource)).assetId;
    const asyncFolder = `${a.folder}/异步副本`;
    fs.mkdirSync(abs(asyncFolder));
    await rpc('armCopyGate', { count: 1, phase: 'after' });
    const changedSourceCopy = request(`/api/creative-assets/copy?project=${a.id}`, { path: asyncSource, folder: asyncFolder });
    await waitCopyGate(1);
    const movedAsyncSource = await move(a.id, asyncSource, relocated(office));
    await rpc('releaseCopyGate');
    const changedSourceResult = await changedSourceCopy;
    assert.equal(changedSourceResult.response.status, 409);
    const asyncTarget = `${asyncFolder}/${path.posix.basename(asyncSource)}`;
    assert.ok(!fs.existsSync(abs(asyncTarget)), '来源已改变时删除本请求复制的目标');
    assert.ok(!fs.existsSync(abs(sidecar(asyncTarget))));
    assert.ok(!readData('asset-workflow.json').items[asyncTarget], '失败不得注册幽灵副本');
    expectInfo(await asset(a.id, movedAsyncSource), asyncSourceId, 'processing');
    assert.equal(fs.readFileSync(abs(sidecar(movedAsyncSource)), 'utf8'), promptText);
    console.log('PASS: 异步复制期间来源移动会拒绝并清理自身目标，保留已移动原件');

    // 子目录改名也只是整理：待处理→可剪辑后，继续只改文件名不得偷偷改处理状态。
    const c = (await api('/api/creative-projects', { action: 'create', name: '子目录改名回归丙' })).project;
    await api('/api/creative-projects', { action: 'activate', id: c.id });
    const cVideoRoot = category(c, 'generated-videos');
    const cPendingFolder = `${cVideoRoot}/待处理`, cEditableFolder = `${cVideoRoot}/可剪辑`;
    fs.mkdirSync(abs(cPendingFolder));
    const cSourcePath = `${cPendingFolder}/仅改名.mp4`;
    fs.writeFileSync(abs(cSourcePath), movie);
    const cId = (await asset(c.id, cSourcePath)).assetId;
    await rpc('renameFolder', { projectId: c.id, path: cPendingFolder, name: '可剪辑' });
    let cPath = `${cEditableFolder}/仅改名.mp4`;
    expectInfo(await asset(c.id, cPath), cId, 'processing');
    cPath = (await api(`/api/creative-assets/rename?project=${c.id}`, { path: cPath, name: '仍待处理.mp4' })).path;
    expectInfo(await asset(c.id, cPath), cId, 'processing');
    await api('/api/creative-projects', { action: 'activate', id: a.id });
    console.log('PASS: 收纳子目录改名后，纯文件改名仍保留持久处理状态');

    for (const operation of ['move', 'copy']) {
      await api(`/api/creative-assets/${operation}?project=${a.id}`, { path: pendingPath, folder: category(b, 'generated-videos') }, 403);
    }
    // 切到乙后，再验证外部剧本的源路径也被拒绝；不把“未激活剧本”409 当成路径校验。
    await api('/api/creative-projects', { action: 'activate', id: b.id });
    for (const operation of ['move', 'copy']) {
      await api(`/api/creative-assets/${operation}?project=${b.id}`, { path: pendingPath, folder: category(b, 'generated-videos') }, 403);
    }
    await api(`/api/creative-assets/rename?project=${b.id}`, { path: pendingPath, name: '越界.mp4' }, 403);
    assert.deepEqual(fs.readFileSync(abs(pendingPath)), movie);
    assert.equal((await files(b.id)).length, 0, '跨项目请求不应产生副本');
    await api('/api/creative-projects', { action: 'activate', id: a.id });
    console.log('PASS: move/copy/rename 均拒绝跨项目路径');

    const customVideoRoot = `${a.folder}/视频素材`;
    await rpc('renameFolder', { projectId: a.id, path: videoRoot, name: '视频素材' });
    pendingPath = customVideoRoot + pendingPath.slice(videoRoot.length);
    classifiedCopyPath = customVideoRoot + classifiedCopyPath.slice(videoRoot.length);
    videoRoot = customVideoRoot;
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    expectInfo(await asset(a.id, classifiedCopyPath), classifiedCopyId, 'editable');
    await expectLinks(pendingPath, pendingId);
    classifiedCopyPath = await move(a.id, classifiedCopyPath, `${videoRoot}/待处理/第01集`);
    expectInfo(await asset(a.id, classifiedCopyPath), classifiedCopyId, 'processing');
    assert.equal((await asset(a.id, classifiedCopyPath)).sourceAssetId, pendingId);
    const savedMeta = (await api('/api/meta')).items[metadataKey(pendingPath)];
    assert.equal(savedMeta.starred, true); assert.deepEqual(savedMeta.tags, ['回归']);
    const expected = new Map((await files(a.id)).map(item => [item.path, {
      assetId: item.assetId, videoDisposition: item.videoDisposition, assetRole: item.assetRole,
      sourceAssetId: item.sourceAssetId,
    }]));
    const savedWorkflow = readData('asset-workflow.json');
    assert.ok(savedWorkflow.items[pendingPath]); assert.equal(savedWorkflow.items[pendingPath].assetId, pendingId);
    await api('/api/creative-projects', { action: 'activate', id: b.id });
    await stop(); await start();
    assert.equal((await api('/api/creative-projects')).activeProjectId, b.id);
    await api('/api/creative-projects', { action: 'activate', id: a.id });
    const afterRestart = new Map((await files(a.id)).map(item => [item.path, {
      assetId: item.assetId, videoDisposition: item.videoDisposition, assetRole: item.assetRole,
      sourceAssetId: item.sourceAssetId,
    }]));
    assert.deepEqual(afterRestart, expected, '完整服务重启后身份/状态/角色/复制来源必须保持');
    expectInfo(await asset(a.id, pendingPath), pendingId, 'processing');
    expectInfo(await asset(a.id, copyPath), copyId, 'processing');
    expectInfo(await asset(a.id, finalPath), finalId, 'editable', 'finals');
    await expectLinks(pendingPath, pendingId);
    assert.equal((await api('/api/meta')).items[metadataKey(pendingPath)].starred, true);
    assert.equal(fs.readFileSync(abs(sidecar(pendingPath)), 'utf8'), promptText);
    assert.equal(fs.readFileSync(abs(sidecar(copyPath)), 'utf8'), promptText);
    await api('/api/creative-projects', { action: 'activate', id: c.id });
    expectInfo(await asset(c.id, cPath), cId, 'processing');
    console.log('ASSET_WORKFLOW_PASS ' + JSON.stringify({ assets: expected.size, persistentIdentity: true,
      ordinaryMoveStatus: true, folderRename: true, designatedReclassification: true,
      copyLineage: true, recreatedCopyIdentity: true, concurrentCopy: true, changedCopySource: true,
      crossProjectRejected: true, sidecarPreserved: true, metaMerged: true,
      ledgerRemapped: true, audioSourceRemapped: true, libraryLinkRemapped: true, sseMoves: true,
      failureRollback: true, renameKeepsStatus: true, restart: true }));
  } finally {
    await stop();
    for (const pending of pendingRpc.values()) clearTimeout(pending.timer);
    assert.ok(path.basename(fixture).startsWith('video-os-asset-workflow-') && path.dirname(fixture) === fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
