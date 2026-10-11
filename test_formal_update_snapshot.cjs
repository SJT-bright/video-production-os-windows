'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { opaqueInventory, assertStopped, checkDatabase } = require('./snapshot-formal-update.cjs');

const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-formal-backup-test-'));
try {
  const source = path.join(fixture, 'source');
  const copy = path.join(fixture, 'copy');
  fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(path.join(source, 'local-state'), 'fixture bytes', { mode: 0o600 });
  fs.symlinkSync('/not-followed/opaque-target', path.join(source, 'link'));
  const original = opaqueInventory(source);
  execFileSync('/bin/cp', ['-cRPp', source, copy]);
  assert.deepEqual(opaqueInventory(copy), original);
  assert.equal(original.summary.symlinks, 1);
  assert.equal('target' in original.entries.find(entry => entry.type === 'symlink'), false);
  fs.appendFileSync(path.join(copy, 'local-state'), 'changed');
  assert.notEqual(opaqueInventory(copy).summary.inventorySha256, original.summary.inventorySha256);
  const options = { installAppBundle: path.join(fixture, 'formal.app'), profile: path.join(fixture, 'profile'), dataDir: path.join(fixture, 'data') };
  assertStopped(options, '123 /other/candidate.app/Contents/MacOS/VideoProductionOS\n', 'p123\nn/other/profile/Cache\n');
  assert.throws(() => assertStopped(options, `456 ${options.installAppBundle}/Contents/MacOS/VideoProductionOS\n`, ''), /仍运行/);
  assert.throws(() => assertStopped(options, `456 ${options.installAppBundle}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n`, ''), /仍运行/);
  assert.throws(() => assertStopped(options, '', `p456\nn${options.profile}/Cookies\n`), /仍被进程使用/);
  assert.throws(() => assertStopped(options, '', `p456\nn${options.dataDir}/production.sqlite-wal\n`), /仍被进程使用/);
  const data = path.join(fixture, 'database');
  fs.mkdirSync(data);
  const db = new DatabaseSync(path.join(data, 'production.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture(id INTEGER PRIMARY KEY); INSERT INTO fixture VALUES(1)');
  db.close();
  const before = opaqueInventory(data);
  assert.equal(checkDatabase(data).integrityCheck, 'ok');
  assert.deepEqual(opaqueInventory(data), before, '数据库检查不得改变权威备份');
  const linkedData = path.join(fixture, 'linked-database');
  fs.mkdirSync(linkedData);
  fs.symlinkSync(path.join(data, 'production.sqlite'), path.join(linkedData, 'production.sqlite'));
  assert.throws(() => checkDatabase(linkedData), /普通文件/);
  console.log('FORMAL_UPDATE_SNAPSHOT_TEST_PASS opaqueBytesLinksModes=true closedProcessGuard=true backupDatabaseUntouched=true');
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
