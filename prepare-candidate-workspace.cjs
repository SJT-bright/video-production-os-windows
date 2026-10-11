'use strict';

// 本脚本只写新候选目录。SQLite 用在线 backup；素材用 APFS 独立 clone。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const { readArg, isWithin, assertAbsoluteDirectory, DEFAULT_CANDIDATE_ID } = require('./candidate-contract.cjs');

const DATA_JSON_FILES = Object.freeze([
  'agent-knowledge.json', 'asset-meta.json', 'audio-library.json', 'doc-annotations.json',
  'creative-projects.json', 'media-sources.json', 'library-sources.json', 'library-links.json',
  'float-video-bounds.json', 'creator-workflows/workflows.json',
]);
const PROFILE_JSON_FILES = Object.freeze(['creator-browser-session.json', 'creator-platforms.json']);

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function remapAbsolutePaths(value, sourceRoot, targetRoot) {
  const remap = text => text === sourceRoot ? targetRoot
    : text.startsWith(`${sourceRoot}${path.sep}`) ? targetRoot + text.slice(sourceRoot.length) : text;
  if (typeof value === 'string') return remap(value);
  if (Array.isArray(value)) return value.map(item => remapAbsolutePaths(item, sourceRoot, targetRoot));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [remap(key), remapAbsolutePaths(item, sourceRoot, targetRoot)]));
  return value;
}

function cloneTree(source, target, evidence, label, omit = () => false) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`${label}包含符号链接，已停止克隆`);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (!omit(entry.name)) cloneTree(path.join(source, entry.name), path.join(target, entry.name), evidence, label, omit);
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`${label}包含不支持的文件节点`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) throw new Error('克隆目标已存在，拒绝覆盖');
  // Node 的 FICLONE_FORCE 在本机 libuv 返回 ENOSYS；macOS cp -c 调用 clonefile。
  execFileSync('/bin/cp', ['-c', '-p', '-n', source, target], { stdio: 'pipe' });
  const copied = fs.statSync(target);
  if (copied.ino === stat.ino && copied.dev === stat.dev) throw new Error('素材副本不能使用硬链接');
  const after = fs.statSync(source);
  evidence.files += 1;
  evidence.logicalBytes += copied.size;
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) evidence.changedDuringCopy += 1;
  fs.utimesSync(target, stat.atime, stat.mtime);
}

