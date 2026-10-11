'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertCandidateBundle } = require('./verify-candidate-build.cjs');
const { readArg, assertAbsoluteDirectory, isWithin } = require('./candidate-contract.cjs');

const DELIVERY_FILES = Object.freeze(['打开候选版.command', '回到原版1.2.3.command', '使用候选版.md', 'delivery-manifest.json']);

function shellQuote(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('启动器路径不能含换行或空字节');
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function loadCandidateAcceptance(file, verified) {
  const receipt = assertAbsoluteDirectory(file, '候选实际启动回执');
  if (!fs.lstatSync(receipt).isFile()) throw new Error('候选实际启动回执不是文件');
  const result = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (result.status !== 'passed' || result.version !== verified.candidateVersion
    || result.runtime?.version !== verified.candidateVersion || result.runtime?.userData !== verified.candidateUserData
    || result.runtime?.projectRoot !== verified.candidateWorkspace || result.runtime?.candidateListenerConfirmed !== true) {
    throw new Error('候选实际启动回执必须与交付版本、工作区和监听进程一致且通过');
  }
  return { file: receipt, result };
}

function localStateDescription(state = {}) {
  const keys = ['projects', 'imageTemplates', 'videoTemplates', 'scriptGroups', 'scriptSegments'];
  if (keys.some(key => !Number.isSafeInteger(state[key]) || state[key] < 0)) return '本轮回执未记录完整的模板与剧本数量。';
  return `本轮实际读回 ${state.projects} 个项目、${state.imageTemplates + state.videoTemplates} 个模板、${state.scriptGroups} 组共 ${state.scriptSegments} 段剧本文本。`;
}

function assertDeliveryLayout(out, candidateApp, userData) {
  if (!isWithin(out, candidateApp) || isWithin(out, userData) || isWithin(userData, out)) {
    throw new Error('交付目录必须包含候选 App，且与个人 profile 互不嵌套');
  }
}

function assertFreshDeliveryFiles(out) {
  for (const name of DELIVERY_FILES) if (fs.existsSync(path.join(out, name))) throw new Error(`交付文件已存在，拒绝覆盖：${name}`);
}

function writeDelivery(options = {}) {
  const out = assertAbsoluteDirectory(options.out, '交付目录');
  const formalApp = assertAbsoluteDirectory(options.originalApp, '原版 App');
  const backup = path.resolve(options.originalBackup || '');
  if (!options.originalBackup || !fs.lstatSync(backup).isFile() || fs.lstatSync(backup).isSymbolicLink()) throw new Error('缺少原版 App 备份 ZIP');
  const backupHash = crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
  if (backupHash !== options.originalBackupHash) throw new Error('原版 App 备份 SHA-256 与基线不一致');
  const plist = path.join(formalApp, 'Contents', 'Info.plist');
  const version = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  if (version !== '1.2.3') throw new Error('回退入口必须指向保留的原版 1.2.3');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', formalApp], { stdio: 'pipe' });
  const verified = assertCandidateBundle(options);
  assertDeliveryLayout(out, verified.appBundle, verified.candidateUserData);
  assertFreshDeliveryFiles(out);
  const accepted = loadCandidateAcceptance(options.acceptanceFile, verified);
  const releaseNote = options.releaseNote || '沿用现有候选工作区，不重新复制正式素材或覆盖候选 profile。';
  const candidateScript = `#!/bin/zsh\nset -euo pipefail\ncandidate_app=${shellQuote(verified.appBundle)}\nif [[ ! -d "$candidate_app" ]]; then\n  echo "候选 App 已移动，请重新生成候选入口。"\n  exit 1\nfi\n/usr/bin/codesign --verify --deep --strict "$candidate_app"\n/usr/bin/open -n "$candidate_app"\necho "候选 ${verified.candidateVersion} 已打开，新增创作保存在独立候选工作区。"\n`;
  const rollbackScript = `#!/bin/zsh\nset -euo pipefail\nformal_app=${shellQuote(formalApp)}\nif [[ ! -d "$formal_app" ]]; then\n  echo "保留的原版 App 不存在，已停止。请检查原版备份。"\n  exit 1\nfi\nformal_version=$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$formal_app/Contents/Info.plist")\nif [[ "$formal_version" != "1.2.3" ]]; then\n  echo "该路径不再是保留的原版 1.2.3，已停止。"\n  exit 1\nfi\n/usr/bin/codesign --verify --deep --strict "$formal_app"\n/usr/bin/open "$formal_app"\necho "已打开原版 1.2.3。原版继续使用正式数据；候选新增素材仍保留在候选工作区。"\necho "若要把候选新增素材用于原版，请显式合并素材，不要用旧 data 备份覆盖正式数据。"\n`;
  fs.mkdirSync(out, { recursive: true });
  for (const [name, script] of [['打开候选版.command', candidateScript], ['回到原版1.2.3.command', rollbackScript]]) {
    fs.writeFileSync(path.join(out, name), script, { mode: 0o755 });
    fs.chmodSync(path.join(out, name), 0o755);
  }
  const instructions = `# 视频制作 OS 候选 ${verified.candidateVersion}\n\n直接双击“打开候选版.command”，或双击候选 App 即可使用，无需安装 Node.js、配置源码或手动设置工作区。候选带隔离提示，使用独立工作区；原版 1.2.3 可同时保留。此包只供当前 Mac 本地使用，入口和素材工作区固定在现有位置，请保留这些目录。\n\n${releaseNote}\n\n候选工作区：\n\n\`${verified.candidateWorkspace}\`\n\n候选素材是正式素材的 APFS 独立副本。候选中的创建、改名、移动与删除只影响候选副本。本轮沿用既有候选 profile 和创作数据，不重建工作区或重做正式数据快照。最初复制默认工作台 Local Storage 时原 App 正在运行，快照一致性没有保证；${localStateDescription(accepted.result.localState)}这不代表活跃原 profile 的逐项完整快照。网页登录起初未复制；若已有候选登录，它留在现有候选 profile 中，不触碰正式登录。\n\n需要回到原版时，双击“回到原版1.2.3.command”。该入口只打开保留的原程序，不恢复旧 data、不删除候选数据。原版继续使用原有正式素材和最新数据；候选新增素材继续留在上述候选工作区，后续合并需要明确处理。退出候选前请等候选导入或保存完成。上一试用版 App 和 ZIP 另行保留；rc.1 与 rc.2 共用同一候选 profile，不应同时运行，回到旧候选程序不会恢复旧数据。\n\n原版 App：\n\n\`${formalApp}\`\n\n实际原版 App 1.2.3 完整备份：\n\n\`${backup}\`\n\n备份 SHA-256：\`${backupHash}\`。该 ZIP 已解包核对严格签名和 114 个运行资源，可恢复程序本体。\n\n源码基线是提交 \`217ce8558d112dfcc2bb4464d0e98c0cc2cc2bab\`，标签 \`rollback/asset-workflow-before-20261009\`；源码可能比现用 App 包新，二者不是同一基线。回到原版不需要检出源码，也不恢复开工前数据。\n\n实际候选 ${verified.candidateVersion} 已验证独立 userData、工作区和数据目录，页面端口属于候选进程。实际启动回执：\`${accepted.file}\`。原生拖拽回执不代表剪映已真实接收文件，网页登录仍需用户实际使用确认。未上传 GitHub。\n`;
  fs.writeFileSync(path.join(out, '使用候选版.md'), instructions);
  const manifest = { schemaVersion: 1, deliveredAt: new Date().toISOString(), candidateVersion: verified.candidateVersion,
    candidateId: verified.candidateId, candidateApp: verified.appBundle, candidateUserData: verified.candidateUserData,
    candidateWorkspace: verified.candidateWorkspace, nativeAcceptance: accepted.file, releaseNote,
    originalApp: formalApp, originalAppVersion: version,
    originalAppBackup: backup, originalAppBackupSha256: backupHash,
    sourceBaselineCommit: '217ce8558d112dfcc2bb4464d0e98c0cc2cc2bab', sourceBaselineTag: 'rollback/asset-workflow-before-20261009',
    sourceBaselineEquivalentToOriginalApp: false, rollbackRestoresOldData: false,
    candidateDataMerged: false, releaseUploaded: false };
  fs.writeFileSync(path.join(out, 'delivery-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    const result = writeDelivery({ out: readArg(argv, '--out'), appBundle: readArg(argv, '--app'),
      candidateUserData: readArg(argv, '--candidate-user-data'), arch: readArg(argv, '--arch') || process.arch,
      originalApp: readArg(argv, '--original-app'), originalBackup: readArg(argv, '--original-backup'),
      originalBackupHash: readArg(argv, '--original-backup-hash'), acceptanceFile: readArg(argv, '--acceptance-file'),
      releaseNote: readArg(argv, '--release-note') });
    console.log(`CANDIDATE_DELIVERY_READY version=${result.candidateVersion} original=${result.originalAppVersion} rollbackRestoresOldData=false`);
  } catch (error) { console.error(`CANDIDATE_DELIVERY_FAIL ${error.message}`); process.exitCode = 1; }
}

module.exports = { DELIVERY_FILES, shellQuote, loadCandidateAcceptance, localStateDescription,
  assertDeliveryLayout, assertFreshDeliveryFiles, writeDelivery };
