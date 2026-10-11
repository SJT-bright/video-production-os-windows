'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { candidateBuildOptions } = require('./candidate-contract.cjs');
const { remapAbsolutePaths, cloneTree, snapshotDatabase } = require('./prepare-candidate-workspace.cjs');

async function run() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vos-candidate-contract-')));
  let original;
  try {
    const source = path.join(root, 'original');
    const clone = path.join(root, 'candidate', 'profile', 'workspace');
    const profile = path.dirname(clone);
    const out = path.join(root, 'delivery');
    const options = candidateBuildOptions(['--out', out, '--candidate-user-data', profile], __dirname);
    assert.equal(options.version, '1.3.0-rc.2');
    assert.equal(options.bundleId, 'local.video-production-os.candidate.asset-workflow-20261009');
    assert.throws(() => candidateBuildOptions(['--candidate-user-data', profile], __dirname), /--out/);
    assert.throws(() => candidateBuildOptions(['--candidate-user-data', path.join(os.homedir(), 'Library/Application Support/视频制作 OS'), '--out', out]), /正式浏览器配置/);
    assert.throws(() => candidateBuildOptions(['--candidate-user-data', profile, '--out', path.join(__dirname, 'dist/candidate')]), /dist/);
    assert.throws(() => candidateBuildOptions(['--candidate-user-data', profile, '--out', out, '--version', '1.3.0']), /prerelease/);
    const mapped = remapAbsolutePaths({ [source + '/素材库/a.mp4']: source + '/创作资产库/a.png',
      untouched: source + '-other/a.png', note: `正文 ${source}/a.png`, nested: [source] }, source, clone);
    assert.equal(mapped[clone + '/素材库/a.mp4'], clone + '/创作资产库/a.png');
    assert.equal(mapped.untouched, source + '-other/a.png');
    assert.equal(mapped.note, `正文 ${source}/a.png`);
    assert.deepEqual(mapped.nested, [clone]);
    fs.mkdirSync(source);
    fs.mkdirSync(clone, { recursive: true });
    const file = path.join(source, 'asset.bin');
    fs.writeFileSync(file, 'ORIGINAL');
    const stats = { files: 0, logicalBytes: 0, changedDuringCopy: 0 };
    cloneTree(file, path.join(clone, 'asset.bin'), stats, '测试素材');
    fs.writeFileSync(path.join(clone, 'asset.bin'), 'CANDIDATE');
    assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL');
    assert.equal(stats.files, 1);
    fs.symlinkSync(file, path.join(source, 'link.bin'));
    assert.throws(() => cloneTree(path.join(source, 'link.bin'), path.join(clone, 'link.bin'), stats, '测试素材'), /符号链接/);
    const database = path.join(source, 'production.sqlite');
    original = new DatabaseSync(database);
    original.exec('PRAGMA journal_mode=WAL; CREATE TABLE asset_refs(id TEXT PRIMARY KEY, path TEXT UNIQUE); CREATE TABLE inbox_items(id TEXT PRIMARY KEY, asset_path TEXT);');
    original.prepare('INSERT INTO asset_refs VALUES (?, ?)').run('stable-id', source + '/创作资产库/a.png');
    original.prepare('INSERT INTO inbox_items VALUES (?, ?)').run('inbox-id', source + '/创作资产库/a.png');
    const before = original.prepare('SELECT * FROM asset_refs').all();
    const backup = path.join(clone, 'production.sqlite');
    const evidence = await snapshotDatabase(database, backup, source, clone);
    assert.equal(evidence.integrity, 'ok');
    assert.deepEqual(original.prepare('SELECT * FROM asset_refs').all(), before);
    const copied = new DatabaseSync(backup, { readOnly: true });
    try {
      assert.equal(copied.prepare('SELECT id FROM asset_refs').get().id, 'stable-id');
      assert.equal(copied.prepare('SELECT path FROM asset_refs').get().path, clone + '/创作资产库/a.png');
      assert.equal(copied.prepare('SELECT asset_path FROM inbox_items').get().asset_path, clone + '/创作资产库/a.png');
    } finally { copied.close(); }
    await assert.rejects(() => snapshotDatabase(database, backup, source, clone), /目标已存在/);
    console.log('CANDIDATE_PACKAGING_CONTRACT_PASS apfsIndependent=true liveWalBackup=true sourcePreserved=true pathRemapKeepsIds=true');
  } finally {
    if (original) original.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
