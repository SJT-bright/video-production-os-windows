'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertCandidateBundle } = require('./verify-candidate-build.cjs');
const { readArg, assertAbsoluteDirectory, isWithin } = require('./candidate-contract.cjs');
const { loadCandidateAcceptance, assertDeliveryLayout } = require('./write-candidate-delivery.cjs');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function packageCandidateDelivery(options = {}) {
  const delivery = assertAbsoluteDirectory(options.delivery, '候选交付目录');
  const manifest = JSON.parse(fs.readFileSync(path.join(delivery, 'delivery-manifest.json'), 'utf8'));
  assertDeliveryLayout(delivery, manifest.candidateApp, manifest.candidateUserData);
  const verified = assertCandidateBundle({ appBundle: manifest.candidateApp,
    candidateUserData: manifest.candidateUserData, arch: options.arch || process.arch });
  const accepted = loadCandidateAcceptance(options.acceptanceFile || manifest.nativeAcceptance, verified);
  const receiptFile = assertAbsoluteDirectory(options.receiptFile || path.join(path.dirname(delivery), 'candidate-archive-verification.json'), '候选 ZIP 验收回执');
  if (isWithin(manifest.candidateUserData, receiptFile) || isWithin(delivery, receiptFile)) throw new Error('ZIP 验收回执必须位于个人 profile 与交付目录之外');
  if (fs.existsSync(receiptFile)) throw new Error('候选 ZIP 验收回执已存在，拒绝覆盖');
  const runtimeManifest = path.join(verified.appBundle, 'Contents/Resources/app/build-manifest.json');
  const archive = path.join(path.dirname(delivery), `video-production-os-${verified.candidateVersion}-mac-${options.arch || process.arch}-candidate-${hash(runtimeManifest).slice(0, 8)}.zip`);
  if (fs.existsSync(archive)) throw new Error('同一候选归档已存在，拒绝覆盖');
  for (const name of ['打开候选版.command', '回到原版1.2.3.command']) {
    execFileSync('/bin/zsh', ['-n', path.join(delivery, name)], { stdio: 'pipe' });
    if (!(fs.statSync(path.join(delivery, name)).mode & 0o111)) throw new Error('交付入口缺少可执行权限');
  }
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', delivery, archive], { stdio: 'pipe' });
  const temporary = fs.mkdtempSync(path.join(path.dirname(delivery), 'candidate-archive-check-'));
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, temporary], { stdio: 'pipe' });
    const extracted = path.join(temporary, path.basename(delivery));
    const app = path.join(extracted, path.relative(delivery, verified.appBundle));
    assertCandidateBundle({ appBundle: app, candidateUserData: manifest.candidateUserData, arch: options.arch || process.arch });
    for (const name of ['打开候选版.command', '回到原版1.2.3.command', '使用候选版.md', 'delivery-manifest.json']) {
      if (hash(path.join(delivery, name)) !== hash(path.join(extracted, name))) throw new Error(`候选归档交付文件不一致：${name}`);
    }
    const result = { archivedAt: new Date().toISOString(), archive, sha256: hash(archive), bytes: fs.statSync(archive).size,
      version: verified.candidateVersion, checkedRuntimeResources: verified.checkedFiles,
      extractedSignatureVerified: true, extractedDeliveryHashesVerified: true, personalProfileIncluded: false,
      liveCandidateAcceptance: accepted.file };
    fs.writeFileSync(receiptFile, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    const result = packageCandidateDelivery({ delivery: readArg(argv, '--delivery'), arch: readArg(argv, '--arch') || process.arch,
      acceptanceFile: readArg(argv, '--acceptance-file'), receiptFile: readArg(argv, '--receipt-file') });
    console.log(`CANDIDATE_ARCHIVE_PASS version=${result.version} bytes=${result.bytes} sha256=${result.sha256} archive=${result.archive} privateProfileIncluded=false`);
  } catch (error) { console.error(`CANDIDATE_ARCHIVE_FAIL ${error.message}`); process.exitCode = 1; }
}

module.exports = { packageCandidateDelivery };
