'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CANDIDATE_ID = 'asset-workflow-20261009';
const DEFAULT_CANDIDATE_VERSION = '1.3.0-rc.2';
const CANDIDATE_BUNDLE_PREFIX = 'local.video-production-os.candidate.';

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return '';
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数`);
  return value;
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label}必须是绝对路径`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) throw new Error(`${label}不能使用磁盘根目录或个人主目录`);
  let cursor = resolved;
  while (cursor !== path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`${label}不能经过符号链接`);
    cursor = path.dirname(cursor);
  }
  return resolved;
}

function candidateBuildOptions(argv = process.argv.slice(2), appDir = __dirname) {
  const rawProfile = readArg(argv, '--candidate-user-data');
  if (!rawProfile) return null;
  const userData = assertAbsoluteDirectory(rawProfile, '候选 userData');
  const rawOut = readArg(argv, '--out');
  if (!rawOut) throw new Error('候选构建必须明确指定独立 --out 目录');
  const out = assertAbsoluteDirectory(rawOut, '候选输出目录');
  if (isWithin(path.join(appDir, 'dist'), out)) throw new Error('候选构建不能覆盖常规 dist 目录');
  const formalProfile = path.join(os.homedir(), 'Library', 'Application Support', '视频制作 OS');
  if (isWithin(formalProfile, userData) || isWithin(userData, formalProfile)) throw new Error('候选 userData 必须与正式浏览器配置分离');
  if (isWithin(userData, out) || isWithin(out, userData)) throw new Error('候选 App 输出与 userData 必须是互不嵌套的目录');
  const id = readArg(argv, '--candidate-id') || DEFAULT_CANDIDATE_ID;
  if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(id)) throw new Error('候选标识只能包含小写字母、数字、点和短横线');
  const version = readArg(argv, '--version') || DEFAULT_CANDIDATE_VERSION;
  if (!/^\d+\.\d+\.\d+-[a-z0-9.-]+$/i.test(version)) throw new Error('候选版本必须带 prerelease 后缀');
  return { id, version, userData, out, bundleId: `${CANDIDATE_BUNDLE_PREFIX}${id}` };
}

module.exports = { DEFAULT_CANDIDATE_ID, DEFAULT_CANDIDATE_VERSION, CANDIDATE_BUNDLE_PREFIX,
  readArg, isWithin, assertAbsoluteDirectory, candidateBuildOptions };
