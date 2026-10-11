'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeFilename } = require('./download-router.cjs');
const { normalizeSnapshot } = require('./download-episodes.cjs');

// 下载过程不暴露半成品到资产树。日志只记本地路径和分类，不存网址、Cookie 或登录信息。
function createDownloadReview({ dataDir, targetFor, validateTarget }) {
  if (!path.isAbsolute(dataDir || '') || typeof targetFor !== 'function' || typeof validateTarget !== 'function') throw new Error('视频下载归档配置无效');
  const root = path.resolve(dataDir, 'video-download-review');
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('下载临时目录不能是符号链接');
  const journal = path.join(root, 'reviews.json');
  let entries = {};
  if (fs.existsSync(journal)) {
    const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (!saved || saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) throw new Error('视频下载分类记录无效');
    entries = saved.entries;
  }
  const persist = next => {
    const temp = `${journal}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: next }), { flag: 'wx' });
      fs.renameSync(temp, journal);
      entries = next;
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  };
  const requireEntry = id => {
    const entry = Object.hasOwn(entries, id) ? entries[id] : null;
    if (!entry || !/^[a-f0-9-]{36}$/.test(entry.stageId)) throw new Error('视频下载记录不存在');
    const leaf = sanitizeFilename(entry.filename);
    if (leaf !== entry.filename) throw new Error('视频下载文件名无效');
    const directory = path.join(root, entry.stageId);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('下载记录路径无效');
    const stagePath = path.join(directory, leaf);
    if (fs.existsSync(stagePath) && !fs.lstatSync(stagePath).isFile()) throw new Error('下载记录不是普通文件');
    return { ...entry, stagePath };
  };
  let queue = Promise.resolve();
  const serialize = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const digest = async filename => {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
  };
  const sameFile = async (source, destination) => {
    const a = await fs.promises.stat(source), b = await fs.promises.lstat(destination);
    if (!b.isFile() || a.size !== b.size) return false;
    if (a.dev === b.dev && a.ino === b.ino) return true;
    return await digest(source) === await digest(destination);
  };
  const cleanStage = async entry => {
    await fs.promises.unlink(entry.stagePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.promises.rmdir(path.dirname(entry.stagePath)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const next = { ...entries }; delete next[entry.id]; persist(next);
  };
  return Object.freeze({
    begin(info) {
      if (!/^dl-[a-zA-Z0-9-]+$/.test(info.id || '') || Object.hasOwn(entries, info.id)) throw new Error('视频下载记录重复或无效');
      const episodeSnapshot = info.episodeSnapshot ? normalizeSnapshot(info.episodeSnapshot) : null;
      if (episodeSnapshot && (episodeSnapshot.projectId !== info.projectId || episodeSnapshot.serviceId !== info.serviceId || episodeSnapshot.kind !== 'video')) {
        throw new Error('视频下载分集快照与所属剧本或网站不一致');
      }
      const entry = { id: info.id, projectId: info.projectId, serviceId: info.serviceId, serviceLabel: info.serviceLabel,
        filename: sanitizeFilename(info.filename), stageId: crypto.randomUUID(), startedAt: info.startedAt,
        ...(episodeSnapshot ? { episodeSnapshot } : { day: info.day }),
        productionSnapshot: info.productionSnapshot || {}, choice: '', completed: false };
      const directory = path.join(root, entry.stageId);
      fs.mkdirSync(directory);
      try { persist({ ...entries, [entry.id]: entry }); }
      catch (error) { fs.rmdirSync(directory); throw error; }
      return requireEntry(entry.id);
    },
    choose(id, choice) {
      requireEntry(id);
      if (!['editable', 'processing'].includes(choice)) throw new Error('请选择可剪辑或待处理');
      persist({ ...entries, [id]: { ...entries[id], choice } });
    },
    complete(id) {
      const entry = requireEntry(id);
      if (!fs.existsSync(entry.stagePath) || !fs.statSync(entry.stagePath).size) throw new Error('下载文件为空或不存在');
      persist({ ...entries, [id]: { ...entries[id], completed: true, size: fs.statSync(entry.stagePath).size } });
    },
    list() { return Object.keys(entries).map(requireEntry); },
    finalize(id) {
      return serialize(async () => {
        const entry = requireEntry(id);
        if (!entry.completed || !entry.choice) throw new Error('视频尚未下载完成或未选择分类');
        let destination = entry.finalPath;
        if (destination) {
          await validateTarget(entry, destination);
          const stat = fs.existsSync(destination) ? await fs.promises.lstat(destination) : null;
          if (stat?.isFile() && stat.size === entry.size && (entry.finalized || (fs.existsSync(entry.stagePath) && await sameFile(entry.stagePath, destination)))) {
            await cleanStage(entry);
            return { path: destination, choice: entry.choice, projectId: entry.projectId };
          }
        }
        if (!fs.existsSync(entry.stagePath)) throw new Error('视频暂存文件不存在，请保留下载记录后重试');
        for (let attempt = 0; attempt < 100; attempt++) {
          destination = await targetFor(entry);
          await validateTarget(entry, destination);
          await fs.promises.mkdir(path.dirname(destination), { recursive: true });
          // 先记意图，再用排他写入。退出发生在链接和日志之间也能恢复，不生成重复视频。
          persist({ ...entries, [id]: { ...entries[id], finalPath: destination, finalized: false } });
          try {
            try { await fs.promises.link(entry.stagePath, destination); }
            catch (error) {
              if (!['EXDEV', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
              await fs.promises.copyFile(entry.stagePath, destination, fs.constants.COPYFILE_EXCL);
            }
            try { persist({ ...entries, [id]: { ...entries[id], finalPath: destination, finalized: true } }); }
            catch (error) { await fs.promises.unlink(destination); throw error; }
            break;
          } catch (error) { if (error.code !== 'EEXIST' || attempt === 99) throw error; }
        }
        // 先记最终路径；中途退出时按 finalPath 恢复，不能重复归档同一份视频。
        await cleanStage(entry);
        return { path: destination, choice: entry.choice, projectId: entry.projectId };
      });
    },
    discard(id) {
      return serialize(async () => {
        const entry = requireEntry(id);
        if (entry.finalized) throw new Error('视频已归档，不能作为未完成下载丢弃');
        await cleanStage(entry);
      });
    },
  });
}

module.exports = { createDownloadReview };
