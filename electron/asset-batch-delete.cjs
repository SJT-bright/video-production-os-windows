'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setImmediate: yieldToMainLoop } = require('node:timers/promises');
const { normalizeRelativePath, resolveCreativeAsset } = require('../creative-assets.cjs');

const MAX_BATCH_DELETE = 1000;
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const directoryIdentity = stat => `${stat.dev}:${stat.ino}:${stat.mode}`;
const fileIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

// One coordinator is shared by both desktop surfaces. Confirmation and Trash are
// injected so cancellation, project switches and partial OS failures can be
// exercised using temporary files, without touching an installed application.
function createAssetBatchDelete({ libraryRoot, getActiveProject, getProjectEpoch = () => 0,
  getProtectedPaths = () => [], trash, onDeleted = () => {}, broadcast = () => {}, onWarning = () => {} }) {
  if (!path.isAbsolute(libraryRoot || '') || typeof getActiveProject !== 'function' || typeof trash !== 'function') {
    throw new Error('批量删除配置无效');
  }
  let busy = false;
  const warn = error => { try { onWarning(error); } catch {} };

  const inspect = (relative, project, baseline = null) => {
    if (!relative || relative !== normalizeRelativePath(relative) || !relative.startsWith(`${project.folder}/`)) {
      throw new Error('资产不属于指定剧本或路径无效');
    }
    const downloadCategory = project.categories?.find(category => category.id === 'browser-downloads')?.path;
    if (downloadCategory && (relative === downloadCategory || relative.startsWith(`${downloadCategory}/`))) {
      throw new Error('浏览器下载文件请使用其专用删除操作');
    }
    const rootStat = fs.lstatSync(libraryRoot, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('创作资产库目录已变更');
    const realRoot = fs.realpathSync.native(libraryRoot);
    const projectRoot = path.resolve(realRoot, project.folder);
    if (!within(realRoot, projectRoot) || projectRoot === realRoot) throw new Error('剧本目录无效');
    const entry = resolveCreativeAsset(libraryRoot, relative, 'file');
    if (!entry || !within(projectRoot, entry.abs)) throw new Error('只能删除剧本内的真实文件，不能删除目录或符号链接');
    const ancestors = [directoryIdentity(rootStat)];
    let ancestor = realRoot;
    for (const part of relative.split('/').slice(0, -1)) {
      ancestor = path.join(ancestor, part);
      const stat = fs.lstatSync(ancestor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('资产目录已变更或包含符号链接');
      ancestors.push(directoryIdentity(stat));
    }
    const stat = fs.lstatSync(entry.abs, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('只能删除真实文件资产');
    const candidate = { path: relative, absolutePath: entry.abs, identity: fileIdentity(stat), ancestors: ancestors.join('/') };
    if (baseline && (candidate.absolutePath !== baseline.absolutePath || candidate.identity !== baseline.identity || candidate.ancestors !== baseline.ancestors)) {
      throw new Error('确认期间文件或目录已变更，未执行删除');
    }
    for (const protectedPath of getProtectedPaths() || []) {
      if (typeof protectedPath !== 'string' || !path.isAbsolute(protectedPath)) continue;
      if (path.resolve(protectedPath) === candidate.absolutePath) throw new Error('文件仍在下载或等待归档，请完成或取消后再删除');
      try {
        if (fs.realpathSync.native(protectedPath) === candidate.absolutePath) {
          throw new Error('文件仍在下载或等待归档，请完成或取消后再删除');
        }
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    return candidate;
  };

  return Object.freeze({
    async deleteItems(payload, { confirm, isAlive = () => true } = {}) {
      if (busy) throw new Error('已有批量删除正在执行，请等待完成');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.paths)
        || !payload.paths.length || payload.paths.length > MAX_BATCH_DELETE || payload.paths.some(item => typeof item !== 'string')) {
        throw new Error(`请选择 1 至 ${MAX_BATCH_DELETE} 个文件；超过上限时不会截断或删除`);
      }
      if (typeof confirm !== 'function' || typeof payload.projectId !== 'string' || !payload.projectId) throw new Error('批量删除缺少剧本身份或确认步骤');
      const project = getActiveProject();
      if (!project || project.available === false || project.id !== payload.projectId || typeof project.folder !== 'string') {
        throw new Error('剧本已切换，请重新选择素材');
      }
      const epoch = getProjectEpoch();
      const projectSnapshot = { id: project.id, folder: project.folder, name: project.name,
        categories: (project.categories || []).map(category => ({ id: category.id, path: category.path })) };
      const paths = [...new Set(payload.paths.map(value => normalizeRelativePath(value) || value))];
      const result = { projectId: project.id, requested: paths.length, cancelled: false, deleted: [], failed: [] };
      const stillCurrent = () => {
        const current = getActiveProject();
        return !!isAlive() && current?.available !== false && current?.id === projectSnapshot.id
          && current?.folder === projectSnapshot.folder && getProjectEpoch() === epoch;
      };
      const remainingCancelled = (items, message) => {
        result.cancelled = true;
        result.failed.push(...items.map(item => ({ path: item.path, error: message })));
      };
      busy = true;
      try {
        const items = [], physicalPaths = new Set();
        for (let index = 0; index < paths.length; index++) {
          const relative = paths[index];
          try {
            const item = inspect(relative, projectSnapshot);
            if (physicalPaths.has(item.absolutePath)) {
              result.failed.push({ path: relative, error: '此文件已由另一条选中路径包含，未重复删除' });
            } else {
              physicalPaths.add(item.absolutePath); items.push(item);
            }
          } catch (error) { result.failed.push({ path: relative, error: String(error.message || error) }); }
          if ((index + 1) % 32 === 0 && index + 1 < paths.length) {
            await yieldToMainLoop();
            if (!stillCurrent()) {
              remainingCancelled([...items, ...paths.slice(index + 1).map(path => ({ path }))], '剧本或窗口已切换，已停止删除');
              return result;
            }
          }
        }
        if (!items.length) return result;
        if (!stillCurrent()) { remainingCancelled(items, '剧本或窗口已切换，已停止删除'); return result; }
        const approved = await confirm({ projectId: projectSnapshot.id, projectName: projectSnapshot.name || '',
          count: items.length, paths: items.map(item => item.path) });
        if (!approved) { result.cancelled = true; return result; }
        for (let index = 0; index < items.length; index++) {
          if (!stillCurrent()) {
            remainingCancelled(items.slice(index), '剧本或窗口已切换，已停止剩余删除'); break;
          }
          const item = items[index];
          try {
            // Keep the last path/identity check synchronous with the native
            // call: no await between validation and starting shell.trashItem.
            inspect(item.path, projectSnapshot, item);
            await trash(item.absolutePath);
            result.deleted.push(item.path);
            try { onDeleted({ projectId: projectSnapshot.id, path: item.path, absolutePath: item.absolutePath }); }
            catch (error) { warn(error); }
          } catch (error) { result.failed.push({ path: item.path, error: String(error.message || error) }); }
        }
        return result;
      } finally {
        // The OS may accept only part of a batch. Publish the actual successful
        // paths once; do not turn a refresh failure into a false delete failure.
        if (result.deleted.length) {
          try { broadcast({ projectId: result.projectId, deleted: [...result.deleted], batchDelete: true }); }
          catch (error) { warn(error); }
        }
        busy = false;
      }
    },
  });
}

module.exports = { MAX_BATCH_DELETE, createAssetBatchDelete };
