'use strict';

// This entry point only creates a fresh backup. It never quits, installs, restores,
// opens browser storage, or follows symlinks into another directory.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { formalDeploymentTarget } = require('./formal-deployment-contract.cjs');
const { readArg, assertAbsoluteDirectory, isWithin } = require('./candidate-contract.cjs');
const { verifyOriginalAppBackup } = require('./verify-original-app-backup.cjs');

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try { for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function opaqueInventory(root) {
  const entries = [];
  let bytes = 0;
  function visit(relative) {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    const entry = { path: relative.replaceAll(path.sep, '/'), mode: stat.mode & 0o7777,
      uid: stat.uid, gid: stat.gid, mtimeSeconds: Math.floor(stat.mtimeMs / 1000) };
    if (stat.isSymbolicLink()) {
      entry.type = 'symlink';
      entry.linkSha256 = crypto.createHash('sha256').update(fs.readlinkSync(file)).digest('hex');
    } else if (stat.isDirectory()) entry.type = 'directory';
    else if (stat.isFile()) {
      entry.type = 'file'; entry.bytes = stat.size; entry.sha256 = hashFile(file); bytes += stat.size;
    } else throw new Error('备份目录含有非普通文件/目录/符号链接节点');
    entries.push(entry);
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) visit(path.join(relative, child));
  }
  visit('');
  return { entries, summary: { entries: entries.length, files: entries.filter(entry => entry.type === 'file').length,
    symlinks: entries.filter(entry => entry.type === 'symlink').length, bytes,
    inventorySha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex') } };
}

function assertStopped({ installAppBundle, profile, dataDir }, processListing, openFiles) {
  const processes = processListing === undefined ? execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }) : processListing;
  if (processes.split('\n').some(line => {
    const executable = line.trim().replace(/^\d+\s+/, '');
    return isWithin(installAppBundle, executable);
  })) throw new Error('正式 App 或其 Helper 仍运行；请先正常退出再备份');
  const listing = openFiles === undefined ? (() => {
    try { return execFileSync('/usr/sbin/lsof', ['-n', '-P', '-F', 'pn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { if (typeof error.stdout === 'string') return error.stdout; throw new Error('无法复核正式 profile/data 的打开文件'); }
  })() : openFiles;
  if (listing.split('\n').some(line => line.startsWith('n') && [profile, dataDir].some(root => isWithin(root, line.slice(1))))) {
    throw new Error('正式 profile/data 仍被进程使用；请停止相关写入后再备份');
  }
}

function backupOptions(options) {
  const target = formalDeploymentTarget({ projectRoot: options.projectRoot, dataDir: options.dataDir,
    installAppBundle: options.installAppBundle, arch: options.arch || 'arm64' });
  if (!target) throw new Error('备份缺少正式部署目标');
  const profile = assertAbsoluteDirectory(options.profile, '正式 profile');
  if (profile !== path.join(os.homedir(), 'Library', 'Application Support', '视频制作 OS')) throw new Error('备份 profile 必须是原正式 App 的默认路径');
  const out = assertAbsoluteDirectory(options.out, '正式备份输出');
  for (const source of [target.installAppBundle, target.dataDir, profile]) {
    if (!fs.existsSync(source) || !fs.lstatSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) throw new Error('备份来源必须是已存在的真实目录');
    if (isWithin(source, out) || isWithin(out, source)) throw new Error('备份输出与 App/profile/data 不得嵌套');
  }
  if (fs.existsSync(out)) throw new Error('备份必须使用尚不存在的新输出目录');
  return { ...target, profile, out };
}

function copyDirectory(source, target) {
  execFileSync('/bin/cp', ['-cRPp', source, target], { stdio: 'pipe' });
}

function checkDatabase(dataCopy) {
  const database = path.join(dataCopy, 'production.sqlite');
  if (!fs.existsSync(database) || !fs.lstatSync(database).isFile() || fs.lstatSync(database).isSymbolicLink()) {
    throw new Error('备份 production.sqlite 必须是普通文件，不能跟随符号链接');
  }
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-backup-db-'));
  try {
    const scratch = path.join(temporary, 'data');
    copyDirectory(dataCopy, scratch);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(scratch, 'production.sqlite'), { readOnly: true });
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all();
      const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || foreignKeys.length) throw new Error('备份数据库完整性/外键检查未通过');
      return { integrityCheck: 'ok', foreignKeyViolations: 0, checkedOnDisposableCopy: true, sourceOpened: false };
    } finally { db.close(); }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function snapshotFormalUpdate(rawOptions) {
  if (process.platform !== 'darwin') throw new Error('正式备份入口仅支持本机 macOS');
  const options = backupOptions(rawOptions);
  assertStopped(options);
  const sourceVersion = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(options.installAppBundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  const targetVersion = rawOptions.targetVersion || require('./package.json').version;
  if (![sourceVersion, targetVersion].every(version => /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version))) throw new Error('备份版本号无效');
  fs.mkdirSync(options.out, { recursive: true, mode: 0o700 });
  fs.chmodSync(options.out, 0o700);
  const archive = path.join(options.out, `视频制作OS-${sourceVersion}-before-formal-${targetVersion}.zip`);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', options.installAppBundle], { stdio: 'pipe' });
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', options.installAppBundle, archive], { stdio: 'pipe' });
  const archiveSha256 = hashFile(archive);
  const appVerification = verifyOriginalAppBackup({ archive, sha256: archiveSha256,
    out: path.join(options.out, 'app-restore-verification'), expectedVersion: sourceVersion });
  const copies = {};
  for (const [label, source] of [['profile', options.profile], ['data', options.dataDir]]) {
    console.log(`FORMAL_BACKUP_PROGRESS ${label} opaque copy and hash verification`);
    const before = opaqueInventory(source);
    const target = path.join(options.out, label);
    copyDirectory(source, target);
    const copied = opaqueInventory(target);
    const after = opaqueInventory(source);
    if (JSON.stringify(before.entries) !== JSON.stringify(after.entries)) throw new Error(`正式 ${label} 在备份期间发生变动，不能签收快照`);
    if (JSON.stringify(before.entries) !== JSON.stringify(copied.entries)) throw new Error(`正式 ${label} 副本的字节/链接/权限/时间核验失败`);
    fs.writeFileSync(path.join(options.out, `${label}-opaque-inventory.json`), `${JSON.stringify(copied, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    copies[label] = { source, copy: target, ...copied.summary, contentAndModesMatch: true, sourceStableDuringCopy: true };
    assertStopped(options);
  }
  const receipt = { status: 'passed', createdAt: new Date().toISOString(), purpose: `before formal ${targetVersion} install`, targetVersion,
    sourceApp: options.installAppBundle, sourceVersion: appVerification.version,
    archive, archiveSha256, appSignature: 'strict deep verified', appResources: appVerification.checkedResources,
    appRestoreVerified: true, copies, database: checkDatabase(copies.data.copy),
    personalStorageInspected: false, backupMethod: 'closed-app cp -cRPp with independent opaque byte/link/mode verification',
    cloneOptimizationGuaranteed: false, formalAppReplaced: false, formalAppStoppedByThisScript: false,
    candidateDataMerged: false, rollbackPolicy: 'App-only; do not restore old data/profile over new creations' };
  fs.writeFileSync(path.join(options.out, 'backup-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return receipt;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    const result = snapshotFormalUpdate({ projectRoot: readArg(argv, '--formal-project-root'), dataDir: readArg(argv, '--formal-data-dir'),
      installAppBundle: readArg(argv, '--install-app'), profile: readArg(argv, '--profile'), out: readArg(argv, '--out'), arch: readArg(argv, '--arch') || 'arm64', targetVersion: readArg(argv, '--target-version') });
    console.log(`FORMAL_BACKUP_PASS receipt=${path.join(path.dirname(result.archive), 'backup-receipt.json')} archiveSha256=${result.archiveSha256}`);
  } catch (error) { console.error(`FORMAL_BACKUP_FAIL ${error.message}`); process.exitCode = 1; }
}

module.exports = { hashFile, opaqueInventory, assertStopped, backupOptions, checkDatabase, snapshotFormalUpdate };
