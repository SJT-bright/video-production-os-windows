'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { packager } = require('@electron/packager');
const packagerUnzip = require('./node_modules/@electron/packager/dist/unzip.js');
const { SOURCE_FILES, SOURCE_DIRS, BUILD_SCHEMA_VERSION } = require('./build-contract.cjs');
const { assertMacBundle, EXECUTABLE_NAME } = require('./verify-mac-bundle.cjs');
const { MAC_PROJECT_ROOT_FROM_APP } = require('./electron/runtime-project-path.cjs');
const { prepareMediaTools } = require('./prepare-media-tools.cjs');

const APP_DIR = __dirname;
const PROJECT_ROOT = path.dirname(APP_DIR);
const DIST_ROOT = path.resolve(readArg('--out') || path.join(APP_DIR, 'dist'));
const PRODUCT_NAME = '视频制作 OS';
const BUNDLE_ID = 'local.video-production-os';
const packageInfo = require('./package.json');
const PORTABLE_RELEASE = process.argv.includes('--portable');
const execFileAsync = promisify(execFile);

// Packager 18's legacy ZIP reader can stall under Node 26. macOS ditto is the
// system-native extractor and preserves Electron framework links and modes.
packagerUnzip.extractElectronZip = async (zipPath, targetDir) => {
  await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, targetDir]);
};

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

// 单视频置顶浮窗渲染层（FV-BE-20260928）已列入 build-contract SOURCE_FILES（schema 5），
// 常规复制与 sourceHashes 会覆盖它们。若合同暂时漏掉，下面只补拷、不登记哈希：
// verify-build-manifest 要求清单键与合同严格相等，多一个键会判「文件集合不完整或异常」。
// 合同补齐后此分支为空，不再打印待办。
const FLOAT_VIDEO_RENDERER_FILES = Object.freeze(['float-video.html', 'float-video.css', 'float-video.js']);
const FLOAT_VIDEO_UNDECLARED = FLOAT_VIDEO_RENDERER_FILES.filter(
  relativePath => !SOURCE_FILES.includes(relativePath)
);

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyEntry(stageDir, relativePath) {
  const source = path.join(APP_DIR, relativePath);
  const target = path.join(stageDir, relativePath);
  if (!fs.existsSync(source)) throw new Error(`macOS 发行文件缺失：${relativePath}`);
  fs.cpSync(source, target, { recursive: true, force: true });
}

function collectSourceHashes() {
  const files = [];
  const collect = relativePath => {
    const source = path.join(APP_DIR, relativePath);
    const stat = fs.statSync(source);
    if (stat.isFile()) files.push(relativePath.replace(/\\/g, '/'));
    else for (const entry of fs.readdirSync(source, { withFileTypes: true })) collect(path.join(relativePath, entry.name));
  };
  for (const file of SOURCE_FILES) collect(file);
  for (const directory of SOURCE_DIRS) collect(directory);
  return Object.fromEntries(files.sort().map(relativePath => [relativePath, sha256(path.join(APP_DIR, relativePath))]));
}

