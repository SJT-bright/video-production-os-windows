'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
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
  episode = 1,
  platformFolder: savedPlatformFolder = '',
  legacyDay = '',
  now = new Date(),
  exists,
}) {
  if (!projectRoot) throw new Error('项目下载目录尚未连接');
  const kind = classifyDownload({ filename, mimeType, mode, serviceId });
  if (kind === 'video' && videoDisposition && !['editable', 'processing'].includes(videoDisposition)) throw new Error('视频下载分类无效');
  const platformFolder = savedPlatformFolder || sanitizeFilename(serviceLabel || serviceId || '其他平台', now);
  if (platformFolder !== sanitizeFilename(platformFolder, now) || platformFolder.startsWith('.')) throw new Error('下载网站文件夹名称无效');
  if (kind !== 'file' && (!Number.isSafeInteger(episode) || episode < 1 || episode > 999999)) throw new Error('下载集号无效');
  if (legacyDay && !/^\d{4}-\d{2}-\d{2}$/.test(legacyDay)) throw new Error('旧下载日期目录无效');
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
  const episodeFolder = kind === 'file' ? '' : `第${episode}集`;
  const dispositionFolder = videoDisposition === 'editable' ? '可剪辑' : '待处理';
  // Only unfinished downloads from an older journal retain a dated target.
  // New media is website / episode; documents stay directly under website.
  const directory = legacyDay
    ? (kind === 'video' && videoDisposition
      ? path.join(base, dispositionFolder, platformFolder, legacyDay)
      : path.join(base, platformFolder, legacyDay))
    : (kind === 'video' && videoDisposition
      ? path.join(base, platformFolder, episodeFolder, dispositionFolder)
      : path.join(base, platformFolder, episodeFolder));
  const safeName = sanitizeFilename(filename, now);
  const targetPath = uniquePath(path.join(directory, safeName), exists);
  return { kind, directory, targetPath, isImage, projectScoped: !!scopedDirectories,
    platformFolder, episode: kind === 'file' || legacyDay ? null : episode, episodeLabel: legacyDay ? '' : episodeFolder };
}

function inspectBrowserDownload({ libraryRoot, downloadsRoot, relativePath }) {
  const entry = resolveCreativeAsset(libraryRoot, relativePath, 'file');
  if (!entry || !entry.stat.isFile()) throw new Error('下载文件不存在');
  // Match the asset resolver's native spelling, including Windows TEMP's
  // short-name aliases, before checking the selected project's boundary.
  const root = fs.realpathSync.native(downloadsRoot);
  const within = path.relative(root, entry.abs);
  if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error('只能永久删除当前剧本的浏览器下载文件');
  }
  if (classifyDownload({ filename: path.basename(entry.abs) }) !== 'file') {
    throw new Error('图片、视频和音频不属于浏览器下载文件');
  }
  return entry;
}

const downloadIdentity = entry => [entry.abs, entry.stat.dev, entry.stat.ino, entry.stat.size, entry.stat.mtimeMs, entry.stat.ctimeMs].join(':');
async function deleteBrowserDownloadFile(options) {
  const entry = inspectBrowserDownload(options);
  if (options.expectedIdentity && downloadIdentity(entry) !== options.expectedIdentity) throw new Error('确认期间文件已变更，未执行删除');
  await fs.promises.unlink(entry.abs);
  return entry.abs;
}

// Independent consent for permanent download deletion; never shares the Trash grant.
function createBrowserDownloadDeletion({ libraryRoot, getContext, now = () => performance.now() }) {
  let grant = null, busy = false;
  const key = context => JSON.stringify([context.projectId, context.folder, context.downloadsRoot, context.epoch]);
  return async function remove(relativePath, { confirm, isAlive = () => true } = {}) {
    if (busy) throw new Error('已有下载删除正在执行，请稍后');
    busy = true;
    try {
      const context = getContext(), scope = key(context);
      if (!context.projectId || !context.downloadsRoot || !isAlive()) throw new Error('剧本或窗口已切换，未执行删除');
      const options = { libraryRoot, downloadsRoot: context.downloadsRoot, relativePath };
      const baseline = downloadIdentity(inspectBrowserDownload(options));
      const current = () => isAlive() && key(getContext()) === scope;
      const time = now();
      if (grant && (!grant.isAlive() || grant.scope !== scope || !Number.isFinite(time)
        || time < grant.start || time >= grant.end)) grant = null;
      if (!grant) {
        const result = await confirm({ name: path.basename(relativePath) });
        if (result?.approved !== true) return false;
        if (!current()) throw new Error('剧本或窗口已切换，未执行删除');
        // Revalidate before arming the grant, including replacement during the dialog.
        if (downloadIdentity(inspectBrowserDownload(options)) !== baseline) throw new Error('确认期间文件已变更，未执行删除');
        const start = now();
        if (result.skipConfirmationForFiveMinutes === true && Number.isFinite(start))
          grant = { scope, start, end: start + 5 * 60 * 1000, isAlive };
      }
      if (!current()) throw new Error('剧本或窗口已切换，未执行删除');
      return await deleteBrowserDownloadFile({ ...options, expectedIdentity: baseline });
    } finally { busy = false; }
  };
}

module.exports = {
  classifyDownload,
  sanitizeFilename,
  dateFolder,
  uniquePath,
  resolveDownloadTarget,
  deleteBrowserDownloadFile,
  createBrowserDownloadDeletion,
};
