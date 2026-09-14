'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const MEDIA_SOURCE_CONFIG_VERSION = 1;
const PROJECT_MEDIA_SOURCE_ID = 'project-assets';
const DEFAULT_MAX_MEDIA_SOURCES = 16;
const DEFAULT_MAX_MEDIA_ENTRIES = 50000;
const DEFAULT_MAX_MEDIA_DEPTH = 32;
const MAX_MEDIA_SOURCE_CONFIG_BYTES = 256 * 1024;
const MAX_MEDIA_SOURCE_LABEL_LENGTH = 80;
const MEDIA_SOURCE_ID_PATTERN = /^source-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_SOURCE_KINDS = Object.freeze(['folder', 'downloads']);
const MEDIA_SOURCE_EXTENSIONS = Object.freeze({
  video: Object.freeze(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']),
  image: Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']),
  audio: Object.freeze(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.amr', '.ape']),
});
const PROJECT_MEDIA_TYPES = Object.freeze(['video', 'audio']);
const EXTERNAL_MEDIA_TYPES = Object.freeze(['image', 'video', 'audio']);
const UNSAFE_LABEL_CHARACTERS = /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules']);

const EXTENSION_TO_TYPE = new Map();
for (const [type, extensions] of Object.entries(MEDIA_SOURCE_EXTENSIONS)) {
  for (const extension of extensions) EXTENSION_TO_TYPE.set(extension, type);
}

class InvalidMediaSourceConfigError extends Error {}
class UnsupportedMediaSourceConfigError extends Error {}

function isWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function pathsOverlap(first, second) {
  return isWithin(first, second) || isWithin(second, first);
}

function samePath(first, second) {
  return path.resolve(first) === path.resolve(second);
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error(`${label}必须使用有效的绝对路径`);
  }
  return path.resolve(value);
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}必须是正整数`);
  return number;
}

function nonNegativeInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label}必须是非负整数`);
  return number;
}

function normalizeMediaSourceLabel(value) {
  const label = String(value ?? '').normalize('NFC').trim().replace(/[\t ]+/g, ' ');
  if (!label) throw new Error('请输入素材来源名称');
  if (UNSAFE_LABEL_CHARACTERS.test(label)) throw new Error('素材来源名称不能包含路径分隔符或控制字符');
  if (label === '.' || label === '..') throw new Error('素材来源名称无效');
  if ([...label].length > MAX_MEDIA_SOURCE_LABEL_LENGTH) {
    throw new Error(`素材来源名称不能超过 ${MAX_MEDIA_SOURCE_LABEL_LENGTH} 个字符`);
  }
  return label;
}

function normalizeMediaRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (parts.some(part => SKIPPED_DIRECTORY_NAMES.has(part.toLowerCase()))) return null;
  return parts.join('/');
}

