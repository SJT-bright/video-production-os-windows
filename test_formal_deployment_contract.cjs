'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formalDeploymentTarget, formalBuildOptions, assertFormalRuntimeConfig } = require('./formal-deployment-contract.cjs');
const { DEFAULT_CANDIDATE_VERSION } = require('./candidate-contract.cjs');
const { MAC_PROJECT_ROOT_FROM_APP } = require('./electron/runtime-project-path.cjs');

const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-formal-contract-'));
try {
  const projectRoot = path.join(fixture, 'formal');
  const dataDir = path.join(projectRoot, '视频制作OS', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '视频制作OS', 'package.json'), '{}');
  const installAppBundle = path.join(projectRoot, '视频制作OS', 'dist', '视频制作 OS-darwin-arm64', '视频制作 OS.app');
  const options = { projectRoot, dataDir, installAppBundle, arch: 'arm64' };
  const target = formalDeploymentTarget(options);
  assert.deepEqual(target, { projectRoot, dataDir, installAppBundle });
  assert.equal(formalDeploymentTarget({ arch: 'arm64' }), null, '默认构建合同不得改变');
  for (const missing of ['projectRoot', 'dataDir', 'installAppBundle']) {
    assert.throws(() => formalDeploymentTarget({ ...options, [missing]: '' }), /同时指定/);
  }
  assert.throws(() => formalDeploymentTarget({ ...options, portable: true }), /不能与/);
  assert.throws(() => formalDeploymentTarget({ ...options, candidate: true }), /不能与/);
  assert.throws(() => formalDeploymentTarget({ ...options, dataDir: path.join(fixture, 'other-data') }), /正式 data 必须/);
  assert.throws(() => formalDeploymentTarget({ ...options, installAppBundle: path.join(fixture, 'wrong.app') }), /标准 dist/);
  assert.throws(() => formalDeploymentTarget({ ...options, arch: 'x64' }), /标准 dist/);
  const link = path.join(fixture, 'linked-formal');
  fs.symlinkSync(projectRoot, link);
  assert.throws(() => formalDeploymentTarget({ ...options, projectRoot: link }), /符号链接/);
  const out = path.join(fixture, 'staging');
  const argv = ['--formal-project-root', projectRoot, '--formal-data-dir', dataDir, '--install-app', installAppBundle, '--out', out];
  assert.equal(formalBuildOptions(argv, { arch: 'arm64' }).out, out);
  assert.equal(formalBuildOptions([], { arch: 'arm64' }), null);
  assert.throws(() => formalBuildOptions(argv.slice(0, -2), { arch: 'arm64' }), /独立 --out/);
  assert.throws(() => formalBuildOptions([...argv, '--portable'], { arch: 'arm64' }), /不能与/);
  assert.throws(() => formalBuildOptions([...argv, '--candidate-user-data', path.join(fixture, 'profile')], { arch: 'arm64' }), /不能与/);
  assert.throws(() => formalBuildOptions([...argv.slice(0, -1), path.join(projectRoot, '视频制作OS', 'dist', 'staged')], { arch: 'arm64' }), /覆盖或嵌套/);
  fs.mkdirSync(out);
  assert.throws(() => formalBuildOptions(argv, { arch: 'arm64' }), /尚不存在/);
  const config = { projectRoot, dataDir, formalInstallApp: installAppBundle, projectRootFromBundle: MAC_PROJECT_ROOT_FROM_APP };
  assertFormalRuntimeConfig(config, target);
  assertFormalRuntimeConfig({ projectRoot, dataDir }, null);
  assert.throws(() => assertFormalRuntimeConfig(config, null), /明确提供/);
  assert.throws(() => assertFormalRuntimeConfig({ ...config, formalInstallApp: '/other.app' }, target), /已签名/);
  assert.throws(() => assertFormalRuntimeConfig({ ...config, projectRootFromBundle: '..' }, target), /七层/);
  for (const key of ['candidate', 'candidateId', 'candidateUserData', 'candidateVersion', 'dataLocation']) {
    assert.throws(() => assertFormalRuntimeConfig({ ...config, [key]: false }, target), /candidate\/portable/);
  }
  const version = require('./package.json').version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const lock = require('./package-lock.json');
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.equal(DEFAULT_CANDIDATE_VERSION, '1.3.0-rc.2');
  console.log('FORMAL_DEPLOYMENT_CONTRACT_PASS defaultUnchanged=true signedTargetRequired=true isolatedStaging=true candidateDefaultUnchanged=true');
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
