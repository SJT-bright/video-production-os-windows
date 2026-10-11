'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertMacBundle } = require('./verify-mac-bundle.cjs');
const { CANDIDATE_BUNDLE_PREFIX, readArg, assertAbsoluteDirectory } = require('./candidate-contract.cjs');

function assertCandidateBundle(options = {}) {
  const appBundle = assertAbsoluteDirectory(options.appBundle, '候选 App');
  const userData = assertAbsoluteDirectory(options.candidateUserData, '候选 userData');
  const verified = assertMacBundle({ appBundle, sourceRoot: options.sourceRoot || __dirname,
    arch: options.arch || process.arch, portable: true });
  const config = verified.runtimeConfig;
  if (config.candidate !== true || config.candidateUserData !== userData || !config.candidateId
    || !config.candidateVersion || config.dataLocation !== 'userData') throw new Error('候选 App 隔离运行契约不完整');
  const readPlist = key => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', verified.plist], { encoding: 'utf8' }).trim();
  if (readPlist('CFBundleIdentifier') !== CANDIDATE_BUNDLE_PREFIX + config.candidateId) throw new Error('候选 Bundle ID 必须与正式 App 分离');
  if (readPlist('CFBundleShortVersionString') !== config.candidateVersion) throw new Error('候选 Bundle 版本与运行契约不一致');
  return { ...verified, candidateUserData: userData, candidateId: config.candidateId,
    candidateVersion: config.candidateVersion, candidateWorkspace: path.join(userData, 'workspace') };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    const result = assertCandidateBundle({ appBundle: readArg(argv, '--app'), candidateUserData: readArg(argv, '--candidate-user-data'), arch: readArg(argv, '--arch') || process.arch });
    console.log(`CANDIDATE_BUILD_VERIFY_PASS version=${result.candidateVersion} checked=${result.checkedFiles} independentBundleId=true independentUserData=true`);
  } catch (error) { console.error(`CANDIDATE_BUILD_VERIFY_FAIL ${error.message}`); process.exitCode = 1; }
}

module.exports = { assertCandidateBundle };