function copyJson(source, target, sourceRoot, targetRoot, evidence) {
  if (!fs.existsSync(source)) return;
  if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error('状态 JSON 必须是普通文件');
  // 不打印状态正文；只改副本中的绝对项目路径。
  const raw = fs.readFileSync(source, 'utf8');
  const mapped = remapAbsolutePaths(JSON.parse(raw), sourceRoot, targetRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(mapped, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  evidence.push({ file: path.basename(source), sourceSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    candidateSha256: sha256(target) });
}

async function snapshotDatabase(source, target, sourceRoot, targetRoot) {
  if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error('SQLite 来源必须是普通文件');
  if (fs.existsSync(target)) throw new Error('SQLite 目标已存在，拒绝覆盖');
  const original = new DatabaseSync(source, { readOnly: true });
  let pages;
  try { pages = await backup(original, target); } finally { original.close(); }
  const candidate = new DatabaseSync(target);
  const remapped = {};
  try {
    candidate.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    for (const [table, column] of [['asset_refs', 'path'], ['inbox_items', 'asset_path']]) {
      const exists = candidate.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
      if (!exists) continue;
      const columns = candidate.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some(item => item.name === column)) continue;
      const changed = candidate.prepare(`UPDATE ${table} SET ${column} = ? || substr(${column}, length(?) + 1)
        WHERE ${column} = ? OR substr(${column}, 1, length(?) + 1) = ? || '/'`)
        .run(targetRoot, sourceRoot, sourceRoot, sourceRoot, sourceRoot);
      remapped[`${table}.${column}`] = changed.changes;
    }
    candidate.exec('COMMIT');
    const integrity = candidate.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('候选数据库 integrity_check 失败');
    if (candidate.prepare('PRAGMA foreign_key_check').all().length) throw new Error('候选数据库 foreign_key_check 失败');
    candidate.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) { try { candidate.exec('ROLLBACK'); } catch {} throw error; }
  finally { candidate.close(); }
  return { file: path.basename(source), pages, remapped, integrity: 'ok', candidateSha256: sha256(target) };
}

async function prepareCandidateWorkspace(options = {}) {
  if (process.platform !== 'darwin') throw new Error('候选素材克隆必须在 APFS macOS 主机执行');
  const sourceRoot = assertAbsoluteDirectory(options.sourceProject, '来源项目');
  const sourceProfile = assertAbsoluteDirectory(options.sourceUserData, '来源 userData');
  const profile = assertAbsoluteDirectory(options.candidateUserData, '候选 userData');
  if (isWithin(sourceProfile, profile) || isWithin(profile, sourceProfile)) throw new Error('候选与正式 userData 不能互相嵌套');
  for (const protectedDir of ['创作资产库', '素材库', '视频制作OS/data']) {
    if (isWithin(path.join(sourceRoot, protectedDir), profile)) throw new Error('候选目录不能位于正式素材或 data 中');
  }
  if (fs.existsSync(profile)) throw new Error('候选 userData 已存在；请使用新的空路径，避免覆盖候选新增创作');
  const workspace = path.join(profile, 'workspace');
  const data = path.join(workspace, '视频制作OS', 'data');
  const report = { schemaVersion: 1, candidateId: options.candidateId || DEFAULT_CANDIDATE_ID,
    createdAt: new Date().toISOString(), sourceProject: sourceRoot, candidateUserData: profile,
    candidateWorkspace: workspace, sourceWritten: false, copyMethod: 'APFS clonefile; independent inodes',
    assets: {}, dataJson: [], databases: [], profileJson: [],
    localStorage: { copied: false, liveCopyConsistency: 'not guaranteed', originMigration: 'pending candidate runtime check' },
    websiteLogin: 'not copied; first candidate launch may require sign in', complete: false };
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const reportPath = path.join(profile, 'candidate-seed.json');
  try {
    for (const directory of ['创作资产库', '素材库']) {
      const source = path.join(sourceRoot, directory);
      if (!fs.existsSync(source)) continue;
      const evidence = { files: 0, logicalBytes: 0, changedDuringCopy: 0 };
      cloneTree(source, path.join(workspace, directory), evidence, directory, name => name === '.DS_Store' || name.startsWith('._'));
      report.assets[directory] = evidence;
    }
    const docs = { files: 0, logicalBytes: 0, changedDuringCopy: 0 };
    for (const entry of fs.readdirSync(sourceRoot)) {
      if (!/^(?:AGENTS|MEMORY-MANIFEST|README|VIDEO-\d+.*|TOOL-\d+.*)\.md$/.test(entry)) continue;
      cloneTree(path.join(sourceRoot, entry), path.join(workspace, entry), docs, '项目知识');
    }
    report.knowledge = docs;
    const sourceData = path.join(sourceRoot, '视频制作OS', 'data');
    for (const relative of DATA_JSON_FILES) copyJson(path.join(sourceData, relative), path.join(data, relative), sourceRoot, workspace, report.dataJson);
    for (const entry of fs.readdirSync(sourceData)) {
      if (!/\.(?:sqlite|db)$/.test(entry)) continue;
      report.databases.push(await snapshotDatabase(path.join(sourceData, entry), path.join(data, entry), sourceRoot, workspace));
    }
    for (const relative of PROFILE_JSON_FILES) copyJson(path.join(sourceProfile, relative), path.join(profile, relative), sourceRoot, workspace, report.profileJson);
    const localStorage = path.join(sourceProfile, 'Local Storage', 'leveldb');
    if (fs.existsSync(localStorage)) {
      const evidence = { files: 0, logicalBytes: 0, changedDuringCopy: 0 };
      cloneTree(localStorage, path.join(profile, 'Local Storage', 'leveldb'), evidence, '本地工作区状态', name => name === 'LOCK');
      report.localStorage = { ...report.localStorage, ...evidence, copied: true };
    }
    report.complete = true;
    return report;
  } finally {
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  prepareCandidateWorkspace({ sourceProject: readArg(argv, '--source-project'),
    sourceUserData: readArg(argv, '--source-user-data'), candidateUserData: readArg(argv, '--candidate-user-data'),
    candidateId: readArg(argv, '--candidate-id') })
    .then(report => console.log(`CANDIDATE_WORKSPACE_READY assets=${Object.values(report.assets).reduce((n, item) => n + item.files, 0)} sqlite=${report.databases.length} profileIsolated=true sourceWritten=false report=${path.join(report.candidateUserData, 'candidate-seed.json')}`))
    .catch(error => { console.error(`CANDIDATE_WORKSPACE_FAIL ${error.message}`); process.exitCode = 1; });
}

module.exports = { DATA_JSON_FILES, PROFILE_JSON_FILES, remapAbsolutePaths, cloneTree, snapshotDatabase, prepareCandidateWorkspace };
