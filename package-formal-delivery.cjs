'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertMacBundle } = require('./verify-mac-bundle.cjs');
const { formalDeploymentTarget } = require('./formal-deployment-contract.cjs');
const { readArg, assertAbsoluteDirectory } = require('./candidate-contract.cjs');
const { hashFile } = require('./snapshot-formal-update.cjs');

function packageFormalDelivery(options) {
  const target = formalDeploymentTarget(options);
  if (!target) throw new Error('正式归档缺少部署目标');
  const appBundle = assertAbsoluteDirectory(options.appBundle, '正式暂存 App');
  if (appBundle === target.installAppBundle) throw new Error('正式归档入口只接受未安装的暂存包');
  const out = assertAbsoluteDirectory(options.out, '正式交付输出');
  const receiptFile = assertAbsoluteDirectory(options.receiptFile, '正式包回执');
  if (fs.existsSync(receiptFile)) throw new Error('正式包回执必须使用新文件');
  const verifyOptions = { ...target, appBundle, arch: options.arch, sourceRoot: __dirname, portable: false };
  const verified = assertMacBundle(verifyOptions);
  const manifestPath = path.join(appBundle, 'Contents', 'Resources', 'app', 'build-manifest.json');
  const manifestSha256 = hashFile(manifestPath);
  const version = verified.manifest.appVersion;
  const archive = path.join(out, `video-production-os-${version}-mac-${options.arch}-formal-${manifestSha256.slice(0, 8)}.zip`);
  if (fs.existsSync(archive)) throw new Error('正式 ZIP 已存在，禁止覆盖');
  fs.mkdirSync(out, { recursive: true });
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, archive], { stdio: 'pipe' });
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-formal-archive-'));
  let restored;
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, temporary], { stdio: 'pipe' });
    const restoredApp = path.join(temporary, path.basename(appBundle));
    restored = assertMacBundle({ ...verifyOptions, appBundle: restoredApp });
    if (hashFile(path.join(restoredApp, 'Contents', 'Resources', 'app', 'build-manifest.json')) !== manifestSha256) {
      throw new Error('正式 ZIP 解包后的 manifest 与暂存包不一致');
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const receipt = { status: 'passed', verifiedAt: new Date().toISOString(), version, arch: options.arch,
    appBundle, installAppBundle: target.installAppBundle, projectRoot: target.projectRoot, dataDir: target.dataDir,
    runtimeConfig: verified.runtimeConfig, checkedResources: verified.checkedFiles,
    manifestSha256, executableSha256: hashFile(verified.executable),
    archive, archiveBytes: fs.statSync(archive).size, archiveSha256: hashFile(archive),
    signature: 'strict deep verified', extractedArchiveSignature: 'strict deep verified',
    extractedArchiveResources: restored.checkedFiles, signedInstallTargetVerified: true,
    candidateFieldsAbsent: true, realDataBundled: false, profileBundled: false,
    stagedPackageLaunched: false, formalAppInstalledByThisScript: false,
    acceptanceBoundary: 'Static source/manifest/plist/signature/archive verification; installed runtime must be verified after deployment' };
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    const result = packageFormalDelivery({ projectRoot: readArg(argv, '--formal-project-root'), dataDir: readArg(argv, '--formal-data-dir'),
      installAppBundle: readArg(argv, '--install-app'), appBundle: readArg(argv, '--app'), arch: readArg(argv, '--arch'),
      out: readArg(argv, '--out'), receiptFile: readArg(argv, '--receipt-file') });
    console.log(`FORMAL_PACKAGE_DELIVERY_PASS archive=${result.archive} sha256=${result.archiveSha256} resources=${result.checkedResources}`);
  } catch (error) { console.error(`FORMAL_PACKAGE_DELIVERY_FAIL ${error.message}`); process.exitCode = 1; }
}

module.exports = { packageFormalDelivery };
