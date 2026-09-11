'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { packager } = require('@electron/packager');
const { SOURCE_FILES, SOURCE_DIRS, BUILD_SCHEMA_VERSION } = require('./build-contract.cjs');

const APP_DIR = __dirname;
const PROJECT_ROOT = path.dirname(APP_DIR);
const DIST_ROOT = path.join(APP_DIR, 'dist');
const PRODUCT_NAME = '视频制作OS';
const TARGET_DIR = path.join(DIST_ROOT, `${PRODUCT_NAME}-win32-x64`);

// 实时 data（尤其 SQLite/WAL）不能复制进发行包；发行版通过 runtime-config 指回项目的权威数据目录。
const LEGACY_DATA_NAMES = new Set([
  'agent-knowledge.json', 'asset-meta.json', 'doc-annotations.json',
  'production.sqlite', 'production.sqlite-wal', 'production.sqlite-shm',
]);

function assertGeneratedTarget(target) {
  const relative = path.relative(path.resolve(DIST_ROOT), path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`拒绝覆盖非发行目录：${target}`);
  }
}

function copyEntry(stageDir, relativePath) {
  const source = path.join(APP_DIR, relativePath);
  const target = path.join(stageDir, relativePath);
  if (!fs.existsSync(source)) throw new Error(`发行文件缺失：${relativePath}`);
  fs.cpSync(source, target, { recursive: true, force: true });
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function collectSourceHashes() {
  const entries = [];
  const collect = relativePath => {
    const source = path.join(APP_DIR, relativePath);
    const stat = fs.statSync(source);
    if (stat.isFile()) entries.push(relativePath.replace(/\\/g, '/'));
    else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        collect(path.join(relativePath, entry.name));
      }
    }
  };
  for (const file of SOURCE_FILES) collect(file);
  for (const directory of SOURCE_DIRS) collect(directory);
  return Object.fromEntries(entries.sort().map(relativePath => [relativePath, sha256(path.join(APP_DIR, relativePath))]));
}

function backupLegacyDataBeforeReplace() {
  const legacyDataDir = path.join(TARGET_DIR, 'resources', 'app', 'data');
  if (!fs.existsSync(legacyDataDir)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(APP_DIR, 'data', 'migrations', `legacy-desktop-${stamp}`);
  fs.mkdirSync(path.dirname(backupRoot), { recursive: true });
  fs.cpSync(legacyDataDir, backupRoot, { recursive: true, force: false, errorOnExist: true });

  const conflicting = [];
  for (const name of LEGACY_DATA_NAMES) {
    const legacyPath = path.join(legacyDataDir, name);
    const canonicalPath = path.join(APP_DIR, 'data', name);
    if (!fs.existsSync(legacyPath)) continue;
    if (!fs.existsSync(canonicalPath)) {
      conflicting.push({ name, reason: '权威数据目录缺少该文件' });
      continue;
    }
    if (sha256(legacyPath) !== sha256(canonicalPath)) conflicting.push({ name, reason: '与权威数据内容不一致' });
  }
  if (conflicting.length) {
    fs.writeFileSync(path.join(backupRoot, 'migration-conflicts.json'), `${JSON.stringify({
      createdAt: new Date().toISOString(), legacyDataDir, canonicalDataDir: path.join(APP_DIR, 'data'), conflicting,
    }, null, 2)}\n`, 'utf-8');
    throw new Error(`旧桌面版数据与权威 data 不一致；已备份到 ${backupRoot}。请先核对 migration-conflicts.json，构建已停止以防覆盖用户数据。`);
  }
  return backupRoot;
}

async function build() {
  assertGeneratedTarget(TARGET_DIR);
  const legacyBackup = backupLegacyDataBeforeReplace();

  fs.rmSync(TARGET_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  fs.mkdirSync(DIST_ROOT, { recursive: true });

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-production-os-win-'));
  try {
    for (const file of SOURCE_FILES) copyEntry(stageDir, file);
    for (const directory of SOURCE_DIRS) copyEntry(stageDir, directory);

    const runtimeConfig = {
      projectRoot: PROJECT_ROOT,
      dataDir: path.join(APP_DIR, 'data'),
      compatibilityMode: true,
      buildSchemaVersion: BUILD_SCHEMA_VERSION,
      platform: 'win32',
      arch: 'x64',
    };
    fs.writeFileSync(path.join(stageDir, 'runtime-config.json'), `${JSON.stringify(runtimeConfig, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(path.join(stageDir, 'build-manifest.json'), `${JSON.stringify({
      buildSchemaVersion: BUILD_SCHEMA_VERSION,
      product: '视频制作 OS',
      platform: 'win32',
      arch: 'x64',
      builtAt: new Date().toISOString(),
      sourceHashes: collectSourceHashes(),
      runtimeConfig,
    }, null, 2)}\n`, 'utf-8');

    const electronVersion = require('./node_modules/electron/package.json').version;
    const { downloadArtifact } = await import('@electron/get');
    const electronZip = await downloadArtifact({
      version: electronVersion,
      platform: 'win32',
      arch: 'x64',
      artifactName: 'electron',
      checksums: require('./node_modules/electron/checksums.json'),
    });
    if (!electronZip || !fs.existsSync(electronZip)) {
      throw new Error('Electron 运行时缓存不存在，请先执行安装桌面版依赖或确保网络可达');
    }

    const apps = await packager({
      dir: stageDir,
      out: DIST_ROOT,
      name: PRODUCT_NAME,
      executableName: PRODUCT_NAME,
      platform: 'win32',
      arch: 'x64',
      electronVersion,
      electronZipDir: path.dirname(electronZip),
      overwrite: true,
      prune: false,
      asar: false,
    });
    if (!Array.isArray(apps) || apps.length !== 1) {
      throw new Error('Packager 未返回唯一 Windows 应用路径');
    }
    if (path.resolve(apps[0]) !== path.resolve(TARGET_DIR)) {
      throw new Error(`Packager 输出路径异常：${apps[0]}`);
    }

    const productExe = path.join(TARGET_DIR, `${PRODUCT_NAME}.exe`);
    if (!fs.existsSync(productExe)) {
      throw new Error(`打包后未找到 EXE：${productExe}`);
    }

    fs.writeFileSync(
      path.join(TARGET_DIR, '使用说明.txt'),
      [
        '视频制作 OS 桌面版',
        '',
        '双击“视频制作OS.exe”启动。',
        '这是独立桌面窗口，不会自动跳转到系统浏览器。',
        '网页兼容版仍可从源码目录的“启动OS-浏览器版.bat”单独启动。',
        '',
        `当前项目目录：${PROJECT_ROOT}`,
      ].join('\r\n'),
      'utf-8',
    );

    console.log(`DESKTOP_BUILD_PASS ${productExe}${legacyBackup ? ` legacy_backup=${legacyBackup}` : ''}`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

build().catch(error => {
  console.error(`DESKTOP_BUILD_FAIL ${error.stack || error}`);
  process.exitCode = 1;
});
