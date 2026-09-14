'use strict';

const fs = require('fs');
const path = require('path');
const { classifyCreativeAsset, resolveCreativeAsset } = require('./creative-assets.cjs');

const EXPORT_KINDS = Object.freeze([
  { id: 'voice', category: 'audio', type: 'audio', label: '人物音频' },
  { id: 'finals', category: 'finals', type: 'video', label: '成片' },
]);

function signature(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

// WAV / MP4 / M4A 在导出时会回写长度或索引；不能只凭文件已出现就收录。
// MP3 等流式格式没有完成标记，依靠连续稳定窗口和后续变化重新校验。
function readableExport(filename, stat) {
  if (stat.size <= 0) return false;
  let fd;
  try {
    fd = fs.openSync(filename, 'r');
    const header = Buffer.alloc(16);
    const count = fs.readSync(fd, header, 0, header.length, 0);
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.wav') {
      const riff = header.toString('ascii', 0, 4);
      return count >= 12 && header.toString('ascii', 8, 12) === 'WAVE'
        && (riff === 'RF64' || (riff === 'RIFF' && header.readUInt32LE(4) + 8 <= stat.size));
    }
    if (['.mp4', '.mov', '.m4a', '.m4v'].includes(ext)) {
      let offset = 0, movie = false, data = false;
      for (let boxes = 0; offset < stat.size && boxes < 100000; boxes++) {
        if (fs.readSync(fd, header, 0, 16, offset) < 8) return false;
        let length = header.readUInt32BE(0);
        const type = header.toString('ascii', 4, 8);
        const minLength = length === 1 ? 16 : 8;
        if (length === 1) length = Number(header.readBigUInt64BE(8));
        else if (length === 0) length = stat.size - offset;
        if (!Number.isSafeInteger(length) || length < minLength || offset + length > stat.size) return false;
        movie ||= type === 'moov';
        data ||= type === 'mdat';
        offset += length;
      }
      return offset === stat.size && movie && data;
    }
    if (ext === '.mp3' && header.toString('ascii', 0, 3) === 'ID3') {
      const tagLength = ((header[6] & 127) << 21) | ((header[7] & 127) << 14)
        | ((header[8] & 127) << 7) | (header[9] & 127);
      if (stat.size <= tagLength + 10) return false;
    }
    return count > 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function createEditorExportMonitor({ assetRoot, projectStore, stableMs = 4000,
  pollMs = 2000, now = Date.now, onChange = () => {} }) {
  const records = new Map();
  let folders = [], timer = null, initialized = false;

  function owner(relativePath, type) {
    return folders.find(folder => folder.type === type && relativePath.startsWith(`${folder.path}/`));
  }

  function observe(relativePath, stat, type) {
    const folder = owner(relativePath, type);
    if (!folder) return true;
    const key = signature(stat);
    let record = records.get(relativePath);
    if (!record || record.signature !== key) {
      const oldAtStartup = !initialized && Math.max(stat.mtimeMs, stat.ctimeMs) <= now() - stableMs;
      record = { signature: key, since: now(), ready: oldAtStartup
        && readableExport(path.join(assetRoot, ...relativePath.split('/')), stat) };
      records.set(relativePath, record);
    }
    if (!record.ready && now() - record.since >= stableMs) {
      record.ready = readableExport(path.join(assetRoot, ...relativePath.split('/')), stat);
    }
    return record.ready;
  }

  function refresh() {
    const before = JSON.stringify([...records].map(([key, item]) => [key, item.signature, item.ready]));
    folders = projectStore.list().filter(project => project.available).flatMap(project => EXPORT_KINDS.flatMap(kind => {
      const category = project.categories.find(item => item.id === kind.category);
      if (!category) return [];
      return [{ ...kind, path: category.path, absolutePath: path.join(assetRoot, ...category.path.split('/')),
        projectId: project.id, projectName: project.name }];
    }));
    const seen = new Set();
    let remaining = 20000;
    function walk(absolute, relative, depth = 0) {
      if (depth > 32 || remaining <= 0) return;
      let entries;
      try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (remaining-- <= 0) break;
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const rel = `${relative}/${entry.name}`;
        if (entry.isDirectory()) { walk(path.join(absolute, entry.name), rel, depth + 1); continue; }
        const type = classifyCreativeAsset(entry.name);
        if (!entry.isFile() || !owner(rel, type)) continue;
        const file = resolveCreativeAsset(assetRoot, rel, 'file');
        if (!file) continue;
        seen.add(rel);
        observe(rel, file.stat, type);
      }
    }
    for (const folder of folders) {
      const entry = resolveCreativeAsset(assetRoot, folder.path, 'folder');
      if (entry) walk(entry.abs, folder.path);
    }
    // 达到扫描上限时保留未访问记录，不能把未扫描误当成文件删除。
    if (remaining > 0) for (const key of records.keys()) if (!seen.has(key)) records.delete(key);
    initialized = true;
    const after = JSON.stringify([...records].map(([key, item]) => [key, item.signature, item.ready]));
    if (before !== after) onChange();
  }

  function snapshot(projectId) {
    refresh();
    const project = projectStore.get(projectId);
    if (!project?.available) throw new Error('剧本不存在或文件夹不可用');
    return { project: { id: project.id, name: project.name }, stableMs,
      folders: folders.filter(folder => folder.projectId === projectId).map(folder => {
        const items = [...records].filter(([rel]) => owner(rel, folder.type) === folder);
        return { ...folder, ready: items.filter(([, record]) => record.ready).length,
          pending: items.filter(([, record]) => !record.ready).length };
      }) };
  }

  return {
    refresh, snapshot, owner,
    includeFile(relativePath, stat, type) {
      const previous = records.get(relativePath);
      const before = previous ? `${previous.signature}:${previous.ready}` : '';
      const ready = observe(relativePath, stat, type);
      const next = records.get(relativePath);
      if (next && before !== `${next.signature}:${next.ready}`) onChange();
      return ready;
    },
    markComplete(relativePath) {
      const file = resolveCreativeAsset(assetRoot, relativePath, 'file');
      if (file) records.set(relativePath, { signature: signature(file.stat), since: now(), ready: true });
      onChange();
    },
    start() {
      if (timer) return;
      refresh();
      // 独立于 fs.watch：补上 macOS / Windows 漏报及软件关闭期间的导出。
      timer = setInterval(() => { try { refresh(); } catch (error) { console.warn('[editor-exports]', error.message); } }, pollMs);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createEditorExportMonitor, readableExport, EXPORT_KINDS };
