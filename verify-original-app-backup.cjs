'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safeRelative } = require('./verify-build-manifest.cjs');
const { readArg, assertAbsoluteDirectory } = require('./candidate-contract.cjs');

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function verifyOriginalAppBackup(options = {}) {
  const archive = path.resolve(options.archive || '');
  if (!options.archive || !fs.lstatSync(archive).isFile() || fs.lstatSync(archive).isSymbolicLink()) throw new Error('原版 App 备份必须是普通 ZIP 文件');
  if (hash(archive) !== options.sha256) throw new Error('原版 ZIP 校验和与固定基线不一致');
  const out = assertAbsoluteDirectory(options.out, '恢复验证目录');
  if (fs.existsSync(out)) throw new Error('恢复验证目录必须使用尚不存在的新路径');
  fs.mkdirSync(out, { recursive: true });
  execFileSync('/usr/bin/ditto', ['-x', '-k', archive, out], { stdio: 'pipe' });
  const bundles = [];
  function findBundles(directory, depth = 0) {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.name.endsWith('.app')) bundles.push(absolute);
      else findBundles(absolute, depth + 1);
    }
  }
  findBundles(out);
  if (bundles.length !== 1) throw new Error('原版 ZIP 必须包含唯一完整 App');
  const appBundle = bundles[0];
  const plist = path.join(appBundle, 'Contents/Info.plist');
  const version = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  const expectedVersion = options.expectedVersion || '1.2.3';
  if (version !== expectedVersion) throw new Error(`原版 App 备份版本不是 ${expectedVersion}`);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'pipe' });
  const appRoot = path.join(appBundle, 'Contents/Resources/app');
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'build-manifest.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(appRoot, 'runtime-config.json'), 'utf8'));
  if (JSON.stringify(config) !== JSON.stringify(manifest.runtimeConfig)) throw new Error('原版包的运行契约与内嵌manifest不一致');
  if (fs.existsSync(path.join(appRoot, 'data'))) throw new Error('原版 App 备份中不应包含个人data');
  const entries = Object.entries(manifest.sourceHashes || {});
  if (!entries.length) throw new Error('原版 App 缺少已签名的源码哈希清单');
  for (const [relative, expected] of entries) {
    if (!safeRelative(relative)) throw new Error('原版manifest包含越界路径');
    const file = path.join(appRoot, relative);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || hash(file) !== expected) throw new Error(`原版备份资源校验失败：${relative}`);
  }
  const result = { verifiedAt: new Date().toISOString(), archive, archiveSha256: options.sha256,
    restoredApp: appBundle, version, checkedResources: entries.length, signature: 'strict deep verified',
    runtimeConfigSelfConsistent: true, sourceBaselineEquivalenceClaimed: false, launched: false, formalAppReplaced: false,
    extractedCopyRetained: options.keepExtracted === true };
  if (!options.keepExtracted) fs.rmSync(appBundle, { recursive: true });
  fs.writeFileSync(path.join(out, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    const result = verifyOriginalAppBackup({ archive: readArg(argv, '--backup'), sha256: readArg(argv, '--sha256'), out: readArg(argv, '--out'), expectedVersion: readArg(argv, '--expected-version'), keepExtracted: argv.includes('--keep-extracted') });
    console.log(`ORIGINAL_APP_BACKUP_RESTORE_PASS version=${result.version} resources=${result.checkedResources} strictSignature=true formalAppReplaced=false`);
  } catch (error) { console.error(`ORIGINAL_APP_BACKUP_RESTORE_FAIL ${error.message}`); process.exitCode = 1; }
}

module.exports = { verifyOriginalAppBackup };
