'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SOURCE_FILES, SOURCE_DIRS, BUILD_SCHEMA_VERSION } = require('./build-contract.cjs');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeRelative(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && !value.split(/[\\/]+/).includes('..');
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function verifiedFile(root, relativePath, label) {
  if (!safeRelative(relativePath)) throw new Error(`${label}包含不安全路径：${relativePath}`);
  const absolutePath = path.resolve(root, relativePath);
  if (!isWithin(root, absolutePath)) throw new Error(`${label}越出了预期目录：${relativePath}`);
  let stat;
  try { stat = fs.lstatSync(absolutePath); }
  catch { throw new Error(`${label}缺少文件：${relativePath}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}不是安全的普通文件：${relativePath}`);
  return absolutePath;
}

// This intentionally expands the contract independently of either platform builder.
// A package manifest is evidence to verify, never the source of truth for completeness.
function collectExpectedSourceFiles(sourceRoot) {
  const files = [];
  const collect = relativePath => {
    if (!safeRelative(relativePath)) throw new Error(`构建合同包含不安全路径：${relativePath}`);
    const absolutePath = path.resolve(sourceRoot, relativePath);
    if (!isWithin(sourceRoot, absolutePath)) throw new Error(`构建合同越出源码目录：${relativePath}`);
    let stat;
    try { stat = fs.lstatSync(absolutePath); }
    catch { throw new Error(`构建合同声明的源码缺失：${relativePath}`); }
    if (stat.isSymbolicLink()) throw new Error(`构建合同不允许符号链接：${relativePath}`);
    if (stat.isFile()) {
      files.push(relativePath.replace(/\\/g, '/'));
      return;
    }
    if (!stat.isDirectory()) throw new Error(`构建合同包含未知节点：${relativePath}`);
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      collect(path.join(relativePath, entry.name));
    }
  };
  for (const file of SOURCE_FILES) collect(file);
  for (const directory of SOURCE_DIRS) collect(directory);
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function assertExactKeySet(expected, actual) {
  const actualSet = new Set(actual);
  const missing = expected.filter(key => !actualSet.has(key));
  const unexpected = actual.filter(key => !expected.includes(key));
  if (missing.length || unexpected.length) {
    const describe = values => values.slice(0, 4).join(', ') + (values.length > 4 ? ' …' : '');
    throw new Error(`构建清单文件集合不完整或异常：缺少[${describe(missing)}] 多出[${describe(unexpected)}]`);
  }
}

function verifyPackagedApp(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || '');
  const appRoot = path.resolve(options.appRoot || '');
  const projectRoot = path.resolve(options.projectRoot || '');
  const dataDir = path.resolve(options.dataDir || '');
  if (!sourceRoot || !appRoot || !projectRoot || !dataDir) throw new Error('发行包验证缺少目录契约');
  const manifestPath = path.join(appRoot, 'build-manifest.json');
  const configPath = path.join(appRoot, 'runtime-config.json');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(configPath)) throw new Error('发行包缺少构建清单或运行配置');
  if (fs.existsSync(path.join(appRoot, 'data'))) throw new Error('发行包不应包含实时 data 目录');

  let manifest;
  let runtimeConfig;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    runtimeConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    throw new Error('发行包构建清单或运行配置不是有效 JSON');
  }
  if (manifest.buildSchemaVersion !== BUILD_SCHEMA_VERSION || runtimeConfig.buildSchemaVersion !== BUILD_SCHEMA_VERSION) {
    throw new Error('发行包构建清单版本过旧');
  }
  if (options.platform && manifest.platform !== options.platform) throw new Error('发行包平台与当前验证目标不一致');
  if (options.arch && manifest.arch !== options.arch) throw new Error('发行包架构与当前验证目标不一致');
  if (options.portable) {
    if (runtimeConfig.dataLocation !== 'userData' || runtimeConfig.platform !== 'win32'
      || 'projectRoot' in runtimeConfig || 'dataDir' in runtimeConfig) {
      throw new Error('Windows 下载包必须使用用户目录，不得包含构建机路径');
    }
  } else {
    if (path.resolve(runtimeConfig.projectRoot || '') !== projectRoot) throw new Error('发行包项目根目录与当前项目不一致');
    if (path.resolve(runtimeConfig.dataDir || '') !== dataDir) throw new Error('发行包没有指向唯一权威 data 目录');
  }
  if (typeof options.compatibilityMode === 'boolean' && runtimeConfig.compatibilityMode !== options.compatibilityMode) {
    throw new Error('发行包兼容模式与平台契约不一致');
  }
  if (JSON.stringify(manifest.runtimeConfig) !== JSON.stringify(runtimeConfig)) {
    throw new Error('发行包内嵌运行配置与独立运行配置不一致');
  }

  const hashes = manifest.sourceHashes;
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) throw new Error('发行包构建清单缺少源码哈希');
  const expectedFiles = collectExpectedSourceFiles(sourceRoot);
  const manifestFiles = Object.keys(hashes).sort((left, right) => left.localeCompare(right));
  assertExactKeySet(expectedFiles, manifestFiles);
  for (const relativePath of expectedFiles) {
    const expectedHash = hashes[relativePath];
    if (!/^[a-f0-9]{64}$/i.test(expectedHash || '')) throw new Error(`发行包构建清单哈希格式无效：${relativePath}`);
    const sourcePath = verifiedFile(sourceRoot, relativePath, '源码');
    const packagedPath = verifiedFile(appRoot, relativePath, '发行包');
    if (sha256(sourcePath) !== expectedHash || sha256(packagedPath) !== expectedHash) {
      throw new Error(`发行包已过期：${relativePath}`);
    }
  }
  return { manifest, runtimeConfig, checkedFiles: expectedFiles.length, expectedFiles };
}

module.exports = { verifyPackagedApp, collectExpectedSourceFiles, safeRelative };
