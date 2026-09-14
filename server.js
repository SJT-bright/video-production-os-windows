/**
 * 视频制作 OS — 本地服务器（零第三方运行时依赖；制作台账需要 Node >= 22.5）
 * 用法：node server.js [--open] [--port 3750]
 * 功能：
 *   - 托管 OS 界面静态文件
 *   - /api/scan   扫描项目素材库与用户授权目录中的媒体，并独立汇总项目知识文档
 *   - /api/file   按安全索引 token 读取媒体（支持 Range，用于视频拖动播放）
 *   - /api/doc    读取 Markdown 文档原文
 *   - /api/obsidian/tree  只读镜像当前 Obsidian Vault 的目录层级
 *   - /api/obsidian/note  读取并展示 Obsidian Markdown 笔记
 *   - /api/obsidian/file  读取笔记中的媒体附件
 *   - /api/creative-assets  管理按剧本分层的图片、音频、视频与文档资产
 *   - /api/knowledge  GET/POST Agent 经验知识库
 *   - /api/meta   GET/POST 素材标记（收藏 / 成品 / 备注）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { sanitizeFilename, uniquePath, dateFolder } = require('./electron/download-router.cjs');
const {
  buildCreativeAssetTree,
  classifyCreativeAsset,
  createCreativeAssetFolder,
  ensureCreativeAssetRoot,
  normalizeRelativePath,
  resolveCreativeAsset,
} = require('./creative-assets.cjs');
const { ProductionStore } = require('./production-store.cjs');
const { createCreativeProjectStore } = require('./creative-projects.cjs');
const { createEditorExportMonitor } = require('./editor-exports.cjs');
const { createMediaSourceWatcher } = require('./media-source-watch.cjs');
const { createMediaSourceStore, PROJECT_MEDIA_SOURCE_ID } = require('./electron/media-sources.cjs');

const OS_DIR = __dirname;            // .../视频制作OS
const ROOT = process.env.VIDEO_OS_PROJECT_ROOT
  ? path.resolve(process.env.VIDEO_OS_PROJECT_ROOT)
  : path.dirname(OS_DIR);             // 项目根 D:\青春校园短剧
const ASSET_DIR = path.join(ROOT, '素材库');
const CREATIVE_ASSET_DIR = path.join(ROOT, '创作资产库');
const BUNDLED_DATA_DIR = path.join(OS_DIR, 'data');

function resolveDataDir(configuredPath) {
  const value = String(configuredPath || '').trim();
  if (!value || value.includes('\0')) throw new Error('数据目录配置无效');
  if (process.env.VIDEO_OS_DATA_DIR && !path.isAbsolute(value)) {
    throw new Error('VIDEO_OS_DATA_DIR 必须是绝对路径');
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error('拒绝把磁盘根目录用作数据目录');
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

const DATA_DIR = resolveDataDir(process.env.VIDEO_OS_DATA_DIR || BUNDLED_DATA_DIR);
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'agent-knowledge.json');
const META_FILE = path.join(DATA_DIR, 'asset-meta.json');
const AUDIO_LIBRARY_FILE = path.join(DATA_DIR, 'audio-library.json');
const ANNOTATIONS_FILE = path.join(DATA_DIR, 'doc-annotations.json');
const MEDIA_SOURCE_FILE = path.join(DATA_DIR, 'media-sources.json');
const LIBRARY_SOURCE_FILE = path.join(DATA_DIR, 'library-sources.json');
const LIBRARY_LINK_FILE = path.join(DATA_DIR, 'library-links.json');
const CREATIVE_PROJECT_FILE = path.join(DATA_DIR, 'creative-projects.json');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_IMPORT_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_CREATIVE_ASSET_BYTES = Object.freeze({
  image: 1024 * 1024 * 1024,
  audio: 10 * 1024 * 1024 * 1024,
  video: 100 * 1024 * 1024 * 1024,
  document: 512 * 1024 * 1024,
});

const mediaSourceStore = createMediaSourceStore({
  filePath: MEDIA_SOURCE_FILE,
  projectRoot: ROOT,
  projectAssetRoot: ASSET_DIR,
  homeRoot: os.homedir(),
  onWarning: message => console.warn(`[media-sources] ${message}`),
});

const creativeProjectStore = createCreativeProjectStore({
  filePath: CREATIVE_PROJECT_FILE,
  assetRoot: CREATIVE_ASSET_DIR,
  onWarning: message => console.warn(`[creative-projects] ${message}`),
});

const editorExports = createEditorExportMonitor({
  assetRoot: CREATIVE_ASSET_DIR,
  projectStore: creativeProjectStore,
  onChange: () => scheduleCreativeAssetBroadcast(),
});

function readyCreativeAssetTree(options = {}) {
  return buildCreativeAssetTree(CREATIVE_ASSET_DIR, { ...options, includeFile: editorExports.includeFile });
}

let productionStore = null;
let productionStoreError = null;
try {
  productionStore = new ProductionStore({
    dataDir: DATA_DIR,
    defaultProjectId: creativeProjectStore.active()?.id || 'inspiration',
  });
  productionStore.activateProject(creativeProjectStore.active()?.id || 'inspiration');
} catch (error) {
  productionStoreError = error;
  console.error(`制作台账初始化失败，旧素材与知识功能仍可使用：${error.message}`);
}


const DEFAULT_PORT = parseInt(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1] : '3750', 10) || 3750;
const SHOULD_OPEN = process.argv.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
  '.amr': 'audio/amr', '.ape': 'audio/ape',
};

const MEDIA_TYPES = {
  video: ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.amr', '.ape'],
  doc: ['.md', '.txt', '.srt'],
};

// 扫描时跳过的目录（OS 自身、版本库、依赖）
const SKIP_DIRS = new Set([OS_DIR, CREATIVE_ASSET_DIR, path.join(ROOT, '.git'), path.join(ROOT, 'node_modules')]);

const OBSIDIAN_PREVIEW_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus',
  '.mp4', '.mov', '.webm', '.mkv', '.pdf',
]);

function discoverObsidianVault() {
  const explicit = process.env.OBSIDIAN_VAULT_PATH;
  const configFiles = process.platform === 'darwin'
    ? [path.join(process.env.HOME || '', 'Library', 'Application Support', 'obsidian', 'obsidian.json')]
    : [path.join(process.env.APPDATA || '', 'obsidian', 'obsidian.json')];
  const candidates = [];
  if (explicit) candidates.push({ path: explicit, open: true, ts: Number.MAX_SAFE_INTEGER });
  for (const configFile of configFiles) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      Object.values(config.vaults || {}).forEach(vault => candidates.push(vault));
    } catch {}
  }
  candidates.sort((a, b) => Number(!!b.open) - Number(!!a.open) || Number(b.ts || 0) - Number(a.ts || 0));
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.path !== 'string') continue;
    try {
      const real = fs.realpathSync(candidate.path);
      if (fs.statSync(real).isDirectory()) return real;
    } catch {}
  }
  return null;
}

const OBSIDIAN_VAULT = discoverObsidianVault();

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; frame-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'",
};

function isWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function isRealPathWithin(base, target) {
  try {
    return isWithin(fs.realpathSync(base), fs.realpathSync(target));
  } catch {
    return false;
  }
}

function resolveWithin(base, relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0')) return null;
  const normalized = relPath.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return null;
  const baseAbs = path.resolve(base);
  const abs = path.resolve(baseAbs, normalized);
  if (!isWithin(baseAbs, abs)) return null;

  // Lexical checks stop ../ traversal; realpath checks also stop symlinks
  // from escaping the project root.
  let realBase;
  try { realBase = fs.realpathSync(baseAbs); } catch { return null; }
  try {
    if (!isWithin(realBase, fs.realpathSync(abs))) return null;
  } catch (err) {
    if (err.code !== 'ENOENT') return null;
    try {
      if (!isWithin(realBase, fs.realpathSync(path.dirname(abs)))) return null;
    } catch { return null; }
  }
  return abs;
}

function safeJoin(relPath) {
  return resolveWithin(ROOT, relPath);
}

function safeExistingFile(base, relPath) {
  const abs = resolveWithin(base, relPath);
  if (!abs) return null;
  try {
    const stat = fs.statSync(abs);
    return stat.isFile() ? { abs, stat } : null;
  } catch { return null; }
}

function creativeProjectForRequest(url) {
  const requestedId = String(url.searchParams.get('project') || '').trim();
  const active = creativeProjectStore.active();
  if (requestedId && active && requestedId !== active.id) {
    throw httpError('剧本已切换，请刷新当前工作台', 409);
  }
  const project = active;
  if (!project || !project.available) throw httpError('当前剧本不存在或资产目录不可用', 404);
  return project;
}

function requireProjectAssetPath(project, value, { allowProjectRoot = true } = {}) {
  const normalized = normalizeRelativePath(String(value || ''), { allowRoot: false });
  const withinProject = normalized && (normalized === project.folder || normalized.startsWith(`${project.folder}/`));
  if (!withinProject || (!allowProjectRoot && normalized === project.folder)) {
    throw httpError('目标资产不属于当前剧本', 403);
  }
  return normalized;
}

const EXTERNAL_MEDIA_TOKEN_PREFIX = '@media/';
const WORKBENCH_MEDIA_SOURCE_ID = 'creative-assets';

function indexedMediaPath(sourceId, relativePath) {
  if (sourceId === PROJECT_MEDIA_SOURCE_ID) {
    return toPosixRelative(ROOT, path.join(ASSET_DIR, ...relativePath.split('/')));
  }
  return `${EXTERNAL_MEDIA_TOKEN_PREFIX}${sourceId}/${relativePath}`;
}

function mediaKeysForFile(absolutePath) {
  const keys = [];
  for (const source of mediaSourceStore.list()) {
    const root = mediaSourceStore.directory(source.id);
    if (root && isWithin(root, absolutePath)) keys.push(indexedMediaPath(source.id, toPosixRelative(root, absolutePath)));
  }
  const root = fs.realpathSync(CREATIVE_ASSET_DIR);
  if (isWithin(root, absolutePath)) keys.push(indexedMediaPath(WORKBENCH_MEDIA_SOURCE_ID, toPosixRelative(root, absolutePath)));
  return keys;
}

function canonicalMediaPath(mediaPath) {
  const entry = resolveIndexedMedia(mediaPath);
  return entry ? mediaKeysForFile(entry.abs).at(-1) || mediaPath : mediaPath;
}

function resolveIndexedMedia(relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.length > 4096 || relPath.includes('\0')) return null;
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith(EXTERNAL_MEDIA_TOKEN_PREFIX)) {
    const token = normalized.slice(EXTERNAL_MEDIA_TOKEN_PREFIX.length);
    const separator = token.indexOf('/');
    if (separator <= 0) return null;
    const sourceId = token.slice(0, separator);
    const relativePath = token.slice(separator + 1);
    if (sourceId === WORKBENCH_MEDIA_SOURCE_ID) {
      const entry = resolveCreativeAsset(CREATIVE_ASSET_DIR, relativePath, 'file');
      const type = entry && classifyCreativeAsset(entry.rel);
      if (!entry || !['image', 'video', 'audio'].includes(type)) return null;
      return { ...entry, type, sourceId, relativePath: entry.rel };
    }
    const entry = mediaSourceStore.resolveFile(sourceId, relativePath);
    return entry ? { abs: entry.absolutePath, stat: { size: entry.size }, type: entry.type, sourceId, relativePath } : null;
  }
  const entry = safeExistingFile(ROOT, normalized);
  if (!entry || !isRealPathWithin(ASSET_DIR, entry.abs)) return null;
  const type = classify(path.extname(entry.abs).toLowerCase());
  if (!['video', 'audio'].includes(type)) return null;
  return { ...entry, type, sourceId: PROJECT_MEDIA_SOURCE_ID, relativePath: toPosixRelative(ASSET_DIR, entry.abs) };
}

function isVisibleObsidianPath(relPath) {
  if (typeof relPath !== 'string' || relPath.includes('\0')) return false;
  const normalized = relPath.replace(/\\/g, '/');
  return !normalized.split('/').filter(Boolean).some(part => part.startsWith('.'));
}

function toPosixRelative(base, abs) {
  return path.relative(base, abs).split(path.sep).join('/');
}

function buildObsidianTree() {
  if (!OBSIDIAN_VAULT) return { available: false, rootName: '', stats: { folders: 0, files: 0, notes: 0 }, tree: null };
  const stats = { folders: 0, files: 0, notes: 0 };
  const walkTree = (abs, rel) => {
    const children = [];
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return children; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        stats.folders++;
        children.push({ kind: 'folder', name: entry.name, path: childRel, children: walkTree(childAbs, childRel) });
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = fs.statSync(childAbs); } catch { continue; }
      const ext = path.extname(entry.name).toLowerCase();
      stats.files++;
      if (ext === '.md') stats.notes++;
      children.push({
        kind: ext === '.md' ? 'note' : 'file',
        name: entry.name,
        path: childRel,
        ext,
        previewable: OBSIDIAN_PREVIEW_EXTS.has(ext),
        size: stat.size,
        sizeText: fmtSize(stat.size),
        mtime: stat.mtime.toISOString(),
      });
    }
    return children;
  };
  return {
    available: true,
    rootName: path.basename(OBSIDIAN_VAULT),
    stats,
    tree: { kind: 'folder', name: path.basename(OBSIDIAN_VAULT), path: '', children: walkTree(OBSIDIAN_VAULT, '') },
  };
}

function createObsidianFileIndex() {
  const byName = new Map();
  if (!OBSIDIAN_VAULT) return byName;
  const walkFiles = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFiles(abs);
      else if (entry.isFile()) {
        const rel = toPosixRelative(OBSIDIAN_VAULT, abs);
        const key = entry.name.toLocaleLowerCase('zh-CN');
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(rel);
      }
    }
  };
  walkFiles(OBSIDIAN_VAULT);
  return byName;
}

function resolveObsidianAttachment(noteRel, rawTarget, index) {
  let target = String(rawTarget || '').trim();
  try { target = decodeURIComponent(target); } catch {}
  if (!target || target.includes('\0')) return null;
  target = target.replace(/\\/g, '/');
  const directCandidates = [];
  const noteDir = path.posix.dirname(noteRel);
  if (noteDir && noteDir !== '.') directCandidates.push(path.posix.normalize(path.posix.join(noteDir, target)));
  directCandidates.push(path.posix.normalize(target.replace(/^\//, '')));
  for (const rel of directCandidates) {
    if (!isVisibleObsidianPath(rel)) continue;
    const file = safeExistingFile(OBSIDIAN_VAULT, rel);
    if (file) return rel;
  }
  const matches = index.get(path.posix.basename(target).toLocaleLowerCase('zh-CN')) || [];
  return matches.length === 1 ? matches[0] : null;
}

function obsidianFileUrl(rel) {
  return `/api/obsidian/file?p=${encodeURIComponent(rel)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function transformObsidianEmbeds(noteRel, markdown) {
  const index = createObsidianFileIndex();
  let resolvedCount = 0;
  let unresolvedCount = 0;
  const content = String(markdown || '').replace(/!\[\[([^\]]+)\]\]/g, (_match, inner) => {
    const parts = inner.split('|');
    const target = parts.shift().trim().split('#')[0];
    const sizeSpec = parts.join('|').trim();
    const resolved = resolveObsidianAttachment(noteRel, target, index);
    if (!resolved) {
      unresolvedCount++;
      return `<span class="obsidian-missing">无法解析附件：${escapeHtml(target)}</span>`;
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!OBSIDIAN_PREVIEW_EXTS.has(ext)) return escapeHtml(target);
    resolvedCount++;
    const url = escapeHtml(obsidianFileUrl(resolved));
    const label = escapeHtml(path.basename(resolved));
    const widthMatch = /^(\d{1,4})(?:x\d{1,4})?$/.exec(sizeSpec);
    const width = widthMatch ? ` width="${Math.min(2400, Math.max(24, Number(widthMatch[1])))}"` : '';
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].includes(ext)) {
      return `<img src="${url}" alt="${label}" loading="lazy"${width}>`;
    }
    if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'].includes(ext)) {
      return `<audio controls preload="metadata" src="${url}"></audio>`;
    }
    if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) {
      return `<video controls preload="metadata" src="${url}"></video>`;
    }
    return `[${label}](${url})`;
  });
  return { content, resolvedCount, unresolvedCount };
}

function validDataPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length > 1024) return false;
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith(EXTERNAL_MEDIA_TOKEN_PREFIX)) return !!resolveIndexedMedia(normalized);
  return normalized !== '.' && normalized !== '' && !!safeJoin(normalized);
}

function classify(ext) {
  for (const [type, exts] of Object.entries(MEDIA_TYPES)) {
    if (exts.includes(ext)) return type;
  }
  return null;
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

/* ---------- 素材与文档扫描 ---------- */

