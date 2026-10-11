'use strict';

const path = require('path');
const { assertMacBundle } = require('./verify-mac-bundle.cjs');
const { formalDeploymentTarget } = require('./formal-deployment-contract.cjs');

const APP_DIR = __dirname;
const PROJECT_ROOT = path.dirname(APP_DIR);

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function verifyMacBuild(arch = readArg('--arch')) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('macOS 发行包验证需要 --arch arm64 或 --arch x64');
  const formalTarget = formalDeploymentTarget({ projectRoot: readArg('--formal-project-root'),
    dataDir: readArg('--formal-data-dir'), installAppBundle: readArg('--install-app'), arch,
    portable: process.argv.includes('--portable'), candidate: !!readArg('--candidate-user-data') });
  const packageRoot = path.join(APP_DIR, 'dist', `视频制作 OS-darwin-${arch}`);
  const appBundle = readArg('--app') || path.join(packageRoot, '视频制作 OS.app');
  return assertMacBundle({
      appBundle,
      sourceRoot: APP_DIR,
      projectRoot: formalTarget?.projectRoot || PROJECT_ROOT,
      dataDir: formalTarget?.dataDir || path.join(APP_DIR, 'data'),
      installAppBundle: formalTarget?.installAppBundle,
      arch,
    });
}

if (require.main === module) {
  try {
    const result = verifyMacBuild();
    console.log(`MAC_BUILD_VERIFY_PASS checked=${result.checkedFiles} app=${result.appBundle}`);
  } catch (error) {
    console.error(`MAC_BUILD_VERIFY_FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { verifyMacBuild };
