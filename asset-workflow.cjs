'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { setImmediate: yieldToMainLoop } = require('node:timers/promises');

const VIDEO_DISPOSITIONS = Object.freeze({ 待处理: 'processing', 可剪辑: 'editable' });
function generatedVideoLocation(project, relative) {
  const videoRoot = project?.categories?.find(category => category.id === 'generated-videos')?.path;
  if (!videoRoot || typeof relative !== 'string' || !relative.startsWith(`${videoRoot}/`)) return null;
  const parts = relative.slice(videoRoot.length + 1).split('/');
  if (VIDEO_DISPOSITIONS[parts[0]]) {
    return { videoRoot, legacy: true, videoDisposition: VIDEO_DISPOSITIONS[parts[0]], platformFolder: parts[1] || '', episode: null };
  }
  const match = /^第([1-9]\d{0,5})集$/.exec(parts[1] || '');
  if (!match) return { videoRoot, legacy: true, platformFolder: parts[0] || '', episode: null };
  const hasStatus = !!VIDEO_DISPOSITIONS[parts[2]];
  return { videoRoot, legacy: false, platformFolder: parts[0], episode: Number(match[1]),
    ...(hasStatus ? { videoDisposition: VIDEO_DISPOSITIONS[parts[2]] } : {}),
    subfolders: parts.slice(hasStatus ? 3 : 2, -1) };
}

// Additive metadata: old releases can ignore this file without a database downgrade.
function createAssetWorkflowStore({ filePath, assetRoot, registerAsset }) {
  let data = { version: 1, items: {} }, loadError = null;
  try {
    if (fs.existsSync(filePath)) {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.version !== 1 || !data.items || Array.isArray(data.items) || typeof data.items !== 'object') throw new Error('格式不正确');
    }
  } catch (error) { loadError = new Error(`素材整理记录无法读取，未修改文件：${error.message}`); }
  const within = (value, parent) => value === parent || value.startsWith(`${parent}/`);
  function flush() {
    if (loadError) throw loadError;
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx' });
      fs.renameSync(temporary, filePath);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function destination(project, relative) {
    const finals = project.categories.find(category => category.id === 'finals')?.path;
    if (finals && within(relative, finals)) return { assetRole: 'finals' };
    const location = generatedVideoLocation(project, relative);
    if (location?.videoDisposition) return { videoDisposition: location.videoDisposition, assetRole: 'material' };
    return {};
  }
  function ensure(project, relative, type, overrides = {}, forceNew = false) {
    if (loadError) throw loadError;
    let item = forceNew ? null : data.items[relative];
    if (!item) {
      const asset = registerAsset?.({ projectId: project.id, assetPath: path.join(assetRoot, ...relative.split('/')), kind: type, forceNew });
      item = data.items[relative] = { assetId: asset?.id || `asset-${crypto.randomUUID()}`, projectId: project.id, type,
        assetRole: 'material', ...(type === 'video' ? { videoDisposition: 'editable' } : {}), ...destination(project, relative) };
    }
    Object.assign(item, overrides);
    return { ...item };
  }
  return {
    filePath,
    destination,
    snapshot() { if (loadError) throw loadError; return JSON.parse(JSON.stringify(data)); },
    restore(snapshot) { data = JSON.parse(JSON.stringify(snapshot)); flush(); },
    get(relative) { if (loadError) throw loadError; return data.items[relative] ? { ...data.items[relative] } : null; },
    ensure,
    flush,
    enrich(tree, project) {
      if (!project) return tree;
      const before = Object.keys(data.items).length;
      function walk(node) {
        if (node.kind === 'file') Object.assign(node, ensure(project, node.path, node.type));
        else {
          const category = project.categories.find(entry => entry.path === node.path);
          if (category) node.categoryId = category.id;
          for (const child of node.children || []) walk(child);
        }
      }
      walk(tree.tree);
      if (Object.keys(data.items).length !== before) flush();
      return tree;
    },
    async enrichAsync(tree, project) {
      if (!project) return tree;
      let changed = false;
      const pending = [tree.tree];
      let visited = 0;
      while (pending.length) {
        const node = pending.pop();
        if (++visited % 32 === 0) await yieldToMainLoop();
        if (node.kind === 'file') {
          // A rename/delete can finish while directory I/O is in flight. Do not
          // recreate a registration for a path that has already disappeared.
          if (fs.existsSync(path.join(assetRoot, ...node.path.split('/')))) {
            if (!data.items[node.path]) changed = true;
            Object.assign(node, ensure(project, node.path, node.type));
          }
        } else {
          const category = project.categories.find(entry => entry.path === node.path);
          if (category) node.categoryId = category.id;
          pending.push(...(node.children || []));
        }
      }
      if (changed) flush();
      return tree;
    },
    relocate(project, oldPath, newPath, isFolder) {
      if (loadError) throw loadError;
      const moves = [];
      for (const current of Object.keys(data.items)) {
        if (current !== oldPath && (!isFolder || !current.startsWith(`${oldPath}/`))) continue;
        const next = newPath + current.slice(oldPath.length);
        const item = data.items[current];
        // A filename change is not an intentional quality reclassification.
        if (!isFolder && path.posix.dirname(oldPath) !== path.posix.dirname(newPath)) Object.assign(item, destination(project, next));
        data.items[next] = item;
        delete data.items[current];
        moves.push({ oldPath: current, path: next, assetId: item.assetId });
      }
      flush();
      return moves;
    },
    copy(project, source, target, type) {
      const original = ensure(project, source, type);
      const item = ensure(project, target, type, { assetRole: original.assetRole, videoDisposition: original.videoDisposition,
        sourceAssetId: original.assetId, ...destination(project, target) }, true);
      flush();
      return item;
    },
  };
}

module.exports = { createAssetWorkflowStore, generatedVideoLocation };