async function build() {
  if (process.platform !== 'darwin') throw new Error('macOS .app 必须在真实 macOS 主机上构建；Windows 只维护构建脚本和静态契约。');
  const arch = readArg('--arch') || process.env.VIDEO_OS_MAC_ARCH || process.arch;
  if (!['arm64', 'x64', 'universal'].includes(arch)) throw new Error('未知 macOS 架构');
  await prepareMediaTools('darwin', arch);
  const electronVersion = require('./node_modules/electron/package.json').version;
  const { downloadArtifact } = await import('@electron/get');
  const electronZip = await downloadArtifact({
    version: electronVersion,
    platform: 'darwin',
    arch: arch === 'universal' ? 'arm64' : arch,
    artifactName: 'electron',
    checksums: require('./node_modules/electron/checksums.json'),
  });
  if (!electronZip || !fs.existsSync(electronZip)) throw new Error('Electron macOS 运行时缓存不存在，请先运行安装桌面版依赖-mac.command');
  if (arch === 'universal') {
    await downloadArtifact({ version: electronVersion, platform: 'darwin', arch: 'x64', artifactName: 'electron',
      checksums: require('./node_modules/electron/checksums.json') });
  }
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-production-os-mac-'));
  try {
    for (const file of SOURCE_FILES) copyEntry(stageDir, file);
    for (const directory of SOURCE_DIRS) copyEntry(stageDir, directory);
    // 合同尚未声明的浮窗渲染层文件：补拷进包，保证发行版能打开浮窗；不登记哈希，见上方说明。
    for (const file of FLOAT_VIDEO_UNDECLARED) copyEntry(stageDir, file);
    if (FLOAT_VIDEO_UNDECLARED.length) {
      console.log(`MAC_BUILD_CONTRACT_PENDING unhashed=${FLOAT_VIDEO_UNDECLARED.join(',')} 请把这三项加入 build-contract.cjs 的 SOURCE_FILES 以纳入哈希与过期校验`);
    }
    const runtimeConfig = {
      ...(PORTABLE_RELEASE ? { dataLocation: 'userData' } : {
        projectRoot: PROJECT_ROOT,
        dataDir: path.join(APP_DIR, 'data'),
      }),
      compatibilityMode: false,
      buildSchemaVersion: BUILD_SCHEMA_VERSION,
      platform: 'darwin',
      arch,
      projectRootFromBundle: MAC_PROJECT_ROOT_FROM_APP,
    };
    fs.writeFileSync(path.join(stageDir, 'runtime-config.json'), `${JSON.stringify(runtimeConfig, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(path.join(stageDir, 'build-manifest.json'), `${JSON.stringify({
      buildSchemaVersion: BUILD_SCHEMA_VERSION,
      product: PRODUCT_NAME,
      platform: 'darwin', arch, builtAt: new Date().toISOString(),
      sourceHashes: collectSourceHashes(), runtimeConfig,
    }, null, 2)}\n`, 'utf-8');
    const apps = await packager({
      dir: stageDir,
      out: PORTABLE_RELEASE ? path.join(DIST_ROOT, 'public-release') : DIST_ROOT,
      name: PRODUCT_NAME,
      executableName: EXECUTABLE_NAME,
      platform: 'darwin', arch,
      electronVersion,
      electronZipDir: path.dirname(electronZip),
      appBundleId: BUNDLE_ID,
      appCategoryType: 'public.app-category.productivity',
      icon: path.join(APP_DIR, 'assets', 'app-icon.icns'),
      extendInfo: { CFBundleDisplayName: PRODUCT_NAME },
      appVersion: packageInfo.version,
      buildVersion: String(Date.now()),
      darwinDarkModeSupport: true,
      overwrite: true,
      prune: false,
      asar: false,
    });
    if (!Array.isArray(apps) || apps.length !== 1) throw new Error('Packager 没有返回唯一 macOS 应用路径');
    const appBundle = path.join(apps[0], `${PRODUCT_NAME}.app`);
    // 在本机签名前恢复源码清单所校验的原始 package.json。
    fs.copyFileSync(path.join(APP_DIR, 'package.json'), path.join(appBundle, 'Contents', 'Resources', 'app', 'package.json'));
    await execFileAsync('/usr/bin/plutil', [
      '-replace', 'CFBundleDisplayName', '-string', PRODUCT_NAME,
      path.join(appBundle, 'Contents', 'Info.plist'),
    ]);
    // Electron runtime binaries arrive linker-signed, but staging local app
    // resources invalidates that seal. Re-sign the complete local candidate so
    // Gatekeeper and strict codesign verification see one coherent bundle.
    await execFileAsync('/usr/bin/codesign', [
      '--force', '--deep', '--sign', '-', '--timestamp=none', appBundle,
    ]);
    assertMacBundle({
      appBundle,
      sourceRoot: APP_DIR,
      projectRoot: PROJECT_ROOT,
      dataDir: path.join(APP_DIR, 'data'),
      arch,
      portable: PORTABLE_RELEASE,
    });
    console.log(`MAC_BUILD_CANDIDATE_PASS ${appBundle}`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
  }
}

// Node 26 can otherwise consider the process idle while Packager is awaiting
// ZIP extraction. Keep one lightweight handle alive until the build promise settles.
const buildKeepalive = setInterval(() => {}, 1000);
build()
  .catch(error => {
    console.error(`MAC_BUILD_CANDIDATE_FAIL ${error.stack || error}`);
    process.exitCode = 1;
  })
  .finally(() => clearInterval(buildKeepalive));
