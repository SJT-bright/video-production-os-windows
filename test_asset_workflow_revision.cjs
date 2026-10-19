'use strict';
// Real isolated HTTP/JSON/file regression for the audit fixes. Electron,
// production profiles and external services are never loaded by this suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-workflow-revision-')));
const projectRoot = path.join(fixture, 'project'), data = path.join(fixture, 'data'), assets = path.join(projectRoot, '创作资产库');
const movie = Buffer.concat(['ftyp', 'mdat', 'moov'].map(type => { const box = Buffer.alloc(16); box.writeUInt32BE(16); box.write(type, 4); return box; }));
const receipts = [], requests = new Map();
let child, base, sequence = 0;
const abs = relative => path.join(assets, ...relative.split('/'));
const write = (relative, bytes = movie) => { fs.mkdirSync(path.dirname(abs(relative)), { recursive: true }); fs.writeFileSync(abs(relative), bytes); };
const sidecar = relative => path.posix.join(path.posix.dirname(relative), path.posix.parse(relative).name + '.prompt.txt');
function rpc(action, input = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { requests.delete(id); reject(new Error('Fixture RPC timed out: ' + action)); }, 15000);
    requests.set(id, { resolve, reject, timer }); child.send({ id, action, ...input });
  });
}
async function api(url, body, expected = 200) {
  const response = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, expected, `${url}: ${JSON.stringify(result)}`); return result;
}
async function files(id) {
  const result = await api('/api/creative-assets?project=' + id), output = [];
  const visit = node => { if (node.kind === 'file') output.push(node); else (node.children || []).forEach(visit); };
  visit(result.tree); return output;
}
const asset = async (id, relative) => { const item = (await files(id)).find(item => item.path === relative); assert.ok(item, relative); return item; };
const disposition = (id, relative, value) => api('/api/creative-assets/disposition?project=' + id, { path: relative, disposition: value });
const record = name => receipts.push(name);

