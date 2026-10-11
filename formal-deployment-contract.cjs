'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readArg, assertAbsoluteDirectory, isWithin } = require('./candidate-contract.cjs');
const { MAC_PROJECT_ROOT_FROM_APP } = require('./electron/runtime-project-path.cjs');

function formalDeploymentTarget(options = {}) {
  const fields = ['projectRoot', 'dataDir', 'installAppBundle'];
  if (!fields.some(key => options[key])) return null;
  if (!fields.every(key => options[key])) throw new Error('正式部署必须同时指定 project root、data dir 和 install app');
  if (options.portable || options.candidate) throw new Error('正式部署目标不能与 candidate/portable 混用');
  if (!['arm64', 'x64', 'universal'].includes(options.arch)) throw new Error('正式部署架构无效');
  const projectRoot = assertAbsoluteDirectory(options.projectRoot, '正式项目根目录');
  const dataDir = assertAbsoluteDirectory(options.dataDir, '正式 data 目录');
  const installAppBundle = assertAbsoluteDirectory(options.installAppBundle, '正式 App 安装路径');
  const osDir = path.join(projectRoot, '视频制作OS');
  const packagePath = path.join(osDir, 'package.json');
  if (!fs.existsSync(packagePath) || !fs.lstatSync(packagePath).isFile() || fs.lstatSync(packagePath).isSymbolicLink()) {
    throw new Error('正式项目根目录缺少真实的视频制作OS/package.json');
  }
  if (dataDir !== path.join(osDir, 'data')) throw new Error('正式 data 必须位于正式项目的视频制作OS/data');
  if (!fs.existsSync(dataDir) || !fs.lstatSync(dataDir).isDirectory()) throw new Error('正式 data 目录不存在');
  const expectedApp = path.join(osDir, 'dist', `视频制作 OS-darwin-${options.arch}`, '视频制作 OS.app');
  if (installAppBundle !== expectedApp) throw new Error('正式 App 必须保留项目内标准 dist 安装位置');
  const installedResourceRoot = path.join(installAppBundle, 'Contents', 'Resources', 'app');
  if (path.resolve(installedResourceRoot, MAC_PROJECT_ROOT_FROM_APP) !== projectRoot) {
    throw new Error('正式 App 最终安装位置的七层回溯与项目根目录不一致');
  }
  return { projectRoot, dataDir, installAppBundle };
}

function formalBuildOptions(argv, { arch, appDir = __dirname } = {}) {
  const projectRoot = readArg(argv, '--formal-project-root');
  const dataDir = readArg(argv, '--formal-data-dir');
  const installAppBundle = readArg(argv, '--install-app');
  const target = formalDeploymentTarget({ projectRoot, dataDir, installAppBundle, arch,
    portable: argv.includes('--portable'), candidate: !!readArg(argv, '--candidate-user-data') });
  if (!target) return null;
  const rawOut = readArg(argv, '--out');
  if (!rawOut) throw new Error('正式部署构建必须指定新的独立 --out 目录');
  const out = assertAbsoluteDirectory(rawOut, '正式构建输出目录');
  for (const protectedDir of [path.join(target.projectRoot, '视频制作OS', 'dist'), target.dataDir, path.join(appDir, 'dist')]) {
    if (isWithin(protectedDir, out) || isWithin(out, protectedDir)) throw new Error('正式暂存输出不能覆盖或嵌套已有安装/data 目录');
  }
  if (fs.existsSync(out)) throw new Error('正式构建输出必须使用尚不存在的新目录');
  return { ...target, out };
}

function assertFormalRuntimeConfig(config, target) {
  if (!target) {
    if (config.formalInstallApp) throw new Error('带正式部署目标的包必须明确提供 install app 验证参数');
    return;
  }
  if (['candidate', 'candidateId', 'candidateUserData', 'candidateVersion', 'dataLocation'].some(key => key in config)) {
    throw new Error('正式部署包包含 candidate/portable 配置');
  }
  if (config.projectRoot !== target.projectRoot || config.dataDir !== target.dataDir
    || config.formalInstallApp !== target.installAppBundle) throw new Error('已签名的正式部署目标与验证参数不一致');
  if (config.projectRootFromBundle !== MAC_PROJECT_ROOT_FROM_APP) throw new Error('正式部署包缺少七层回溯契约');
}

module.exports = { formalDeploymentTarget, formalBuildOptions, assertFormalRuntimeConfig };
