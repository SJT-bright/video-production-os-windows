'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCreativeAsset } = require('../creative-assets.cjs');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg', '.heic', '.heif', '.tif', '.tiff', '.ico', '.psd', '.dng', '.cr2']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.mpeg', '.mpg', '.wmv', '.flv', '.3gp', '.ogv', '.m2ts', '.mts']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.amr', '.ape']);
const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
// Keep below the common 255-byte POSIX component limit so multibyte titles do
// not fail at the final filesystem write with ENAMETOOLONG.
const MAX_FILENAME_BYTES = 240;

function classifyDownload({ filename = '', mimeType = '', mode = 'video', serviceId = '' } = {}) {
  const ext = path.extname(String(filename)).toLowerCase();
  const mime = String(mimeType).toLowerCase();
  if (mime.startsWith('image/') || IMAGE_EXTS.has(ext)) return 'image';
  if (mime.startsWith('video/') || VIDEO_EXTS.has(ext)) return 'video';
  if (mime.startsWith('audio/') || AUDIO_EXTS.has(ext)) return 'audio';
  return 'file';
}

function sanitizeFilename(filename, now = new Date()) {
  // Download suggestions may contain paths from a different operating system.
  // Treat both slash styles as separators before producing a local filename.
  const suggestedLeaf = path.posix.basename(String(filename || '').replace(/\\/g, '/'));
  let safe = suggestedLeaf.replace(INVALID_FILENAME, '_').replace(/[. ]+$/g, '').trim();
  if (!safe) {
    const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    safe = `download-${stamp}`;
  } else if (WINDOWS_RESERVED.test(safe)) {
    safe = `_${safe}`;
  }
  if (safe.length <= 180 && Buffer.byteLength(safe, 'utf8') <= MAX_FILENAME_BYTES) return safe;
  const parsed = path.parse(safe);
  const truncateUtf8 = (value, maxBytes, maxCharacters = Infinity) => {
    let result = '';
    let characters = 0;
    for (const character of value) {
      if (characters >= maxCharacters || Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
      result += character;
      characters++;
    }
    return result;
  };
  const extension = truncateUtf8(parsed.ext.slice(0, 20), 40);
  const baseBudget = Math.max(1, MAX_FILENAME_BYTES - Buffer.byteLength(extension, 'utf8'));
  return `${truncateUtf8(parsed.name, baseBudget, Math.max(1, 180 - extension.length))}${extension}`;
}

function dateFolder(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function uniquePath(targetPath, exists = fs.existsSync) {
  if (!exists(targetPath)) return targetPath;
  const parsed = path.parse(targetPath);
  for (let index = 2; index < 10000; index++) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error('同名下载文件过多，无法生成安全文件名');
}

function resolveDownloadTarget({
  projectRoot,
  obsidianVault,
  serviceId,
  serviceLabel,
  mode,
  filename,
  mimeType,
  projectDirectories,
  videoDisposition = '',
  now = new Date(),
  exists,
}) {
  if (!projectRoot) throw new Error('项目下载目录尚未连接');
  const kind = classifyDownload({ filename, mimeType, mode, serviceId });
  if (kind === 'video' && videoDisposition && !['editable', 'processing'].includes(videoDisposition)) throw new Error('视频下载分类无效');
  const platformFolder = sanitizeFilename(serviceLabel || serviceId || '其他平台', now);
  const day = dateFolder(now);
  const isImage = kind === 'image';
  const scopedDirectories = projectDirectories && typeof projectDirectories === 'object' ? projectDirectories : null;
  const directoryKey = kind === 'file' ? 'downloads' : kind;
  if (scopedDirectories && !scopedDirectories[directoryKey]) throw new Error('目标分类已删除或不可用，请先恢复文件夹或选择其他分类');
  if (isImage && !scopedDirectories?.image && !obsidianVault) throw new Error('图片归档目录尚未连接');
  if (kind === 'file' && scopedDirectories && !scopedDirectories.downloads) throw new Error('下载目录尚未连接');
  const base = kind === 'file'
    ? (scopedDirectories?.downloads || path.join(projectRoot, '素材库', '浏览器下载'))
    : isImage
      ? (scopedDirectories?.image || path.join(obsidianVault, 'ai创作短剧', '韩剧制作', '浏览器生成'))
      : kind === 'audio'
        ? (scopedDirectories?.audio || path.join(projectRoot, '素材库', '浏览器生成'))
        : (scopedDirectories?.video || path.join(projectRoot, '素材库', '浏览器生成'));
  // New project video imports share a material folder across dates. Old dated
  // directories and recovery journal paths remain valid and are not migrated.
  const group = kind === 'video' && scopedDirectories ? '素材001' : day;
  const directory = kind === 'video' && videoDisposition
    ? path.join(base, videoDisposition === 'editable' ? '可剪辑' : '待处理', platformFolder, group)
    : path.join(base, platformFolder, group);
  const safeName = sanitizeFilename(filename, now);
  const targetPath = uniquePath(path.join(directory, safeName), exists);
  return { kind, directory, targetPath, isImage, projectScoped: !!scopedDirectories };
}

async function deleteBrowserDownloadFile({ libraryRoot, downloadsRoot, relativePath }) {
  const entry = resolveCreativeAsset(libraryRoot, relativePath, 'file');
  if (!entry || !entry.stat.isFile()) throw new Error('下载文件不存在');
  const root = fs.realpathSync(downloadsRoot);
  const within = path.relative(root, entry.abs);
  if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error('只能永久删除当前剧本的浏览器下载文件');
  }
  if (classifyDownload({ filename: path.basename(entry.abs) }) !== 'file') {
    throw new Error('图片、视频和音频不属于浏览器下载文件');
  }
  await fs.promises.unlink(entry.abs);
  return entry.abs;
}

module.exports = {
  classifyDownload,
  sanitizeFilename,
  dateFolder,
  uniquePath,
  resolveDownloadTarget,
  deleteBrowserDownloadFile,
};
