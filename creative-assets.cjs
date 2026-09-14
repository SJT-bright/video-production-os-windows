'use strict';

const fs = require('fs');
const path = require('path');

const TYPE_EXTENSIONS = Object.freeze({
  image: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']),
  audio: new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.amr', '.ape']),
  video: new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']),
  document: new Set(['.pdf', '.md', '.txt', '.srt', '.json']),
});

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function isWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeRelativePath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > 1024) return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized) return allowRoot ? '' : null;
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  return parts.join('/');
}

function ensureCreativeAssetRoot(root) {
  const resolved = path.resolve(String(root || ''));
  if (!root || resolved === path.parse(resolved).root) throw new Error('创作资产库目录无效');
  const parent = path.dirname(resolved);
  const realParent = fs.realpathSync(parent);
  if (fs.existsSync(resolved)) {
    const rootStat = fs.lstatSync(resolved);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('创作资产库根目录不能是符号链接或普通文件');
  } else {
    fs.mkdirSync(resolved);
  }
  const realRoot = fs.realpathSync(resolved);
  if (path.resolve(path.dirname(realRoot)) !== path.resolve(realParent)) {
    throw new Error('创作资产库真实路径必须是项目根目录的直接子目录');
  }
  return realRoot;
}

function hasSymlinkSegment(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  if (!relative) return false;
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function resolveCreativeAsset(root, relativePath, kind = 'file') {
  const realRoot = ensureCreativeAssetRoot(root);
  const normalized = normalizeRelativePath(String(relativePath || ''), { allowRoot: kind === 'folder' });
  if (normalized === null) return null;
  const candidate = normalized ? path.resolve(realRoot, ...normalized.split('/')) : realRoot;
  if (!isWithin(realRoot, candidate) || hasSymlinkSegment(realRoot, candidate)) return null;
  try {
    const stat = fs.statSync(candidate);
    if (kind === 'file' && !stat.isFile()) return null;
    if (kind === 'folder' && !stat.isDirectory()) return null;
    const real = fs.realpathSync(candidate);
    if (!isWithin(realRoot, real)) return null;
    return { abs: real, rel: normalized, stat };
  } catch {
    return null;
  }
}

function classifyCreativeAsset(filenameOrExtension) {
  const value = String(filenameOrExtension || '').toLowerCase();
  const ext = value.startsWith('.') && !value.includes('/') && !value.includes('\\')
    ? value
    : path.extname(value);
  for (const [type, extensions] of Object.entries(TYPE_EXTENSIONS)) {
    if (extensions.has(ext)) return type;
  }
  return null;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function buildCreativeAssetTree(root, { maxEntries = 20000, scopePath = '', includeFile = null } = {}) {
  const realRoot = ensureCreativeAssetRoot(root);
  const normalizedScope = normalizeRelativePath(String(scopePath || ''), { allowRoot: true });
  if (normalizedScope === null) throw new Error('创作资产范围无效');
  const scope = normalizedScope
    ? resolveCreativeAsset(realRoot, normalizedScope, 'folder')
    : { abs: realRoot, rel: '', stat: fs.statSync(realRoot) };
  if (!scope) throw new Error('创作资产范围不存在');
  const stats = { folders: 0, files: 0, image: 0, audio: 0, video: 0, document: 0, other: 0, bytes: 0 };
  let remaining = Math.max(1, Number(maxEntries) || 20000);
  let truncated = false;

  const walk = (absoluteFolder, relativeFolder) => {
    const children = [];
    let entries = [];
    try { entries = fs.readdirSync(absoluteFolder, { withFileTypes: true }); } catch { return { children, fileCount: 0 }; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'));
    let fileCount = 0;
    for (const entry of entries) {
      if (remaining <= 0) { truncated = true; break; }
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const childRelative = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name;
      const childAbsolute = path.join(absoluteFolder, entry.name);
      if (entry.isDirectory()) {
        remaining--;
        stats.folders++;
        const nested = walk(childAbsolute, childRelative);
        fileCount += nested.fileCount;
        children.push({
          kind: 'folder', name: entry.name, path: childRelative,
          fileCount: nested.fileCount, children: nested.children,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      const type = classifyCreativeAsset(entry.name) || 'other';
      let stat;
      try { stat = fs.statSync(childAbsolute); } catch { continue; }
      remaining--;
      if (includeFile && !includeFile(childRelative, stat, type)) continue;
      fileCount++;
      stats.files++;
      stats[type]++;
      stats.bytes += stat.size;
      children.push({
        kind: 'file', name: entry.name, path: childRelative,
        ext: path.extname(entry.name).toLowerCase(), type,
        size: stat.size, sizeText: formatBytes(stat.size), mtime: stat.mtime.toISOString(),
      });
    }
    return { children, fileCount };
  };

  const rootNode = walk(scope.abs, scope.rel);
  const rootName = scope.rel ? path.basename(scope.rel) : path.basename(realRoot);
  return {
    available: true,
    rootName,
    scopePath: scope.rel,
    stats: { ...stats, sizeText: formatBytes(stats.bytes) },
    truncated,
    tree: {
      kind: 'folder', name: rootName, path: scope.rel,
      fileCount: rootNode.fileCount, children: rootNode.children,
    },
  };
}

function validateFolderName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 80) throw new Error('文件夹名称应为 1—80 个字符');
  if (name.startsWith('.') || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || WINDOWS_RESERVED_NAMES.test(name)) {
    throw new Error('文件夹名称包含系统不支持的字符');
  }
  return name;
}

function createCreativeAssetFolder(root, parentPath, requestedName) {
  const realRoot = ensureCreativeAssetRoot(root);
  const parent = resolveCreativeAsset(realRoot, String(parentPath || ''), 'folder');
  if (!parent) throw new Error('上级文件夹不存在或不在创作资产库内');
  const name = validateFolderName(requestedName);
  const target = path.join(parent.abs, name);
  if (!isWithin(realRoot, target)) throw new Error('文件夹路径无效');
  try { fs.mkdirSync(target); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('同名文件夹已经存在');
    throw error;
  }
  return {
    name,
    path: parent.rel ? `${parent.rel}/${name}` : name,
  };
}

module.exports = {
  TYPE_EXTENSIONS,
  buildCreativeAssetTree,
  classifyCreativeAsset,
  createCreativeAssetFolder,
  ensureCreativeAssetRoot,
  normalizeRelativePath,
  resolveCreativeAsset,
  validateFolderName,
};