async function main() {
  for (const directory of [projectRoot, data, path.join(fixture, 'vault')]) fs.mkdirSync(directory, { recursive: true });
  const script = `
    const api = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
    process.on('message', message => {
      try {
        let result;
        if (message.action === 'catalog') { api.setDownloadEpisodeServiceProvider(() => message.services); result = true; }
        else if (message.action === 'capture') result = api.downloadEpisodeStore.capture(message.info);
        else if (message.action === 'advance') result = api.advanceDownloadEpisode(message.info);
        else if (message.action === 'renameFolder') result = api.renameCreativeFolder(message.projectId, message.path, message.name);
        else if (message.action === 'record') { api.recordAssetWorkflow(message.projectId, message.absolutePath, message.patch); result = true; }
        else if (message.action === 'guard') { api.setAssetMutationGuard(() => { if (message.block) throw new Error('fixture active download'); }); result = true; }
        else if (message.action === 'ledgerFail') {
          const original = api.productionStore.relocateAsset;
          api.productionStore.relocateAsset = function (...args) { api.productionStore.relocateAsset = original; throw new Error('fixture ledger failure'); };
          result = true;
        } else throw new Error('Unknown fixture RPC');
        process.send({ id: message.id, result });
      } catch (error) { process.send({ id: message.id, error: error.message }); }
    });
    api.startServer(0, 0).then(({ port }) => console.log('REVISION_PORT=' + port));
  `;
  child = spawn(process.execPath, ['-e', script], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_DATA_DIR: data, OBSIDIAN_VAULT_PATH: path.join(fixture, 'vault') } });
  child.on('message', message => {
    const pending = requests.get(message.id); if (!pending) return;
    requests.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
  });
  base = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error('Fixture server timeout: ' + errors)), 15000);
    child.stderr.on('data', bytes => { errors += bytes; });
    child.stdout.on('data', bytes => { output += bytes; const match = output.match(/REVISION_PORT=(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
    child.once('exit', code => { clearTimeout(timer); if (!base) reject(new Error('Fixture server exited ' + code + ': ' + errors)); });
  });
  const a = (await api('/api/creative-projects', { action: 'create', name: '工作流修复甲' }, 201)).project;
  const b = (await api('/api/creative-projects', { action: 'create', name: '工作流修复乙' }, 201)).project;
  await api('/api/creative-projects', { action: 'activate', id: a.id });
  let videoRoot = a.categories.find(category => category.id === 'generated-videos').path;
  const scope = { projectId: a.id, serviceId: 'hehui', kind: 'video', serviceLabel: '核绘' };
  const episodeFile = path.join(data, 'download-episodes.json');
  const initial = await api('/api/download-episodes?project=' + a.id);
  assert.equal(initial.states.length, 24); assert.equal(fs.existsSync(episodeFile), false, 'Read-only defaults do not save cursors or create site/episode folders');
  record('browser-compatible-default-batch-does-not-mutate-cursors');
  let pending = `${videoRoot}/核绘/第1集/待处理/来源.mp4`;
  write(pending); write(sidecar(pending), '保留完整提示词\n');
  const before = await asset(a.id, pending); assert.equal(before.videoDisposition, 'processing');
  const editableFolder = `${videoRoot}/核绘/第1集/可剪辑`;
  assert.equal(fs.existsSync(abs(editableFolder)), false);
  let converted = await disposition(a.id, pending, 'editable');
  assert.equal(converted.folder, editableFolder); assert.equal(converted.assetId, before.assetId); assert.equal(converted.videoDisposition, 'editable');
  assert.equal(fs.existsSync(abs(pending)), false); assert.deepEqual(fs.readFileSync(abs(converted.path)), movie);
  assert.equal(fs.readFileSync(abs(sidecar(converted.path)), 'utf8'), '保留完整提示词\n');
  pending = converted.path; record('first-scan-nested-processing-and-on-demand-editable-transition-retain-identity-sidecar');
  converted = await disposition(a.id, pending, 'processing'); pending = converted.path;
  const copied = await api('/api/creative-assets/copy?project=' + a.id, { path: pending, folder: editableFolder });
  assert.equal(copied.videoDisposition, 'editable'); assert.notEqual(copied.assetId, before.assetId); assert.equal(copied.sourceAssetId, before.assetId);
  const moved = await api('/api/creative-assets/move?project=' + a.id, { path: copied.path, folder: `${videoRoot}/核绘/第1集/待处理` });
  assert.equal(moved.videoDisposition, 'processing'); record('move-and-copy-into-new-status-directories-update-disposition');
  const ordinary = `${a.folder}/普通整理/待处理`; fs.mkdirSync(abs(ordinary), { recursive: true });
  const plain = await api('/api/creative-assets/move?project=' + a.id, { path: pending, folder: ordinary });
  assert.equal(plain.videoDisposition, 'processing');
  const renamed = await api('/api/creative-assets/rename?project=' + a.id, { path: plain.path, name: '保留状态.mp4' });
  assert.equal((await asset(a.id, renamed.path)).videoDisposition, 'processing'); record('ordinary-organizing-and-pure-rename-retain-disposition');
  await rpc('renameFolder', { projectId: a.id, path: videoRoot, name: '自定义视频分类' });
  videoRoot = `${a.folder}/自定义视频分类`;
  const importedPending = `${videoRoot}/核绘/第8集/待处理`;
  fs.mkdirSync(abs(importedPending), { recursive: true });
  const imported = await fetch(base + `/api/creative-assets/import?project=${a.id}&folder=${encodeURIComponent(importedPending)}&naming=original&name=${encodeURIComponent('本地原名.mp4')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: movie });
  assert.equal(imported.status, 201, await imported.clone().text());
  const importedResult = await imported.json(); assert.equal(importedResult.name, '本地原名.mp4');
  assert.equal((await asset(a.id, importedResult.path)).videoDisposition, 'processing');
  const changed = await disposition(a.id, importedResult.path, 'editable'); assert.equal(changed.videoDisposition, 'editable');
  assert.ok(changed.path.startsWith(videoRoot + '/')); record('renamed-category-id-drives-local-import-and-status-action');
  await rpc('record', { projectId: a.id, absolutePath: abs(changed.path), patch: { videoDisposition: 'processing' } });
  const corrected = await disposition(a.id, changed.path, 'editable'); assert.equal(corrected.path, changed.path);
  assert.equal(corrected.changed, true); assert.equal(corrected.videoDisposition, 'editable'); assert.equal(corrected.assetId, changed.assetId);
  record('explicit-same-directory-action-corrects-stale-metadata-without-moving-file');
  const unknown = `${videoRoot}/未登记站点/第1集/待处理/x.mp4`, legacy = `${videoRoot}/待处理/核绘/2026-10-01/x.mp4`;
  write(unknown); write(legacy);
  for (const relative of [unknown, legacy, `${a.folder}/人物资产`]) {
    await api('/api/creative-assets/disposition?project=' + a.id, { path: relative, disposition: 'editable' }, 400);
  }
  assert.equal(fs.existsSync(abs(`${videoRoot}/未登记站点/第1集/可剪辑`)), false);
  await api('/api/creative-assets/disposition?project=' + b.id, { path: changed.path, disposition: 'processing' }, 409);
  await rpc('guard', { block: true });
  await api('/api/creative-assets/disposition?project=' + a.id, { path: changed.path, disposition: 'processing' }, 400);
  await rpc('guard', { block: false }); record('unknown-unassigned-directory-cross-project-and-downloading-action-rejected');
  const rollback = `${videoRoot}/核绘/第9集/待处理/回滚.mp4`; write(rollback); write(sidecar(rollback), '回滚提示词');
  const rollbackId = (await asset(a.id, rollback)).assetId;
  await rpc('ledgerFail'); await api('/api/creative-assets/disposition?project=' + a.id, { path: rollback, disposition: 'editable' }, 400);
  assert.deepEqual(fs.readFileSync(abs(rollback)), movie); assert.equal(fs.readFileSync(abs(sidecar(rollback)), 'utf8'), '回滚提示词');
  assert.equal((await asset(a.id, rollback)).assetId, rollbackId);
  assert.equal(fs.existsSync(abs(`${videoRoot}/核绘/第9集/可剪辑`)), false); record('failed-state-transition-rolls-back-original-links-and-created-empty-directory');
  await rpc('capture', { info: scope });
  const advancedHTTP = await api('/api/download-episodes/advance?project=' + a.id, { ...scope, expectedEpisode: 1 });
  assert.equal(advancedHTTP.advanced, true); assert.equal(advancedHTTP.state.episode, 2);
  const staleAdvance = await api('/api/download-episodes/advance?project=' + a.id, { ...scope, expectedEpisode: 1 });
  assert.equal(staleAdvance.advanced, false); assert.equal(staleAdvance.state.episode, 2);
  assert.equal(fs.existsSync(abs(`${videoRoot}/核绘/第3集`)), false, 'Stale HTTP advance never creates another episode');
  await api('/api/download-episodes/advance?project=' + b.id, { ...scope, expectedEpisode: 2 }, 409);
  record('browser-compatible-http-advance-stale-and-project-guards-share-native-store');
  let batch = await api('/api/download-episodes?project=' + a.id);
  let current = batch.states.find(state => state.serviceId === 'hehui' && state.kind === 'video');
  assert.deepEqual(current.existingEpisodes, [1, 2, 8, 9]); assert.equal(current.episode, 2);
  const select = { projectId: a.id, serviceId: 'hehui', kind: 'video', episode: 1, expectedEpisode: 2 };
  const selected = await api('/api/download-episodes/select?project=' + a.id, select);
  assert.equal(selected.selected, true); assert.equal(selected.state.episode, 1);
  const stale = await api('/api/download-episodes/select?project=' + a.id, { ...select, episode: 2 });
  assert.equal(stale.selected, false); assert.equal(stale.state.episode, 1);
  await api('/api/download-episodes/select?project=' + a.id, { ...select, episode: 99, expectedEpisode: 1 }, 400);
  assert.equal(fs.existsSync(abs(`${videoRoot}/核绘/第99集`)), false);
  const linked = abs(`${videoRoot}/核绘/第3集`); fs.symlinkSync(abs(`${videoRoot}/核绘/第1集`), linked, process.platform === 'win32' ? 'junction' : 'dir');
  await api('/api/download-episodes/select?project=' + a.id, { ...select, episode: 3, expectedEpisode: 1 }, 400);
  batch = await api('/api/download-episodes?project=' + a.id);
  assert.ok(!batch.states.find(state => state.serviceId === 'hehui' && state.kind === 'video').existingEpisodes.includes(3));
  assert.equal(batch.states.find(state => state.serviceId === 'hehui' && state.kind === 'image').episode, 1);
  record('existing-episode-selection-stale-guard-numeric-sort-real-directories-and-kind-isolation');
  const custom = { projectId: a.id, serviceId: 'custom-removed-identity', kind: 'video', serviceLabel: '旧自定义站点' };
  await rpc('capture', { info: custom });
  const customRoot = `${videoRoot}/旧自定义站点`; write(`${customRoot}/第10集/可剪辑/归档.mp4`);
  await rpc('catalog', { services: [{ id: 'hehui', label: '核绘', hidden: true }, { id: 'gpt', label: 'GPT' }] });
  batch = await api('/api/download-episodes?project=' + a.id);
  const hidden = batch.states.find(state => state.serviceId === 'hehui' && state.kind === 'video');
  const archived = batch.states.find(state => state.serviceId === custom.serviceId);
  assert.equal(hidden.archiveOnly, true); assert.equal(hidden.downloadable, false); assert.equal(hidden.available, true);
  assert.equal(archived.archiveOnly, true); assert.equal(archived.archived, true); assert.equal(archived.downloadable, false);
  assert.deepEqual(archived.existingEpisodes, [10]); assert.equal(archived.platformPath, customRoot);
  assert.equal(batch.states.some(state => state.platformFolder === '未登记站点'), false);
  record('hidden-and-removed-registered-service-archive-identities-retained-without-inventing-unknown-sites');
  console.log(JSON.stringify({ status: 'passed', formalAppTouched: false, scope: 'isolated-real-http-json-files', checks: receipts }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Fixture closing')); }
  if (child?.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000).unref(); }); }
  assert.ok(path.basename(fixture).startsWith('video-os-workflow-revision-'));
  fs.rmSync(fixture, { recursive: true, force: true });
});
