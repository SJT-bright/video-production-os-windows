'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyPackagedApp } = require('./verify-build-manifest.cjs');
const { MAC_PROJECT_ROOT_FROM_APP } = require('./electron/runtime-project-path.cjs');
const { formalDeploymentTarget, assertFormalRuntimeConfig } = require('./formal-deployment-contract.cjs');

const EXECUTABLE_NAME = 'VideoProductionOS';

function runMacTool(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf-8' });
  if (result.error || result.status !== 0) {
    throw new Error(`${label}失败：${result.error?.message || result.stderr || result.stdout || '未知错误'}`);
  }
  return String(result.stdout || '').trim();
}

function assertRegularExecutable(executablePath) {
  let stat;
  try { stat = fs.lstatSync(executablePath); }
  catch { throw new Error('macOS Bundle 缺少主程序'); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error('macOS Bundle 主程序不是可执行的普通文件');
  }
}

function assertMacBundle(options = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS Bundle 完整性验证必须在真实 macOS 主机执行');
  const appBundle = path.resolve(options.appBundle || '');
  const sourceRoot = path.resolve(options.sourceRoot || '');
  const projectRoot = path.resolve(options.projectRoot || '');
  const dataDir = path.resolve(options.dataDir || '');
  const arch = options.arch;
  if (!['arm64', 'x64', 'universal'].includes(arch)) throw new Error('macOS Bundle 架构无效');
  const formalTarget = options.installAppBundle ? formalDeploymentTarget({ projectRoot, dataDir,
    installAppBundle: options.installAppBundle, arch, portable: options.portable }) : null;
  const contents = path.join(appBundle, 'Contents');
  const executable = path.join(contents, 'MacOS', EXECUTABLE_NAME);
  const plist = path.join(contents, 'Info.plist');
  const appRoot = path.join(contents, 'Resources', 'app');
  if (!fs.existsSync(appBundle) || !fs.statSync(appBundle).isDirectory()) throw new Error('macOS App 不存在或不是目录');
  if (!fs.existsSync(plist) || !fs.existsSync(appRoot)) throw new Error('macOS Bundle 缺少 Info.plist 或应用资源');
  assertRegularExecutable(executable);
  if (fs.existsSync(path.join(appRoot, 'data'))) throw new Error('macOS Bundle 不得包含实时 data 目录');

  runMacTool('plutil', ['-lint', plist], 'Info.plist 语法校验');
  const plistExecutable = runMacTool('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist], 'Info.plist 可执行文件读取');
  if (plistExecutable !== EXECUTABLE_NAME) throw new Error(`Info.plist 的 CFBundleExecutable 不匹配：${plistExecutable || '空'}`);
  const displayName = runMacTool('plutil', ['-extract', 'CFBundleDisplayName', 'raw', '-o', '-', plist], '应用显示名称读取');
  if (displayName !== '视频制作 OS') throw new Error(`macOS 应用显示名称不匹配：${displayName || '空'}`);
  const expectedLipoArch = arch === 'x64' ? 'x86_64' : arch;
  const executableArchs = runMacTool('lipo', ['-archs', executable], 'macOS 主程序架构校验').split(/\s+/);
  const expectedArchs = arch === 'universal' ? ['arm64', 'x86_64'] : [expectedLipoArch];
  if (!expectedArchs.every(value => executableArchs.includes(value))) throw new Error(`macOS 主程序架构不是预期的 ${expectedArchs}`);
  runMacTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle], 'macOS Bundle 签名校验');

  const verified = verifyPackagedApp({
    sourceRoot,
    appRoot,
    projectRoot,
    dataDir,
    platform: 'darwin',
    arch,
    compatibilityMode: false,
    portable: options.portable === true,
  });
  if (verified.runtimeConfig.projectRootFromBundle !== MAC_PROJECT_ROOT_FROM_APP) {
    throw new Error('macOS Bundle 缺少可重定位项目根目录契约');
  }
  const relocatedProjectRoot = path.resolve(appRoot, verified.runtimeConfig.projectRootFromBundle);
  assertFormalRuntimeConfig(verified.runtimeConfig, formalTarget);
  if (formalTarget) {
    const bundleId = runMacTool('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], '正式 Bundle ID 读取');
    const version = runMacTool('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], '正式版本读取');
    if (bundleId !== 'local.video-production-os') throw new Error('正式部署包的 Bundle ID 不匹配');
    if (version !== verified.manifest.appVersion || version !== require(path.join(sourceRoot, 'package.json')).version) {
      throw new Error('正式部署包的版本与源码/manifest 不一致');
    }
  }
  if (!options.portable && !formalTarget && relocatedProjectRoot !== projectRoot) {
    throw new Error(`macOS Bundle 项目根目录回溯错误：期望 ${projectRoot}，实际 ${relocatedProjectRoot}`);
  }
  return {
    appBundle,
    executable,
    plist,
    executableArchs,
    ...(formalTarget ? { formalDeploymentTarget: formalTarget, stagedBundle: appBundle !== formalTarget.installAppBundle } : {}),
    ...verified,
  };
}

module.exports = { EXECUTABLE_NAME, assertMacBundle };
