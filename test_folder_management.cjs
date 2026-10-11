'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createCreativeProjectStore } = require('./creative-projects.cjs');
const { nextSequentialImportName } = require('./electron/import-names.cjs');

const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-folder-management-')));
process.env.VIDEO_OS_PROJECT_ROOT = fixture;
process.env.VIDEO_OS_DATA_DIR = path.join(fixture, 'data');
process.env.OBSIDIAN_VAULT_PATH = path.join(fixture, 'vault');
const server = require('./server.js');
const store = server.creativeProjectStore;
const assetRoot = server.creativeAssetDir;
const read = name => JSON.parse(fs.readFileSync(path.join(fixture, 'data', name), 'utf8'));
const write = (name, data) => fs.writeFileSync(path.join(fixture, 'data', name), JSON.stringify(data));

(async () => {
  try {
    const { server: http } = await server.startServer(0, 0);
    const base = `http://127.0.0.1:${http.address().port}`;
    async function api(route, body, raw = false) {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
      const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    }
    const project = store.create({ name: '分类测试🎬' });
    const old = `${project.folder}/成片`, renamed = `${project.folder}/最后的成品`;
    const oldAudio = `${project.folder}/音频`;
    const file = `${old}/旧视频.mp4`;
    const movie = Buffer.concat(['ftyp', 'mdat', 'moov'].map(type => { const b = Buffer.alloc(16); b.writeUInt32BE(16); b.write(type, 4); return b; }));
    fs.writeFileSync(path.join(assetRoot, file), movie);
    fs.writeFileSync(path.join(assetRoot, old, '旧视频.prompt.txt'), 'prompt retained');
    assert.ok(server.productionStore, '需要验证持久化下载记录');
    server.productionStore.recordDownload({ id: 'test-folder-download', savePath: path.join(assetRoot, file), filename: '旧视频.mp4', kind: 'video', mode: 'video' }, { projectId: project.id });
    write('audio-library.json', { version: 1, items: [{ id: 'voice-1', kind: 'voice', projectId: project.id,
      name: '人物音色', path: `${oldAudio}/人物.wav`, sourcePath: file }], ignoredPaths: [`${oldAudio}/忽略.wav`] });
    write('library-links.json', { items: { a: { path: file } } });
    write('asset-meta.json', { version: 1, items: { [`@media/creative-assets/${file}`]: { favorite: true, note: '保留' } } });
    server.renameCreativeFolder(project.id, old, '最后的成品');
    assert.equal(store.category(project.id, 'finals').path, renamed);
    assert.equal(read('audio-library.json').items[0].sourcePath, `${renamed}/旧视频.mp4`);
    assert.equal(read('library-links.json').items.a.path, `${renamed}/旧视频.mp4`);
    assert.equal(read('asset-meta.json').items[`@media/creative-assets/${renamed}/旧视频.mp4`].note, '保留');
    assert.equal(server.productionStore.db.prepare('SELECT asset_path FROM inbox_items WHERE download_key = ?').get('test-folder-download').asset_path,
      path.join(assetRoot, renamed, '旧视频.mp4'));
    assert.ok(fs.existsSync(path.join(assetRoot, renamed, '旧视频.prompt.txt')));
    const reopened = createCreativeProjectStore({ assetRoot, filePath: path.join(fixture, 'data/creative-projects.json') });
    assert.equal(reopened.category(project.id, 'finals').label, '最后的成品');
    assert.ok(!fs.existsSync(path.join(assetRoot, old)), '扫描和重启不能补回旧分类');
    const uploads = await Promise.all(Array.from({ length: 5 }, () => api(`/api/creative-assets/import?project=${project.id}&folder=${encodeURIComponent(renamed)}&name=original.mp4`, movie, true)));
    assert.deepEqual(uploads.map(item => item.name).sort(), [1, 2, 3, 4, 5].map(n => `00${n}.mp4`));
    fs.unlinkSync(path.join(assetRoot, renamed, '005.mp4'));
    assert.equal(nextSequentialImportName(path.join(assetRoot, renamed), '最后的成品', 'input.mov'), '006.mov');
    assert.equal(nextSequentialImportName(path.join(assetRoot, renamed), '改名不重置编号', 'input.png'), '007.png');
    const scan = await api('/api/scan');
    assert.ok(scan.files.filter(item => item.relativePath?.startsWith(renamed)).every(item => item.meta.isFinal));
    const exports = server.editorExports.snapshot(project.id);
    assert.equal(exports.folders.find(item => item.id === 'finals').path, renamed);
    server.renameCreativeFolder(project.id, oldAudio, '角色声音');
    assert.equal(read('audio-library.json').items[0].path, `${project.folder}/角色声音/人物.wav`);
    assert.equal(read('audio-library.json').ignoredPaths[0], `${project.folder}/角色声音/忽略.wav`);
    const wav = Buffer.alloc(100); wav.write('RIFF'); wav.writeUInt32LE(92, 4); wav.write('WAVE', 8);
    const importedVoice = await api(`/api/library-import?project=${project.id}&kind=audio&name=old.wav`, wav, true);
    assert.equal(importedVoice.name, '001.wav');
    await api('/api/scan');
    assert.ok(read('audio-library.json').items.some(item => item.path === importedVoice.path && item.kind === 'voice'));
    assert.throws(() => server.renameCreativeFolder(project.id, renamed, '人物资产'), /已经存在/);
    assert.throws(() => server.renameCreativeFolder(project.id, renamed, '../escape'), /字符/);
    assert.throws(() => server.renameCreativeFolder(project.id, project.folder, '根'), /当前剧本/);
    fs.writeFileSync(path.join(assetRoot, renamed, '.busy.part'), 'busy');
    assert.throws(() => server.renameCreativeFolder(project.id, renamed, '新名字'), /导入任务/);
    fs.unlinkSync(path.join(assetRoot, renamed, '.busy.part'));
    assert.throws(() => store.renameFolder(project.id, renamed, '失败测试', () => { throw Error('fixture failure'); }), /fixture/);
    assert.equal(store.category(project.id, 'finals').path, renamed);
    await store.deleteFolder(project.id, renamed, absolute => fs.renameSync(absolute, path.join(fixture, 'trash')));
    const afterDelete = createCreativeProjectStore({ assetRoot, filePath: path.join(fixture, 'data/creative-projects.json') });
    afterDelete.list();
    assert.ok(!fs.existsSync(path.join(assetRoot, renamed)) && !fs.existsSync(path.join(assetRoot, old)));
    assert.throws(() => afterDelete.category(project.id, 'finals'), /已删除/);
    console.log('FOLDER_MANAGEMENT_PASS: 分类身份、重启、并发编号、音频/成片联动、路径限制、失败回滚、删除不复生');
  } finally {
    server.editorExports.stop(); server.mediaSourceWatcher?.stop(); server.server.closeAllConnections();
    await new Promise(resolve => server.server.close(resolve)); server.productionStore?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