function classifyMediaFile(filenameOrExtension) {
  const value = String(filenameOrExtension || '').toLowerCase();
  const extension = value.startsWith('.') && !value.includes('/') && !value.includes('\\')
    ? value
    : path.extname(value);
  return EXTENSION_TO_TYPE.get(extension) || null;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function assetKeyFor(sourceId, relativePath) {
  const digest = createHash('sha256').update(sourceId).update('\0').update(relativePath).digest('hex');
  return `media-${digest}`;
}

function identityPath(value) {
  const resolved = path.resolve(value);
  let cursor = resolved;
  const missingSegments = [];
  while (true) {
    try {
      return path.resolve(fs.realpathSync(cursor), ...missingSegments);
    } catch (error) {
      const parent = path.dirname(cursor);
      if (!error || error.code !== 'ENOENT' || parent === cursor) return resolved;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function hasProtectedSegment(rootPath) {
  const parsed = path.parse(rootPath);
  const relative = path.relative(parsed.root, rootPath);
  return relative.split(path.sep).some(segment => {
    const normalized = segment.toLowerCase();
    return normalized === '.git' || normalized === 'node_modules';
  });
}

function hasSymlinkSegment(root, candidate) {
  const relative = path.relative(root, candidate);
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

function nextBackupPath(filePath) {
  const base = `${filePath}.corrupt-${Date.now()}`;
  if (!fs.existsSync(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('无法为损坏的媒体来源配置生成备份文件名');
}

function persistedDocument(sources) {
  return {
    version: MEDIA_SOURCE_CONFIG_VERSION,
    sources: sources.map(({ id, label, rootPath, kind }) => ({ id, label, rootPath, kind })),
  };
}

function writeConfigAtomically(filePath, sources) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const payload = `${JSON.stringify(persistedDocument(sources), null, 2)}\n`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, payload, 'utf-8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
    try {
      const directoryDescriptor = fs.openSync(directory, 'r');
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } catch {}
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function createMediaSourceStore(options = {}) {
  const filePath = absolutePath(options.filePath, '媒体来源配置文件');
  const requestedProjectRoot = absolutePath(options.projectRoot, '项目根目录');
  const requestedProjectAssetRoot = absolutePath(options.projectAssetRoot, '项目素材库目录');
  const requestedHomeRoot = absolutePath(options.homeRoot, '用户主目录');
  const maxSources = positiveInteger(options.maxSources, DEFAULT_MAX_MEDIA_SOURCES, '媒体来源数量上限');
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_MEDIA_ENTRIES, '媒体扫描条目上限');
  const maxDepth = nonNegativeInteger(options.maxDepth, DEFAULT_MAX_MEDIA_DEPTH, '媒体扫描深度上限');
  const maxConfigBytes = positiveInteger(
    options.maxConfigBytes,
    MAX_MEDIA_SOURCE_CONFIG_BYTES,
    '媒体来源配置文件大小上限',
  );
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : randomUUID;
  const onWarning = typeof options.onWarning === 'function' ? options.onWarning : () => {};

  let projectRoot;
  try {
    const stat = fs.lstatSync(requestedProjectRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('项目根目录不是安全的普通目录');
    projectRoot = fs.realpathSync(requestedProjectRoot);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error('项目根目录不存在');
    throw error;
  }

  if (!isWithin(requestedProjectRoot, requestedProjectAssetRoot)) {
    throw new Error('项目素材库目录必须位于项目根目录内');
  }

  let projectAssetRoot = requestedProjectAssetRoot;
  try {
    const stat = fs.lstatSync(requestedProjectAssetRoot);
    if (!stat.isSymbolicLink() && stat.isDirectory()) {
      const real = fs.realpathSync(requestedProjectAssetRoot);
      if (!isWithin(projectRoot, real)) throw new Error('项目素材库真实路径越出了项目根目录');
      projectAssetRoot = real;
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  const homeRoot = identityPath(requestedHomeRoot);
  const dataRoot = identityPath(path.dirname(filePath));
  const osRoot = identityPath(path.dirname(__dirname));
  const protectedProjectRoots = [
    identityPath(path.join(projectRoot, '.git')),
    identityPath(path.join(projectRoot, 'node_modules')),
  ];
  const projectSource = Object.freeze({
    id: PROJECT_MEDIA_SOURCE_ID,
    label: '项目素材库',
    rootPath: projectAssetRoot,
    kind: 'project',
    builtIn: true,
  });

  let loaded = false;
  let sources = [];
  let storeStatus = { warning: '', recovered: false, writable: true };

  function warn(message) {
    storeStatus.warning = message;
    try { onWarning(message); } catch {}
  }

  function assertAllowedRoot(rootPath) {
    const resolved = path.resolve(rootPath);
    const identity = identityPath(resolved);
    if (samePath(identity, path.parse(identity).root)) throw new Error('不能把文件系统根目录设为素材来源');
    if (samePath(identity, homeRoot)) throw new Error('不能扫描整个用户主目录，请选择一个明确的子目录');
    if (samePath(identity, projectRoot)) throw new Error('不能扫描整个项目根目录，请使用项目素材库');
    if (pathsOverlap(identity, osRoot)) throw new Error('视频制作 OS 程序目录不能作为素材来源');
    if (pathsOverlap(identity, dataRoot)) throw new Error('视频制作 OS 数据目录不能作为素材来源');
    if (hasProtectedSegment(resolved) || protectedProjectRoots.some(root => pathsOverlap(identity, root))) {
      throw new Error('.git 和 node_modules 目录不能作为素材来源');
    }
    return identity;
  }

  function assertNoOverlap(rootPath, existingSources) {
    const candidateLexical = path.resolve(rootPath);
    const candidateIdentity = identityPath(candidateLexical);
    for (const source of [projectSource, ...existingSources]) {
      const existingLexical = path.resolve(source.rootPath);
      const existingIdentity = identityPath(existingLexical);
      if (
        pathsOverlap(candidateLexical, existingLexical)
        || pathsOverlap(candidateIdentity, existingIdentity)
      ) {
        throw new Error(`素材来源与“${source.label}”重复或存在父子目录重叠`);
      }
    }
  }

  function validatePersistedDocument(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new InvalidMediaSourceConfigError('配置根节点必须是对象');
    }
    if (document.version > MEDIA_SOURCE_CONFIG_VERSION) {
      throw new UnsupportedMediaSourceConfigError(`不支持的媒体来源配置版本：${String(document.version)}`);
    }
    if (document.version !== MEDIA_SOURCE_CONFIG_VERSION) {
      throw new InvalidMediaSourceConfigError(`媒体来源配置版本无效：${String(document.version)}`);
    }
    if (!Array.isArray(document.sources)) throw new InvalidMediaSourceConfigError('sources 必须是数组');
    if (document.sources.length > maxSources) {
      throw new InvalidMediaSourceConfigError(`媒体来源数量超过上限 ${maxSources}`);
    }

    const validated = [];
    const ids = new Set();
    const labels = new Set();
    let downloadsCount = 0;
    for (let index = 0; index < document.sources.length; index++) {
      const entry = document.sources[index];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new InvalidMediaSourceConfigError(`第 ${index + 1} 个媒体来源格式无效`);
      }
      const id = String(entry.id || '').trim().toLowerCase();
      if (!MEDIA_SOURCE_ID_PATTERN.test(id)) {
        throw new InvalidMediaSourceConfigError(`第 ${index + 1} 个媒体来源 ID 无效`);
      }
      let label;
      let rootPath;
      try {
        label = normalizeMediaSourceLabel(entry.label);
        rootPath = absolutePath(entry.rootPath, `第 ${index + 1} 个媒体来源目录`);
        rootPath = assertAllowedRoot(rootPath);
      } catch (error) {
        throw new InvalidMediaSourceConfigError(`第 ${index + 1} 个媒体来源无效：${error.message}`);
      }
      const kind = String(entry.kind || '');
      if (!MEDIA_SOURCE_KINDS.includes(kind)) {
        throw new InvalidMediaSourceConfigError(`第 ${index + 1} 个媒体来源类型无效`);
      }
      if (kind === 'downloads' && ++downloadsCount > 1) {
        throw new InvalidMediaSourceConfigError('Downloads 来源只能添加一次');
      }
      const labelKey = label.toLocaleLowerCase('zh-CN');
      if (ids.has(id)) throw new InvalidMediaSourceConfigError(`存在重复的媒体来源 ID：${id}`);
      if (labels.has(labelKey)) throw new InvalidMediaSourceConfigError(`存在重复的媒体来源名称：${label}`);
      try { assertNoOverlap(rootPath, validated); }
      catch (error) { throw new InvalidMediaSourceConfigError(error.message); }
      ids.add(id);
      labels.add(labelKey);
      validated.push({ id, label, rootPath, kind, builtIn: false });
    }
    return validated;
  }

  function recoverDamagedConfig(reason) {
    try {
      const backupPath = nextBackupPath(filePath);
      fs.renameSync(filePath, backupPath);
      storeStatus = { warning: '', recovered: true, writable: true };
      warn(`媒体来源配置已损坏，已备份并恢复为空配置：${reason}`);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        storeStatus = { warning: '', recovered: true, writable: true };
        warn(`媒体来源配置读取时已移除，已恢复为空配置：${reason}`);
        return;
      }
      storeStatus = { warning: '', recovered: false, writable: false };
      warn('媒体来源配置已损坏且无法安全备份；本次仅使用项目素材库');
    }
  }

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        storeStatus = { warning: '', recovered: false, writable: false };
        warn('媒体来源配置路径不是安全的普通文件；本次仅使用项目素材库');
        return;
      }
      if (stat.size > maxConfigBytes) {
        recoverDamagedConfig(`配置文件超过 ${maxConfigBytes} 字节`);
        return;
      }
      let document;
      try { document = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
      catch { recoverDamagedConfig('JSON 无法解析'); return; }
      try { sources = validatePersistedDocument(document); }
      catch (error) {
        if (error instanceof UnsupportedMediaSourceConfigError) {
          storeStatus = { warning: '', recovered: false, writable: false };
          warn(`${error.message}；为避免覆盖较新版本数据，本次仅使用项目素材库`);
          return;
        }
        recoverDamagedConfig(error.message);
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      storeStatus = { warning: '', recovered: false, writable: false };
      warn('媒体来源配置无法读取；本次仅使用项目素材库');
    }
  }

  function assertWritable() {
    loadOnce();
    if (!storeStatus.writable) throw new Error(storeStatus.warning || '媒体来源配置当前不可写');
  }

  function sourceMediaTypes(source) {
    return source.builtIn ? PROJECT_MEDIA_TYPES : EXTERNAL_MEDIA_TYPES;
  }

  function sourceHealth(source) {
    try {
      const stat = fs.lstatSync(source.rootPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return { available: false, status: 'offline', realRoot: '' };
      }
      fs.accessSync(source.rootPath, fs.constants.R_OK | fs.constants.X_OK);
      const realRoot = fs.realpathSync(source.rootPath);
      if (source.builtIn) {
        if (!isWithin(projectRoot, realRoot)) return { available: false, status: 'offline', realRoot: '' };
      } else {
        try { assertAllowedRoot(realRoot); }
        catch { return { available: false, status: 'offline', realRoot: '' }; }
      }
      return { available: true, status: 'online', realRoot };
    } catch {
      return { available: false, status: 'offline', realRoot: '' };
    }
  }

  function publicSource(source, health = sourceHealth(source), downloadsIdentity = '') {
    return {
      id: source.id,
      token: source.id,
      label: source.label,
      kind: source.kind,
      builtIn: !!source.builtIn,
      removable: !source.builtIn,
      mediaTypes: [...sourceMediaTypes(source)],
      available: health.available,
      status: health.status,
      isDownloads: source.kind === 'downloads' || (
        !!downloadsIdentity
        && !!health.realRoot
        && samePath(downloadsIdentity, health.realRoot)
      ),
    };
  }

  function downloadsIdentityFrom(value) {
    if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return '';
    try {
      const stat = fs.lstatSync(value);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return '';
      return fs.realpathSync(value);
    } catch {
      return '';
    }
  }

  function createId() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const token = String(idFactory() || '').trim().toLowerCase();
      const id = token.startsWith('source-') ? token : `source-${token}`;
      if (!MEDIA_SOURCE_ID_PATTERN.test(id)) throw new Error('媒体来源 ID 生成器返回了无效 UUID');
      if (!sources.some(source => source.id === id)) return id;
    }
    throw new Error('无法生成唯一的媒体来源 ID');
  }

  function findSource(sourceId) {
    const id = String(sourceId || '').trim().toLowerCase();
    if (id === PROJECT_MEDIA_SOURCE_ID) return projectSource;
    if (!MEDIA_SOURCE_ID_PATTERN.test(id)) return null;
    return sources.find(source => source.id === id) || null;
  }

  function list(listOptions = {}) {
    loadOnce();
    if (!listOptions || typeof listOptions !== 'object' || Array.isArray(listOptions)) {
      throw new Error('媒体来源列表参数格式无效');
    }
    const downloadsIdentity = downloadsIdentityFrom(listOptions.downloadsPath);
    return [projectSource, ...sources].map(source => publicSource(source, sourceHealth(source), downloadsIdentity));
  }

  function addDirectory(input = {}) {
    assertWritable();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('媒体来源信息格式无效');
    const label = normalizeMediaSourceLabel(input.label);
    const kind = String(input.kind || 'folder');
    if (!MEDIA_SOURCE_KINDS.includes(kind)) throw new Error('媒体来源类型只能是 folder 或 downloads');
    if (kind === 'downloads' && sources.some(source => source.kind === 'downloads')) {
      throw new Error('Downloads 来源只能添加一次');
    }
    const requestedRoot = absolutePath(input.rootPath, '媒体来源目录');
    let rootPath;
    try {
      const stat = fs.lstatSync(requestedRoot);
      if (stat.isSymbolicLink()) throw new Error('素材来源根目录不能是符号链接');
      if (!stat.isDirectory()) throw new Error('素材来源必须是现有目录');
      rootPath = fs.realpathSync(requestedRoot);
    } catch (error) {
      if (error && error.code === 'ENOENT') throw new Error('素材来源目录不存在');
      throw error;
    }
    rootPath = assertAllowedRoot(rootPath);
    assertNoOverlap(rootPath, sources);
    const labelKey = label.toLocaleLowerCase('zh-CN');
    if (sources.some(source => source.label.toLocaleLowerCase('zh-CN') === labelKey)) {
      throw new Error(`媒体来源名称已存在：${label}`);
    }
    if (sources.length >= maxSources) throw new Error(`外部媒体来源最多只能添加 ${maxSources} 个`);
    const source = { id: createId(), label, rootPath, kind, builtIn: false };
    const next = [...sources, source];
    writeConfigAtomically(filePath, next);
    sources = next;
    storeStatus = { warning: '', recovered: false, writable: true };
    return publicSource(source);
  }

  function remove(sourceId) {
    assertWritable();
    const id = String(sourceId || '').trim().toLowerCase();
    if (id === PROJECT_MEDIA_SOURCE_ID) throw new Error('项目素材库是内置来源，不能删除');
    if (!MEDIA_SOURCE_ID_PATTERN.test(id)) throw new Error('媒体来源 ID 无效');
    const index = sources.findIndex(source => source.id === id);
    if (index < 0) throw new Error('媒体来源不存在或已被删除');
    const removed = sources[index];
    const next = sources.filter((_source, sourceIndex) => sourceIndex !== index);
    writeConfigAtomically(filePath, next);
    sources = next;
    storeStatus = { warning: '', recovered: false, writable: true };
    return publicSource(removed);
  }

  function resolveFile(sourceId, relativePath) {
    loadOnce();
    const source = findSource(sourceId);
    const normalized = normalizeMediaRelativePath(relativePath);
    if (!source || !normalized) return null;
    const type = classifyMediaFile(normalized);
    if (!type || !sourceMediaTypes(source).includes(type)) return null;
    const health = sourceHealth(source);
    if (!health.available) return null;
    const candidate = path.resolve(health.realRoot, ...normalized.split('/'));
    if (!isWithin(health.realRoot, candidate) || hasSymlinkSegment(health.realRoot, candidate)) return null;
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      const real = fs.realpathSync(candidate);
      if (!isWithin(health.realRoot, real)) return null;
      return {
        sourceId: source.id,
        sourceToken: source.id,
        relativePath: normalized,
        assetKey: assetKeyFor(source.id, normalized),
        type,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        absolutePath: real,
      };
    } catch {
      return null;
    }
  }

  function scan() {
    loadOnce();
    const allSources = [projectSource, ...sources];
    const files = [];
    const sourceResults = [];
    const counts = { video: 0, image: 0, audio: 0 };
    let remainingEntries = maxEntries;
    let truncated = false;

    for (const source of allSources) {
      const health = sourceHealth(source);
      const sourceCounts = { video: 0, image: 0, audio: 0 };
      let sourceTruncated = false;
      let readErrors = 0;
      const startingFileCount = files.length;
      const allowedTypes = new Set(sourceMediaTypes(source));

      const walk = (absoluteDirectory, relativeDirectory, depth) => {
        let entries;
        try { entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true }); }
        catch { readErrors++; return; }
        entries.sort((first, second) => first.name.localeCompare(second.name, 'zh-CN'));
        for (const entry of entries) {
          if (remainingEntries <= 0) {
            sourceTruncated = true;
            truncated = true;
            break;
          }
          remainingEntries--;
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue;
          const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
          const absolutePath = path.join(absoluteDirectory, entry.name);
          if (entry.isDirectory()) {
            if (depth >= maxDepth) {
              sourceTruncated = true;
              truncated = true;
              continue;
            }
            walk(absolutePath, relativePath, depth + 1);
            if (remainingEntries <= 0) break;
            continue;
          }
          if (!entry.isFile()) continue;
          const type = classifyMediaFile(entry.name);
          if (!type || !allowedTypes.has(type)) continue;
          let stat;
          try {
            stat = fs.lstatSync(absolutePath);
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
          } catch {
            readErrors++;
            continue;
          }
          const extension = path.extname(entry.name).toLowerCase();
          const assetKey = assetKeyFor(source.id, relativePath);
          files.push({
            sourceId: source.id,
            sourceToken: source.id,
            sourceLabel: source.label,
            relativePath,
            displayPath: `${source.label}/${relativePath}`,
            assetKey,
            name: entry.name,
            ext: extension,
            type,
            size: stat.size,
            sizeText: formatBytes(stat.size),
            mtime: stat.mtime.toISOString(),
          });
          sourceCounts[type]++;
          counts[type]++;
        }
      };

      if (health.available) {
        if (remainingEntries <= 0) {
          sourceTruncated = true;
          truncated = true;
        } else {
          walk(health.realRoot, '', 0);
        }
      }

      const status = !health.available ? 'offline' : readErrors > 0 ? 'partial' : 'online';
      sourceResults.push({
        ...publicSource(source, { ...health, status }),
        status,
        fileCount: files.length - startingFileCount,
        counts: sourceCounts,
        truncated: sourceTruncated,
        readErrors,
      });
    }

    files.sort((first, second) => (
      second.mtime.localeCompare(first.mtime)
      || first.assetKey.localeCompare(second.assetKey)
    ));
    return {
      scannedAt: new Date().toISOString(),
      counts,
      files,
      sources: sourceResults,
      truncated,
      maxDepth,
      maxEntries,
    };
  }

  return Object.freeze({
    list,
    // 仅供本地主进程使用；公开来源列表继续不暴露绝对路径。
    directory(sourceId) {
      loadOnce();
      const source = findSource(sourceId);
      return source ? sourceHealth(source).realRoot || '' : '';
    },
    addDirectory,
    remove,
    resolveFile,
    scan,
    status() {
      loadOnce();
      return { ...storeStatus };
    },
  });
}

module.exports = {
  MEDIA_SOURCE_CONFIG_VERSION,
  PROJECT_MEDIA_SOURCE_ID,
  DEFAULT_MAX_MEDIA_SOURCES,
  DEFAULT_MAX_MEDIA_ENTRIES,
  DEFAULT_MAX_MEDIA_DEPTH,
  MAX_MEDIA_SOURCE_CONFIG_BYTES,
  MAX_MEDIA_SOURCE_LABEL_LENGTH,
  MEDIA_SOURCE_ID_PATTERN,
  MEDIA_SOURCE_KINDS,
  MEDIA_SOURCE_EXTENSIONS,
  PROJECT_MEDIA_TYPES,
  EXTERNAL_MEDIA_TYPES,
  normalizeMediaSourceLabel,
  normalizeMediaRelativePath,
  classifyMediaFile,
  createMediaSourceStore,
};
