'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeFilename } = require('./download-router.cjs');

const MEDIA_KINDS = new Set(['image', 'video', 'audio']);
const MAX_EPISODE = 999999;

function episodeNumber(value = 1) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EPISODE) throw new Error('集号必须是 1—999999 的整数');
  return value;
}

function episodeLabel(value) { return `第${episodeNumber(value)}集`; }

function scopeOf(value = {}) {
  const projectId = String(value.projectId || '').trim();
  const serviceId = String(value.serviceId || '').trim();
  if (!projectId || !serviceId || projectId.length > 200 || serviceId.length > 200 || /[\u0000-\u001f]/.test(projectId + serviceId)) {
    throw new Error('下载分集所属剧本或网站无效');
  }
  if (!MEDIA_KINDS.has(value.kind)) throw new Error('该下载类型不支持分集');
  return { projectId, serviceId, kind: value.kind };
}

function platformFolderOf(value) {
  const folder = String(value || '');
  if (!folder || folder !== sanitizeFilename(folder) || folder.startsWith('.') || Buffer.byteLength(folder, 'utf8') > 240) {
    throw new Error('下载网站文件夹名称无效');
  }
  return folder;
}

function normalizeSnapshot(value) {
  const scope = scopeOf(value);
  return Object.freeze({ ...scope, episode: episodeNumber(value.episode), platformFolder: platformFolderOf(value.platformFolder) });
}

function scopeKey(scope) { return JSON.stringify([scope.projectId, scope.serviceId, scope.kind]); }

// Every read uses the in-memory document. Only a download snapshot or an explicit
// "next episode" click writes; rendering all website rows never reads the disk.
function createDownloadEpisodeStore({ filePath } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('下载分集记录必须使用绝对路径');
  let entries = new Map();
  if (fs.existsSync(filePath)) {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error('下载分集记录不能是符号链接');
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved?.version !== 1 || !Array.isArray(saved.entries)) throw new Error('下载分集记录格式无效，原文件已保留');
    for (const record of saved.entries) {
      const normalized = normalizeSnapshot(record), key = scopeKey(normalized);
      if (entries.has(key)) throw new Error('下载分集记录重复，原文件已保留');
      entries.set(key, normalized);
    }
  }
  const persist = next => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: [...next.values()] }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filePath);
      entries = next;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  const get = info => {
    const scope = scopeOf(info), key = scopeKey(scope);
    if (entries.has(key)) return { ...entries.get(key) };
    let platformFolder = sanitizeFilename(info.platformFolder || info.serviceLabel || scope.serviceId);
    // Distinct sites whose labels sanitize to the same filesystem component
    // must still have different archives. Existing registered roots stay fixed.
    if ([...entries.values()].some(other => other.projectId === scope.projectId && other.kind === scope.kind
      && other.serviceId !== scope.serviceId && other.platformFolder.toLocaleLowerCase() === platformFolder.toLocaleLowerCase())) {
      platformFolder = sanitizeFilename(`${platformFolder} (${scope.serviceId})`);
    }
    return { ...scope, episode: 1, platformFolder: platformFolderOf(platformFolder) };
  };
  return Object.freeze({
    get,
    list(projectId) { return [...entries.values()].filter(entry => entry.projectId === projectId).map(entry => ({ ...entry })); },
    capture(info) {
      const snapshot = normalizeSnapshot(get(info)), key = scopeKey(snapshot);
      if (!entries.has(key)) { const next = new Map(entries); next.set(key, snapshot); persist(next); }
      return snapshot;
    },
    renamePlatform(info, platformFolder) {
      const current = get(info);
      const renamed = normalizeSnapshot({ ...current, platformFolder });
      if (renamed.platformFolder === current.platformFolder) return { ...current };
      if ([...entries.values()].some(other => other.projectId === current.projectId && other.kind === current.kind
        && other.serviceId !== current.serviceId && other.platformFolder.toLocaleLowerCase() === renamed.platformFolder.toLocaleLowerCase())) {
        throw new Error('该下载网站目录已属于另一个网站');
      }
      const next = new Map(entries); next.set(scopeKey(renamed), renamed); persist(next);
      return { ...renamed };
    },
    advance(info, { create } = {}) {
      if (typeof create !== 'function') throw new Error('下载分集文件夹配置无效');
      const current = get(info);
      if (info.expectedEpisode !== undefined && episodeNumber(info.expectedEpisode) !== current.episode) {
        return { state: current, advanced: false };
      }
      const nextSnapshot = normalizeSnapshot({ ...current, episode: current.episode + 1 });
      // Folder creation validates the current project/category in the caller.
      // Existing genuine folders are reused so 第1集 -> 第2集 never skips a
      // number. The caller rejects a file/symlink; no previous files are moved.
      // A failure does not advance the saved cursor.
      create(current);
      create(nextSnapshot);
      const next = new Map(entries); next.set(scopeKey(nextSnapshot), nextSnapshot); persist(next);
      return { state: { ...nextSnapshot }, advanced: true };
    },
    select(info, { exists } = {}) {
      if (typeof exists !== 'function') throw new Error('已有集文件夹检查配置无效');
      const current = get(info);
      if (info.expectedEpisode !== undefined && episodeNumber(info.expectedEpisode) !== current.episode) {
        return { state: current, selected: false };
      }
      const chosen = normalizeSnapshot({ ...current, episode: episodeNumber(info.episode) });
      if (!exists(chosen)) throw new Error('所选集文件夹不存在或不是可用真实目录');
      if (chosen.episode === current.episode) return { state: current, selected: false };
      const next = new Map(entries); next.set(scopeKey(chosen), chosen); persist(next);
      return { state: { ...chosen }, selected: true };
    },
  });
}

const DOWNLOAD_EPISODE_CATEGORIES = Object.freeze({ image: 'generated-images', video: 'generated-videos', audio: 'audio' });
function downloadEpisodeBatch({ project, store, services, existingEpisodes = () => [] }) {
  if (!project) return { projectId: '', states: [] };
  const catalog = new Map((services || []).map(service => [service.id, service]));
  const scopes = new Map();
  for (const service of catalog.values()) for (const kind of MEDIA_KINDS) {
    scopes.set(scopeKey({ projectId: project.id, serviceId: service.id, kind }), { projectId: project.id, serviceId: service.id, kind, serviceLabel: service.label });
  }
  for (const saved of store.list(project.id)) scopes.set(scopeKey(saved), saved);
  const states = [...scopes.values()].map(scope => {
    const service = catalog.get(scope.serviceId), state = store.get(scope);
    const category = project.categories?.find(item => item.id === DOWNLOAD_EPISODE_CATEGORIES[scope.kind]);
    const platformPath = category ? `${category.path}/${state.platformFolder}` : '';
    return { ...state, serviceLabel: service?.label || state.platformFolder, label: episodeLabel(state.episode), platformPath,
      episodePath: platformPath ? `${platformPath}/${episodeLabel(state.episode)}` : '',
      available: !!(project.available && category?.available), legacy: false,
      archived: !service, hidden: !!service?.hidden, downloadable: !!service && !service.hidden,
      archiveOnly: !service || !!service.hidden,
      existingEpisodes: platformPath ? existingEpisodes(platformPath) : [] };
  });
  return { projectId: project.id, states };
}

module.exports = { MEDIA_KINDS, MAX_EPISODE, DOWNLOAD_EPISODE_CATEGORIES, episodeNumber, episodeLabel, normalizeSnapshot, createDownloadEpisodeStore, downloadEpisodeBatch };