function walk(dir, out, allowedTypes) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(abs)) continue;
      walk(abs, out, allowedTypes);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      const type = classify(ext);
      if (!type || (allowedTypes && !allowedTypes.has(type))) continue;
      let stat;
      try { stat = fs.statSync(abs); } catch { continue; }
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      out.push({
        path: rel,
        name: ent.name,
        ext,
        type,
        size: stat.size,
        sizeText: fmtSize(stat.size),
        mtime: stat.mtime.toISOString(),
        // 以 . 开头的目录（.analysis 等分析中间产物）默认隐藏，可在界面里开启
        hidden: rel.split('/').some(seg => seg.startsWith('.')),
      });
    }
  }
}

// 从蒸馏文档里提取标题与“一句话蒸馏”摘要
function extractDocMeta(abs) {
  let text = '';
  try { text = fs.readFileSync(abs, 'utf-8'); } catch { return null; }
  // “一句话蒸馏”章节：取该标题后到下一个同级/更高级标题之间的正文
  let summary = '';
  const sumMatch = text.match(/#{2,3}\s*[^\n]*一句话蒸馏[^\n]*\n+([\s\S]*?)(?=\n#{1,3}\s|\n---|$)/);
  if (sumMatch) {
    summary = sumMatch[1].replace(/[>#*`|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  // 标题统一用文件名（去掉 ID 前缀），避免文档内首个小节标题顶替文档名
  const baseName = path.basename(abs, '.md');
  return {
    title: baseName.replace(/^(VIDEO|TOOL)-\d+_/, ''),
    summary,
    chars: text.length,
  };
}

function parseManifest() {
  // 解析 MEMORY-MANIFEST.md 中 TOOL/VIDEO 表格，供蒸馏文库展示“用途与优先章节”
  const table = {};
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, 'MEMORY-MANIFEST.md'), 'utf-8'); } catch { return table; }
  const rowRe = /^\|\s*(VIDEO|TOOL)-(\d+)\s*\|\s*`([^`]+)`\s*\|([^|]+)\|([^|]+)\|/gm;
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    table[`${m[1]}-${m[2]}`] = {
      file: m[3].trim(),
      purpose: m[4].trim(),
      priority: m[5].trim(),
    };
  }
  return table;
}

// 工作台与媒体栏目共用原文件；不迁移资产，也不依赖当前选中的剧本。
function includeWorkbenchMedia(mediaScan) {
  const source = {
    id: WORKBENCH_MEDIA_SOURCE_ID, token: WORKBENCH_MEDIA_SOURCE_ID,
    label: '创作工作台', kind: 'workbench', builtIn: true, removable: false,
    mediaTypes: ['image', 'video', 'audio'], available: false, status: 'offline',
    fileCount: 0, counts: { image: 0, video: 0, audio: 0 }, truncated: false,
  };
  let snapshot;
  try { snapshot = readyCreativeAssetTree(); }
  catch { return { ...mediaScan, sources: [...mediaScan.sources, source] }; }
  source.available = true;
  source.status = 'online';
  source.truncated = snapshot.truncated;

  const projects = creativeProjectStore.list();
  const media = [];
  const collect = node => {
    if (node.kind === 'folder') (node.children || []).forEach(collect);
    else if (source.mediaTypes.includes(node.type)) media.push(node);
  };
  collect(snapshot.tree);
  const workbenchRoot = fs.realpathSync(CREATIVE_ASSET_DIR);
  const byAbsolutePath = new Map(media.map(file => [path.join(workbenchRoot, ...file.path.split('/')), file]));
  const projectFor = file => {
    const project = projects.find(item => file.path.startsWith(`${item.folder}/`));
    return { projectId: project?.id || '', projectName: project?.name || file.path.split('/')[0],
      exportKind: editorExports.owner(file.path, file.type)?.id || '' };
  };
  // 同一个工作台文件始终使用同一 token；外部索引只作为旧标记的兼容别名。
  const aliases = new Map();
  const files = mediaScan.files.flatMap(file => {
    const entry = mediaSourceStore.resolveFile(file.sourceId, file.relativePath);
    if (entry) {
      const relative = path.relative(workbenchRoot, entry.absolutePath).split(path.sep).join('/');
      if (relative && !relative.startsWith('../') && !path.isAbsolute(relative)
        && editorExports.owner(relative, file.type)) {
        try { if (!editorExports.includeFile(relative, fs.statSync(entry.absolutePath), file.type)) return []; }
        catch { return []; }
      }
    }
    const workbenchFile = entry && byAbsolutePath.get(entry.absolutePath);
    if (!workbenchFile) return [file];
    aliases.set(workbenchFile.path, { path: indexedMediaPath(file.sourceId, file.relativePath), sourceId: file.sourceId });
    return [];
  });
  for (const file of byAbsolutePath.values()) {
    files.push({
      ...file, ...projectFor(file), sourceId: source.id, sourceToken: source.id,
      sourceLabel: source.label, relativePath: file.path,
      aliasPath: aliases.get(file.path)?.path || '',
      linkedSourceId: aliases.get(file.path)?.sourceId || '',
      displayPath: `${source.label}/${file.path}`,
      assetKey: `media-${crypto.createHash('sha256').update(source.id).update('\0').update(file.path).digest('hex')}`,
    });
    source.fileCount++;
    source.counts[file.type]++;
  }
  files.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.assetKey.localeCompare(b.assetKey));
  const counts = { image: 0, video: 0, audio: 0 };
  files.forEach(file => { counts[file.type]++; });
  return {
    ...mediaScan, files, counts, sources: [...mediaScan.sources, source],
    truncated: mediaScan.truncated || snapshot.truncated,
  };
}

function handleScan() {
  editorExports.refresh();
  const mediaScan = includeWorkbenchMedia(mediaSourceStore.scan());
  const projectSource = mediaScan.sources.find(source => source.id === PROJECT_MEDIA_SOURCE_ID);
  const assetAvailable = projectSource?.available === true;
  const savedMeta = readJson(META_FILE, { version: 1, items: {} });
  preserveWorkbenchMetadata(mediaScan.files, savedMeta);
  const sourceSettings = readJson(LIBRARY_SOURCE_FILE, { items: {} }).items || {};
  const projects = creativeProjectStore.list();
  const audioEntries = syncAudioLibrary(mediaScan.files).items;
  const files = mediaScan.files.map(file => {
    const mediaPath = indexedMediaPath(file.sourceId, file.relativePath);
    const setting = sourceSettings[file.linkedSourceId || file.sourceId] || {};
    const meta = { ...(savedMeta.items[file.aliasPath] || {}), ...(savedMeta.items[mediaPath] || {}) };
    const project = projects.find(item => item.id === (file.projectId || meta.projectId || setting.projectId));
    const audio = file.type === 'audio' && audioEntries.find(item =>
      item.projectId === project?.id && item.path === file.relativePath);
    const finalSource = file.type === 'video' && (setting.purpose === 'finals' || file.exportKind === 'finals');
    return {
      ...file,
      projectId: project?.id || '',
      projectName: project?.name || '未归属',
      name: audio?.name || file.name,
      audioRole: file.type === 'audio' ? (audio?.kind || (file.relativePath.includes('/BGM/') ? 'bgm' : file.relativePath.includes('/音效/') ? 'sfx' : 'voice')) : '',
      finalSource,
      path: mediaPath,
      hidden: false,
      meta: finalSource ? { ...meta, isFinal: true } : meta,
    };
  });

  // 蒸馏文库仍从整个项目读取文档，不与素材扫描边界绑定。
  const projectDocs = [];
  walk(ROOT, projectDocs, new Set(['doc']));
  const manifest = parseManifest();
  const docs = [];   // 蒸馏文库用：VIDEO-* / TOOL-* / 手册 / 系统文件
  for (const f of projectDocs) {
    const base = path.basename(f.path, '.md');
    let group = null;
    if (/^VIDEO-\d+_/.test(f.name)) group = 'distill';
    else if (/^TOOL-\d+_/.test(f.name)) group = 'tool';
    else if (f.name === 'AGENTS.md' || f.name === 'MEMORY-MANIFEST.md') group = 'system';
    else if (!f.path.includes('/')) group = 'manual'; // 根目录其他 md（手册/SOP）
    if (!group) continue;
    const meta = extractDocMeta(path.join(ROOT, f.path));
    const idMatch = f.name.match(/^(VIDEO|TOOL)-(\d+)/);
    const manifestEntry = idMatch ? manifest[`${idMatch[1]}-${idMatch[2]}`] : null;
    docs.push({
      ...f,
      group,
      id: idMatch ? `${idMatch[1]}-${idMatch[2]}` : base,
      base,
      title: meta ? meta.title : base,
      summary: meta ? meta.summary : '',
      chars: meta ? meta.chars : 0,
      manifest: manifestEntry,
      registered: !!manifestEntry,
    });
  }
  docs.sort((a, b) => a.id.localeCompare(b.id, 'zh'));

  const counts = { ...mediaScan.counts, doc: 0, hidden: 0 };
  return {
    rootName: path.basename(ROOT),
    assetRoot: path.basename(ASSET_DIR),
    assetAvailable,
    scannedAt: mediaScan.scannedAt,
    counts,
    files,
    sources: mediaScan.sources.map(source => ({ ...source, ...sourceSettings[source.id] })),
    projects: projects.map(({ id, name }) => ({ id, name })),
    truncated: mediaScan.truncated,
    scanLimits: { maxEntries: mediaScan.maxEntries, maxDepth: mediaScan.maxDepth },
    docs,
  };
}

function preserveWorkbenchMetadata(files, meta = readJson(META_FILE, { version: 1, items: {} })) {
  let changed = false;
  for (const file of files) {
    if (!file.aliasPath || !meta.items[file.aliasPath]) continue;
    const key = indexedMediaPath(file.sourceId, file.relativePath);
    const combined = { ...meta.items[file.aliasPath], ...(meta.items[key] || {}) };
    if (JSON.stringify(combined) !== JSON.stringify(meta.items[key])) { meta.items[key] = combined; changed = true; }
  }
  if (changed) writeJson(META_FILE, meta);
}

function prepareMediaSourceRemoval() {
  preserveWorkbenchMetadata(includeWorkbenchMedia(mediaSourceStore.scan()).files);
}

/* ---------- JSON 存取 ---------- */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(temp, file);
  } catch (err) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw err;
  }
}

function readAudioLibrary() {
  if (!fs.existsSync(AUDIO_LIBRARY_FILE)) return { version: 1, items: [] };
  const data = JSON.parse(fs.readFileSync(AUDIO_LIBRARY_FILE, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.items)) throw httpError('音乐音效库数据无法读取', 500);
  return data;
}

function syncAudioLibrary(files) {
  const data = readAudioLibrary();
  const ignored = new Set(data.ignoredPaths || []);
  const existing = new Set(data.items.map(item => item.path).filter(Boolean));
  if (!files) {
    files = [];
    const collect = node => node.kind === 'folder' ? (node.children || []).forEach(collect)
      : files.push({ ...node, sourceId: WORKBENCH_MEDIA_SOURCE_ID, relativePath: node.path });
    collect(readyCreativeAssetTree().tree);
  }
  let changed = false;
  const projects = creativeProjectStore.list();
  for (const file of files) {
    if (file.type !== 'audio' || file.sourceId !== WORKBENCH_MEDIA_SOURCE_ID) continue;
    const relative = file.relativePath;
    const parts = relative.split('/');
    const kind = parts.includes('BGM') ? 'bgm' : parts.includes('音效') ? 'sfx' : '';
    const project = projects.find(item => item.folder === parts[0]);
    if (!kind || !project || existing.has(relative) || ignored.has(relative)) continue;
    data.items.push({ id: crypto.randomUUID(), projectId: project.id, kind,
      name: path.parse(file.name).name.slice(0, 120), path: relative, filename: file.name,
      size: file.size, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    existing.add(relative); changed = true;
  }
  if (changed) writeJson(AUDIO_LIBRARY_FILE, data);
  return data;
}

function audioLibraryKind(value) {
  if (!['bgm', 'sfx'].includes(value)) throw httpError('请选择 BGM 或音效', 400);
  return value;
}

function audioLibraryName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 120) throw httpError('名称需为 1–120 个字符', 400);
  return name;
}

function audioLibraryEntry(data, project, id, kind) {
  const item = data.items.find(item => item.id === id && item.projectId === project.id && (!kind || item.kind === kind));
  if (!item) throw httpError('这条音乐或音效不存在，请刷新后重试', 404);
  return item;
}

/* 经验库保存前自动快照，保留最近 30 份 */
function backupKnowledge() {
  try {
    if (!fs.existsSync(KNOWLEDGE_FILE)) return;
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(KNOWLEDGE_FILE, path.join(dir, `agent-knowledge-${stamp}.json`));
    const names = fs.readdirSync(dir)
      .filter(n => /^agent-knowledge-/.test(n)).sort();
    while (names.length > 30) fs.rmSync(path.join(dir, names.shift()), { force: true });
  } catch {}
}

/* ---------- HTTP ---------- */

function sendJson(res, code, obj, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function sendFile(req, res, abs, mime) {
  let stat;
  try { stat = fs.statSync(abs); } catch {
    res.writeHead(404); res.end('Not Found'); return;
  }
  if (!stat.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': mime || MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2]) || stat.size === 0) {
      res.writeHead(416, { ...SECURITY_HEADERS, 'Content-Range': `bytes */${stat.size}` });
      res.end(); return;
    }
    let start;
    let end;
    if (!m[1]) {
      const suffixLength = parseInt(m[2], 10);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { ...SECURITY_HEADERS, 'Content-Range': `bytes */${stat.size}` });
        res.end(); return;
      }
      start = Math.max(0, stat.size - suffixLength);
      end = stat.size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        res.writeHead(416, { ...SECURITY_HEADERS, 'Content-Range': `bytes */${stat.size}` });
        res.end(); return;
      }
      end = Math.min(end, stat.size - 1);
    }
    if (start < 0 || start >= stat.size || start > end) {
      res.writeHead(416, { ...SECURITY_HEADERS, 'Content-Range': `bytes */${stat.size}` });
      res.end(); return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    const stream = fs.createReadStream(abs, { start, end });
    stream.on('error', err => res.destroy(err));
    stream.pipe(res);
    return;
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  const stream = fs.createReadStream(abs);
  stream.on('error', err => res.destroy(err));
  stream.pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', c => {
      total += c.length;
      if (total <= MAX_BODY_BYTES && !tooLarge) chunks.push(c);
      else tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge) { resolve(null); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function isTrustedLocalUiRequest(req) {
  const host = String(req.headers.host || '');
  let hostName = '';
  try {
    hostName = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(hostName)) return false;
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return false;
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireProductionStore() {
  if (productionStore) return productionStore;
  throw httpError(`制作台账不可用：${productionStoreError ? productionStoreError.message : '当前运行时不支持 SQLite'}`, 503);
}

function requireTrustedJsonWrite(req) {
  if (!isTrustedLocalUiRequest(req)) throw httpError('拒绝跨站写入请求', 403);
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw httpError('请求必须使用 application/json', 415);
}

function productionErrorResponse(res, error) {
  sendJson(res, error.statusCode || 500, {
    error: error.message || '制作台账操作失败',
    code: error.code || 'PRODUCTION_ERROR',
  });
}

// 资产重命名公共路径：文件、同名血缘 sidecar（.prompt.txt）与制作台账一起更新。
const UUID_STYLE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPORT_KIND_LABELS = { image: '生成图片', video: '生成视频' };

function renameAssetEverywhere(oldAbs, newAbs) {
  const audioData = readAudioLibrary();
  const oldAudioPath = toPosixRelative(CREATIVE_ASSET_DIR, oldAbs);
  const newAudioPath = toPosixRelative(CREATIVE_ASSET_DIR, newAbs);
  const oldKeys = mediaKeysForFile(oldAbs);
  const newKeys = mediaKeysForFile(newAbs);
  fs.renameSync(oldAbs, newAbs);
  let audioChanged = false;
  for (const item of audioData.items) {
    if (item.path === oldAudioPath || item.path?.startsWith(`${oldAudioPath}/`)) {
      item.path = newAudioPath + item.path.slice(oldAudioPath.length);
      item.filename = path.posix.basename(item.path);
      audioChanged = true;
    }
  }
  if (audioData.ignoredPaths?.includes(oldAudioPath)) {
    audioData.ignoredPaths = audioData.ignoredPaths.map(value => value === oldAudioPath ? newAudioPath : value);
    audioChanged = true;
  }
  if (audioChanged) {
    writeJson(AUDIO_LIBRARY_FILE, audioData);
    broadcastEvent('audio-library');
  }
  const links = readJson(LIBRARY_LINK_FILE, { items: {} });
  let linksChanged = false;
  for (const item of Object.values(links.items)) {
    if (item.path === oldAudioPath) { item.path = newAudioPath; linksChanged = true; }
  }
  if (linksChanged) writeJson(LIBRARY_LINK_FILE, links);
  // 保留统一媒体索引中的收藏、备注及成片标记。
  if (oldKeys.length && newKeys.length) {
    const meta = readJson(META_FILE, { version: 1, items: {} });
    const previous = oldKeys.filter(key => meta.items[key]);
    if (previous.length) {
      const merged = Object.assign({}, ...previous.map(key => meta.items[key]));
      previous.forEach(key => { delete meta.items[key]; });
      meta.items[newKeys.at(-1)] = merged;
      writeJson(META_FILE, meta);
    }
  }
  // sidecar 命名是「去扩展名的文件名.prompt.txt」，与 /api/prompt-sidecar 保持一致。
  const oldParsed = path.parse(oldAbs);
  const newParsed = path.parse(newAbs);
  const oldSidecar = path.join(oldParsed.dir, `${oldParsed.name}.prompt.txt`);
  try {
    if (fs.existsSync(oldSidecar)) fs.renameSync(oldSidecar, path.join(newParsed.dir, `${newParsed.name}.prompt.txt`));
  } catch {}
  try {
    const store = typeof requireProductionStore === 'function' ? productionStore : null;
    store?.relocateAsset?.(oldAbs, newAbs, path.basename(newAbs));
  } catch {}
}

// 顺序导入命名：扫描目标目录里已有的 `<前缀>-NNN.` 编号，返回下一个编号的文件名。
function nextSequentialImportName(directory, prefix, originalName) {
  const safePrefix = String(prefix || '').trim() || '资产';
  const extension = path.extname(originalName).toLowerCase();
  if (!extension) return originalName;
  let max = 0;
  try {
    const pattern = new RegExp(`^${safePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.`);
    for (const entry of fs.readdirSync(directory)) {
      const match = entry.match(pattern);
      if (match) max = Math.max(max, Number.parseInt(match[1], 10) || 0);
    }
  } catch {}
  return `${safePrefix}-${String(max + 1).padStart(3, '0')}${extension}`;
}

async function commitUniqueImport(tempPath, preferredPath) {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const targetPath = uniquePath(preferredPath);
    try {
      await fs.promises.link(tempPath, targetPath);
      await fs.promises.unlink(tempPath);
      return targetPath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw httpError('同名文件过多，无法完成导入', 409);
}

async function receiveMediaImport(req, filename, requestedKind) {
  if (!isTrustedLocalUiRequest(req)) throw httpError('拒绝跨站导入请求', 403);
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
    throw httpError('导入请求格式不正确', 415);
  }
  const contentLength = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) throw httpError('无法确认文件大小', 411);
  if (contentLength > MAX_MEDIA_IMPORT_BYTES) throw httpError('单个文件不能超过 100 GB', 413);

  const safeName = sanitizeFilename(filename);
  const actualKind = classify(path.extname(safeName).toLowerCase());
  if (!['video', 'audio'].includes(actualKind) || actualKind !== requestedKind) {
    throw httpError(requestedKind === 'audio' ? '请选择支持的音频文件' : '请选择支持的视频文件', 415);
  }

  const targetDirectory = path.join(ASSET_DIR, '手动导入', dateFolder());
  fs.mkdirSync(targetDirectory, { recursive: true });
  const tempPath = path.join(targetDirectory, `.${process.pid}-${crypto.randomUUID()}.part`);
  let receivedBytes = 0;
  req.on('data', chunk => { receivedBytes += chunk.length; });
  try {
    await pipeline(req, fs.createWriteStream(tempPath, { flags: 'wx' }));
    if (receivedBytes !== contentLength) throw httpError('文件传输不完整，请重新导入', 400);
    const targetPath = await commitUniqueImport(tempPath, path.join(targetDirectory, safeName));
    scheduleRescanBroadcast();
    return {
      ok: true,
      kind: actualKind,
      name: path.basename(targetPath),
      path: toPosixRelative(ROOT, targetPath),
      size: receivedBytes,
    };
  } catch (error) {
    try { await fs.promises.unlink(tempPath); } catch {}
    throw error;
  }
}

async function receiveCreativeAssetImport(req, filename, folderPath, renameSequentially = true) {
  if (!isTrustedLocalUiRequest(req)) throw httpError('拒绝跨站导入请求', 403);
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
    throw httpError('导入请求格式不正确', 415);
  }
  const contentLength = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) throw httpError('无法确认文件大小', 411);

  ensureCreativeAssetRoot(CREATIVE_ASSET_DIR);
  const requestedFolder = String(folderPath || '').trim();
  if (!requestedFolder) throw httpError('请先选择一个剧本文件夹，不能把资产直接放在库根', 400);
  const folder = resolveCreativeAsset(CREATIVE_ASSET_DIR, requestedFolder, 'folder');
  if (!folder) throw httpError('目标文件夹不存在或不在创作资产库内', 404);
  const safeName = sanitizeFilename(filename);
  if (safeName.startsWith('.')) throw httpError('资产文件名不能以“.”开头', 400);
  const type = classifyCreativeAsset(safeName);
  if (!type) throw httpError('请选择图片、音频、视频、PDF、Markdown、文本、字幕或 JSON 文件', 415);
  if (contentLength > MAX_CREATIVE_ASSET_BYTES[type]) {
    throw httpError(`${type === 'video' ? '视频' : type === 'audio' ? '音频' : type === 'image' ? '图片' : '文档'}资产超过当前单文件上限`, 413);
  }

  const tempPath = path.join(folder.abs, `.${process.pid}-${crypto.randomUUID()}.part`);
  let receivedBytes = 0;
  req.on('data', chunk => { receivedBytes += chunk.length; });
  try {
    await pipeline(req, fs.createWriteStream(tempPath, { flags: 'wx' }));
    if (receivedBytes !== contentLength) throw httpError('文件传输不完整，请重新导入', 400);
    // 图片和视频导入时按“文件夹名-序号”自动重命名（例如 人物资产-003.png），
    // 序号沿用目标文件夹里已有的最大编号；文档等其他类型保留原文件名。
    let preferredName = safeName;
    if (renameSequentially && (type === 'image' || type === 'video')) {
      preferredName = nextSequentialImportName(folder.abs, path.basename(folder.rel), safeName);
    }
    const targetPath = await commitUniqueImport(tempPath, path.join(folder.abs, preferredName));
    editorExports.markComplete(toPosixRelative(CREATIVE_ASSET_DIR, targetPath));
    scheduleCreativeAssetBroadcast();
    return {
      ok: true,
      type,
      name: path.basename(targetPath),
      path: toPosixRelative(CREATIVE_ASSET_DIR, targetPath),
      size: receivedBytes,
    };
  } catch (error) {
    try { await fs.promises.unlink(tempPath); } catch {}
    throw error;
  }
}

const libraryUseTasks = new Map();
async function useLibraryAsset(body) {
  const key = JSON.stringify([body.projectId, body.source || 'media', body.path, body.category || '']);
  if (libraryUseTasks.has(key)) return libraryUseTasks.get(key);
  const task = copyLibraryAsset(body);
  libraryUseTasks.set(key, task);
  try { return await task; }
  finally { libraryUseTasks.delete(key); }
}

async function copyLibraryAsset(body) {
  const project = creativeProjectStore.list().find(item => item.id === body.projectId && item.available);
  if (!project) throw httpError('请选择素材要用于哪个剧本', 400);
  const sourcePath = String(body.path || '');
  const entry = body.source === 'obsidian'
    ? OBSIDIAN_VAULT && isVisibleObsidianPath(sourcePath) && safeExistingFile(OBSIDIAN_VAULT, sourcePath)
    : resolveIndexedMedia(sourcePath);
  const type = entry && classifyCreativeAsset(entry.abs);
  if (!entry || !type) throw httpError('素材不存在，或不在已关联的来源中', 404);
  const categories = { image: ['生成图片', '人物资产', '场景资产', '服装与道具', '色卡', '首帧与尾帧'],
    audio: ['音频', 'BGM', '音效'], video: ['生成视频', '成片', '视频参考'], document: ['剧本与提示词'] };
  const category = body.category || categories[type]?.[0];
  if (!categories[type]?.includes(category)) throw httpError('素材类型与目标分类不匹配', 400);
  const folderPath = `${project.folder}/${category}`;
  let folder = resolveCreativeAsset(CREATIVE_ASSET_DIR, folderPath, 'folder');
  if (!folder) { createCreativeAssetFolder(CREATIVE_ASSET_DIR, project.folder, category); folder = resolveCreativeAsset(CREATIVE_ASSET_DIR, folderPath, 'folder'); }
  const original = fs.statSync(entry.abs);
  if (!original.isFile() || original.size > MAX_CREATIVE_ASSET_BYTES[type]) throw httpError('素材大小超过导入限制', 413);
  const links = readJson(LIBRARY_LINK_FILE, { items: {} });
  const key = crypto.createHash('sha256').update(`${entry.abs}\0${project.id}\0${category}`).digest('hex');
  const previous = links.items[key];
  if (previous && previous.size === original.size && previous.mtime === original.mtimeMs
    && resolveCreativeAsset(CREATIVE_ASSET_DIR, previous.path, 'file')) return { ok: true, ...previous, existing: true };
  if (path.dirname(entry.abs) === folder.abs) return { ok: true, path: toPosixRelative(CREATIVE_ASSET_DIR, entry.abs), existing: true };
  const temporary = path.join(folder.abs, `.${crypto.randomUUID()}.part`);
  try {
    await fs.promises.copyFile(entry.abs, temporary, fs.constants.COPYFILE_EXCL);
    const current = fs.statSync(entry.abs);
    if (current.size !== original.size || current.mtimeMs !== original.mtimeMs) throw httpError('源文件仍在写入，请等待导出完成后重试', 409);
    const target = await commitUniqueImport(temporary, path.join(folder.abs, path.basename(entry.abs)));
    const relative = toPosixRelative(CREATIVE_ASSET_DIR, target);
    editorExports.markComplete(relative);
    // 重新读取，避免两个素材同时复制时覆盖另一条关联。
    const latest = readJson(LIBRARY_LINK_FILE, { items: {} });
    latest.items[key] = { path: relative, size: original.size, mtime: original.mtimeMs };
    writeJson(LIBRARY_LINK_FILE, latest);
    if (body.source !== 'obsidian') {
      const meta = readJson(META_FILE, { version: 1, items: {} });
      const previousMeta = Object.assign({}, ...mediaKeysForFile(entry.abs).map(item => meta.items[item] || {}));
      if (Object.keys(previousMeta).length) {
        meta.items[indexedMediaPath(WORKBENCH_MEDIA_SOURCE_ID, relative)] = { ...previousMeta, isFinal: false, rejected: false };
        writeJson(META_FILE, meta);
      }
    }
    syncAudioLibrary();
    scheduleCreativeAssetBroadcast();
    broadcastEvent('audio-library');
    return { ok: true, path: relative, projectId: project.id, category, existing: false };
  } finally { try { await fs.promises.unlink(temporary); } catch {} }
}

/* ---------- 素材文件夹监听：文件落盘后通过 SSE 通知前端自动刷新 ---------- */

const eventClients = new Set();

function broadcastEvent(name, payload = {}) {
  const safeName = String(name || '').replace(/[^a-z0-9_-]/gi, '');
  if (!safeName) return;
  const data = JSON.stringify(payload);
  for (const client of eventClients) {
    try { client.write(`event: ${safeName}\ndata: ${data}\n\n`); } catch { eventClients.delete(client); }
  }
}

function broadcastRescan() {
  broadcastEvent('rescan');
}

function broadcastProduction() {
  broadcastEvent('production', { revision: productionStore && productionStore.getContext()?.revision || 0 });
}

function broadcastCreativeAssets() {
  broadcastEvent('creative-assets');
  scheduleRescanBroadcast();
}

function broadcastCreativeProjects() {
  const activeProject = creativeProjectStore.active();
  broadcastEvent('creative-projects', {
    activeProjectId: activeProject?.id || '',
    project: activeProject || null,
  });
}

function creativeProjectsSnapshot() {
  editorExports.refresh();
  const snapshot = creativeProjectStore.snapshot();
  return {
    ...snapshot,
    projects: snapshot.projects.map(project => {
      let assetCount = 0;
      try {
        assetCount = Number(readyCreativeAssetTree({ scopePath: project.folder }).stats.files || 0);
      } catch {}
      return {
        ...project,
        assetCount,
      };
    }),
  };
}

let rescanTimer = null;
let creativeAssetTimer = null;
function scheduleRescanBroadcast() {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(broadcastRescan, 800);
}

function scheduleCreativeAssetBroadcast() {
  clearTimeout(creativeAssetTimer);
  creativeAssetTimer = setTimeout(broadcastCreativeAssets, 300);
}

function watchAssets() {
  try {
    if (fs.existsSync(ASSET_DIR)) {
      fs.watch(ASSET_DIR, { recursive: true }, () => scheduleRescanBroadcast());
    } else {
      // 素材库目录还没建：先盯住项目根目录，等它出现后转成递归监听
      const rootWatcher = fs.watch(ROOT, () => {
        if (fs.existsSync(ASSET_DIR)) {
          rootWatcher.close();
          fs.watch(ASSET_DIR, { recursive: true }, () => scheduleRescanBroadcast());
          scheduleRescanBroadcast();
        }
      });
    }
  } catch {}
}
watchAssets();

function watchCreativeAssets() {
  try {
    ensureCreativeAssetRoot(CREATIVE_ASSET_DIR);
    fs.watch(CREATIVE_ASSET_DIR, { recursive: true }, () => scheduleCreativeAssetBroadcast());
  } catch {}
}
watchCreativeAssets();
editorExports.start();
const mediaSourceWatcher = createMediaSourceWatcher({ store: mediaSourceStore, onChange: broadcastRescan });
mediaSourceWatcher.start();


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  // 烟测专用：延迟 10 秒响应，用于验证“加载超时”提示链路（仅烟测环境注册）。
  if (p === '/__test__/hang' && process.env.VIDEO_OS_SMOKE_TEST === '1') {
    console.log(`[srv-debug] hang-arrived ${new Date().toISOString()}`);
    setTimeout(() => {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>late</body></html>');
      } catch {}
    }, 10000);
    return;
  }
  if (p.includes('creator-fixture')) console.log(`[srv-debug] ${new Date().toISOString()} ${req.method} ${req.url}`);

  try {
    if (p === '/api/creative-projects') {
      if (req.method === 'GET') {
        if (!isTrustedLocalUiRequest(req)) { sendJson(res, 403, { error: '拒绝跨站读取' }); return; }
        sendJson(res, 200, creativeProjectsSnapshot());
        return;
      }
      if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET, POST' }); return; }
      try {
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw httpError('请求内容格式错误', 400);
        const action = String(body.action || 'activate');
        let project;
        if (action === 'create') project = creativeProjectStore.create({ name: body.name });
        else if (action === 'ensure') {
          project = creativeProjectStore.ensure({ name: body.name });
          project = creativeProjectStore.activate(project.id);
        } else if (action === 'activate') project = creativeProjectStore.activate(String(body.id || ''));
        else throw httpError('剧本操作不受支持', 400);
        if (productionStore) productionStore.activateProject(project.id);
        broadcastCreativeProjects();
        broadcastCreativeAssets();
        broadcastProduction();
        sendJson(res, action === 'create' ? 201 : 200, { ok: true, project, ...creativeProjectsSnapshot() });
      } catch (error) {
        const conflict = error.code === 'PROJECT_EXISTS' || /同名|已经存在/.test(String(error.message || ''));
        sendJson(res, conflict ? 409 : (error.statusCode || 400), { error: error.message || '剧本操作失败', code: error.code || 'INVALID_PROJECT' });
      }
      return;
    }

    // 已下线的拆解入口不再读取或改写旧 JSON；历史文件原样保留。
    if (['/api/script-breakdowns', '/api/script-breakdown', '/api/open-script-breakdown-folder'].includes(p)) {
      sendJson(res, 410, { error: '剧本拆解功能已移除，已有文件仍保留在本地。' });
      return;
    }

    if (p === '/api/production') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      if (!productionStore) {
        sendJson(res, 200, {
          available: false,
          error: productionStoreError ? productionStoreError.message : '制作台账不可用',
          shots: [], context: null, inbox: [], stats: { shots: 0, inbox: 0, unassigned: 0, statuses: {} },
        });
        return;
      }
      const snapshot = productionStore.snapshot();
      delete snapshot.databasePath;
      sendJson(res, 200, snapshot);
      return;
    }

    if (p === '/api/production/health') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      try {
        const health = requireProductionStore().health();
        delete health.databasePath;
        sendJson(res, health.ok ? 200 : 503, { available: true, ...health });
      } catch (error) {
        sendJson(res, 503, { available: false, ok: false, error: error.message });
      }
      return;
    }

    if (p === '/api/shots') {
      try {
        const store = requireProductionStore();
        if (req.method === 'GET') {
          sendJson(res, 200, { items: store.listShots(), context: store.getContext() });
          return;
        }
        if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET, POST' }); return; }
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw httpError('请求内容格式错误', 400);
        const action = String(body.action || 'create');
      if (['update', 'delete'].includes(action) && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)) {
          const error = httpError('镜头操作需要当前版本号，请刷新后重试', 400);
          error.code = 'REVISION_REQUIRED';
          throw error;
        }
        let result;
        const projectId = creativeProjectStore.active()?.id || 'inspiration';
        if (action === 'create') result = store.createShot({ ...body, projectId });
        else if (action === 'update') result = store.updateShot(body.id, { ...body, projectId });
        else if (action === 'delete') result = store.deleteShot(body.id, { ...body, projectId });
        else throw httpError('镜头操作不受支持', 400);
        broadcastProduction();
        sendJson(res, action === 'create' ? 201 : 200, { ok: true, item: result });
      } catch (error) { productionErrorResponse(res, error); }
      return;
    }

    if (p === '/api/context') {
      try {
        const store = requireProductionStore();
        if (req.method === 'GET') { sendJson(res, 200, store.getContext()); return; }
        if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET, POST' }); return; }
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw httpError('请求内容格式错误', 400);
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
          const error = httpError('创作上下文操作需要当前版本号，请刷新后重试', 400);
          error.code = 'REVISION_REQUIRED';
          throw error;
        }
        const context = store.setContext({ ...body, projectId: creativeProjectStore.active()?.id || 'inspiration' });
        broadcastProduction();
        sendJson(res, 200, { ok: true, context });
      } catch (error) { productionErrorResponse(res, error); }
      return;
    }

    if (p === '/api/inbox') {
      try {
        const store = requireProductionStore();
        if (req.method === 'GET') {
          const rawLimit = url.searchParams.get('limit');
          const rawOffset = url.searchParams.get('offset');
          const requestedLimit = rawLimit === null || rawLimit.trim() === '' ? 200 : Number(rawLimit);
          const requestedOffset = rawOffset === null || rawOffset.trim() === '' ? 0 : Number(rawOffset);
          const page = store.listInboxPage({
            includeDismissed: url.searchParams.get('dismissed') === '1',
            limit: Number.isInteger(requestedLimit) ? requestedLimit : 200,
            offset: Number.isInteger(requestedOffset) ? requestedOffset : 0,
          });
          sendJson(res, 200, page);
          return;
        }
        if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET, POST' }); return; }
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw httpError('请求内容格式错误', 400);
        const item = store.updateInbox(body.id, { ...body, projectId: creativeProjectStore.active()?.id || 'inspiration' });
        broadcastProduction();
        sendJson(res, 200, { ok: true, item });
      } catch (error) { productionErrorResponse(res, error); }
      return;
    }

    if (p === '/api/asset-uses') {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'POST' }); return; }
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw httpError('请求内容格式错误', 400);
        const result = requireProductionStore().linkAssetUse({
          ...body,
          projectId: creativeProjectStore.active()?.id || 'inspiration',
        });
        broadcastProduction();
        sendJson(res, 200, result);
      } catch (error) { productionErrorResponse(res, error); }
      return;
    }

    if (p === '/api/library-import') {
      try {
        if (req.method !== 'POST') throw httpError('方法不允许', 405);
        if (!isTrustedLocalUiRequest(req)) throw httpError('拒绝跨站导入', 403);
        const project = creativeProjectStore.list().find(project => project.id === url.searchParams.get('project'));
        if (!project) throw httpError('请选择归属剧本', 400);
        const kind = url.searchParams.get('kind');
        if (!['audio', 'video'].includes(kind) || classifyCreativeAsset(url.searchParams.get('name') || '') !== kind) throw httpError('文件类型不匹配', 415);
        const category = kind === 'audio' ? '音频' : '生成视频';
        const folder = `${project.folder}/${category}`;
        if (!resolveCreativeAsset(CREATIVE_ASSET_DIR, folder, 'folder')) createCreativeAssetFolder(CREATIVE_ASSET_DIR, project.folder, category);
        const result = await receiveCreativeAssetImport(req, url.searchParams.get('name'), folder);
        sendJson(res, 201, result);
      } catch (error) { sendJson(res, error.statusCode || 400, { error: error.message }); }
      return;
    }

    if (p === '/api/library-use') {
      try {
        if (req.method !== 'POST') throw httpError('方法不允许', 405);
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw httpError('请求无效', 400);
        sendJson(res, 200, await useLibraryAsset(body));
      } catch (error) { sendJson(res, error.statusCode || 400, { error: error.message }); }
      return;
    }

    if (p === '/api/library-sources') {
      try {
        if (req.method !== 'POST') throw httpError('方法不允许', 405);
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw httpError('请求无效', 400);
        const data = readJson(LIBRARY_SOURCE_FILE, { items: {} });
        if (body.action === 'remove') {
          prepareMediaSourceRemoval();
          mediaSourceStore.remove(String(body.id || ''));
          delete data.items[body.id];
        } else {
          const projectId = String(body.projectId || '');
          if (projectId && !creativeProjectStore.list().some(project => project.id === projectId)) throw httpError('剧本不存在', 400);
          const purpose = body.purpose === 'finals' ? 'finals' : 'media';
          if (purpose === 'finals' && !projectId) throw httpError('请为成片文件夹选择归属剧本', 400);
          let source;
          if (body.action === 'add') {
            source = mediaSourceStore.addDirectory({ rootPath: body.rootPath, label: body.label || path.basename(String(body.rootPath || '')), kind: 'folder' });
          } else if (body.action === 'save') source = mediaSourceStore.list().find(source => source.id === body.id);
          else throw httpError('操作无效', 400);
          if (!source) throw httpError('索引来源不存在', 404);
          data.items[source.id] = { projectId, purpose };
        }
        writeJson(LIBRARY_SOURCE_FILE, data);
        mediaSourceWatcher.refresh();
        broadcastRescan();
        sendJson(res, 200, { ok: true });
      } catch (error) { sendJson(res, error.statusCode || 400, { error: error.message }); }
      return;
    }

    if (p === '/api/scan') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      if (!isTrustedLocalUiRequest(req)) { sendJson(res, 403, { error: '拒绝跨站读取' }); return; }
      sendJson(res, 200, handleScan()); return;
    }

    if (p === '/api/audio-library' || p === '/api/audio-library/upload') {
      try {
        if (!isTrustedLocalUiRequest(req)) throw httpError('拒绝跨站请求', 403);
        const project = creativeProjectForRequest(url);
        if (p.endsWith('/upload')) {
          if (req.method !== 'POST') throw httpError('方法不允许', 405);
          const kind = audioLibraryKind(url.searchParams.get('kind'));
          const id = url.searchParams.get('entry') || '';
          const filename = url.searchParams.get('name') || '';
          if (classifyCreativeAsset(filename) !== 'audio') throw httpError('请拖入 MP3、WAV、M4A 等音频文件', 415);
          if (id) audioLibraryEntry(readAudioLibrary(), project, id, kind);
          const category = kind === 'bgm' ? 'BGM' : '音效';
          const folder = `${project.folder}/${category}`;
          if (!resolveCreativeAsset(CREATIVE_ASSET_DIR, folder, 'folder')) {
            createCreativeAssetFolder(CREATIVE_ASSET_DIR, project.folder, category);
          }
          const imported = await receiveCreativeAssetImport(req, filename, folder, false);
          // Read after the streamed upload so simultaneous imports do not overwrite each other.
          const data = syncAudioLibrary();
          let item;
          if (id) item = audioLibraryEntry(data, project, id, kind);
          else {
            item = { id: crypto.randomUUID(), projectId: project.id, kind,
              name: path.parse(imported.name).name.slice(0, 120), createdAt: new Date().toISOString() };
            data.items.push(item);
          }
          Object.assign(item, { path: imported.path, filename: imported.name, size: imported.size, updatedAt: new Date().toISOString() });
          data.items = data.items.filter(entry => entry === item || entry.path !== imported.path);
          data.ignoredPaths = (data.ignoredPaths || []).filter(value => value !== imported.path);
          writeJson(AUDIO_LIBRARY_FILE, data);
          broadcastEvent('audio-library');
          sendJson(res, 201, { ok: true, item });
        } else if (req.method === 'GET') {
          const data = syncAudioLibrary();
          const items = data.items.filter(item => item.projectId === project.id).map(item => {
            let available = false;
            if (item.path) {
              try { available = !!resolveCreativeAsset(CREATIVE_ASSET_DIR, requireProjectAssetPath(project, item.path), 'file'); } catch {}
            }
            return { ...item, available };
          });
          sendJson(res, 200, { items });
        } else if (req.method === 'POST') {
          requireTrustedJsonWrite(req);
          const body = await readBody(req);
          const data = syncAudioLibrary();
          let item;
          if (body.action === 'create') {
            item = { id: crypto.randomUUID(), projectId: project.id, kind: audioLibraryKind(body.kind),
              name: audioLibraryName(body.name), path: '', createdAt: new Date().toISOString() };
            data.items.push(item);
          } else {
            item = audioLibraryEntry(data, project, body.id);
            if (body.action === 'rename') item.name = audioLibraryName(body.name);
            else if (body.action === 'remove') {
              data.items = data.items.filter(entry => entry !== item);
              if (item.path) data.ignoredPaths = [...new Set([...(data.ignoredPaths || []), item.path])];
            }
            else throw httpError('操作无效', 400);
          }
          item.updatedAt = new Date().toISOString();
          writeJson(AUDIO_LIBRARY_FILE, data);
          broadcastEvent('audio-library');
          sendJson(res, 200, { ok: true, item });
        } else throw httpError('方法不允许', 405);
      } catch (error) { sendJson(res, error.statusCode || 400, { error: error.message }); }
      return;
    }

    if (p === '/api/editor-exports' || p === '/api/editor-exports/open') {
      const opening = p.endsWith('/open');
      const method = opening ? 'POST' : 'GET';
      if (req.method !== method) { sendJson(res, 405, { error: '方法不允许' }, { Allow: method }); return; }
      if (!isTrustedLocalUiRequest(req)) { sendJson(res, 403, { error: '拒绝跨站读取' }); return; }
      try {
        // 查看、复制导出目录不应切换正在创作的剧本，也不受当前编辑锁限制。
        const projectId = url.searchParams.get('project') || creativeProjectStore.active()?.id;
        const project = creativeProjectStore.get(projectId);
        if (!project?.available) throw httpError('剧本不存在或文件夹不可用', 404);
        const snapshot = editorExports.snapshot(project.id);
        if (!opening) { sendJson(res, 200, snapshot); return; }
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        const folder = snapshot.folders.find(item => item.id === body?.kind);
        if (!folder) throw httpError('请选择人物音频或成片目录', 400);
        const entry = resolveCreativeAsset(CREATIVE_ASSET_DIR, folder.path, 'folder');
        if (!entry) throw httpError('导出目录不可用', 404);
        if (!['darwin', 'win32'].includes(process.platform)) throw httpError('当前系统不支持打开文件夹', 400);
        await new Promise((resolve, reject) => execFile(process.platform === 'darwin' ? 'open' : 'explorer.exe',
          [entry.abs], { windowsHide: true }, error => {
            // Explorer 成功转交给现有窗口时也可能返回 1。
            if (error && !(process.platform === 'win32' && error.code === 1)) reject(error); else resolve();
          }));
        sendJson(res, 200, { ok: true, path: entry.abs });
      } catch (error) { sendJson(res, error.statusCode || 400, { error: error.message }); }
      return;
    }

    if (p === '/api/creative-assets') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      if (!isTrustedLocalUiRequest(req)) { sendJson(res, 403, { error: '拒绝跨站读取' }); return; }
      try {
        const project = creativeProjectForRequest(url);
        editorExports.refresh();
        sendJson(res, 200, {
          ...readyCreativeAssetTree({ scopePath: project.folder }),
          project,
        });
      }
      catch (error) { sendJson(res, error.statusCode || 500, { error: `创作资产库读取失败：${error.message}` }); }
      return;
    }

    if (p === '/api/creative-assets/folder') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'POST' }); return; }
      try {
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw httpError('请求内容格式错误', 400);
        const project = creativeProjectForRequest(url);
        const parent = requireProjectAssetPath(project, String(body.parent || project.folder));
        const folder = createCreativeAssetFolder(CREATIVE_ASSET_DIR, parent, body.name);
        scheduleCreativeAssetBroadcast();
        sendJson(res, 201, { ok: true, folder });
      } catch (error) {
        const conflict = String(error.message || '').includes('同名文件夹');
        sendJson(res, conflict ? 409 : (error.statusCode || 400), { error: error.message || '文件夹创建失败' });
      }
      return;
    }

    if (p === '/api/creative-assets/import') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'POST' }); return; }
      try {
        const project = creativeProjectForRequest(url);
        const folder = requireProjectAssetPath(project, url.searchParams.get('folder') || '', { allowProjectRoot: false });
        const result = await receiveCreativeAssetImport(
          req,
          url.searchParams.get('name') || '',
          folder,
          // 首帧/尾帧截取的文件名带镜头语义，跳过顺序重命名。
          !url.searchParams.get('frame'),
        );
        const frameKind = String(url.searchParams.get('frame') || '').trim();
        if (frameKind) {
          let importedEntry = null;
          try {
            if (!['first', 'tail'].includes(frameKind) || result.type !== 'image') {
              throw httpError('首尾帧登记信息无效', 400);
            }
            const sourcePath = requireProjectAssetPath(project, url.searchParams.get('source') || '', { allowProjectRoot: false });
            const sourceEntry = resolveCreativeAsset(CREATIVE_ASSET_DIR, sourcePath, 'file');
            if (!sourceEntry || classifyCreativeAsset(sourceEntry.rel) !== 'video') {
              throw httpError('首尾帧来源视频不存在或不属于当前剧本', 404);
            }
            importedEntry = resolveCreativeAsset(CREATIVE_ASSET_DIR, result.path, 'file');
            if (!importedEntry) throw httpError('截取的首尾帧文件没有成功落盘', 500);
            const asset = requireProductionStore().registerFrameAsset({
              projectId: project.id,
              frameKind,
              assetPath: importedEntry.abs,
              confirmed: true,
            });
            result.frameAsset = {
              id: asset.id,
              frameKind,
              originType: asset.origin_type,
              confirmedAt: asset.confirmed_at,
              source: sourceEntry.rel,
            };
            broadcastProduction();
          } catch (error) {
            if (importedEntry) {
              try { fs.unlinkSync(importedEntry.abs); } catch {}
              scheduleCreativeAssetBroadcast();
            }
            throw error;
          }
        }
        sendJson(res, 201, result);
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message || '资产导入失败' });
      }
      return;
    }

    if (p === '/api/creative-assets/rename') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'POST' }); return; }
      try {
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw httpError('请求内容格式错误', 400);
        const project = creativeProjectForRequest(url);
        const entryPath = requireProjectAssetPath(project, String(body.path || ''), { allowProjectRoot: false });
        const entry = resolveCreativeAsset(CREATIVE_ASSET_DIR, entryPath, 'file');
        if (!entry) throw httpError('资产不存在或不在创作资产库内', 404);
        let newName = sanitizeFilename(String(body.name || '').trim());
        if (!newName) throw httpError('请输入新的文件名', 400);
        const originalExt = path.extname(entry.rel);
        if (originalExt && !newName.toLowerCase().endsWith(originalExt.toLowerCase())) newName += originalExt;
        if (!classifyCreativeAsset(newName)) throw httpError('新文件名没有受支持的扩展名', 415);
        const targetAbs = path.join(path.dirname(entry.abs), newName);
        if (targetAbs !== entry.abs && fs.existsSync(targetAbs)) throw httpError('同名文件已存在', 409);
        if (targetAbs !== entry.abs) renameAssetEverywhere(entry.abs, targetAbs);
        scheduleCreativeAssetBroadcast();
        sendJson(res, 200, {
          ok: true,
          name: newName,
          path: toPosixRelative(CREATIVE_ASSET_DIR, targetAbs),
        });
      } catch (error) {
        const conflict = String(error.message || '').includes('同名文件');
        sendJson(res, conflict ? 409 : (error.statusCode || 400), { error: error.message || '重命名失败' });
      }
      return;
    }

    if (p === '/api/creative-assets/move') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'POST' }); return; }
      try {
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw httpError('请求内容格式错误', 400);
        const project = creativeProjectForRequest(url);
        const entryPath = requireProjectAssetPath(project, String(body.path || ''), { allowProjectRoot: false });
        const entry = resolveCreativeAsset(CREATIVE_ASSET_DIR, entryPath, 'file');
        if (!entry) throw httpError('资产不存在或不在创作资产库内', 404);
        const folderPath = requireProjectAssetPath(project, String(body.folder || ''), { allowProjectRoot: false });
        const folder = resolveCreativeAsset(CREATIVE_ASSET_DIR, folderPath, 'folder');
        if (!folder) throw httpError('目标文件夹不存在或不在创作资产库内', 404);
        if (path.dirname(entry.abs) === folder.abs) throw httpError('资产已在该文件夹内', 400);
        const targetAbs = uniquePath(path.join(folder.abs, path.basename(entry.rel)));
        try {
          renameAssetEverywhere(entry.abs, targetAbs);
        } catch (error) {
          if (error.code !== 'EXDEV') throw error;
          // 跨卷回退：复制到目标后再走同一套血缘/台账同步删除原文件。
          fs.copyFileSync(entry.abs, targetAbs);
          renameAssetEverywhere(entry.abs, targetAbs);
        }
        scheduleCreativeAssetBroadcast();
        sendJson(res, 200, {
          ok: true,
          name: path.basename(targetAbs),
          path: toPosixRelative(CREATIVE_ASSET_DIR, targetAbs),
          folder: folder.rel,
        });
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message || '移动失败' });
      }
      return;
    }


    if (p === '/api/creative-assets/normalize') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'POST' }); return; }
      try {
        requireTrustedJsonWrite(req);
        const body = await readBody(req);
        const project = creativeProjectForRequest(url);
        const requestedFolder = (body && typeof body.folder === 'string' && body.folder) || url.searchParams.get('folder') || '';
        const folderPath = requireProjectAssetPath(project, requestedFolder, { allowProjectRoot: false });
        const folder = resolveCreativeAsset(CREATIVE_ASSET_DIR, folderPath, 'folder');
        if (!folder) throw httpError('目标文件夹不存在或不在创作资产库内', 404);
        const victims = fs.readdirSync(folder.abs)
          .filter(name => UUID_STYLE_NAME.test(path.basename(name, path.extname(name))) && classifyCreativeAsset(name))
          .map(name => {
            const abs = path.join(folder.abs, name);
            return { name, abs, mtime: fs.statSync(abs).mtimeMs };
          })
          .sort((a, b) => a.mtime - b.mtime);
        if (!victims.length) { sendJson(res, 200, { ok: true, renamed: [] }); return; }
        const maxSeq = {};
        try {
          for (const entry of fs.readdirSync(folder.abs)) {
            const match = entry.match(/^(生成图片|生成视频)-(\d+)\./);
            if (match) maxSeq[match[1]] = Math.max(maxSeq[match[1]] || 0, Number.parseInt(match[2], 10) || 0);
          }
        } catch {}
        const renamed = [];
        for (const victim of victims) {
          const kind = classifyCreativeAsset(victim.name);
          const label = IMPORT_KIND_LABELS[kind];
          if (!label) continue;
          maxSeq[label] = (maxSeq[label] || 0) + 1;
          const newName = `${label}-${String(maxSeq[label]).padStart(3, '0')}${path.extname(victim.name)}`;
          const newAbs = path.join(folder.abs, newName);
          if (fs.existsSync(newAbs)) { maxSeq[label] += 1; continue; }
          renameAssetEverywhere(victim.abs, newAbs);
          renamed.push({ from: victim.name, to: newName });
        }
        scheduleCreativeAssetBroadcast();
        sendJson(res, 200, { ok: true, renamed });
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message || '文件名整理失败' });
      }
      return;
    }

    if (p === '/api/creative-assets/file') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      if (!isTrustedLocalUiRequest(req)) { sendJson(res, 403, { error: '拒绝跨站读取' }); return; }
      let requested;
      try { requested = requireProjectAssetPath(creativeProjectForRequest(url), url.searchParams.get('p') || ''); }
      catch (error) { sendJson(res, error.statusCode || 403, { error: error.message }); return; }
      const entry = resolveCreativeAsset(CREATIVE_ASSET_DIR, requested, 'file');
      const type = entry && classifyCreativeAsset(entry.rel);
      if (!entry || !type) { sendJson(res, 404, { error: '资产不存在或不支持预览' }); return; }
      sendFile(req, res, entry.abs, MIME[path.extname(entry.abs).toLowerCase()]);
      return;
    }

    if (p === '/api/open-creative-assets-folder' || p === '/api/show-creative-asset') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      if (!isTrustedLocalUiRequest(req)) { sendJson(res, 403, { error: '拒绝跨站操作' }); return; }
      ensureCreativeAssetRoot(CREATIVE_ASSET_DIR);
      let requested;
      try {
        const project = creativeProjectForRequest(url);
        requested = requireProjectAssetPath(project, url.searchParams.get('p') || project.folder);
      } catch (error) {
        sendJson(res, error.statusCode || 403, { error: error.message });
        return;
      }
      const entry = p === '/api/show-creative-asset'
        ? resolveCreativeAsset(CREATIVE_ASSET_DIR, requested, 'file')
        : resolveCreativeAsset(CREATIVE_ASSET_DIR, requested, 'folder');
      if (!entry) { sendJson(res, 404, { error: '资产或文件夹不存在' }); return; }
      if (process.platform === 'win32') {
        const args = p === '/api/show-creative-asset' ? [`/select,${entry.abs}`] : [entry.abs];
        execFile('explorer.exe', args, { windowsHide: true }, () => {});
      } else if (process.platform === 'darwin') {
        execFile('open', p === '/api/show-creative-asset' ? ['-R', entry.abs] : [entry.abs], () => {});
      } else {
        sendJson(res, 200, { ok: false, message: '当前系统不支持打开文件夹' }); return;
      }
      sendJson(res, 200, { ok: true, path: entry.abs });
      return;
    }

    if (p === '/api/import-media') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'POST' }); return; }
      const requestedKind = url.searchParams.get('kind');
      if (!['video', 'audio'].includes(requestedKind)) {
        sendJson(res, 400, { error: 'kind 必须是 video 或 audio' });
        return;
      }
      try {
        const result = await receiveMediaImport(
          req,
          url.searchParams.get('name') || '',
          requestedKind,
        );
        sendJson(res, 201, result);
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message || '导入失败' });
      }
      return;
    }

    if (p === '/api/open-asset-folder') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      if (!isTrustedLocalUiRequest(req)) { sendJson(res, 403, { error: '拒绝跨站操作' }); return; }
      fs.mkdirSync(ASSET_DIR, { recursive: true });
      if (process.platform === 'win32') execFile('explorer.exe', [ASSET_DIR], { windowsHide: true }, () => {});
      else if (process.platform === 'darwin') execFile('open', [ASSET_DIR], () => {});
      else { sendJson(res, 200, { ok: false, message: '当前系统不支持打开文件夹' }); return; }
      sendJson(res, 200, { ok: true, path: ASSET_DIR });
      return;
    }

    if (p === '/api/file' || p === '/api/doc') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      if (!isTrustedLocalUiRequest(req)) { sendJson(res, 403, { error: '拒绝跨站读取' }); return; }
      const rel = url.searchParams.get('p') || '';
      if (p === '/api/doc') {
        const entry = safeExistingFile(ROOT, rel);
        if (!entry || isRealPathWithin(CREATIVE_ASSET_DIR, entry.abs)) {
          sendJson(res, 404, { error: '文件不存在' }); return;
        }
        const type = classify(path.extname(entry.abs).toLowerCase());
        if (type !== 'doc') { sendJson(res, 404, { error: '仅支持读取文档' }); return; }
        const text = fs.readFileSync(entry.abs, 'utf-8');
        sendJson(res, 200, { path: rel.replace(/\\/g, '/'), content: text });
      } else {
        const entry = resolveIndexedMedia(rel);
        if (!entry) { sendJson(res, 404, { error: '索引媒体不存在或来源已离线' }); return; }
        sendFile(req, res, entry.abs);
      }
      return;
    }

    if (p === '/api/obsidian/tree') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      sendJson(res, 200, buildObsidianTree()); return;
    }

    if (p === '/api/obsidian/note') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      if (!OBSIDIAN_VAULT) { sendJson(res, 404, { error: '未找到本机 Obsidian Vault' }); return; }
      const rel = (url.searchParams.get('p') || '').replace(/\\/g, '/');
      if (!isVisibleObsidianPath(rel) || path.extname(rel).toLowerCase() !== '.md') {
        sendJson(res, 404, { error: '笔记不存在' }); return;
      }
      const entry = safeExistingFile(OBSIDIAN_VAULT, rel);
      if (!entry || entry.stat.size > 5 * 1024 * 1024) {
        sendJson(res, 404, { error: '笔记不存在或文件过大' }); return;
      }
      const raw = fs.readFileSync(entry.abs, 'utf-8');
      const transformed = transformObsidianEmbeds(rel, raw);
      sendJson(res, 200, {
        path: rel,
        name: path.basename(rel, path.extname(rel)),
        content: transformed.content,
        rawLength: raw.length,
        resolvedEmbeds: transformed.resolvedCount,
        unresolvedEmbeds: transformed.unresolvedCount,
        mtime: entry.stat.mtime.toISOString(),
      });
      return;
    }

    if (p === '/api/obsidian/file') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      if (!OBSIDIAN_VAULT) { sendJson(res, 404, { error: '未找到本机 Obsidian Vault' }); return; }
      const rel = (url.searchParams.get('p') || '').replace(/\\/g, '/');
      const ext = path.extname(rel).toLowerCase();
      if (!isVisibleObsidianPath(rel) || !OBSIDIAN_PREVIEW_EXTS.has(ext)) {
        sendJson(res, 404, { error: '附件不存在或不支持预览' }); return;
      }
      const entry = safeExistingFile(OBSIDIAN_VAULT, rel);
      if (!entry) { sendJson(res, 404, { error: '附件不存在' }); return; }
      sendFile(req, res, entry.abs, MIME[ext]);
      return;
    }

    if (p === '/api/knowledge') {
      if (req.method === 'GET') {
        sendJson(res, 200, readJson(KNOWLEDGE_FILE, { version: 1, sections: [] }));
      } else if (req.method === 'POST') {
        try { requireTrustedJsonWrite(req); }
        catch (error) { sendJson(res, error.statusCode || 403, { error: error.message }); return; }
        const body = await readBody(req);
        if (!body || !Array.isArray(body.sections) || body.sections.length > 100 || body.sections.some(sec =>
          !sec || typeof sec !== 'object' || typeof sec.id !== 'string' || typeof sec.name !== 'string' ||
          !Array.isArray(sec.items) || sec.items.length > 500 || sec.items.some(item =>
            !item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.title !== 'string' ||
            typeof item.body !== 'string'))
        ) { sendJson(res, 400, { error: '格式错误或内容过大' }); return; }
        backupKnowledge();
        writeJson(KNOWLEDGE_FILE, body);
        sendJson(res, 200, { ok: true });
      } else { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET, POST' }); }
      return;
    }

    if (p === '/api/backups') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      const dir = path.join(DATA_DIR, 'backups');
      let names = [];
      try { names = fs.readdirSync(dir).filter(n => /^agent-knowledge-[\dTZ:-]+\.json$/.test(n)).sort().reverse(); } catch {}
      sendJson(res, 200, { count: names.length, files: names.slice(0, 50) });
      return;
    }

    if (p === '/api/prompt-sidecar') {
      if (req.method === 'GET') {
        if (!isTrustedLocalUiRequest(req)) { sendJson(res, 403, { error: '拒绝跨站读取' }); return; }
        const rel = (url.searchParams.get('p') || '').replace(/\\/g, '/');
        const entry = rel.startsWith(`${EXTERNAL_MEDIA_TOKEN_PREFIX}${WORKBENCH_MEDIA_SOURCE_ID}/`)
          ? resolveIndexedMedia(rel) : safeExistingFile(ROOT, rel);
        if (!entry) { sendJson(res, 404, { error: '文件不存在' }); return; }
        const parsed = path.parse(entry.abs);
        const sidecar = path.join(parsed.dir, parsed.name + '.prompt.txt');
        try {
          const stat = fs.lstatSync(sidecar);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('不是普通文件');
          const text = fs.readFileSync(sidecar, 'utf-8');
          sendJson(res, 200, { found: true, content: text.slice(0, 20000) });
        } catch { sendJson(res, 200, { found: false }); }
      } else if (req.method === 'POST') {
        try { requireTrustedJsonWrite(req); }
        catch (error) { sendJson(res, error.statusCode || 403, { error: error.message }); return; }
        const body = await readBody(req);
        const abs = body && typeof body.path === 'string' ? path.resolve(body.path) : '';
        const prompt = body && typeof body.prompt === 'string' ? body.prompt : '';
        const inRoot = isRealPathWithin(ROOT, abs);
        const inVault = OBSIDIAN_VAULT && isRealPathWithin(OBSIDIAN_VAULT, abs);
        if (!body || !abs || (!inRoot && !inVault) || !prompt) { sendJson(res, 400, { error: '格式错误' }); return; }
        const parsed = path.parse(abs);
        const sidecar = path.join(parsed.dir, parsed.name + '.prompt.txt');
        if (!(inRoot ? isWithin(ROOT, sidecar) : isWithin(OBSIDIAN_VAULT, sidecar))) {
          sendJson(res, 400, { error: '路径不合法' }); return;
        }
        const header = `生成来源｜${String(body.service || '未知平台')}｜模式：${body.mode === 'image' ? '图片' : '视频'}｜归档：${new Date().toISOString().slice(0, 19).replace('T', ' ')}\n${'='.repeat(46)}\n\n`;
        try { fs.mkdirSync(parsed.dir, { recursive: true }); fs.writeFileSync(sidecar, header + prompt, 'utf-8'); }
        catch (err) { sendJson(res, 500, { error: '写入失败：' + err.message }); return; }
        sendJson(res, 200, { ok: true, sidecar: path.basename(sidecar) });
      } else { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET, POST' }); }
      return;
    }

    if (p === '/api/meta') {
      if (req.method === 'GET') {
        sendJson(res, 200, readJson(META_FILE, { version: 1, items: {} }));
      } else if (req.method === 'POST') {
        try { requireTrustedJsonWrite(req); }
        catch (error) { sendJson(res, error.statusCode || 403, { error: error.message }); return; }
        const body = await readBody(req);
        const requestedKey = body && typeof body.path === 'string' ? body.path.replace(/\\/g, '/') : '';
        if (!body || !validDataPath(requestedKey)) { sendJson(res, 400, { error: '格式错误' }); return; }
        const key = canonicalMediaPath(requestedKey);
        const meta = readJson(META_FILE, { version: 1, items: {} });
        const entry = resolveIndexedMedia(key);
        const aliases = entry ? mediaKeysForFile(entry.abs) : [key];
        const prev = Object.assign({ starred: false, isFinal: false, tags: [], note: '', rating: 0, rejected: false },
          ...aliases.map(alias => meta.items[alias] || {}));
        // 字段级合并：只更新本次提交的字段，保留其余字段（否则“标成品”会清掉“收藏”）
        meta.items[key] = {
          starred: body.starred !== undefined ? !!body.starred : prev.starred,
          isFinal: body.isFinal !== undefined ? !!body.isFinal : prev.isFinal,
          tags: Array.isArray(body.tags) ? body.tags.filter(t => typeof t === 'string').slice(0, 50) : prev.tags,
          note: typeof body.note === 'string' ? body.note.slice(0, 10000) : prev.note,
          rating: Number.isFinite(body.rating) ? Math.max(0, Math.min(5, Math.round(body.rating))) : (prev.rating || 0),
          rejected: body.rejected !== undefined ? !!body.rejected : !!prev.rejected,
        };
        writeJson(META_FILE, meta);
        sendJson(res, 200, { ok: true, item: meta.items[key] });
      } else { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET, POST' }); }
      return;
    }

    if (p === '/api/annotations') {
      if (req.method === 'GET') {
        sendJson(res, 200, readJson(ANNOTATIONS_FILE, { version: 1, items: {} }));
      } else if (req.method === 'POST') {
        try { requireTrustedJsonWrite(req); }
        catch (error) { sendJson(res, error.statusCode || 403, { error: error.message }); return; }
        const body = await readBody(req);
        const key = body && typeof body.path === 'string' ? body.path.replace(/\\/g, '/') : '';
        if (!body || !validDataPath(key)) { sendJson(res, 400, { error: '格式错误' }); return; }
        const data = readJson(ANNOTATIONS_FILE, { version: 1, items: {} });
        const prev = data.items[key] || { bookmarked: false, note: '' };
        data.items[key] = {
          bookmarked: body.bookmarked !== undefined ? !!body.bookmarked : prev.bookmarked,
          note: typeof body.note === 'string' ? body.note.slice(0, 10000) : prev.note,
        };
        writeJson(ANNOTATIONS_FILE, data);
        sendJson(res, 200, { ok: true, item: data.items[key] });
      } else { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET, POST' }); }
      return;
    }

    if (p === '/api/reveal') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      if (!isTrustedLocalUiRequest(req)) { sendJson(res, 403, { error: '拒绝跨站操作' }); return; }
      const rel = url.searchParams.get('p') || '';
      let entry = resolveIndexedMedia(rel);
      if (!entry) {
        const documentEntry = safeExistingFile(ROOT, rel);
        const type = documentEntry ? classify(path.extname(documentEntry.abs).toLowerCase()) : null;
        if (documentEntry && type === 'doc') entry = documentEntry;
      }
      if (!entry) { sendJson(res, 404, { error: '文件不存在或来源已离线' }); return; }
      if (process.platform === 'win32') {
        execFile('explorer.exe', ['/select,', entry.abs], { windowsHide: true });
        sendJson(res, 200, { ok: true });
      } else if (process.platform === 'darwin') {
        execFile('open', ['-R', entry.abs], () => {});
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 200, { ok: false, message: '当前系统不支持定位文件' });
      }
      return;
    }

    if (p === '/api/events') {
      if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
      });
      res.write('retry: 5000\n\n');
      eventClients.add(res);
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(beat); } }, 25000);
      req.on('close', () => { clearInterval(beat); eventClients.delete(res); });
      return;
    }

    if (p.startsWith('/api/')) { sendJson(res, 404, { error: '未知接口' }); return; }

    if (req.method !== 'GET') { sendJson(res, 405, { error: '方法不允许' }, { Allow: 'GET' }); return; }

    // 静态文件：/ -> index.html，其余映射到 OS_DIR；data 只走受控 API。
    let relStatic;
    try { relStatic = decodeURIComponent(p === '/' ? 'index.html' : p.slice(1)); }
    catch { sendJson(res, 400, { error: '路径编码错误' }); return; }
    const staticEntry = safeExistingFile(OS_DIR, relStatic);
    const isBundledPrivateData = staticEntry && isWithin(BUNDLED_DATA_DIR, staticEntry.abs);
    const isConfiguredPrivateData = staticEntry && isWithin(OS_DIR, DATA_DIR) && isWithin(DATA_DIR, staticEntry.abs);
    if (!staticEntry || isBundledPrivateData || isConfiguredPrivateData) {
      sendJson(res, 404, { error: '资源不存在' }); return;
    }
    sendFile(req, res, staticEntry.abs);
  } catch (err) {
    sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

server.once('close', () => { editorExports.stop(); mediaSourceWatcher.stop(); });

function startServer(port = DEFAULT_PORT, attemptsLeft = 8, options = {}) {
  const shouldOpen = options.open === undefined ? SHOULD_OPEN : !!options.open;
  return new Promise((resolve, reject) => {
    const tryListen = (candidatePort, remaining) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && remaining > 0) {
          tryListen(candidatePort + 1, remaining - 1);
        } else {
          reject(err);
        }
      });
      server.listen(candidatePort, '127.0.0.1', () => {
        const addr = `http://localhost:${candidatePort}`;
        console.log('');
        console.log('  ╔══════════════════════════════════════╗');
        console.log('  ║        视频制作 OS  已启动            ║');
        console.log('  ╚══════════════════════════════════════╝');
        console.log(`  项目根目录：${ROOT}`);
        console.log(`  视频/音频素材：${ASSET_DIR}`);
        console.log(`  创作资产库：${CREATIVE_ASSET_DIR}`);
        console.log(`  OS 数据目录：${DATA_DIR}`);
        console.log(`  浏览器打开：${addr}`);
        console.log('  关闭本窗口或按 Ctrl+C 即可退出。');
        console.log('');
        if (shouldOpen && process.platform === 'win32') exec(`start "" "${addr}"`, { shell: 'cmd.exe' });
        else if (shouldOpen && process.platform === 'darwin') execFile('open', [addr], () => {});
        resolve({ server, port: candidatePort, url: addr });
      });
    };
    tryListen(port, attemptsLeft);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('启动失败：', err.message);
    process.exit(1);
  });
}

module.exports = {
  startServer,
  server,
  root: ROOT,
  assetDir: ASSET_DIR,
  creativeAssetDir: CREATIVE_ASSET_DIR,
  dataDir: DATA_DIR,
  obsidianVault: OBSIDIAN_VAULT,
  productionStore,
  productionStoreError,
  creativeProjectStore,
  editorExports,
  mediaSourceStore,
  mediaSourceWatcher,
  prepareMediaSourceRemoval,
  broadcastRescan,
  broadcastProduction,
  broadcastCreativeAssets,
  broadcastCreativeProjects,
};
